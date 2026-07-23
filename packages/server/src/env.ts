import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load `.env` before anything reads `process.env`.
 *
 * Why this exists: nothing else loads env files. The npm scripts don't pass
 * `--env-file`, there's no dotenv dependency, and workspace scripts run with
 * the cwd at `packages/server` — so a repo-root `.env` would be missed anyway.
 *
 * Behavior:
 * - Real environment variables always win; `.env` only fills in what's missing.
 * - Searches JAWBOT_ENV_FILE (if set), the cwd, and the repo root, so it works
 *   from either directory, in dev (tsx) or prod (node dist).
 *
 * Import this module first, for its side effect:  import "./env.js";
 */
function candidatePaths(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // env.ts lives at packages/server/{src,dist}/env.js → repo root is three up.
  const repoRoot = resolve(here, "../../..");
  const paths = [
    process.env.JAWBOT_ENV_FILE,
    resolve(process.cwd(), ".env"),
    resolve(repoRoot, ".env"),
  ].filter((p): p is string => Boolean(p));
  return [...new Set(paths.map((p) => resolve(p)))];
}

function applyEnvFile(file: string): number {
  let applied = 0;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq === -1) continue;

    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    // Real environment wins; only fill gaps.
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied++;
    }
  }
  return applied;
}

export function loadEnv(): void {
  for (const file of candidatePaths()) {
    if (!existsSync(file)) continue;
    try {
      const applied = applyEnvFile(file);
      console.log(`[jawbot] loaded env from ${file} (${applied} var(s))`);
    } catch (err) {
      console.warn(
        `[jawbot] failed to load env file ${file}: ${(err as Error).message}`,
      );
    }
  }
}

loadEnv();
