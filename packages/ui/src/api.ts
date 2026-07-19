import type { ChatMessage, Job, Session } from "@jawbot/shared";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

export async function createSession(): Promise<Session> {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "web_ui" }),
  });
  const data = (await res.json()) as { session?: Session; error?: string };
  if (!res.ok || !data.session) {
    throw new Error(data.error ?? `createSession failed (${res.status})`);
  }
  return data.session;
}

export async function listMessages(sessionId: string): Promise<ChatMessage[]> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/messages`);
  const data = (await res.json()) as {
    messages?: ChatMessage[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error ?? `listMessages failed (${res.status})`);
  }
  return data.messages ?? [];
}

export async function sendMessage(
  sessionId: string,
  content: string,
): Promise<{
  userMessage: ChatMessage;
  assistantMessage?: ChatMessage;
  jobs: Job[];
}> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const data = (await res.json()) as {
    userMessage?: ChatMessage;
    assistantMessage?: ChatMessage;
    jobs?: Job[];
    error?: string;
  };
  if (!res.ok || !data.userMessage) {
    throw new Error(data.error ?? `sendMessage failed (${res.status})`);
  }
  return {
    userMessage: data.userMessage,
    assistantMessage: data.assistantMessage,
    jobs: data.jobs ?? [],
  };
}

export async function health(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export function chatWsUrl(): string {
  const configured = import.meta.env.VITE_WS_URL as string | undefined;
  if (configured) return configured;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws/chat`;
}

export type { ChatMessage, Session, Job };
