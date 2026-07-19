import express from "express";
import cors from "cors";
import type { CreateSessionRequest, PostMessageRequest } from "@jawbot/shared";
import type { Orchestrator } from "../orchestrator/index.js";
import type { SessionStore } from "../sessions/store.js";
import type { JobStore } from "../jobs/store.js";
import type { EventBus } from "../events/bus.js";
import type { SkillRegistry } from "../skills/registry.js";

export function createHttpApp(deps: {
  orchestrator: Orchestrator;
  sessions: SessionStore;
  jobs: JobStore;
  jobEvents: EventBus;
  skills: SkillRegistry;
}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "jawbot",
      version: "0.1.0",
      llm: process.env.JAWBOT_LLM ?? "heuristic",
    });
  });

  app.get("/skills", (_req, res) => {
    res.json({ skills: deps.skills.list() });
  });

  app.post("/sessions", (req, res) => {
    const body = (req.body ?? {}) as CreateSessionRequest;
    const session = deps.orchestrator.createSession(body.channel ?? "web_ui");
    res.status(201).json({ session });
  });

  app.get("/sessions/:id/messages", (req, res) => {
    const session = deps.sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    res.json({
      session,
      messages: deps.sessions.listMessages(session.id),
    });
  });

  app.post("/sessions/:id/messages", async (req, res) => {
    try {
      const body = (req.body ?? {}) as PostMessageRequest;
      const result = await deps.orchestrator.handleUserMessage(
        req.params.id,
        body.content ?? "",
      );
      res.status(201).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === "session not found" ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  // Debug / internal — not the chat UX
  app.get("/jobs", (_req, res) => {
    res.json({ jobs: deps.jobs.list() });
  });

  app.get("/jobs/:id", (req, res) => {
    const job = deps.jobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    res.json({
      job,
      events: deps.jobEvents.forJob(job.id),
    });
  });

  return app;
}
