import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Skill } from "@jawbot/shared";
import { parseSkill } from "./format.js";

export interface LoadedSkills {
  dir: string;
  skills: Skill[];
  errors: Array<{ file: string; error: string }>;
}

/**
 * Resolve the skills folder. Override with JAWBOT_SKILLS_DIR; otherwise use the
 * repo-root `skills/` directory (works for both src via tsx and compiled dist).
 */
export function skillsDir(): string {
  if (process.env.JAWBOT_SKILLS_DIR) {
    return resolve(process.env.JAWBOT_SKILLS_DIR);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../../skills");
}

/** Load and parse every `*.txt` skill file in the folder (startup, no watch). */
export function loadSkillsFromDir(dir = skillsDir()): LoadedSkills {
  const errors: LoadedSkills["errors"] = [];
  const skills: Skill[] = [];

  if (!existsSync(dir)) {
    return { dir, skills, errors };
  }

  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".txt"))
    .sort();

  const seen = new Map<string, string>();
  for (const file of files) {
    const full = join(dir, file);
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch (err) {
      errors.push({ file, error: (err as Error).message });
      continue;
    }

    const fallbackId = basename(file, ".txt");
    const { skill, errors: parseErrors } = parseSkill(text, fallbackId);
    for (const e of parseErrors) errors.push({ file, error: e });

    if (!skill) continue;

    const prior = seen.get(skill.id);
    if (prior) {
      errors.push({
        file,
        error: `duplicate skill id "${skill.id}" (already defined in ${prior})`,
      });
      continue;
    }
    seen.set(skill.id, file);
    skills.push(skill);
  }

  return { dir, skills, errors };
}
