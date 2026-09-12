# Golem Substrate · Admin Dashboard

Real-time admin UI for the agentic harness. Discovers projects under
`GOLEM_PROJECTS_ROOT`, parses each project's `journal/hook.jsonl` +
`journal/summary.jsonl` + `tracker/<state>/*.md`, and streams updates over
WebSocket.

## Accessing the dashboard

Once the dashboard is running (`golem dashboard` from the repo root, or
`npm run dashboard` from the repo root), the canonical URL is:

**`http://dashboard.golem.localhost:7420`**

You don't need to edit `/etc/hosts` or run any DNS setup. Per [RFC 6761](https://www.rfc-editor.org/rfc/rfc6761), any hostname ending in `.localhost` resolves to `127.0.0.1` on macOS Sonoma+, modern Linux (with systemd-resolved), and Windows 10+. Chrome, Safari, curl, and Node all use the system resolver and pick this up automatically.

If your environment ever fails to resolve `dashboard.golem.localhost` (older OS, a corporate DNS override, etc.), the fallback is a one-line `/etc/hosts` entry:

```
127.0.0.1 dashboard.golem.localhost
```

The port is fixed at 7420 — `golem dashboard` always reuses the same port, even across restarts (see the implementation in `dashboard/server/index.js`). If port 7420 is ever held by something that isn't a previous golem dashboard, the server will print a clear error rather than drift to a different port.

## Quick start

With the new Node CLI installed (`npm link` from the repo root):

```bash
golem dashboard
```

Or manually, from the repo root (deps + lockfile live at the repo root, not
in `dashboard/`):

```bash
npm install
npm run dashboard
```

Open <http://dashboard.golem.localhost:7420> (fallback: <http://127.0.0.1:7420>).

To smoke-check a running instance: `npm run check:dashboard` (from the repo
root) or `golem status`.

## Delivery inspection and recovery

`GET /api/message-envelopes/:id` also exposes ordinary notifications. Use
`?view=receipt` for the compact projection of any envelope; add `&content=1`
only when the message text is needed. Receipts distinguish native input,
Claude channel submission, uncertainty, and turn settlement—not task completion.

Pi persists its admission boundary before native input. After possible input,
restart retains the original attempt and requires recovery rather than replay.
Only a definite pre-input failure releases that reservation. Running workers
must be upgraded/restarted together with the dashboard to acquire this repair;
updating source alone does not.

Cancellation fences unclaimed retries, not input already in flight. A legacy
channel's ambiguous handoff is blocked, never automatically repeated. Blocked
queued tickets retain their envelope/error in `GET /api/dispatch-queue?status=all`
and leave the active FIFO; this neither cancels their task nor claims delivery.

Delayed and recurring notifications use the same durable delivery outbox. The
dashboard clock emits one immutable occurrence at a time; it coalesces missed
cadence boundaries and never interprets replies or ticket state. Use `golem
schedule inspect` and `cancel`; cancellation stops future work but cannot recall
a publication already in flight.

`npm run test:collaboration` covers the delivery and scheduling journeys. Its native matrix
requires the Codex schema recorded in `lib/codex-app-server-contract.js`. To test
with that recorded binary without changing the installed CLI:

```bash
npm exec --yes --package=@openai/codex@0.146.0 -- npm test
```

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `7420` | HTTP/WS port (off Vite's 4173 default by design). Auto-increments by 1 if busy (up to +20). |
| `HOST` | `127.0.0.1` | Listen host. |
| `GOLEM_PROJECTS_ROOT` | `~/Documents/software/experiments/golem/golem-projects` | Where to scan for substrate projects. |
| `GOLEM_AGENT_ACTIVE_MS` | `60000` | An agent is "active" if its last event is fresher than this. |
| `GOLEM_AGENT_IDLE_MS` | `900000` | Beyond this, an agent without an explicit stop is treated as done. |
| `GOLEM_SPAWN_CORR_MS` | `30000` | Window in which a new `session_id` is correlated to a recent `agent-spawn`. |
| `GOLEM_HOOK_CAP` | `500` | Per-agent hook events retained in memory. |
| `GOLEM_JOURNAL_CAP` | `200` | Per-agent journal entries retained. |
| `LOG_LEVEL` | `info` | Fastify pino log level. |

## Architecture

```
golem/dashboard/
├── (deps live in the repo-root package.json — Fastify + ws + chokidar + gray-matter)
├── server/
│   ├── config.js                     # env-driven config
│   ├── index.js                      # Fastify server + REST + WS + static
│   ├── projects.js                   # Discover projects under GOLEM_PROJECTS_ROOT
│   ├── journal.js                    # Tail hook.jsonl + summary.jsonl, build agents
│   ├── tracker.js                    # Read tracker/<state>/*.md tickets (gray-matter)
│   ├── state.js                      # In-memory store, file watcher, event emitter
│   ├── roles.js                      # subagent_type → role glyph/colour map
│   └── util.js                       # JSON parsing, hashing, formatting
└── web/
    ├── index.html                    # Loads React UMD + babel-standalone
    ├── styles.css                    # Verbatim from the design handoff
    ├── extra.css                     # Live-data-only additions
    └── src/
        ├── api.js                    # REST + WS client (plain JS)
        ├── store.js                  # Live store (snapshot + WS deltas)
        ├── format.js                 # fmtRuntime / fmtTimeAgo / fmtClock
        ├── icons.jsx                 # SVG icon set
        ├── atoms.jsx                 # Avatar / StatusPill / Carousel / useStore
        ├── shell.jsx                 # Sidebar + Topbar
        ├── dashboard.jsx             # Dashboard page
        ├── project-view.jsx          # Project view (timeline + kanban)
        ├── drawer.jsx                # Agent drawer (journal + hooks)
        ├── other-pages.jsx           # Projects, Agents, Logs pages
        ├── tweaks.jsx                # Accent-colour FAB + popover
        └── app.jsx                   # Root + routing + hash-based deep links
```

## Data model

An **agent** in this dashboard = one `session_id` observed in
`journal/hook.jsonl`. The server correlates a newly-appearing `session_id`
to the most recent `agent-spawn` event from any parent session within
`GOLEM_SPAWN_CORR_MS` to attach a `subagent_type`/`name`/`team_name`. A
session that is never claimed remains anonymous (rendered with a dashed
avatar) — typically the orchestrator/main thread.

Status is heuristic:

- `running` — has at least one `tool-pre` without a matching `tool-post`, AND last activity within `GOLEM_AGENT_ACTIVE_MS`.
- `active` — recent activity within `GOLEM_AGENT_ACTIVE_MS` (or `GOLEM_AGENT_IDLE_MS` and no stop event).
- `done` — saw `subagent-stop` / `session-end`, or hasn't been heard from past the idle timeout. Sessions that only show up in `summary.jsonl` are also `done` (terminal records).

Tickets come from `tracker/<state>/*.md`. The `column` is the directory the
file lives in. Priority is read from the `priority` frontmatter key, else
from `labels` (`P0..P3`, `blocking`/`critical` → P0), else from `effort`
(`large` → P1, `medium` → P2, `small` → P3). `assignee` is taken verbatim
from frontmatter when present (currently no substrate persona writes that
field, so most tickets render as `Unassigned`).

## Live updates

`chokidar` watches each project's `hook.jsonl`, `summary.jsonl`, and
`tracker/` directory. On change, the server tail-reads only the appended
bytes (tracking byte offsets) and re-emits coarse `agents-update` /
`tickets-update` deltas over the WebSocket. Clients also receive a full
`snapshot` on connect and after `projects-list` discoveries.

## REST endpoints

```
GET /api/health                              → { ok, projects_root, project_count }
GET /api/meta                                → { roles, columns, config }
GET /api/snapshot                            → { projects, agents, tickets } (everything)
GET /api/projects                            → ProjectSummary[]
GET /api/projects/:id                        → ProjectSummary
GET /api/projects/:id/agents                 → Agent[]
GET /api/projects/:id/agents/:agentId        → AgentDetail (journal + hooks)
GET /api/projects/:id/tickets                → Ticket[]
```

## WebSocket protocol

Connect to `ws://<host>:<port>/ws`. The server sends:

```jsonc
// On connect:
{ "type": "snapshot",       "payload": {projects,agents,tickets}, "ts": 1234 }

// On change:
{ "type": "agents-update",  "projectId": "factscroll", "agents": [...] }
{ "type": "tickets-update", "projectId": "factscroll", "tickets": [...] }
{ "type": "project-update", "project": {id,name,glyph,...} }
{ "type": "projects-list",  "projects": [...] }       // re-discovery
{ "type": "agent-detail",   "projectId": "...", "agent": {...} }  // on subscribe
{ "type": "pong",           "ts": 1234 }
```

The client may send:

```jsonc
{ "type": "ping" }
{ "type": "subscribe-agent", "projectId": "factscroll", "agentId": "factscroll:..." }
```

## Notes

- Frontend uses **babel-standalone** in the browser to transform JSX at load
  time. Pragmatic for an internal tool — no bundler in the chain. Swap to
  Vite later if the file count grows.
- The agent-correlation heuristic (linking spawn events to spawned session
  ids by temporal proximity) is best-effort. Multi-spawn within
  `GOLEM_SPAWN_CORR_MS` is matched in FIFO order. A more reliable mapping
  would require Claude Code to expose a parent→child session id field on
  spawn events.
- The dashboard is read-only by design; it never writes to a project's tree.
