/**
 * Tiny structured logger for the backend.
 *
 * Level via JAWBOT_LOG_LEVEL (debug|info|warn|error, default info). Output:
 *   2026-07-24T05:00:00.000Z INFO  [scope] message {json}
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function threshold(): number {
  const raw = (process.env.JAWBOT_LOG_LEVEL ?? "info").toLowerCase();
  return ORDER[raw as LogLevel] ?? ORDER.info;
}

function safeJson(data: unknown): string {
  try {
    return JSON.stringify(data, (_key, value) => {
      if (typeof value === "string" && value.length > 500) {
        return `${value.slice(0, 500)}…`;
      }
      if (typeof value === "bigint") return value.toString();
      return value;
    });
  } catch {
    return String(data);
  }
}

function emit(
  level: LogLevel,
  scope: string,
  message: string,
  data?: unknown,
): void {
  if (ORDER[level] < threshold()) return;
  const ts = new Date().toISOString();
  const head = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const line = data === undefined ? head : `${head} ${safeJson(data)}`;
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  child(subScope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, d) => emit("debug", scope, m, d),
    info: (m, d) => emit("info", scope, m, d),
    warn: (m, d) => emit("warn", scope, m, d),
    error: (m, d) => emit("error", scope, m, d),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
