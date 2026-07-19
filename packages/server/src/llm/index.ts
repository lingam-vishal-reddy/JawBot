import type { LlmClient } from "./types.js";
import { HeuristicLlm } from "./heuristic.js";
import { OpenAiLlm } from "./openai.js";

export type { LlmClient, PlanResult, PlanRequest } from "./types.js";
export { HeuristicLlm } from "./heuristic.js";
export { OpenAiLlm } from "./openai.js";

export function createLlmClient(): LlmClient {
  const mode = (process.env.JAWBOT_LLM ?? "heuristic").toLowerCase();
  if (mode === "openai") {
    return new OpenAiLlm();
  }
  return new HeuristicLlm();
}
