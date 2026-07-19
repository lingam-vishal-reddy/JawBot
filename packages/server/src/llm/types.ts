import type { ChatMessage, PlannedAction, SkillName } from "@jawbot/shared";

export interface SkillDescriptor {
  name: SkillName;
  description: string;
}

export interface PlanRequest {
  history: ChatMessage[];
  userMessage: string;
  skills: SkillDescriptor[];
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

export interface LlmClient {
  /** Decide whether to act, what skills to call, and whether to speak. */
  plan(req: PlanRequest): Promise<PlanResult>;
  /** Optional second pass to phrase the reply after actions finish. */
  phraseReply?(req: ReplyRequest): Promise<string | null>;
}
