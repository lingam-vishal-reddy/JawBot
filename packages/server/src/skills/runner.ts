import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  Job,
  Skill,
  SkillRun,
  SkillRunStep,
  SkillTask,
  SkillTaskStep,
} from "@jawbot/shared";
import type { ChatBus } from "../chat/bus.js";
import type { EventBus } from "../events/bus.js";
import type { JobStore } from "../jobs/store.js";
import type { LlmClient } from "../llm/types.js";
import type { LinuxRuntime } from "../runtime/linux.js";
import type { SessionStore } from "../sessions/store.js";
import type { SkillRunStore } from "./runs.js";

/**
 * Executes a skill task step-by-step on the Linux runtime, tracking status in
 * the SkillRunStore and streaming progress to chat + job telemetry.
 *
 * Runs are asynchronous: start() returns immediately and the run proceeds in
 * the background so long builds (e.g. Chromium) don't block the request. The
 * caller/user polls status via chat ("status") or the /skills/runs endpoints.
 */
export class SkillRunner {
  constructor(
    private readonly runtime: LinuxRuntime,
    private readonly runs: SkillRunStore,
    private readonly jobs: JobStore,
    private readonly jobEvents: EventBus,
    private readonly chat: ChatBus,
    private readonly sessions: SessionStore,
    private readonly llm: LlmClient,
  ) {}

  start(
    sessionId: string,
    skill: Skill,
    task: SkillTask,
    triggerMessage = "",
  ): SkillRun {
    const now = new Date().toISOString();
    // Resolved commands are filled in as each step runs.
    const steps: SkillRunStep[] = task.steps.map((step, index) => ({
      index,
      name: step.name,
      command: "",
      status: "queued",
    }));

    const run: SkillRun = {
      id: randomUUID(),
      sessionId,
      skillId: skill.id,
      skillName: skill.name,
      taskId: task.id,
      taskName: task.name,
      status: "queued",
      steps,
      createdAt: now,
    };
    this.runs.upsert(run);

    // Fire-and-forget; progress is surfaced via chat + status endpoints.
    void this.execute(run.id, skill, task, triggerMessage);
    return run;
  }

  private async execute(
    runId: string,
    skill: Skill,
    task: SkillTask,
    triggerMessage: string,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    const sessionId = run.sessionId;

    this.runs.update(runId, {
      status: "running",
      startedAt: new Date().toISOString(),
    });

    // Context handed to the LLM to resolve each command. No substitution here.
    const context = { ...skill.params, ...task.params };

    for (const step of task.steps) {
      const current = this.runs.get(runId);
      const stepRef = current?.steps.find((s) => s.name === step.name);
      const index = stepRef?.index ?? 0;

      // Let the LLM produce the actual command from the general template +
      // context (branch, output dir, …) + the user's message. If no LLM
      // supports this (heuristic planner), run the template verbatim.
      const command = await this.resolveCommand(skill, task, step, context, triggerMessage);

      const job = this.createJob(sessionId, command, runId);
      this.runs.updateStep(runId, index, {
        status: "running",
        command,
        jobId: job.id,
        startedAt: new Date().toISOString(),
      });
      this.jobEvents.emit(job.id, sessionId, "skill.progress", {
        skillRunId: runId,
        step: step.name,
        phase: "executing",
        command,
      });

      // Headful: run each step in a visible terminal so interactive prompts
      // (e.g. sudo during Chromium build-deps) have a real TTY the logged-in
      // user can answer. Keep the window open so progress is watchable.
      const result = await this.runtime.runVisible({
        command,
        cwd: step.cwd,
        timeoutMs: step.timeoutMs,
        title: `${skill.name} · ${step.name}`,
        keepOpenOnSuccess: true,
        onStdout: (chunk) =>
          this.jobEvents.emit(job.id, sessionId, "log.chunk", {
            stream: "stdout",
            text: chunk,
          }),
      });

      const ok = !result.timedOut && (result.exitCode ?? 1) === 0;
      const finishedAt = new Date().toISOString();

      if (ok) {
        this.jobs.update(job.id, {
          status: "succeeded",
          finishedAt,
          result: { exitCode: result.exitCode },
        });
        this.jobEvents.emit(job.id, sessionId, "job.completed", {
          exitCode: result.exitCode,
        });
        this.runs.updateStep(runId, index, { status: "succeeded", finishedAt });
      } else {
        const error = result.timedOut
          ? `timed out after ${step.timeoutMs ?? 120_000}ms`
          : `exited with code ${result.exitCode ?? "null"}`;
        this.jobs.update(job.id, { status: "failed", finishedAt, error });
        this.jobEvents.emit(job.id, sessionId, "job.failed", { error });
        this.runs.updateStep(runId, index, {
          status: "failed",
          finishedAt,
          error,
        });
        this.runs.update(runId, {
          status: "failed",
          finishedAt,
          error: `${step.name}: ${error}`,
        });
        this.postChat(
          sessionId,
          `${skill.name} · ${task.name} failed at step ${index + 1}/${
            task.steps.length
          } (${step.name}): ${error}.`,
        );
        return;
      }
    }

    this.runs.update(runId, {
      status: "succeeded",
      finishedAt: new Date().toISOString(),
    });
    this.postChat(
      sessionId,
      `Finished ${skill.name} · ${task.name} — all ${task.steps.length} step${
        task.steps.length === 1 ? "" : "s"
      } succeeded.`,
    );
  }

  private async resolveCommand(
    skill: Skill,
    task: SkillTask,
    step: SkillTaskStep,
    context: Record<string, string>,
    triggerMessage: string,
  ): Promise<string> {
    if (!this.llm.resolveCommand) return step.template;
    try {
      const resolved = (
        await this.llm.resolveCommand({
          skillName: skill.name,
          skillContext: skill.context,
          taskName: task.name,
          stepName: step.name,
          template: step.template,
          context,
          userMessage: triggerMessage,
        })
      ).trim();
      return resolved || step.template;
    } catch {
      // Never block the run on resolution — fall back to the template as-is.
      return step.template;
    }
  }

  private createJob(
    sessionId: string,
    command: string,
    skillRunId: string,
  ): Job {
    const job: Job = {
      id: randomUUID(),
      sessionId,
      tool: "run_command",
      input: { command },
      status: "running",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      skillRunId,
    };
    this.jobs.upsert(job);
    this.jobEvents.emit(job.id, sessionId, "job.started", {
      tool: job.tool,
      skillRunId,
    });
    return job;
  }

  private postChat(sessionId: string, content: string): void {
    const message: ChatMessage = {
      id: randomUUID(),
      sessionId,
      role: "assistant",
      content,
      ts: new Date().toISOString(),
    };
    this.sessions.addMessage(message);
    this.chat.publish(message);
  }
}

/** Human-readable status summary for a session's skill runs. */
export function formatRunsStatus(runs: SkillRun[]): string {
  if (runs.length === 0) {
    return "No skill tasks have been triggered yet.";
  }
  return runs
    .map((run) => {
      const done = run.steps.filter((s) => s.status === "succeeded").length;
      const header = `${run.skillName} · ${run.taskName}: ${run.status} (${done}/${run.steps.length} steps)`;
      const active = run.steps.find((s) => s.status === "running");
      const failed = run.steps.find((s) => s.status === "failed");
      if (failed) return `${header} — failed at “${failed.name}”: ${failed.error ?? "unknown error"}`;
      if (active) return `${header} — running “${active.name}”`;
      return header;
    })
    .join("\n");
}
