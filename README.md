# JawBot

Chat-driven Linux agent. You talk in natural language; the **orchestrator** (LLM) decides whether any machine work is needed, runs skills only when useful, and replies in chat only when there is something worth saying.

This is **not** a build-notification bus. Job telemetry exists internally; the user-facing product is a conversation.

## HLD

```text
┌─────────────┐  message          ┌──────────┐  plan        ┌─────────────┐
│  Chat UI    │ ───────────────►  │ Gateway  │ ───────────► │ Orchestrator│
│ (channel)   │ ◄── assistant ──  │ HTTP/WS  │ ◄── reply ── │ + LLM       │
└─────────────┘     messages      └──────────┘              └──────┬──────┘
                                                                   │ may create
                                                                   ▼
                                                            ┌─────────────┐
                                                            │   Skills    │
                                                            │ open_shell  │
                                                            │ run_command │
                                                            └──────┬──────┘
                                                                   ▼
                                                            ┌─────────────┐
                                                            │Linux Runtime│
                                                            └─────────────┘
```

| Concept | Role |
|---------|------|
| **Message** | What the user (and later Slack) sends. Primary API. |
| **Orchestrator + LLM** | Interprets the turn; may plan zero or more actions; decides whether to speak. |
| **Job** | Internal execution of a skill. Created by the orchestrator — **never** by the client. |
| **Chat reply** | LLM-authored (or phrased) text. Omitted when silence is enough. |
| **Job events** | Internal (`/jobs/:id`). Not streamed into the chat UI. |

### Turn lifecycle

1. User sends a chat message  
2. Planner LLM chooses actions (or none) + whether a reply is needed  
3. Skills run as Jobs if planned  
4. Optional phrasing pass turns results into one assistant message  
5. UI shows chat bubbles only — not job logs

## Quick start

```bash
npm install
npm run build -w @jawbot/shared
npm run dev:server   # :8787
npm run dev:ui       # :5173
```

Open the UI and say: `Open a new shell tab`

### LLM mode

| Mode | Env | Behavior |
|------|-----|----------|
| Heuristic (default) | `JAWBOT_LLM=heuristic` | Local rules for POC without an API key |
| OpenAI-compatible | `JAWBOT_LLM=openai` + `OPENAI_API_KEY` | Real planner/phrasing (`OPENAI_MODEL`, `OPENAI_BASE_URL` optional) |

```bash
JAWBOT_LLM=openai OPENAI_API_KEY=sk-... npm run dev:server
```

### API (chat)

```bash
# create session
curl -s -X POST localhost:8787/sessions -H 'content-type: application/json' -d '{}'

# talk
curl -s -X POST localhost:8787/sessions/<id>/messages \
  -H 'content-type: application/json' \
  -d '{"content":"Open a new shell tab"}'
```

WebSocket: `ws://localhost:8787/ws/chat` → `{type:"subscribe", sessionId}` → `{type:"message", message}`

## Layout

```text
packages/
  shared/     Message, Session, Job (internal), skill names
  server/
    gateway/       chat HTTP + WS
    orchestrator/  message → plan → optional jobs → optional reply
    llm/           heuristic | openai planner
    skills/        open_shell, run_command
    runtime/       Linux desktop + processes
    sessions/      chat history
    jobs/          internal job store
    events/        internal job event bus
    chat/          chat message bus
  ui/         chatbot test channel
```

## Later (not in this milestone)

- Slack as another channel adapter on the same session/message API  
- Custom skills registered into the registry  
- Workflows as multi-step plans inside the orchestrator  
- Auth / security
