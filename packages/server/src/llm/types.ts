import type { ChatMessage, PlannedAction, ToolName } from "@jawbot/shared";

export interface ToolDescriptor {
  name: ToolName;
  description: string;
}

export interface PlanRequest {
  history: ChatMessage[];
  userMessage: string;
  /** Low-level machine primitives the planner may invoke. */
  tools: ToolDescriptor[];
  /** Plain-text playbooks (skills) the user has supplied, for extra context. */
  skillsContext?: string;
}

/**
 * Planner output for one user turn.
 * - actions: machine work to run (may be empty — e.g. pure Q&A)
 * - reply: user-facing text. null/undefined = stay silent (no assistant bubble)
 * - needsReply: if false, orchestrator will not post an assistant message
 *   unless something failed and we must surface it.
 */
export interface PlanResult {
  actions: PlannedAction[];
  reply?: string | null;
  needsReply: boolean;
  reasoning?: string;
}

export interface ReplyRequest {
  history: ChatMessage[];
  userMessage: string;
  actionSummaries: string[];
  draftReply?: string | null;
  failed?: boolean;
}

/**
 * Ask the planner to turn a general step template into the actual shell command
 * for one skill-task step, using the declared context (params) and the user's
 * message. No rule-based substitution happens anywhere — the LLM decides.
 */
export interface PreviousStepResult {
  name: string;
  command: string;
  exitCode: number | null;
  /** Tail of the command's output. */
  output: string;
}

export interface ResolveCommandRequest {
  skillName: string;
  /** The skill's plain-text playbook, for extra context. */
  skillContext: string;
  taskName: string;
  stepName: string;
  /** The general template authored in the skill file. */
  template: string;
  /** Declared context values (e.g. branch, output_dir) with defaults. */
  context: Record<string, string>;
  /** The user's triggering message (may contain overrides in prose). */
  userMessage: string;
  /**
   * Results of the earlier steps in this task (in order), so the LLM can adapt
   * the next command to what actually happened.
   */
  previousSteps: PreviousStepResult[];
}

/**
 * Ask the planner to turn failing command output into a concise, human-readable
 * error message (one sentence). The exit code alone is not useful to the user.
 */
export interface SummarizeErrorRequest {
  command: string;
  /** Captured stdout+stderr from the failed command (may be truncated). */
  output: string;
  exitCode: number | null;
  skillName?: string;
  taskName?: string;
  stepName?: string;
}

export interface LlmClient {
  /** Decide whether to act, what tools to call, and whether to speak. */
  plan(req: PlanRequest): Promise<PlanResult>;
  /** Optional second pass to phrase the reply after actions finish. */
  phraseReply?(req: ReplyRequest): Promise<string | null>;
  /**
   * Optional: resolve a step template into a concrete shell command. When a
   * client doesn't implement this (e.g. the heuristic planner) the runner uses
   * the template verbatim.
   */
  resolveCommand?(req: ResolveCommandRequest): Promise<string>;
  /**
   * Optional: summarize failing command output into one concise error line.
   * When absent (heuristic planner) the caller falls back to the last
   * meaningful output line.
   */
  summarizeError?(req: SummarizeErrorRequest): Promise<string>;
}
