import "./env.js";
import { createServer } from "node:http";
import { EventBus } from "./events/bus.js";
import { ChatBus } from "./chat/bus.js";
import { JobStore } from "./jobs/store.js";
import { SessionStore } from "./sessions/store.js";
import { LinuxRuntime } from "./runtime/linux.js";
import { ToolRegistry } from "./tools/registry.js";
import { SkillRegistry } from "./skills/registry.js";
import { loadSkillsFromDir } from "./skills/loader.js";
import { SkillRunStore } from "./skills/runs.js";
import { SkillRunner } from "./skills/runner.js";
import { Orchestrator } from "./orchestrator/index.js";
import { createHttpApp } from "./gateway/http.js";
import { attachChatSocket } from "./gateway/ws.js";
import { createLlmClient } from "./llm/index.js";
import { createLogger } from "./log.js";

const log = createLogger("server");

const PORT = Number(process.env.JAWBOT_PORT ?? 8787);
const HOST = process.env.JAWBOT_HOST ?? "0.0.0.0";

const jobEvents = new EventBus();
const chat = new ChatBus();
const jobs = new JobStore();
const sessions = new SessionStore();
const runtime = new LinuxRuntime(process.env.DISPLAY ?? ":1");
const tools = new ToolRegistry();
const loaded = loadSkillsFromDir();
const skills = new SkillRegistry(loaded.skills);
const skillRuns = new SkillRunStore();
const llm = createLlmClient();
const skillRunner = new SkillRunner(
  runtime,
  skillRuns,
  jobs,
  jobEvents,
  chat,
  sessions,
  llm,
);
const orchestrator = new Orchestrator(
  sessions,
  jobs,
  jobEvents,
  chat,
  tools,
  runtime,
  llm,
  skills,
  skillRuns,
  skillRunner,
);

const app = createHttpApp({
  orchestrator,
  sessions,
  jobs,
  jobEvents,
  tools,
  skills,
  skillRuns,
  skillRunner,
});
const server = createServer(app);
attachChatSocket(server, chat);

server.listen(PORT, HOST, () => {
  log.info(`gateway listening`, {
    http: `http://${HOST}:${PORT}`,
    ws: `ws://${HOST}:${PORT}/ws/chat`,
    display: process.env.DISPLAY ?? ":1",
    llm: process.env.JAWBOT_LLM ?? "heuristic",
    logLevel: process.env.JAWBOT_LOG_LEVEL ?? "info",
  });
  log.info(`tools registered`, { tools: tools.list().map((t) => t.name) });
  log.info(`skills loaded`, {
    dir: loaded.dir,
    skills: skills.list().map((s) => s.id),
  });
  for (const e of loaded.errors) {
    log.warn(`skill load warning`, { file: e.file, error: e.error });
  }
});
