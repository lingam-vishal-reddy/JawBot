import type { Job, ToolName } from "@jawbot/shared";
import type { EventBus } from "../events/bus.js";
import type { LinuxRuntime } from "../runtime/linux.js";

export interface ToolContext {
  job: Job;
  runtime: LinuxRuntime;
  events: EventBus;
}

export interface ToolResult {
  result?: Record<string, unknown>;
  /** Short factual summary for the planner/phrasing pass — not shown raw to the user. */
  summary?: string;
}

/**
 * A tool is a low-level machine primitive the orchestrator can invoke
 * (open a shell, run a command). Tools are code. Skills are plain-text
 * playbooks that ultimately drive tools.
 */
export interface Tool {
  name: ToolName;
  description: string;
  run(ctx: ToolContext): Promise<ToolResult>;
}
