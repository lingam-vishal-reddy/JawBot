import type { Skill, SkillTask, SkillTaskStep } from "@jawbot/shared";

/**
 * Prescribed plain-text skill format. Users drop `.txt` files in the skills
 * folder and they are loaded at startup.
 *
 * Format:
 *
 *   id: chromium-android
 *   name: Chromium Android
 *   description: one-line summary
 *   triggers: chromium, chrome android
 *
 *   [context]
 *   Free-form plain-text playbook. Everything until the next [section]
 *   header is kept verbatim and handed to the planner.
 *
 *   [task setup]
 *   name: Chromium Android setup
 *   description: what this task does
 *   triggers: setup, set up, install
 *
 *   step: Clone depot_tools
 *   command: git clone https://... "$HOME/depot_tools"
 *   timeout: 600            # seconds (or use `timeoutMs:` for milliseconds)
 *
 *   step: Fetch Chromium
 *   command: fetch --nohooks android
 *
 * Rules:
 * - `key: value` header lines set the skill (before any section) or the task.
 * - `triggers` is a comma-separated list.
 * - `[context]` captures raw multi-line text until the next section.
 * - `[task <id>]` opens a task; its `name`/`description`/`triggers` lines must
 *   come before the first `step:`.
 * - `step:` opens a step (its value is the step name); the following
 *   `command:`, `cwd:`, `timeout:`/`timeoutMs:` lines configure that step.
 * - Lines starting with `#` are comments (except inside a [context] block).
 */

export interface ParsedSkillResult {
  skill?: Skill;
  errors: string[];
}

type Mode = "header" | "context" | "task";

export function parseSkill(text: string, fallbackId?: string): ParsedSkillResult {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);

  let id = "";
  let name = "";
  let description = "";
  let triggers: string[] = [];
  const contextLines: string[] = [];
  const tasks: SkillTask[] = [];

  let mode: Mode = "header";
  let currentTask: SkillTask | null = null;
  let currentStep: SkillTaskStep | null = null;

  const finishTask = () => {
    if (currentTask) {
      currentStep = null;
      tasks.push(currentTask);
      currentTask = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Section headers switch mode regardless of current mode.
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      const label = section[1]!.trim();
      if (/^context$/i.test(label)) {
        finishTask();
        mode = "context";
        continue;
      }
      const taskMatch = label.match(/^task\s*:?\s*(.+)$/i);
      if (taskMatch) {
        finishTask();
        mode = "task";
        currentStep = null;
        currentTask = {
          id: slug(taskMatch[1]!.trim()),
          name: taskMatch[1]!.trim(),
          description: "",
          triggers: [],
          steps: [],
        };
        continue;
      }
      errors.push(`unknown section [${label}] at line ${i + 1}`);
      continue;
    }

    if (mode === "context") {
      contextLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const kv = trimmed.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!kv) {
      errors.push(`unrecognized line ${i + 1}: "${trimmed}"`);
      continue;
    }
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim();

    if (mode === "header") {
      switch (key) {
        case "id":
          id = slug(value);
          break;
        case "name":
          name = value;
          break;
        case "description":
          description = value;
          break;
        case "triggers":
          triggers = splitList(value);
          break;
        default:
          errors.push(`unknown skill field "${key}" at line ${i + 1}`);
      }
      continue;
    }

    // mode === "task"
    if (!currentTask) continue;
    if (key === "step") {
      currentStep = { name: value, command: "" };
      currentTask.steps.push(currentStep);
      continue;
    }
    if (currentStep) {
      switch (key) {
        case "command":
          currentStep.command = value;
          break;
        case "cwd":
          currentStep.cwd = value;
          break;
        case "timeout": {
          const secs = Number(value);
          if (Number.isFinite(secs)) currentStep.timeoutMs = secs * 1000;
          break;
        }
        case "timeoutms": {
          const ms = Number(value);
          if (Number.isFinite(ms)) currentStep.timeoutMs = ms;
          break;
        }
        default:
          errors.push(`unknown step field "${key}" at line ${i + 1}`);
      }
      continue;
    }
    // task-level fields (before first step)
    switch (key) {
      case "name":
        currentTask.name = value;
        break;
      case "description":
        currentTask.description = value;
        break;
      case "triggers":
        currentTask.triggers = splitList(value);
        break;
      default:
        errors.push(`unknown task field "${key}" at line ${i + 1}`);
    }
  }

  finishTask();

  if (!id) id = fallbackId ? slug(fallbackId) : "";
  if (!name) name = id;

  if (!id) {
    errors.push("missing required field: id");
  }
  for (const task of tasks) {
    const bad = task.steps.filter((s) => !s.command.trim());
    for (const s of bad) {
      errors.push(`task "${task.id}" step "${s.name}" has no command`);
    }
  }

  if (!id || errors.some((e) => e.includes("required"))) {
    return { errors };
  }

  const skill: Skill = {
    id,
    name,
    description,
    triggers,
    context: contextLines.join("\n").trim(),
    tasks,
  };
  return { skill, errors };
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
