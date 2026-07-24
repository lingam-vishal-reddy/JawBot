import express from "express";
import cors from "cors";
import type { CreateSessionRequest, PostMessageRequest } from "@jawbot/shared";
import type { Orchestrator } from "../orchestrator/index.js";
import type { SessionStore } from "../sessions/store.js";
import type { JobStore } from "../jobs/store.js";
import type { EventBus } from "../events/bus.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { SkillRunStore } from "../skills/runs.js";
import type { SkillRunner } from "../skills/runner.js";
import { createLogger } from "../log.js";

const log = createLogger("http");

export function createHttpApp(deps: {
  orchestrator: Orchestrator;
  sessions: SessionStore;
  jobs: JobStore;
  jobEvents: EventBus;
  tools: ToolRegistry;
  skills: SkillRegistry;
  skillRuns: SkillRunStore;
  skillRunner: SkillRunner;
}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  // Request logging.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const line = {
        status: res.statusCode,
        ms: Date.now() - start,
      };
      if (res.statusCode >= 500) {
        log.error(`${req.method} ${req.path}`, line);
      } else if (res.statusCode >= 400) {
        log.warn(`${req.method} ${req.path}`, line);
      } else {
        log.info(`${req.method} ${req.path}`, line);
      }
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "jawbot",
      version: "0.1.0",
      llm: process.env.JAWBOT_LLM ?? "heuristic",
    });
  });

  // Low-level machine primitives the orchestrator can invoke.
  app.get("/tools", (_req, res) => {
    res.json({ tools: deps.tools.list() });
  });

  // Plain-text playbooks the user can teach/trigger.
  app.get("/skills", (_req, res) => {
    res.json({ skills: deps.skills.list() });
  });

  app.get("/skills/runs", (req, res) => {
    const sessionId =
      typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    const runs = sessionId
      ? deps.skillRuns.listForSession(sessionId)
      : deps.skillRuns.list();
    res.json({ runs });
  });

  app.get("/skills/runs/:runId", (req, res) => {
    const run = deps.skillRuns.get(req.params.runId);
    if (!run) {
      res.status(404).json({ error: "skill run not found" });
      return;
    }
    res.json({ run });
  });

  // Trigger a skill task directly (chat is the primary path; this is for APIs).
  app.post("/skills/:id/tasks/:taskId/trigger", (req, res) => {
    const skill = deps.skills.get(req.params.id);
    if (!skill) {
      res.status(404).json({ error: "skill not found" });
      return;
    }
    const task = skill.tasks.find((t) => t.id === req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    const sessionId = (req.body ?? {}).sessionId as string | undefined;
    if (!sessionId || !deps.sessions.get(sessionId)) {
      res.status(400).json({ error: "valid sessionId is required" });
      return;
    }
    const run = deps.skillRunner.start(sessionId, skill, task);
    res.status(202).json({ run });
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
