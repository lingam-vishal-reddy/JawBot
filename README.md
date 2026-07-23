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

Skills are **plain-text `.txt` files** in the `skills/` folder — drop a file in
the prescribed format (below) and it is loaded automatically at startup (set
`JAWBOT_SKILLS_DIR` to use a different folder). Shipped example:
`skills/chromium-android.txt` — set up and build Chromium for Android. Trigger
it from chat and poll progress:

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

### Skill file format

Each skill is one `.txt` file in `skills/`. Header key/value lines describe the
skill, a `[context]` block holds the free-form playbook, and each `[task <id>]`
block lists steps. A match needs a **skill trigger and a task trigger** in the
message (e.g. "build chromium").

```text
id: my-skill                      # optional; defaults to the file name
name: My Skill
description: one-line summary
triggers: foo, foo thing          # comma-separated

[context]
Free-form plain-text playbook handed to the planner as context.
Everything up to the next [section] is kept verbatim.

[task setup]
name: My setup
description: what this task does
triggers: setup, set up, install

step: First step name
command: echo "runs on the Linux runtime via run_command"
timeout: 600                      # seconds (or timeoutMs: for milliseconds)

step: Second step
command: make -j
cwd: /some/dir                    # optional working directory
```

Lines starting with `#` are comments (except inside `[context]`). Steps run
sequentially; the run stops and reports on the first failing step.

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
- Beta is an **independent** client with its own wire protocol (not
  OpenAI-shaped). It authenticates with two headers — `x-openapi-token` and
  `x-generative-ai-client` — and its endpoint is `BETA_BASE_URL` + `BETA_PATH`
  (both configurable). Optional: `BETA_MODEL`, `BETA_BASE_URL`,
  `BETA_PATH` (default `/generate`).

  Request/response schema:

  ```text
  Request  { modelIds: string[], contents: string[], systemPrompt: string, isStream: boolean }
  Response { content: string }
  ```

  `modelIds` carries the single configurable `BETA_MODEL`, `contents` is the
  conversation as plain strings, and `content` is the returned text.

Also: `JAWBOT_PORT`, `DISPLAY`

### Frontend

Use **Jaws** against this host:

```bash
VITE_JAWBOT_URL=http://<linux-host>:8787 npm run dev
```

CORS is open for POC.

## Layout

```text
skills/     User-authored skill playbooks (*.txt), loaded at startup
packages/
  shared/   Session, Message, Job, Skill (types)
  server/   gateway, orchestrator, llm, tools, skills (loader/registry/runner), runtime
```

## Later

Slack channel, hot-reload of skill files, workflows, auth — same message API.
