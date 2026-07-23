import { randomUUID } from "node:crypto";
import type {
  ChannelKind,
  ChatMessage,
  Job,
  PlannedAction,
  Session,
} from "@jawbot/shared";
import type { ChatBus } from "../chat/bus.js";
import type { EventBus } from "../events/bus.js";
import type { JobStore } from "../jobs/store.js";
import type { LlmClient } from "../llm/types.js";
import type { LinuxRuntime } from "../runtime/linux.js";
import type { SessionStore } from "../sessions/store.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { SkillRunStore } from "../skills/runs.js";
import { SkillRunner, formatRunsStatus } from "../skills/runner.js";

export interface HandleMessageResult {
  userMessage: ChatMessage;
  assistantMessage?: ChatMessage;
  jobs: Job[];
}

/**
 * Chat orchestrator: user message in → optional skill run / tool jobs →
 * optional LLM reply. Clients never create jobs; the planner decides.
 *
 * Skills (plain-text playbooks) are matched deterministically here so they work
 * even with the heuristic planner, and their context is also fed to the LLM.
 */
export class Orchestrator {
  constructor(
    private readonly sessions: SessionStore,
    private readonly jobs: JobStore,
    private readonly jobEvents: EventBus,
    private readonly chat: ChatBus,
    private readonly tools: ToolRegistry,
    private readonly runtime: LinuxRuntime,
    private readonly llm: LlmClient,
    private readonly skills: SkillRegistry,
    private readonly skillRuns: SkillRunStore,
    private readonly skillRunner: SkillRunner,
  ) {}

  createSession(channel: ChannelKind = "web_ui"): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      channel,
      createdAt: now,
      updatedAt: now,
    };
    return this.sessions.upsert(session);
  }

  async handleUserMessage(
    sessionId: string,
    content: string,
  ): Promise<HandleMessageResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("session not found");
    }

    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error("message content is required");
    }

    const userMessage = this.publishMessage({
      id: randomUUID(),
      sessionId,
      role: "user",
      content: trimmed,
      ts: new Date().toISOString(),
    });

    // 1) Status queries about running skill tasks.
    if (isStatusQuery(trimmed)) {
      const status = formatRunsStatus(this.skillRuns.listForSession(sessionId));
      const assistantMessage = this.publishMessage({
        id: randomUUID(),
        sessionId,
        role: "assistant",
        content: status,
        ts: new Date().toISOString(),
      });
      return { userMessage, assistantMessage, jobs: [] };
    }

    // 2) Explicit skill task trigger (e.g. "set up chromium", "build chromium").
    const match = this.skills.match(trimmed);
    if (match) {
      const run = this.skillRunner.start(
        sessionId,
        match.skill,
        match.task,
        trimmed,
      );
      const assistantMessage = this.publishMessage({
        id: randomUUID(),
        sessionId,
        role: "assistant",
        content:
          `Triggering ${match.skill.name} · ${match.task.name} ` +
          `(${match.task.steps.length} step${
            match.task.steps.length === 1 ? "" : "s"
          }). I'll post progress here — ask “status” anytime.`,
        ts: new Date().toISOString(),
      });
      const runJobs = this.jobs
        .list(Number.MAX_SAFE_INTEGER)
        .filter((j) => j.skillRunId === run.id);
      return { userMessage, assistantMessage, jobs: runJobs };
    }

    // 3) Skill named without a task → list what it can do.
    const skillOnly = this.skills.matchSkillOnly(trimmed);
    if (skillOnly) {
      const tasks = skillOnly.tasks
        .map((t) => `“${skillOnly.name.toLowerCase().split(" ")[0]} ${t.id}” — ${t.description}`)
        .join("\n");
      const assistantMessage = this.publishMessage({
        id: randomUUID(),
        sessionId,
        role: "assistant",
        content: `${skillOnly.name} can:\n${tasks}`,
        ts: new Date().toISOString(),
      });
      return { userMessage, assistantMessage, jobs: [] };
    }

    // 4) Fall through to the LLM planner for general tool use / chat.
    const history = this.sessions.listMessages(sessionId).filter(
      (m) => m.id !== userMessage.id,
    );

    const plan = await this.llm.plan({
      history,
      userMessage: trimmed,
      tools: this.tools.list(),
      skillsContext: this.skills.plannerContext(),
    });

    const jobs: Job[] = [];
    const summaries: string[] = [];
    let failed = false;

    for (const action of plan.actions) {
      try {
        const { job, summary } = await this.runAction(sessionId, action);
        jobs.push(job);
        if (summary) summaries.push(summary);
      } catch (err) {
        failed = true;
        const message = err instanceof Error ? err.message : String(err);
        summaries.push(message);
      }
    }

    const jobIds = jobs.map((j) => j.id);
    let assistantMessage: ChatMessage | undefined;

    const shouldSpeak =
      plan.needsReply || failed || (jobs.length > 0 && summaries.length > 0);

    if (shouldSpeak) {
      let reply: string | null | undefined = plan.reply;

      // Phrase after actions when draft was deferred, or on failure.
      if (
        this.llm.phraseReply &&
        (failed || reply == null || (jobs.length > 0 && !plan.reply?.trim()))
      ) {
        reply = await this.llm.phraseReply({
          history,
          userMessage: trimmed,
          actionSummaries: summaries,
          draftReply: plan.reply,
          failed,
        });
      }

      if (!reply?.trim() && failed) {
        reply = summaries.join("\n") || "Something went wrong.";
      }

      // Silence is allowed: planner said needsReply but produced nothing useful.
      if (reply?.trim()) {
        assistantMessage = this.publishMessage({
          id: randomUUID(),
          sessionId,
          role: "assistant",
          content: reply.trim(),
          ts: new Date().toISOString(),
          jobIds: jobIds.length ? jobIds : undefined,
        });
      }
    }

    return { userMessage, assistantMessage, jobs };
  }

  private publishMessage(message: ChatMessage): ChatMessage {
    this.sessions.addMessage(message);
    this.chat.publish(message);
    return message;
  }

  private async runAction(
    sessionId: string,
    action: PlannedAction,
  ): Promise<{ job: Job; summary?: string }> {
    const job: Job = {
      id: randomUUID(),
      sessionId,
      tool: action.tool,
      input: action.input ?? {},
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    this.jobs.upsert(job);
    this.jobEvents.emit(job.id, sessionId, "job.accepted", {
      tool: job.tool,
    });

    this.jobs.update(job.id, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
    this.jobEvents.emit(job.id, sessionId, "job.started", {
      tool: job.tool,
    });

    try {
      const tool = this.tools.get(action.tool);
      const { result, summary } = await tool.run({
        job,
        runtime: this.runtime,
        events: this.jobEvents,
        llm: this.llm,
      });

      const completed =
        this.jobs.update(job.id, {
          status: "succeeded",
          finishedAt: new Date().toISOString(),
          result,
        }) ?? job;

      this.jobEvents.emit(job.id, sessionId, "job.completed", {
        result: result ?? {},
      });

      return { job: completed, summary };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const extra =
        err && typeof err === "object" && "result" in err
          ? (err as { result: Record<string, unknown> }).result
          : undefined;

      this.jobs.update(job.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: message,
        result: extra,
      });
      this.jobEvents.emit(job.id, sessionId, "job.failed", {
        error: message,
        result: extra,
      });
      throw err;
    }
  }
}

function isStatusQuery(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\b(status|progress)\b/.test(lower)) return true;
  return /\bhow('?s| is| are|zit)?\b.*\b(going|build|setup|coming|it|things)\b/.test(
    lower,
  );
}
