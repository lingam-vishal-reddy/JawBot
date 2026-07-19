import { useEffect, useRef, useState } from "react";
import {
  chatWsUrl,
  createSession,
  health,
  listMessages,
  sendMessage,
  type ChatMessage,
} from "./api";

const SUGGESTIONS = [
  "Open a new shell tab",
  "Run uname -a",
  "What can you do?",
];

export function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverOk, setServerOk] = useState(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const seenIds = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await createSession();
        if (cancelled) return;
        setSessionId(session.id);
        const existing = await listMessages(session.id);
        for (const m of existing) seenIds.current.add(m.id);
        setMessages(existing);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ping = async () => {
      const ok = await health();
      if (!cancelled) setServerOk(ok);
    };
    void ping();
    const id = setInterval(ping, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const ws = new WebSocket(chatWsUrl());
    ws.onopen = () => {
      setLive(true);
      ws.send(JSON.stringify({ type: "subscribe", sessionId }));
    };
    ws.onclose = () => setLive(false);
    ws.onerror = () => setLive(false);
    ws.onmessage = (msg) => {
      try {
        const payload = JSON.parse(String(msg.data)) as {
          type?: string;
          message?: ChatMessage;
        };
        if (payload.type === "message" && payload.message) {
          const m = payload.message;
          if (seenIds.current.has(m.id)) return;
          seenIds.current.add(m.id);
          setMessages((prev) => [...prev, m]);
        }
      } catch {
        /* ignore */
      }
    };
    return () => ws.close();
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function onSend(text: string) {
    if (!sessionId || busy) return;
    const content = text.trim();
    if (!content) return;
    setError(null);
    setBusy(true);
    setDraft("");
    try {
      const result = await sendMessage(sessionId, content);
      // HTTP response is source of truth; WS may race — merge carefully.
      for (const m of [result.userMessage, result.assistantMessage]) {
        if (!m) continue;
        if (seenIds.current.has(m.id)) continue;
        seenIds.current.add(m.id);
        setMessages((prev) => [...prev, m]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="top">
        <div>
          <h1>
            Jaw<span>Bot</span>
          </h1>
          <p>Chat with the machine. I decide if anything needs to run.</p>
        </div>
        <div className="pills">
          <span className={`pill ${serverOk ? "ok" : "bad"}`}>
            api {serverOk ? "up" : "down"}
          </span>
          <span className={`pill ${live ? "ok" : "bad"}`}>
            chat {live ? "live" : "down"}
          </span>
        </div>
      </header>

      <main className="chat">
        {messages.length === 0 && !busy && (
          <div className="empty">
            <p>Ask in plain language.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => void onSend(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            <div className="role">{m.role === "user" ? "You" : "JawBot"}</div>
            <div className="content">{m.content}</div>
          </div>
        ))}

        {busy && (
          <div className="bubble assistant thinking">
            <div className="role">JawBot</div>
            <div className="content">Thinking…</div>
          </div>
        )}
        <div ref={bottomRef} />
      </main>

      <footer className="composer">
        {error && <p className="error">{error}</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onSend(draft);
          }}
        >
          <textarea
            rows={2}
            value={draft}
            placeholder="Message JawBot…"
            disabled={!sessionId || busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void onSend(draft);
              }
            }}
          />
          <button type="submit" disabled={!sessionId || busy || !draft.trim()}>
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}
