import type { LlmClient } from "./types.js";
import { HeuristicLlm } from "./heuristic.js";
import { OpenAiLlm } from "./openai.js";
import { BetaLlm } from "./beta.js";

export type { LlmClient, PlanResult, PlanRequest } from "./types.js";
export { HeuristicLlm } from "./heuristic.js";
export { OpenAiLlm } from "./openai.js";
export { BetaLlm } from "./beta.js";

/**
 * Pick the planner at runtime via JAWBOT_LLM:
 *   - "heuristic" (default): deterministic, no API key
 *   - "openai": OpenAI-compatible bearer client
 *   - "beta": independent OpenAPI-like client (x-openapi-token +
 *     x-generative-ai-client headers, configurable base URL + path)
 */
export function createLlmClient(): LlmClient {
  const mode = (process.env.JAWBOT_LLM ?? "heuristic").toLowerCase();
  switch (mode) {
    case "openai":
      return new OpenAiLlm();
    case "beta":
      return new BetaLlm();
    default:
      return new HeuristicLlm();
  }
}
