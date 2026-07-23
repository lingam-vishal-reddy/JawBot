import type { PlannedAction } from "@jawbot/shared";
import { isToolName } from "@jawbot/shared";
import type {
  LlmClient,
  PlanRequest,
  PlanResult,
  ReplyRequest,
  ResolveCommandRequest,
  SummarizeErrorRequest,
} from "./types.js";
import { cleanCommand, tailText } from "./openai.js";

/**
 * Beta response envelope: a single string `content`.
 */
interface BetaResponse {
  content?: string;
}

/**
 * Independent "beta" planner. Its wire protocol is deliberately different from
 * the OpenAI client — no `messages`/`choices`. Instead:
 *
 *   Request  { modelIds: string[], contents: string[], systemPrompt: string, isStream: boolean }
 *   Response { content: string }
 *
 * Auth is via two headers:
 *   - x-openapi-token
 *   - x-generative-ai-client
 *
 * Both the base URL and the request path are configurable, so the endpoint is
 * `${baseUrl}${path}`.
 *
 * Enable with:
 *   JAWBOT_LLM=beta \
 *   BETA_OPENAPI_TOKEN=... \
 *   BETA_GENERATIVE_AI_CLIENT=... \
 *   [BETA_BASE_URL=...] [BETA_PATH=/generate] [BETA_MODEL=...]
 */
export class BetaLlm implements LlmClient {
  private readonly openApiToken: string;
  private readonly generativeAiClient: string;
  private readonly baseUrl: string;
  private readonly path: string;
  private readonly modelId: string;

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
      opts?.path ?? process.env.BETA_PATH ?? "/generate",
    );
    this.modelId = opts?.model ?? process.env.BETA_MODEL ?? "beta";

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

    const systemPrompt = `You are JawBot's planner for a Linux workstation agent.
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

    // contents: the conversation so far as plain strings, then the new message.
    const contents = [
      ...req.history.slice(-12).map((m) => `${m.role}: ${m.content}`),
      req.userMessage,
    ];

    const content = await this.generate(systemPrompt, contents);
    return parsePlan(content || "{}");
  }

  async phraseReply(req: ReplyRequest): Promise<string | null> {
    if (req.draftReply?.trim() && !req.failed) return req.draftReply.trim();

    const systemPrompt = `You are JawBot. Write one short chat reply for the user.
No markdown dump of logs unless they asked for output.
If a command produced useful stdout, summarize or quote briefly.
If failed, say so plainly. Return plain text only.`;

    const contents = [
      JSON.stringify({
        userMessage: req.userMessage,
        actionSummaries: req.actionSummaries,
        failed: req.failed ?? false,
        draftReply: req.draftReply ?? null,
      }),
    ];

    const content = await this.generate(systemPrompt, contents);
    const trimmed = content.trim();
    return trimmed.length ? trimmed : null;
  }

  async resolveCommand(req: ResolveCommandRequest): Promise<string> {
    const systemPrompt = `You turn a general step template into ONE concrete shell command for a Linux machine.
Use the provided context values (e.g. branch, output directory), the user's message, and the results of previous steps to decide the exact command.
Adapt to what actually happened in previous steps (paths chosen, failures, files created); stay consistent with them.
Prefer the context/user values over anything hardcoded in the template.
Output ONLY the command — no prose, no markdown, no backticks. Multiple statements may be joined with ';' or '&&'.`;

    const contents = [
      JSON.stringify({
        skill: req.skillName,
        task: req.taskName,
        step: req.stepName,
        template: req.template,
        context: req.context,
        userMessage: req.userMessage,
        playbook: req.skillContext,
        previousSteps: req.previousSteps.map((s) => ({
          name: s.name,
          command: s.command,
          exitCode: s.exitCode,
          output: tailText(s.output, 1500),
        })),
      }),
    ];

    const content = await this.generate(systemPrompt, contents);
    return cleanCommand(content);
  }

  async summarizeError(req: SummarizeErrorRequest): Promise<string> {
    const systemPrompt = `A shell command failed. Write ONE concise, human-readable sentence describing what went wrong, based on the output.
Focus on the actual cause (missing dependency, permission, not found, syntax, network, etc.).
Do NOT just restate the exit code. No markdown, no backticks, no prose beyond the sentence. Max ~200 characters.`;

    const contents = [
      JSON.stringify({
        step: req.stepName,
        command: req.command,
        exitCode: req.exitCode,
        output: tailText(req.output, 4000),
      }),
    ];

    const content = await this.generate(systemPrompt, contents);
    return content.replace(/\s+/g, " ").trim().slice(0, 300);
  }

  private async generate(
    systemPrompt: string,
    contents: string[],
  ): Promise<string> {
    const res = await fetch(this.endpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openapi-token": this.openApiToken,
        "x-generative-ai-client": this.generativeAiClient,
      },
      body: JSON.stringify({
        modelIds: [this.modelId],
        contents,
        systemPrompt,
        isStream: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Beta LLM error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as BetaResponse;
    return data.content ?? "";
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
