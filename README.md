# JawBot

Linux backend for a chat-driven workstation agent.

Clients (e.g. **[Jaws](https://github.com/sunnydie86/Jaws)**) send chat messages. The orchestrator + LLM decides whether to run skills, and replies only when useful. Jobs are internal — clients never create them.

PoC focus: say “open a new shell tab” from Jaws → a visible terminal opens on this Linux desktop.

## HLD

```text
Jaws (chat UI) ──message──► Gateway ──► Orchestrator + LLM
                                             │ may create Jobs
                                             ▼
                                   Skills ─► Tools → Linux Runtime
```

| Piece | Role |
|--------|------|
| Gateway | `POST /sessions`, `POST /sessions/:id/messages`, `WS /ws/chat` |
| Orchestrator + LLM | Plan actions, optional reply |
| Tools | Executable primitives: `open_shell`, `run_command` |
| Skills | Plain-text playbooks the user supplies (e.g. `chromium-android`) that drive tools |
| Runtime | Visible terminal + process execution on Linux |

### Tools vs Skills

- **Tools** are code — the low-level machine primitives the orchestrator invokes
  (`open_shell`, `run_command`). Clients never pick them; the planner does.
- **Skills** are *context in plain language* — a playbook that teaches JawBot how
  to accomplish something, plus optional runnable **tasks**. Tasks execute as a
  sequence of steps (ultimately via `run_command`) and are tracked so you can get
  status updates.

Built-in example skill: **`chromium-android`** — set up and build Chromium for
Android. Trigger it from chat and poll progress:

```bash
# trigger
curl -s -X POST localhost:8787/sessions/<id>/messages \
  -H 'content-type: application/json' -d '{"content":"set up chromium for android"}'
curl -s -X POST localhost:8787/sessions/<id>/messages \
  -H 'content-type: application/json' -d '{"content":"build chromium"}'
# status
curl -s -X POST localhost:8787/sessions/<id>/messages \
  -H 'content-type: application/json' -d '{"content":"status"}'
```

Skill endpoints:

| Endpoint | Purpose |
|----------|---------|
| `GET /tools` | List executable tools |
| `GET /skills` | List skills + their tasks |
| `GET /skills/runs[?sessionId=]` | List skill task runs (status) |
| `GET /skills/runs/:runId` | One run's step-by-step status |
| `POST /skills/:id/tasks/:taskId/trigger` | Trigger a task (`{sessionId}`) |

## Quick start

```bash
npm install
npm run dev          # http://0.0.0.0:8787
```

```bash
curl -s -X POST localhost:8787/sessions -H 'content-type: application/json' -d '{}'
curl -s -X POST localhost:8787/sessions/<id>/messages \
  -H 'content-type: application/json' \
  -d '{"content":"Open a new shell tab"}'
```

### LLM

The planner client is chosen at runtime via `JAWBOT_LLM`:

| Mode | Env |
|------|-----|
| Heuristic (default) | `JAWBOT_LLM=heuristic` |
| OpenAI-compatible | `JAWBOT_LLM=openai` + `OPENAI_API_KEY` |
| Beta (OpenAPI-like) | `JAWBOT_LLM=beta` + `BETA_OPENAPI_TOKEN` + `BETA_GENERATIVE_AI_CLIENT` |

- OpenAI optional: `OPENAI_MODEL`, `OPENAI_BASE_URL`
- Beta is an **independent** client (separate from the OpenAI one). It
  authenticates with two headers — `x-openapi-token` and
  `x-generative-ai-client` — and its endpoint is `BETA_BASE_URL` + `BETA_PATH`
  (both configurable). Optional: `BETA_MODEL`, `BETA_BASE_URL`,
  `BETA_PATH` (default `/chat/completions`).

Also: `JAWBOT_PORT`, `DISPLAY`

### Frontend

Use **Jaws** against this host:

```bash
VITE_JAWBOT_URL=http://<linux-host>:8787 npm run dev
```

CORS is open for POC.

## Layout

```text
packages/
  shared/   Session, Message, Job, Skill (types)
  server/   gateway, orchestrator, llm, tools, skills, runtime
```

## Later

Slack channel, user-authored skills at runtime, workflows, auth — same message API.
