/** Channel that owns the conversation. Slack / other messengers plug in later. */
export type ChannelKind = "jaws" | "web_ui" | "api" | "system";

export type Role = "user" | "assistant" | "system";

/**
 * Built-in tool names — the low-level machine primitives the orchestrator can
 * invoke. Clients never pick these; the planner does.
 *
 * NOTE: these used to be called "skills". Tools are the executable primitives;
 * Skills (see below) are plain-text playbooks a user supplies as context.
 */
export type ToolName = "open_shell" | "run_command";

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/** Internal unit of machine work — created by the orchestrator, not the client. */
export interface Job {
  id: string;
  sessionId: string;
  tool: ToolName;
  input: Record<string, unknown>;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  result?: Record<string, unknown>;
  /** Set when this job was created as a step of a skill run. */
  skillRunId?: string;
}

export type JobEventType =
  | "job.accepted"
  | "job.started"
  | "job.completed"
  | "job.failed"
  | "terminal.opened"
  | "log.chunk"
  | "skill.progress";

/** Internal telemetry for tools/runtime. Not the primary UX stream. */
export interface JobEvent {
  id: string;
  jobId: string;
  sessionId: string;
  type: JobEventType;
  ts: string;
  data?: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  ts: string;
  /** Optional linkage when a reply followed machine work. */
  jobIds?: string[];
}

export interface Session {
  id: string;
  channel: ChannelKind;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionRequest {
  channel?: ChannelKind;
}

export interface PostMessageRequest {
  content: string;
}

/** What the planner decided to do for one user turn. */
export interface PlannedAction {
  tool: ToolName;
  input: Record<string, unknown>;
}

export interface OpenShellInput {
  cwd?: string;
  title?: string;
  tab?: boolean;
}

export interface RunCommandInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  visible?: boolean;
}

export function isToolName(value: unknown): value is ToolName {
  return value === "open_shell" || value === "run_command";
}

/* -------------------------------------------------------------------------- */
/* Skills                                                                     */
/*                                                                            */
/* A Skill is user-supplied context in plain language — a playbook that tells */
/* JawBot how to accomplish something. Unlike tools, skills are not code:     */
/* they carry a description, trigger phrases, and one or more runnable tasks. */
/* Each task is a sequence of steps that ultimately run via tools, and can be */
/* tracked for status updates.                                                */
/* -------------------------------------------------------------------------- */

/**
 * One step in a skill task. `template` is a GENERAL template — it is NOT run
 * verbatim when an LLM planner is configured. The LLM resolves the actual shell
 * command from this template plus the task/skill `params` (branch, output dir,
 * …) and the user's message. With the heuristic planner (no LLM) the template
 * runs as-is. There is deliberately no rule-based placeholder substitution.
 */
export interface SkillTaskStep {
  name: string;
  template: string;
  cwd?: string;
  timeoutMs?: number;
}

/** A runnable unit of a skill (e.g. "setup", "build"). */
export interface SkillTask {
  id: string;
  name: string;
  description: string;
  /** Natural-language phrases that trigger this task. */
  triggers: string[];
  /** Context values (with defaults) handed to the LLM to resolve commands. */
  params: Record<string, string>;
  steps: SkillTaskStep[];
}

/** A plain-text capability the user teaches JawBot. */
export interface Skill {
  id: string;
  name: string;
  description: string;
  /** Natural-language phrases that identify this skill. */
  triggers: string[];
  /** Plain-text playbook / context handed to the planner. */
  context: string;
  /** Skill-wide context values (with defaults); tasks may override. */
  params: Record<string, string>;
  tasks: SkillTask[];
}

/** Lightweight skill view for API/listing (omits raw step templates). */
export interface SkillDescriptor {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  params: Record<string, string>;
  tasks: Array<{
    id: string;
    name: string;
    description: string;
    triggers: string[];
    params: Record<string, string>;
    stepCount: number;
  }>;
}

export type SkillRunStatus = JobStatus;

export interface SkillRunStep {
  index: number;
  name: string;
  command: string;
  status: SkillRunStatus;
  jobId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

/** A single invocation of a skill task, tracked for status updates. */
export interface SkillRun {
  id: string;
  sessionId: string;
  skillId: string;
  skillName: string;
  taskId: string;
  taskName: string;
  status: SkillRunStatus;
  steps: SkillRunStep[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export function toSkillDescriptor(skill: Skill): SkillDescriptor {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    triggers: skill.triggers,
    params: skill.params,
    tasks: skill.tasks.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      triggers: t.triggers,
      params: t.params,
      stepCount: t.steps.length,
    })),
  };
}
