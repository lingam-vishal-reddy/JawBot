import type { ChatMessage, Session } from "@jawbot/shared";

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly messages = new Map<string, ChatMessage[]>();

  upsert(session: Session): Session {
    this.sessions.set(session.id, session);
    if (!this.messages.has(session.id)) {
      this.messages.set(session.id, []);
    }
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  touch(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.set(id, { ...s, updatedAt: new Date().toISOString() });
  }

  addMessage(message: ChatMessage): ChatMessage {
    const list = this.messages.get(message.sessionId) ?? [];
    list.push(message);
    this.messages.set(message.sessionId, list);
    this.touch(message.sessionId);
    return message;
  }

  listMessages(sessionId: string): ChatMessage[] {
    return [...(this.messages.get(sessionId) ?? [])];
  }
}
