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
import { createLogger } from "../log.js";

const log = createLogger("orchestrator");

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

    log.info("message received", { sessionId, content: trimmed });

    // 1) Status queries about running work (skill tasks + tool jobs).
    if (isStatusQuery(trimmed)) {
      log.info("status query", { sessionId });
      const assistantMessage = this.publishMessage({
        id: randomUUID(),
        sessionId,
        role: "assistant",
        content: this.formatStatus(sessionId),
        ts: new Date().toISOString(),
      });
      return { userMessage, assistantMessage, jobs: [] };
    }

    // 2) Explicit skill task trigger (e.g. "set up chromium", "build chromium").
    const match = this.skills.match(trimmed);
    if (match) {
      log.info("skill trigger", {
        sessionId,
        skill: match.skill.id,
        task: match.task.id,
      });
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
    log.info("plan", {
      sessionId,
      actions: plan.actions.map((a) => a.tool),
      needsReply: plan.needsReply,
    });

    // 5) Long-running work (run_command) executes in the BACKGROUND so the UI
    // returns immediately; the result is posted to chat when it's done, and the
    // user can ask "status" meanwhile.
    const hasLongRunning = plan.actions.some((a) => a.tool === "run_command");
    if (plan.actions.length > 0 && hasLongRunning) {
      const ack = this.publishMessage({
        id: randomUUID(),
        sessionId,
        role: "assistant",
        content: ackFor(plan.actions),
        ts: new Date().toISOString(),
      });
      void this.runActionsInBackground(sessionId, trimmed, history, plan);
      return { userMessage, assistantMessage: ack, jobs: [] };
    }

    // 6) Fast/no actions (open_shell, pure chat) run inline.
    const { jobs, summaries, failed } = await this.runActions(
      sessionId,
      plan.actions,
    );
    const assistantMessage = await this.speak(
      sessionId,
      trimmed,
      history,
      plan,
      jobs,
      summaries,
      failed,
    );
    return { userMessage, assistantMessage, jobs };
  }

  /** Run planned actions, collecting jobs + summaries. */
  private async runActions(
    sessionId: string,
    actions: PlannedAction[],
  ): Promise<{ jobs: Job[]; summaries: string[]; failed: boolean }> {
    const jobs: Job[] = [];
    const summaries: string[] = [];
    let failed = false;
    for (const action of actions) {
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
    return { jobs, summaries, failed };
  }

  /** Execute actions off the request path and post the result to chat. */
  private async runActionsInBackground(
    sessionId: string,
    userMessage: string,
    history: ChatMessage[],
    plan: Awaited<ReturnType<LlmClient["plan"]>>,
  ): Promise<void> {
    log.info("running actions in background", {
      sessionId,
      actions: plan.actions.map((a) => a.tool),
    });
    try {
      const { jobs, summaries, failed } = await this.runActions(
        sessionId,
        plan.actions,
      );
      await this.speak(
        sessionId,
        userMessage,
        history,
        plan,
        jobs,
        summaries,
        failed,
      );
      log.info("background actions done", { sessionId, failed });
    } catch (err) {
      log.error("background actions crashed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Phrase and publish the assistant reply for a set of actions. */
  private async speak(
    sessionId: string,
    userMessage: string,
    history: ChatMessage[],
    plan: Awaited<ReturnType<LlmClient["plan"]>>,
    jobs: Job[],
    summaries: string[],
    failed: boolean,
  ): Promise<ChatMessage | undefined> {
    const jobIds = jobs.map((j) => j.id);
    const shouldSpeak =
      plan.needsReply || failed || (jobs.length > 0 && summaries.length > 0);
    if (!shouldSpeak) return undefined;

    let reply: string | null | undefined = plan.reply;
    if (
      this.llm.phraseReply &&
      (failed || reply == null || (jobs.length > 0 && !plan.reply?.trim()))
    ) {
      reply = await this.llm.phraseReply({
        history,
        userMessage,
        actionSummaries: summaries,
        draftReply: plan.reply,
        failed,
      });
    }
    if (!reply?.trim() && failed) {
      reply = summaries.join("\n") || "Something went wrong.";
    }
    if (!reply?.trim()) return undefined;

    return this.publishMessage({
      id: randomUUID(),
      sessionId,
      role: "assistant",
      content: reply.trim(),
      ts: new Date().toISOString(),
      jobIds: jobIds.length ? jobIds : undefined,
    });
  }

  /** Human-readable status of a session's skill runs + tool jobs. */
  private formatStatus(sessionId: string): string {
    const parts: string[] = [];
    const runs = this.skillRuns.listForSession(sessionId);
    if (runs.length > 0) parts.push(formatRunsStatus(runs));

    const jobs = this.jobs
      .list(Number.MAX_SAFE_INTEGER)
      .filter((j) => j.sessionId === sessionId && !j.skillRunId)
      .slice(0, 5);
    if (jobs.length > 0) {
      const lines = jobs.map((j) => {
        const cmd = (j.input?.command as string | undefined) ?? j.tool;
        return `${j.status} · ${j.tool}: ${cmd}`;
      });
      parts.push(`Recent commands:\n${lines.join("\n")}`);
    }

    return parts.length > 0
      ? parts.join("\n\n")
      : "Nothing running yet.";
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

function ackFor(actions: PlannedAction[]): string {
  const commands = actions
    .filter((a) => a.tool === "run_command")
    .map((a) => (a.input?.command as string | undefined)?.trim())
    .filter((c): c is string => Boolean(c));
  if (commands.length === 1) {
    return `On it — running \`${commands[0]}\` in a terminal. I'll post the result here when it's done; ask "status" anytime.`;
  }
  if (commands.length > 1) {
    return `On it — running ${commands.length} commands. I'll post results here when they're done; ask "status" anytime.`;
  }
  return `On it — I'll post the result here when it's done; ask "status" anytime.`;
}

function isStatusQuery(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\b(status|progress)\b/.test(lower)) return true;
  return /\bhow('?s| is| are|zit)?\b.*\b(going|build|setup|coming|it|things)\b/.test(
    lower,
  );
}
