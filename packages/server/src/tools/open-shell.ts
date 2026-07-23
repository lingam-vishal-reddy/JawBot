import type { OpenShellInput } from "@jawbot/shared";
import type { Tool } from "./types.js";

export const openShellTool: Tool = {
  name: "open_shell",
  description: "Open a visible terminal window/tab on the Linux desktop",
  async run({ job, runtime, events }) {
    const input = job.input as unknown as OpenShellInput;
    const opened = runtime.openTerminal({
      cwd: input.cwd,
      title: input.title ?? `JawBot — ${job.id.slice(0, 8)}`,
      tab: input.tab ?? true,
    });

    events.emit(job.id, job.sessionId, "terminal.opened", {
      pid: opened.pid,
      emulator: opened.emulator,
      cwd: opened.cwd,
      display: opened.display,
    });

    return {
      result: {
        pid: opened.pid,
        emulator: opened.emulator,
        cwd: opened.cwd,
        display: opened.display,
      },
      summary: `Opened ${opened.emulator} (pid ${opened.pid}) in ${opened.cwd}`,
    };
  },
};
