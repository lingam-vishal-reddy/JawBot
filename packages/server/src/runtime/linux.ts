import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface OpenTerminalOptions {
  cwd?: string;
  title?: string;
  tab?: boolean;
  /** Optional command to run inside the visible terminal. */
  command?: string;
}

export interface RunProcessOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface RunProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface OpenTerminalResult {
  pid: number;
  emulator: string;
  cwd: string;
  display: string;
}

export interface RunVisibleOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  title?: string;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  pollMs?: number;
  /** Keep the window open after success (default: only kept open on failure). */
  keepOpenOnSuccess?: boolean;
}

export interface RunVisibleResult extends RunProcessResult {
  pid: number;
  emulator: string;
  display: string;
}

function resolveCwd(cwd?: string): string {
  const candidate = cwd?.trim() ? resolve(cwd) : homedir();
  return existsSync(candidate) ? candidate : homedir();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Linux desktop runtime: open visible terminals and run headless processes.
 * GUI path uses xfce4-terminal (available in this env); falls back to x-terminal-emulator.
 */
export class LinuxRuntime {
  private readonly display: string;

  constructor(display = process.env.DISPLAY ?? ":1") {
    this.display = display;
  }

  detectEmulator(): string {
    const candidates = [
      "xfce4-terminal",
      "x-terminal-emulator",
      "gnome-terminal",
      "xterm",
    ];
    for (const bin of candidates) {
      if (this.which(bin)) return bin;
    }
    throw new Error(
      "No terminal emulator found. Install xfce4-terminal or set PATH.",
    );
  }

  openTerminal(options: OpenTerminalOptions = {}): OpenTerminalResult {
    const cwd = resolveCwd(options.cwd);
    const emulator = this.detectEmulator();
    const title = options.title ?? "JawBot Shell";
    const args = this.buildTerminalArgs(emulator, {
      cwd,
      title,
      tab: options.tab ?? true,
      command: options.command,
    });

    const child = spawn(emulator, args, {
      cwd,
      env: {
        ...process.env,
        DISPLAY: this.display,
      },
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    if (!child.pid) {
      throw new Error(`Failed to spawn ${emulator}`);
    }

    return {
      pid: child.pid,
      emulator,
      cwd,
      display: this.display,
    };
  }

  runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
    const cwd = resolveCwd(options.cwd);
    const timeoutMs = options.timeoutMs ?? 120_000;

    return new Promise((resolvePromise) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DISPLAY: this.display,
        ...options.env,
      };
      // Avoid nvm noise when the parent process has npm_config_prefix set.
      delete env.npm_config_prefix;
      delete env.NPM_CONFIG_PREFIX;

      const child = spawn("bash", ["-lc", options.command], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 2000).unref();
      }, timeoutMs);

      child.stdout.on("data", (buf: Buffer) => {
        const chunk = buf.toString("utf8");
        stdout += chunk;
        options.onStdout?.(chunk);
      });
      child.stderr.on("data", (buf: Buffer) => {
        const chunk = buf.toString("utf8");
        stderr += chunk;
        options.onStderr?.(chunk);
      });

      const finish = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ exitCode, signal, stdout, stderr, timedOut });
      };

      child.on("error", (err) => {
        stderr += `${err.message}\n`;
        finish(1, null);
      });
      child.on("close", (code, signal) => finish(code, signal));
    });
  }

  /**
   * Headful command execution: run a command inside a VISIBLE terminal window
   * so interactive prompts (e.g. `sudo`) have a real TTY the logged-in user can
   * answer. Output is tee'd to a log file that we tail into onStdout, and the
   * command's exit code is written to a sentinel file we wait on.
   *
   * This is why `sudo` "hangs" in headless mode: there is no TTY/stdin, so the
   * password prompt has nowhere to go. Running visibly fixes that.
   */
  runVisible(options: RunVisibleOptions): Promise<RunVisibleResult> {
    const cwd = resolveCwd(options.cwd);
    const emulator = this.detectEmulator();
    const title = options.title ?? "JawBot";
    const timeoutMs = options.timeoutMs ?? 120_000;
    const pollMs = options.pollMs ?? 500;

    const dir = mkdtempSync(join(tmpdir(), "jawbot-visible-"));
    const logFile = join(dir, "output.log");
    const codeFile = join(dir, "exit.code");

    const hold = options.keepOpenOnSuccess
      ? `echo; echo "[JawBot] exit=$ec — press Enter to close"; read`
      : `if [ "$ec" != "0" ]; then echo; echo "[JawBot] exit=$ec — press Enter to close"; read; fi`;

    // Runs inside the visible terminal via `bash -lc`.
    const innerScript = [
      `cd ${shellQuote(cwd)}`,
      `touch ${shellQuote(logFile)}`,
      `set -o pipefail`,
      `( ${options.command} ) 2>&1 | tee ${shellQuote(logFile)}`,
      `ec=\${PIPESTATUS[0]}`,
      `printf '%s' "$ec" > ${shellQuote(codeFile)}`,
      hold,
    ].join("; ");

    const args = this.buildVisibleArgs(emulator, { cwd, title }, innerScript);

    const child = spawn(emulator, args, {
      cwd,
      env: {
        ...process.env,
        ...options.env,
        DISPLAY: this.display,
      },
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    const pid = child.pid ?? 0;

    return new Promise<RunVisibleResult>((resolvePromise) => {
      let stdout = "";
      let offset = 0;
      let spawnError = false;
      const start = Date.now();

      child.on("error", () => {
        spawnError = true;
      });

      const tail = () => {
        try {
          if (existsSync(logFile)) {
            const buf = readFileSync(logFile);
            if (buf.length > offset) {
              const chunk = buf.subarray(offset).toString("utf8");
              offset = buf.length;
              stdout += chunk;
              options.onStdout?.(chunk);
            }
          }
        } catch {
          /* file may briefly not exist; ignore */
        }
      };

      const finish = (
        exitCode: number | null,
        timedOut: boolean,
      ): void => {
        clearInterval(timer);
        tail();
        if (timedOut && pid) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              /* already gone */
            }
          }
        }
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        resolvePromise({
          exitCode,
          signal: null,
          stdout,
          stderr: "",
          timedOut,
          pid,
          emulator,
          display: this.display,
        });
      };

      const timer = setInterval(() => {
        tail();

        if (existsSync(codeFile)) {
          const raw = (() => {
            try {
              return readFileSync(codeFile, "utf8").trim();
            } catch {
              return "";
            }
          })();
          if (raw.length) {
            const code = Number.parseInt(raw, 10);
            finish(Number.isNaN(code) ? null : code, false);
            return;
          }
        }

        if (spawnError) {
          finish(null, false);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          finish(null, true);
        }
      }, pollMs);
    });
  }

  private buildVisibleArgs(
    emulator: string,
    opts: { cwd: string; title: string },
    innerScript: string,
  ): string[] {
    if (
      emulator.includes("xfce4-terminal") ||
      emulator === "x-terminal-emulator"
    ) {
      return [
        `--working-directory=${opts.cwd}`,
        `--title=${opts.title}`,
        "--window",
        "-e",
        `bash -lc ${shellQuote(innerScript)}`,
      ];
    }
    if (emulator.includes("gnome-terminal")) {
      return [
        `--working-directory=${opts.cwd}`,
        "--window",
        "--",
        "bash",
        "-lc",
        innerScript,
      ];
    }
    // xterm-style
    return ["-T", opts.title, "-e", `bash -lc ${shellQuote(innerScript)}`];
  }

  private buildTerminalArgs(
    emulator: string,
    opts: {
      cwd: string;
      title: string;
      tab: boolean;
      command?: string;
    },
  ): string[] {
    const holdCommand = opts.command
      ? `bash -lc ${shellQuote(`${opts.command}; echo; echo '[JawBot] exit=$? — press Enter to close'; read`)}`
      : "bash";

    if (emulator.includes("xfce4-terminal") || emulator === "x-terminal-emulator") {
      const args = [
        `--working-directory=${opts.cwd}`,
        `--title=${opts.title}`,
      ];
      if (opts.tab) args.push("--tab");
      else args.push("--window");
      args.push("-e", holdCommand);
      return args;
    }

    if (emulator.includes("gnome-terminal")) {
      return [
        `--working-directory=${opts.cwd}`,
        opts.tab ? "--tab" : "--window",
        "--",
        "bash",
        "-lc",
        opts.command
          ? `${opts.command}; echo; echo '[JawBot] done — press Enter'; read`
          : "exec bash",
      ];
    }

    // xterm-style
    return ["-T", opts.title, "-e", holdCommand];
  }

  private which(bin: string): boolean {
    const pathEnv = process.env.PATH ?? "";
    return pathEnv.split(":").some((dir) => existsSync(`${dir}/${bin}`));
  }
}
