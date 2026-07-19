import type { SkillName } from "@jawbot/shared";
import type { Skill } from "./types.js";
import { openShellSkill } from "./open-shell.js";
import { runCommandSkill } from "./run-command.js";

const skills: Skill[] = [openShellSkill, runCommandSkill];

export class SkillRegistry {
  private readonly byName = new Map<SkillName, Skill>();

  constructor(list: Skill[] = skills) {
    for (const skill of list) {
      this.byName.set(skill.name, skill);
    }
  }

  get(name: SkillName): Skill {
    const skill = this.byName.get(name);
    if (!skill) {
      throw new Error(`No skill registered: ${name}`);
    }
    return skill;
  }

  list(): Array<{ name: SkillName; description: string }> {
    return [...this.byName.values()].map((s) => ({
      name: s.name,
      description: s.description,
    }));
  }

  register(skill: Skill): void {
    this.byName.set(skill.name, skill);
  }
}
