import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ChatBus } from "../chat/bus.js";
import type { ChatMessage } from "@jawbot/shared";

interface ClientMessage {
  type?: string;
  sessionId?: string;
}

/**
 * Chat WebSocket. Pushes assistant/user messages for a session.
 * Job telemetry is intentionally not on this socket.
 */
export function attachChatSocket(
  server: HttpServer,
  chat: ChatBus,
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws/chat" });

  wss.on("connection", (socket) => {
    let unsubscribe: (() => void) | undefined;
    let sessionId: string | undefined;

    socket.send(
      JSON.stringify({
        type: "hello",
        ts: new Date().toISOString(),
        message: "send {type:'subscribe', sessionId}",
      }),
    );

    socket.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        socket.send(JSON.stringify({ type: "error", error: "invalid json" }));
        return;
      }

      if (msg.type === "subscribe" && msg.sessionId) {
        unsubscribe?.();
        sessionId = msg.sessionId;
        unsubscribe = chat.onSession(sessionId, (message) =>
          send(socket, message),
        );
        socket.send(
          JSON.stringify({ type: "subscribed", sessionId }),
        );
      }

      if (msg.type === "ping") {
        socket.send(
          JSON.stringify({ type: "pong", ts: new Date().toISOString() }),
        );
      }
    });

    socket.on("close", () => unsubscribe?.());
  });

  return wss;
}

function send(socket: WebSocket, message: ChatMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify({ type: "message", message }));
  }
}
