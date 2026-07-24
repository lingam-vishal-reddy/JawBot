import type { ToolName } from "@jawbot/shared";
import type { Tool } from "./types.js";
import { openShellTool } from "./open-shell.js";
import { runCommandTool } from "./run-command.js";

const tools: Tool[] = [openShellTool, runCommandTool];

export class ToolRegistry {
  private readonly byName = new Map<ToolName, Tool>();

  constructor(list: Tool[] = tools) {
    for (const tool of list) {
      this.byName.set(tool.name, tool);
    }
  }

  get(name: ToolName): Tool {
    const tool = this.byName.get(name);
    if (!tool) {
      throw new Error(`No tool registered: ${name}`);
    }
    return tool;
  }

  list(): Array<{ name: ToolName; description: string }> {
    return [...this.byName.values()].map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  register(tool: Tool): void {
    this.byName.set(tool.name, tool);
  }
}
