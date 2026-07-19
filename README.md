# JawBot

Linux backend for a chat-driven workstation agent.

Clients (e.g. **[Jaws](https://github.com/sunnydie86/Jaws)**) send chat messages. The orchestrator + LLM decides whether to run skills, and replies only when useful. Jobs are internal — clients never create them.

PoC focus: say “open a new shell tab” from Jaws → a visible terminal opens on this Linux desktop.

## HLD

```text
Jaws (chat UI) ──message──► Gateway ──► Orchestrator + LLM
                                             │ may create Jobs
                                             ▼
                                        Skills → Linux Runtime
```

| Piece | Role |
|--------|------|
| Gateway | `POST /sessions`, `POST /sessions/:id/messages`, `WS /ws/chat` |
| Orchestrator + LLM | Plan actions, optional reply |
| Skills | `open_shell`, `run_command` (+ custom later) |
| Runtime | Visible terminal + process execution on Linux |

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

| Mode | Env |
|------|-----|
| Heuristic (default) | `JAWBOT_LLM=heuristic` |
| OpenAI-compatible | `JAWBOT_LLM=openai` + `OPENAI_API_KEY` |

Optional: `OPENAI_MODEL`, `OPENAI_BASE_URL`, `JAWBOT_PORT`, `DISPLAY`

### Frontend

Use **Jaws** against this host:

```bash
VITE_JAWBOT_URL=http://<linux-host>:8787 npm run dev
```

CORS is open for POC.

## Layout

```text
packages/
  shared/   Session, Message, Job (internal) types
  server/   gateway, orchestrator, llm, skills, runtime
```

## Later

Slack channel, custom skills, workflows, auth — same message API.
