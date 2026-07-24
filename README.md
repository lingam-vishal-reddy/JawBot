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
| Tools | Executable primitives: `open_shell`, `run_command` (headful) |
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
param: output_dir = out/Default   # context values (with defaults)
param: branch = main

[context]
Free-form plain-text playbook handed to the planner as context.
Everything up to the next [section] is kept verbatim.

[task build]
name: My build
description: what this task does
triggers: build, compile
param: apk_target = my_apk         # task params override skill params

step: Configure
template: gn gen {{output_dir}} --args='target_os="android"'
timeout: 600                       # seconds (or timeoutMs: for milliseconds)

step: Compile
template: autoninja -C {{output_dir}} {{apk_target}}
cwd: /some/dir                     # optional working directory
```

Lines starting with `#` are comments (except inside `[context]`). Steps run
sequentially; the run stops and reports on the first failing step.

#### Templates, params, and command resolution

Step `template:` (alias `command:`) is a **general template** that references
params as `{{param}}` placeholders (e.g. `gn gen {{output_dir}}`).

- With an LLM planner (`openai` / `beta`): the LLM produces the **actual**
  command for each step from the template + the declared `param` context
  (branch, output directory, …) + your triggering message — so "build chromium
  on branch main into out/Release" can change the output dir and branch. The
  LLM decides; nothing is substituted by rule.
- With the heuristic planner (no LLM), or if LLM resolution fails: the
  `{{param}}` placeholders are replaced with their **default** values, so write
  defaults that make the template runnable as-is.

Steps are **not** pre-chained. A task runs as an **adaptive loop**: each step's
command is resolved **after** the previous step finishes, and the previous
steps' commands + exit codes + output are passed to the LLM so it can adapt the
next command to what actually happened. The whole task runs in one persistent
terminal, so `cd`, environment, and generated files carry across steps (e.g.
`gn gen` then `autoninja` find `build.ninja`). When the task ends the terminal
drops into an interactive shell so you can keep working from the final state.

### Headful execution

Everything runs **headful** — commands (both `run_command` and skill task
steps) execute in a **visible terminal** on the Linux desktop (`DISPLAY`, e.g.
via VNC), never headless. This gives interactive prompts such as `sudo` a real
TTY, so a logged-in user can see the work and type a password when asked.
Output is still streamed back to chat/telemetry; step windows stay open so you
can watch progress, and a failing window stays open showing the error.

Details:
- Commands run in an **interactive** shell (`bash -ic`), so your `~/.bashrc`
  is loaded just like a normal terminal.
- One terminal window per task/command (no stray extra window). Each command is
  echoed (you see the command, not just its output).
- A skill task uses **one persistent terminal**, driven command-by-command, so
  shell state carries across steps and you can keep typing in it afterwards.
- On failure the user-facing message is a **concise, LLM-summarized error**
  (not just an exit code); without an LLM it falls back to the last meaningful
  output line.

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

Also: `JAWBOT_PORT`, `DISPLAY`, `JAWBOT_LOG_LEVEL` (`debug|info|warn|error`,
default `info`)

### Logging

The backend logs structured lines to stdout/stderr:

```text
2026-07-24T05:33:28.373Z INFO  [orchestrator] skill trigger {"skill":"echodemo","task":"go"}
```

Scopes include `server`, `http` (one line per request with status + ms),
`orchestrator`, `skill-runner`, `runtime` (terminal + per-command lifecycle),
and `llm:*`. Set `JAWBOT_LOG_LEVEL=debug` for LLM request/response timing.

### Long-running commands

Work runs in the background so the UI returns immediately:

- Skill tasks are already async — triggering one returns an acknowledgement and
  progress is posted to chat (a `✓` line after each step) plus a final summary.
- A chat `run_command` also runs in the background: you get an immediate "On it…"
  ack, and the result is posted to chat when the command finishes.
- Ask "status" any time for the state of skill runs and recent commands.

#### Config / `.env`

On startup JawBot loads a `.env` file (see `.env.example`). It searches
`JAWBOT_ENV_FILE`, the current directory, and the repo root — so it works from
either the repo root or the `packages/server` workspace, in dev (`tsx`) or prod
(`node dist`). Real environment variables always take precedence; `.env` only
fills in what's missing.

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
