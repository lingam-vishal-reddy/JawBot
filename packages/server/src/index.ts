import { createServer } from "node:http";
import { EventBus } from "./events/bus.js";
import { ChatBus } from "./chat/bus.js";
import { JobStore } from "./jobs/store.js";
import { SessionStore } from "./sessions/store.js";
import { LinuxRuntime } from "./runtime/linux.js";
import { SkillRegistry } from "./skills/registry.js";
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
const skills = new SkillRegistry();
const llm = createLlmClient();
const orchestrator = new Orchestrator(
  sessions,
  jobs,
  jobEvents,
  chat,
  skills,
  runtime,
  llm,
);

const app = createHttpApp({
  orchestrator,
  sessions,
  jobs,
  jobEvents,
  skills,
});
const server = createServer(app);
attachChatSocket(server, chat);

server.listen(PORT, HOST, () => {
  console.log(`[jawbot] gateway listening on http://${HOST}:${PORT}`);
  console.log(`[jawbot] chat ws://localhost:${PORT}/ws/chat`);
  console.log(`[jawbot] DISPLAY=${process.env.DISPLAY ?? ":1"}`);
  console.log(`[jawbot] LLM=${process.env.JAWBOT_LLM ?? "heuristic"}`);
  console.log(
    `[jawbot] skills: ${skills.list().map((s) => s.name).join(", ")}`,
  );
});
