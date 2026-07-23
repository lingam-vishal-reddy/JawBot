import type { PlannedAction } from "@jawbot/shared";
import { isToolName } from "@jawbot/shared";
import type { LlmClient, PlanRequest, PlanResult, ReplyRequest } from "./types.js";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * OpenAI-compatible planner. Enable with:
 *   JAWBOT_LLM=openai OPENAI_API_KEY=... [OPENAI_BASE_URL=...] [OPENAI_MODEL=...]
 */
export class OpenAiLlm implements LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts?: { apiKey?: string; baseUrl?: string; model?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = (
      opts?.baseUrl ??
      process.env.OPENAI_BASE_URL ??
      "https://api.openai.com/v1"
    ).replace(/\/$/, "");
    this.model = opts?.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is required for OpenAiLlm");
    }
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
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
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
      throw new Error(`OpenAI error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    return data.choices?.[0]?.message?.content ?? "";
  }
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
