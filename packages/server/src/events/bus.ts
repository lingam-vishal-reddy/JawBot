import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { JobEvent, JobEventType } from "@jawbot/shared";

type Listener = (event: JobEvent) => void;

/**
 * In-process event bus. Swap for Redis/NATS later without changing publishers.
 */
export class EventBus {
  private readonly ee = new EventEmitter();
  private readonly history: JobEvent[] = [];
  private readonly maxHistory: number;

  constructor(maxHistory = 1000) {
    this.maxHistory = maxHistory;
    this.ee.setMaxListeners(100);
  }

  emit(
    jobId: string,
    sessionId: string,
    type: JobEventType,
    data?: Record<string, unknown>,
  ): JobEvent {
    const event: JobEvent = {
      id: randomUUID(),
      jobId,
      sessionId,
      type,
      ts: new Date().toISOString(),
      data,
    };
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
    this.ee.emit("event", event);
    this.ee.emit(`job:${jobId}`, event);
    this.ee.emit(`session:${sessionId}`, event);
    return event;
  }

  onAll(listener: Listener): () => void {
    this.ee.on("event", listener);
    return () => this.ee.off("event", listener);
  }

  onJob(jobId: string, listener: Listener): () => void {
    const key = `job:${jobId}`;
    this.ee.on(key, listener);
    return () => this.ee.off(key, listener);
  }

  recent(limit = 100): JobEvent[] {
    return this.history.slice(-limit);
  }

  forJob(jobId: string): JobEvent[] {
    return this.history.filter((e) => e.jobId === jobId);
  }
}
