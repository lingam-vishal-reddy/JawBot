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
  console.log(`[jawbot] gateway listening on http://${HOST}:${PORT}`);
  console.log(`[jawbot] chat ws://localhost:${PORT}/ws/chat`);
  console.log(`[jawbot] DISPLAY=${process.env.DISPLAY ?? ":1"}`);
  console.log(`[jawbot] LLM=${process.env.JAWBOT_LLM ?? "heuristic"}`);
  console.log(
    `[jawbot] tools: ${tools.list().map((t) => t.name).join(", ")}`,
  );
  const skillIds = skills.list().map((s) => s.id);
  console.log(
    `[jawbot] skills (${loaded.dir}): ${
      skillIds.length ? skillIds.join(", ") : "none"
    }`,
  );
  for (const e of loaded.errors) {
    console.warn(`[jawbot] skill load warning (${e.file}): ${e.error}`);
  }
});
