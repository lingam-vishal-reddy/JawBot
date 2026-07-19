import type { RunCommandInput } from "@jawbot/shared";
import type { Skill } from "./types.js";

export const runCommandSkill: Skill = {
  name: "run_command",
  description: "Run a shell command on the Linux machine",
  async run({ job, runtime, events }) {
    const input = job.input as unknown as RunCommandInput;
    if (!input.command?.trim()) {
      throw new Error("run_command requires input.command");
    }

    if (input.visible) {
      const opened = runtime.openTerminal({
        cwd: input.cwd,
        title: `JawBot run — ${job.id.slice(0, 8)}`,
        tab: true,
        command: input.command,
      });
      events.emit(job.id, job.sessionId, "terminal.opened", {
        pid: opened.pid,
        emulator: opened.emulator,
        cwd: opened.cwd,
        display: opened.display,
        command: input.command,
      });
    }

    events.emit(job.id, job.sessionId, "skill.progress", {
      phase: "executing",
      command: input.command,
      cwd: input.cwd,
    });

    const result = await runtime.runProcess({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
      onStdout: (chunk) => {
        events.emit(job.id, job.sessionId, "log.chunk", {
          stream: "stdout",
          text: chunk,
        });
      },
      onStderr: (chunk) => {
        events.emit(job.id, job.sessionId, "log.chunk", {
          stream: "stderr",
          text: chunk,
        });
      },
    });

    if (result.timedOut) {
      throw new Error(
        `Command timed out after ${input.timeoutMs ?? 120_000}ms`,
      );
    }
    if ((result.exitCode ?? 1) !== 0) {
      const err = new Error(
        `Command exited with code ${result.exitCode ?? "null"}`,
      );
      (err as Error & { result: typeof result }).result = result;
      throw err;
    }

    const stdout = result.stdout.trim();
    const summary =
      stdout.length > 0
        ? `Command ok. Output:\n${truncate(stdout, 1200)}`
        : `Command ok (exit ${result.exitCode}).`;

    return {
      result: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      summary,
    };
  },
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
