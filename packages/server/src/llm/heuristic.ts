import type { PlannedAction } from "@jawbot/shared";
import type { LlmClient, PlanRequest, PlanResult, ReplyRequest } from "./types.js";

/**
 * Deterministic planner for local POC without an API key.
 * Replaced by OpenAI (or other) when JAWBOT_LLM=openai and key is set.
 */
export class HeuristicLlm implements LlmClient {
  async plan(req: PlanRequest): Promise<PlanResult> {
    const text = req.userMessage.trim();
    const lower = text.toLowerCase();

    if (isGreeting(lower) || isMetaQuestion(lower)) {
      return {
        actions: [],
        needsReply: true,
        reply: greetingReply(lower),
        reasoning: "conversational; no machine work",
      };
    }

    if (wantsOpenShell(lower)) {
      const cwd = extractCwd(text);
      const action: PlannedAction = {
        skill: "open_shell",
        input: {
          title: "JawBot Shell",
          tab: true,
          ...(cwd ? { cwd } : {}),
        },
      };
      return {
        actions: [action],
        needsReply: true,
        reply: cwd
          ? `Opening a terminal in ${cwd}.`
          : "Opening a new terminal for you.",
        reasoning: "user asked to open a shell/terminal",
      };
    }

    const run = extractRunCommand(text, lower);
    if (run) {
      return {
        actions: [
          {
            skill: "run_command",
            input: {
              command: run.command,
              visible: run.visible,
            },
          },
        ],
        needsReply: true,
        reply: null, // phrase after we see the result
        reasoning: "user asked to run a command",
      };
    }

    // Unknown: speak, don't invent machine work.
    return {
      actions: [],
      needsReply: true,
      reply:
        "I can open a terminal on the Linux desktop or run a command. " +
        'Try “open a new shell tab” or “run uname -a”.',
      reasoning: "no matching action",
    };
  }

  async phraseReply(req: ReplyRequest): Promise<string | null> {
    if (req.failed) {
      return `That didn’t work: ${req.actionSummaries.join(" ")}`;
    }
    if (req.draftReply?.trim()) return req.draftReply.trim();
    if (req.actionSummaries.length === 0) return null;
    return req.actionSummaries.join("\n");
  }
}

function isGreeting(lower: string): boolean {
  return /^(hi|hello|hey|yo|sup)\b/.test(lower) || lower === "help";
}

function isMetaQuestion(lower: string): boolean {
  return (
    lower.includes("what can you") ||
    lower.includes("who are you") ||
    lower.includes("how do you")
  );
}

function greetingReply(lower: string): string {
  if (lower === "help" || lower.includes("what can you")) {
    return (
      "I’m JawBot. Tell me what you want on the Linux machine — " +
      "for example open a shell, or run a specific command. " +
      "I’ll decide whether anything needs to execute."
    );
  }
  return "Hey. What do you want me to do on the machine?";
}

function wantsOpenShell(lower: string): boolean {
  if (/\b(run|execute|exec)\b/.test(lower) && !/\b(shell|terminal|tab)\b/.test(lower)) {
    return false;
  }
  return (
    /\b(open|launch|start|new)\b/.test(lower) &&
    /\b(shell|terminal|tab|console)\b/.test(lower)
  );
}

function extractCwd(text: string): string | undefined {
  const m =
    text.match(/\bin\s+((?:\/|\~\/)[^\s"']+)/i) ||
    text.match(/\bcwd\s*[:=]\s*(\S+)/i);
  return m?.[1];
}

function extractRunCommand(
  text: string,
  lower: string,
): { command: string; visible: boolean } | null {
  const visible = /\b(visible|show|watch)\b/.test(lower);

  const quoted =
    text.match(/\brun\s+[`"'](.+?)[`"']\s*$/i) ||
    text.match(/\bexecute\s+[`"'](.+?)[`"']\s*$/i);
  if (quoted?.[1]) return { command: quoted[1].trim(), visible };

  const prefixed = text.match(/^(?:run|execute|exec)\s+(.+)$/i);
  if (prefixed?.[1] && !wantsOpenShell(lower)) {
    return { command: prefixed[1].trim(), visible };
  }

  // “can you uname -a” / bare command-ish lines
  if (/^(uname|pwd|ls|whoami|date|df|free|cat|echo)\b/i.test(text.trim())) {
    return { command: text.trim(), visible };
  }

  return null;
}
