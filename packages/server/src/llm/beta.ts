import type { PlannedAction } from "@jawbot/shared";
import { isToolName } from "@jawbot/shared";
import type { LlmClient, PlanRequest, PlanResult, ReplyRequest } from "./types.js";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Independent "beta" OpenAPI-like planner. Separate from OpenAiLlm on purpose.
 *
 * Auth is via two headers instead of a bearer token:
 *   - x-openapi-token
 *   - x-generative-ai-client
 *
 * Both the base URL and the request path are configurable, so the endpoint is
 * `${baseUrl}${path}` (e.g. https://beta.example.com + /v1/generate).
 *
 * Enable with:
 *   JAWBOT_LLM=beta \
 *   BETA_OPENAPI_TOKEN=... \
 *   BETA_GENERATIVE_AI_CLIENT=... \
 *   [BETA_BASE_URL=...] [BETA_PATH=/chat/completions] [BETA_MODEL=...]
 */
export class BetaLlm implements LlmClient {
  private readonly openApiToken: string;
  private readonly generativeAiClient: string;
  private readonly baseUrl: string;
  private readonly path: string;
  private readonly model: string;

  constructor(opts?: {
    openApiToken?: string;
    generativeAiClient?: string;
    baseUrl?: string;
    path?: string;
    model?: string;
  }) {
    this.openApiToken =
      opts?.openApiToken ?? process.env.BETA_OPENAPI_TOKEN ?? "";
    this.generativeAiClient =
      opts?.generativeAiClient ?? process.env.BETA_GENERATIVE_AI_CLIENT ?? "";
    this.baseUrl = (
      opts?.baseUrl ??
      process.env.BETA_BASE_URL ??
      "https://api.beta.local/v1"
    ).replace(/\/$/, "");
    this.path = normalizePath(
      opts?.path ?? process.env.BETA_PATH ?? "/chat/completions",
    );
    this.model = opts?.model ?? process.env.BETA_MODEL ?? "beta";

    if (!this.openApiToken) {
      throw new Error("BETA_OPENAPI_TOKEN is required for BetaLlm");
    }
    if (!this.generativeAiClient) {
      throw new Error("BETA_GENERATIVE_AI_CLIENT is required for BetaLlm");
    }
  }

  /** Fully-qualified endpoint: base URL + configurable path. */
  private endpoint(): string {
    return `${this.baseUrl}${this.path}`;
  }

  async plan(req: PlanRequest): Promise<PlanResult> {
    const toolList = req.tools
      .map((t) => `- ${t.name}: ${t.description}`)
      .join("\n");

    const skillsBlock = req.skillsContext?.trim()
      ? `\n\nUser-supplied skills (plain-text playbooks). Use these as context; ` +
        `if the user asks to run one, translate its steps into run_command actions:\n${req.skillsContext}`
      : "";

    const system = `You are JawBot's planner for a Linux workstation agent.
You receive a user chat message. Decide:
1) which tools (if any) to invoke
2) whether the user needs a chat reply

Rules:
- Do NOT treat every message as work. Pure conversation → no actions.
- Only use listed tools.
- needsReply=false only when silence is clearly better (rare). Prefer a short reply.
- reply should be natural chat, not a build log or notification dump.
- For run_command, put the exact shell command in input.command.
- For open_shell, optional input: cwd, title, tab.

Return ONLY JSON:
{
  "actions": [{"tool":"open_shell"|"run_command","input":{}}],
  "needsReply": true,
  "reply": "string or null if you want to phrase after actions",
  "reasoning": "short"
}

Available tools:
${toolList}${skillsBlock}`;

    const history = req.history.slice(-12).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));

    const content = await this.complete(
      [
        { role: "system", content: system },
        ...history,
        { role: "user", content: req.userMessage },
      ],
      { json: true },
    );

    return parsePlan(content || "{}");
  }

  async phraseReply(req: ReplyRequest): Promise<string | null> {
    if (req.draftReply?.trim() && !req.failed) return req.draftReply.trim();

    const system = `You are JawBot. Write one short chat reply for the user.
No markdown dump of logs unless they asked for output.
If a command produced useful stdout, summarize or quote briefly.
If failed, say so plainly. Return plain text only.`;

    const user = JSON.stringify({
      userMessage: req.userMessage,
      actionSummaries: req.actionSummaries,
      failed: req.failed ?? false,
      draftReply: req.draftReply ?? null,
    });

    const content = await this.complete([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    const trimmed = content.trim();
    return trimmed.length ? trimmed : null;
  }

  private async complete(
    messages: Array<{ role: string; content: string }>,
    opts?: { json?: boolean },
  ): Promise<string> {
    const res = await fetch(this.endpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openapi-token": this.openApiToken,
        "x-generative-ai-client": this.generativeAiClient,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        messages,
        ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Beta LLM error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    return data.choices?.[0]?.message?.content ?? "";
  }
}

function normalizePath(path: string): string {
  if (!path) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function parsePlan(content: string): PlanResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFences(content));
  } catch {
    return {
      actions: [],
      needsReply: true,
      reply: content.trim() || "I couldn’t parse a plan for that.",
      reasoning: "invalid json from model",
    };
  }

  const obj = raw as {
    actions?: unknown;
    needsReply?: unknown;
    reply?: unknown;
    reasoning?: unknown;
  };

  const actions: PlannedAction[] = [];
  if (Array.isArray(obj.actions)) {
    for (const item of obj.actions) {
      if (!item || typeof item !== "object") continue;
      const tool =
        (item as { tool?: unknown }).tool ??
        (item as { skill?: unknown }).skill;
      const input = (item as { input?: unknown }).input;
      if (!isToolName(tool)) continue;
      actions.push({
        tool,
        input:
          input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {},
      });
    }
  }

  return {
    actions,
    needsReply: obj.needsReply !== false,
    reply:
      typeof obj.reply === "string"
        ? obj.reply
        : obj.reply === null
          ? null
          : undefined,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined,
  };
}

function stripFences(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m?.[1] ?? text).trim();
}
