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
 *   param: output_dir = out/Android
 *   param: branch = main
 *
 *   [context]
 *   Free-form plain-text playbook. Everything until the next [section]
 *   header is kept verbatim and handed to the planner.
 *
 *   [task build]
 *   name: Chromium Android build
 *   description: what this task does
 *   triggers: build, compile
 *   param: apk_target = chrome_public_apk
 *
 *   step: Configure
 *   template: gn gen out/Android --args='target_os="android"'
 *   timeout: 600            # seconds (or use `timeoutMs:` for milliseconds)
 *
 * Rules:
 * - `key: value` header lines set the skill (before any section) or the task.
 * - `triggers` is a comma-separated list.
 * - `param: name = default` declares a context value referenced in templates as
 *   `{{name}}`. Skill-level params apply to every task; task-level params
 *   override them.
 * - `[context]` captures raw multi-line text until the next section.
 * - `[task <id>]` opens a task; its header lines must come before the first
 *   `step:`.
 * - `step:` opens a step (its value is the step name); the following
 *   `template:` (or `command:`) is a GENERAL template that references params as
 *   `{{param}}`. With an LLM planner the LLM resolves the actual command from
 *   the template + params + the user's message; the heuristic planner replaces
 *   `{{param}}` with the declared default values.
 * - `cwd:` / `timeout:` / `timeoutMs:` configure the current step.
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
  const skillParams: Record<string, string> = {};
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
          params: {},
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
        case "param": {
          const p = parseParam(value);
          if (p) skillParams[p.name] = p.value;
          else errors.push(`invalid param at line ${i + 1}: "${value}"`);
          break;
        }
        default:
          errors.push(`unknown skill field "${key}" at line ${i + 1}`);
      }
      continue;
    }

    // mode === "task"
    if (!currentTask) continue;
    if (key === "step") {
      currentStep = { name: value, template: "" };
      currentTask.steps.push(currentStep);
      continue;
    }
    if (currentStep) {
      switch (key) {
        case "template":
        case "command":
          currentStep.template = value;
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
      case "param": {
        const p = parseParam(value);
        if (p) currentTask.params[p.name] = p.value;
        else errors.push(`invalid param at line ${i + 1}: "${value}"`);
        break;
      }
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
    const bad = task.steps.filter((s) => !s.template.trim());
    for (const s of bad) {
      errors.push(`task "${task.id}" step "${s.name}" has no template/command`);
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
    params: skillParams,
    tasks,
  };
  return { skill, errors };
}

function parseParam(value: string): { name: string; value: string } | null {
  const eq = value.indexOf("=");
  const name = (eq === -1 ? value : value.slice(0, eq)).trim();
  if (!/^[A-Za-z_][\w.-]*$/.test(name)) return null;
  const def = eq === -1 ? "" : value.slice(eq + 1).trim();
  return { name, value: unquote(def) };
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
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
