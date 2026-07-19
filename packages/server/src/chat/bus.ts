import { EventEmitter } from "node:events";
import type { ChatMessage } from "@jawbot/shared";

type Listener = (message: ChatMessage) => void;

/** Chat-facing stream: only user/assistant messages, not job telemetry. */
export class ChatBus {
  private readonly ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(100);
  }

  publish(message: ChatMessage): void {
    this.ee.emit("message", message);
    this.ee.emit(`session:${message.sessionId}`, message);
  }

  onSession(sessionId: string, listener: Listener): () => void {
    const key = `session:${sessionId}`;
    this.ee.on(key, listener);
    return () => this.ee.off(key, listener);
  }

  onAll(listener: Listener): () => void {
    this.ee.on("message", listener);
    return () => this.ee.off("message", listener);
  }
}
