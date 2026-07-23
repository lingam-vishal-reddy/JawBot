import type { Skill, SkillDescriptor, SkillTask } from "@jawbot/shared";
import { toSkillDescriptor } from "@jawbot/shared";

export interface SkillMatch {
  skill: Skill;
  task: SkillTask;
}

/**
 * Holds plain-text Skills (user-supplied playbooks, loaded from the skills
 * folder at startup) and resolves natural language to a runnable skill task.
 */
export class SkillRegistry {
  private readonly byId = new Map<string, Skill>();

  constructor(list: Skill[] = []) {
    for (const skill of list) {
      this.byId.set(skill.id, skill);
    }
  }

  register(skill: Skill): void {
    this.byId.set(skill.id, skill);
  }

  get(id: string): Skill | undefined {
    return this.byId.get(id);
  }

  all(): Skill[] {
    return [...this.byId.values()];
  }

  list(): SkillDescriptor[] {
    return this.all().map(toSkillDescriptor);
  }

  /** Plain-text context block for every skill, fed to the LLM planner. */
  plannerContext(): string {
    const skills = this.all();
    if (skills.length === 0) return "";
    return skills
      .map((s) => {
        const tasks = s.tasks
          .map((t) => `    • ${t.id} — ${t.description}`)
          .join("\n");
        return `# Skill: ${s.name} (id: ${s.id})\n${s.context}\n  Tasks:\n${tasks}`;
      })
      .join("\n\n");
  }

  /**
   * Resolve a user message to a skill task. A match requires a skill trigger
   * AND a task trigger to be present (e.g. "build chromium").
   */
  match(text: string): SkillMatch | undefined {
    const lower = text.toLowerCase();
    for (const skill of this.all()) {
      if (!hasTrigger(lower, skill.triggers)) continue;
      for (const task of skill.tasks) {
        if (hasTrigger(lower, task.triggers)) {
          return { skill, task };
        }
      }
    }
    return undefined;
  }

  /** True when a skill is referenced but no specific task trigger matched. */
  matchSkillOnly(text: string): Skill | undefined {
    const lower = text.toLowerCase();
    for (const skill of this.all()) {
      if (hasTrigger(lower, skill.triggers)) return skill;
    }
    return undefined;
  }
}

function hasTrigger(lowerText: string, triggers: string[]): boolean {
  return triggers.some((t) => matchesWord(lowerText, t.toLowerCase()));
}

/** Match a trigger phrase on word boundaries to avoid accidental substrings. */
function matchesWord(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\W)${escaped}(\\W|$)`).test(text);
}
