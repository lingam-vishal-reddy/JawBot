import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
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
}

export interface RunVisibleResult extends RunProcessResult {
  pid: number;
  emulator: string;
  display: string;
}

export interface VisibleStepResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

export interface ControlledRunOptions {
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
}

/**
 * A live handle to ONE persistent, visible, interactive terminal. Commands are
 * sent one at a time and executed in the same shell (so `cd`, env, and files
 * carry over). Call `finish()` to hand the terminal to the user.
 */
export interface ControlledSession {
  readonly pid: number;
  readonly emulator: string;
  readonly display: string;
  /** Send a command, wait for it to finish, and return its result. */
  run(command: string, opts?: ControlledRunOptions): Promise<VisibleStepResult>;
  /** Stop driving and drop the terminal into an interactive shell for the user. */
  finish(): void;
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
   * Headful execution of a single command in a visible terminal, then hand the
   * terminal to the user. Built on openControlledSession.
   */
  async runVisible(options: RunVisibleOptions): Promise<RunVisibleResult> {
    const session = this.openControlledSession({
      cwd: options.cwd,
      env: options.env,
      title: options.title,
      pollMs: options.pollMs,
    });
    try {
      const r = await session.run(options.command, {
        timeoutMs: options.timeoutMs,
        onOutput: (chunk) => options.onStdout?.(chunk),
      });
      return {
        exitCode: r.exitCode,
        signal: null,
        stdout: r.output,
        stderr: "",
        timedOut: r.timedOut,
        pid: session.pid,
        emulator: session.emulator,
        display: session.display,
      };
    } finally {
      session.finish();
    }
  }

  /**
   * Open ONE persistent, visible, interactive terminal that executes commands
   * on demand (see ControlledSession). This lets the caller run a command, look
   * at the result, decide the next command, and run it — all in the SAME shell,
   * so `cd`, env, and generated files carry over (e.g. `gn gen` then
   * `autoninja` find build.ninja). `finish()` hands the terminal to the user.
   *
   * Mechanics: a controller loop inside the terminal reads commands from a FIFO
   * (kept open from Node so writes never block), echoes each command, runs it
   * via process substitution (so `cd` persists), and writes the exit code to a
   * per-command sentinel file we wait on while tailing the output log. `~/.bashrc`
   * is loaded (interactive shell) and prompts like `sudo` get a real TTY.
   */
  openControlledSession(options: {
    cwd?: string;
    env?: Record<string, string>;
    title?: string;
    pollMs?: number;
  } = {}): ControlledSession {
    const cwd = resolveCwd(options.cwd);
    const emulator = this.detectEmulator();
    const title = options.title ?? "JawBot";
    const pollMs = options.pollMs ?? 300;

    const dir = mkdtempSync(join(tmpdir(), "jawbot-visible-"));
    const fifo = join(dir, "cmd.fifo");
    execFileSync("mkfifo", [fifo]);
    const dirQ = shellQuote(dir);

    // Controller loop, run in the visible interactive terminal. Reads
    // "<seq> <command>" lines and "__DONE__" to finish.
    const controller = [
      `set +H`,
      `cd ${shellQuote(cwd)}`,
      `exec 3<> ${shellQuote(fifo)}`,
      `while IFS= read -r __line <&3; do`,
      `  [ "$__line" = "__DONE__" ] && break`,
      `  __seq=\${__line%% *}`,
      `  __cmd=\${__line#* }`,
      `  printf '\\n\\033[1;36m$ %s\\033[0m\\n' "$__cmd"`,
      `  { eval "$__cmd" ; } > >(tee ${dirQ}/"$__seq".log) 2>&1`,
      `  __ec=$?`,
      `  printf '%s' "$__ec" > ${dirQ}/"$__seq".code`,
      `done`,
      `echo; echo "[JawBot] done — you can keep working in this shell (type 'exit' to close)"`,
      `exec bash -i`,
    ].join("\n");

    const args = this.buildVisibleArgs(emulator, { cwd, title }, controller);
    const child = spawn(emulator, args, {
      cwd,
      env: { ...process.env, ...options.env, DISPLAY: this.display },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const pid = child.pid ?? 0;

    // Keep a read-write fd open so writes never block and the reader never
    // sees EOF (loop stays alive until __DONE__).
    const keepFd = openSync(fifo, fsConstants.O_RDWR);

    let seq = 0;
    let finished = false;
    const display = this.display;

    const killGroup = () => {
      if (!pid) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    };

    const run = (
      command: string,
      opts: ControlledRunOptions = {},
    ): Promise<VisibleStepResult> => {
      const id = ++seq;
      const cmd = command.replace(/\r?\n/g, " ; ");
      const logFile = join(dir, `${id}.log`);
      const codeFile = join(dir, `${id}.code`);
      const timeoutMs = opts.timeoutMs ?? 120_000;

      writeSync(keepFd, `${id} ${cmd}\n`);

      return new Promise<VisibleStepResult>((resolvePromise) => {
        let output = "";
        let offset = 0;
        const start = Date.now();

        const tail = () => {
          try {
            const buf = readFileSync(logFile);
            if (buf.length > offset) {
              const chunk = buf.subarray(offset).toString("utf8");
              offset = buf.length;
              output += chunk;
              opts.onOutput?.(chunk);
            }
          } catch {
            /* not created yet */
          }
        };

        const timer = setInterval(() => {
          tail();
          let raw = "";
          try {
            raw = readFileSync(codeFile, "utf8").trim();
          } catch {
            /* not done */
          }
          if (raw.length) {
            clearInterval(timer);
            tail();
            const code = Number.parseInt(raw, 10);
            resolvePromise({
              exitCode: Number.isNaN(code) ? null : code,
              output,
              timedOut: false,
            });
            return;
          }
          if (Date.now() - start > timeoutMs) {
            clearInterval(timer);
            tail();
            killGroup();
            resolvePromise({ exitCode: null, output, timedOut: true });
          }
        }, pollMs);
      });
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        writeSync(keepFd, `__DONE__\n`);
      } catch {
        /* terminal may be gone */
      }
      try {
        closeSync(keepFd);
      } catch {
        /* ignore */
      }
      // Give the controller a moment to consume before removing temp files.
      setTimeout(() => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }, 3000).unref();
    };

    return { pid, emulator, display, run, finish };
  }

  private buildVisibleArgs(
    emulator: string,
    opts: { cwd: string; title: string },
    innerScript: string,
  ): string[] {
    // Interactive shell (`-i`) so ~/.bashrc is sourced like a normal terminal.
    if (
      emulator.includes("xfce4-terminal") ||
      emulator === "x-terminal-emulator"
    ) {
      // No `--window`: options before it would configure a first (default)
      // window and `--window` would open a SECOND one — that's what caused two
      // terminals to appear. A single default window runs the command.
      return [
        `--working-directory=${opts.cwd}`,
        `--title=${opts.title}`,
        "-e",
        `bash -ic ${shellQuote(innerScript)}`,
      ];
    }
    if (emulator.includes("gnome-terminal")) {
      return [
        `--working-directory=${opts.cwd}`,
        "--",
        "bash",
        "-ic",
        innerScript,
      ];
    }
    // xterm-style
    return ["-T", opts.title, "-e", `bash -ic ${shellQuote(innerScript)}`];
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
