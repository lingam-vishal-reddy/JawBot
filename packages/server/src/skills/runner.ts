import { randomUUID } from "node:crypto";
import {
  applyTemplate,
  type ChatMessage,
  type Job,
  type Skill,
  type SkillRun,
  type SkillRunStep,
  type SkillTask,
  type SkillTaskStep,
} from "@jawbot/shared";
import type { ChatBus } from "../chat/bus.js";
import type { EventBus } from "../events/bus.js";
import type { JobStore } from "../jobs/store.js";
import type { LlmClient, PreviousStepResult } from "../llm/types.js";
import type { LinuxRuntime, VisibleStepResult } from "../runtime/linux.js";
import { createLogger } from "../log.js";

const log = createLogger("skill-runner");
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
    log.info("skill run started", {
      runId,
      skill: skill.id,
      task: task.id,
      steps: task.steps.length,
    });

    const context = { ...skill.params, ...task.params };

    // ONE persistent interactive terminal. We resolve and run steps one at a
    // time so the LLM can decide each command from the PREVIOUS results, and
    // state (cd, env, files) carries across steps in the same shell.
    const session = this.runtime.openControlledSession({
      title: `${skill.name} · ${task.name}`,
    });
    const previousSteps: PreviousStepResult[] = [];

    try {
      for (let i = 0; i < task.steps.length; i++) {
        const step = task.steps[i]!;

        // Decide this command from the template + context + prior results.
        const command = await this.resolveCommand(
          skill,
          task,
          step,
          context,
          triggerMessage,
          previousSteps,
        );

        const job = this.createJob(sessionId, command, runId);
        this.runs.updateStep(runId, i, {
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

        const result = await session.run(command, {
          timeoutMs: step.timeoutMs,
          onOutput: (chunk) =>
            this.jobEvents.emit(job.id, sessionId, "log.chunk", {
              stream: "stdout",
              text: chunk,
            }),
        });

        const finishedAt = new Date().toISOString();
        const ok = !result.timedOut && (result.exitCode ?? 1) === 0;

        previousSteps.push({
          name: step.name,
          command,
          exitCode: result.exitCode,
          output: result.output,
        });

        if (ok) {
          this.jobs.update(job.id, {
            status: "succeeded",
            finishedAt,
            result: { exitCode: result.exitCode },
          });
          this.jobEvents.emit(job.id, sessionId, "job.completed", {
            exitCode: result.exitCode,
          });
          this.runs.updateStep(runId, i, { status: "succeeded", finishedAt });
          log.info("step succeeded", {
            runId,
            skill: skill.id,
            task: task.id,
            step: i + 1,
            of: task.steps.length,
          });
          // Status update after each command completes.
          this.postChat(
            sessionId,
            `✓ ${skill.name} · ${task.name} — step ${i + 1}/${
              task.steps.length
            } done: ${step.name}`,
          );
          continue;
        }

        // Failure → concise LLM error, stop the task (terminal stays for user).
        const error = await this.describeFailure(skill, task, step, command, result);
        log.warn("step failed", {
          runId,
          skill: skill.id,
          task: task.id,
          step: i + 1,
          error,
        });
        this.jobs.update(job.id, { status: "failed", finishedAt, error });
        this.jobEvents.emit(job.id, sessionId, "job.failed", { error });
        this.runs.updateStep(runId, i, { status: "failed", finishedAt, error });
        this.runs.update(runId, {
          status: "failed",
          finishedAt,
          error: `${step.name}: ${error}`,
        });
        this.postChat(
          sessionId,
          `${skill.name} · ${task.name} failed at step ${i + 1}/${
            task.steps.length
          } (${step.name}): ${error}`,
        );
        return;
      }

      this.runs.update(runId, {
        status: "succeeded",
        finishedAt: new Date().toISOString(),
      });
      log.info("skill run succeeded", { runId, skill: skill.id, task: task.id });
      this.postChat(
        sessionId,
        `Finished ${skill.name} · ${task.name} — all ${task.steps.length} step${
          task.steps.length === 1 ? "" : "s"
        } succeeded. The terminal is still open for you to continue.`,
      );
    } finally {
      // Hand the terminal to the user (drops into an interactive shell).
      session.finish();
    }
  }

  private async resolveCommand(
    skill: Skill,
    task: SkillTask,
    step: SkillTaskStep,
    context: Record<string, string>,
    triggerMessage: string,
    previousSteps: PreviousStepResult[],
  ): Promise<string> {
    // Heuristic planner (no LLM): substitute {{param}} with defaults.
    if (!this.llm.resolveCommand) return applyTemplate(step.template, context);
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
          previousSteps,
        })
      ).trim();
      // Fall back to default substitution if the LLM returns nothing.
      return resolved || applyTemplate(step.template, context);
    } catch {
      // Never block the run on resolution — substitute defaults.
      return applyTemplate(step.template, context);
    }
  }

  private async describeFailure(
    skill: Skill,
    task: SkillTask,
    step: SkillTaskStep,
    command: string,
    result: VisibleStepResult,
  ): Promise<string> {
    if (result.timedOut) {
      const secs = Math.round((step.timeoutMs ?? 120_000) / 1000);
      return `timed out after ${secs}s`;
    }
    const output = result.output ?? "";
    if (this.llm.summarizeError) {
      try {
        const summary = (
          await this.llm.summarizeError({
            command,
            output,
            exitCode: result.exitCode,
            skillName: skill.name,
            taskName: task.name,
            stepName: step.name,
          })
        ).trim();
        if (summary) return summary;
      } catch {
        /* fall through to output-based fallback */
      }
    }
    return (
      lastMeaningfulLine(output) ||
      `command failed (exit ${result.exitCode ?? "?"})`
    );
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

/** Fallback (no LLM): last meaningful line of output, preferring error-ish lines. */
function lastMeaningfulLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  const rx =
    /(error|fatal|not found|no such|denied|permission|cannot|unable|failed|traceback|exception)/i;
  const hit = [...lines].reverse().find((l) => rx.test(l));
  const line = hit ?? lines[lines.length - 1]!;
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
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
