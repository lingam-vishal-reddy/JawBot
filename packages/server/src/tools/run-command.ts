import type { RunCommandInput } from "@jawbot/shared";
import type { Tool } from "./types.js";

export const runCommandTool: Tool = {
  name: "run_command",
  description: "Run a shell command on the Linux machine (visible terminal)",
  async run({ job, runtime, events }) {
    const input = job.input as unknown as RunCommandInput;
    if (!input.command?.trim()) {
      throw new Error("run_command requires input.command");
    }

    events.emit(job.id, job.sessionId, "skill.progress", {
      phase: "executing",
      command: input.command,
      cwd: input.cwd,
    });

    // Headful by design: run in a visible terminal so the logged-in user can
    // see it and answer interactive prompts (sudo, etc.). No headless path.
    const result = await runtime.runVisible({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
      title: `JawBot run — ${job.id.slice(0, 8)}`,
      onStdout: (chunk) => {
        events.emit(job.id, job.sessionId, "log.chunk", {
          stream: "stdout",
          text: chunk,
        });
      },
    });

    events.emit(job.id, job.sessionId, "terminal.opened", {
      pid: result.pid,
      emulator: result.emulator,
      cwd: input.cwd,
      display: result.display,
      command: input.command,
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
      },
      summary,
    };
  },
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
