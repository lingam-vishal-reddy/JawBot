import type { Job, SkillName } from "@jawbot/shared";
import type { EventBus } from "../events/bus.js";
import type { LinuxRuntime } from "../runtime/linux.js";

export interface SkillContext {
  job: Job;
  runtime: LinuxRuntime;
  events: EventBus;
}

export interface SkillResult {
  result?: Record<string, unknown>;
  /** Short factual summary for the planner/phrasing pass — not shown raw to the user. */
  summary?: string;
}

export interface Skill {
  name: SkillName;
  description: string;
  run(ctx: SkillContext): Promise<SkillResult>;
}
