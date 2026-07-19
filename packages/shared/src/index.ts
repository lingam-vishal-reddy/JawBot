/** Channel that owns the conversation. Slack / other messengers plug in later. */
export type ChannelKind = "jaws" | "web_ui" | "api" | "system";

export type Role = "user" | "assistant" | "system";

/** Built-in skill names. Orchestrator chooses these; clients never pick them. */
export type SkillName = "open_shell" | "run_command";

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
  skill: SkillName;
  input: Record<string, unknown>;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  result?: Record<string, unknown>;
}

export type JobEventType =
  | "job.accepted"
  | "job.started"
  | "job.completed"
  | "job.failed"
  | "terminal.opened"
  | "log.chunk"
  | "skill.progress";

/** Internal telemetry for skills/runtime. Not the primary UX stream. */
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
  skill: SkillName;
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

export function isSkillName(value: unknown): value is SkillName {
  return value === "open_shell" || value === "run_command";
}
