# REPO-MAP.md
> Last verified: 2026-09-30 @ c445f19 — maintained via golem:docs-maintenance.

## Directory structure

- `cli/` — CLI entry points and command dispatch.
- `lib/` — shared runtime, compiler, delivery, and harness helpers.
- `substrate/` — instruction, role, skill, hook, and plugin sources.
- `plugin/` — generated CC rollback copy; never hand-edit.
- `dashboard/` — Fastify tracker/API, web source, and built UI.
- `mcp/channel/` — tracker MCP server and REST client.
- `shims/` — Pi extension.

## Key modules & entry points

### CLI and collaboration

Management: `lib/management-{context,resolve,registry,session,team,agent,capabilities}.js`.
Acceptance: `test/management-real-journey.test.mjs` (explicit actual-app opt-in),
`test/_interactive-attach.py` (owned client PTY), and `test/session-native.test.mjs`
(real cold legacy CLI import plus container lifecycle). Native reporting stays
Herdr-owned; Pi application PID/birth lives in its typed lease, not an MCP sidecar.
Processes: `lib/worker-control.js` + `lib/process-group.js`.
`cli/collaboration.js` schedules/messages; `cli/ticket.js` tracker authoring.
`lib/session-role.js` defines roles; retired names only migrate.

### Instructions

`substrate/skills/`: `spec-driven-development/` (spec method), `lead/`, `spec-writing/`,
`tracker/` (records, templates, ticket CLI), `team-ops/` (teams, agents, reminders).

### Dashboard

`dashboard/server/index.js` owns admin REST/WS; `tracker-db.js` owns SQLite tickets.
`share-tunnel.js` owns one Golem-owned cloudflared quick tunnel to the dashboard via
`~/.golem/share-tunnel.json`: Share hands out `/read/<id>` links, Stop kills the tunnel.
`html-body.js`/`md-body.js` patch strict anchors via `body-anchor.js`; `mermaid-check.js`
validates diagrams. `notification-schedule*.js` schedules; `comment-dispatch.js` routes feedback.
Agents never touch SQLite directly.

### Compiler and delivery

`lib/compiler/` renders substrate with drift/tamper checks; `lint.js` only reports word count.
`lib/typed-worker-endpoint.js` owns Pi envelopes; `lib/herdr-driver.js` native hosting.
`lib/team-registry.js` never treats worker cache as membership authority.
`lib/runtime-compatibility.js` separates policy warnings from initialization/native outcomes.

## Data flow

Hooks/shims register sessions under `~/.golem/`. The dashboard owns tracker writes and
native/typed dispatch. Sharing tunnels the dashboard itself; Stop ends every shared link at once.

## Constraints & gotchas

- Project rules come from `AGENTS.md`; shared rules come from `substrate/`, never renders.
- Claude installs from `~/.golem/renders/`; rendering does not update or reload the plugin.
- Pi 0.99.1 / Node.js 22.19+ are tested baselines; version/provider labels warn, not veto delivery.
- Pi and Claude Code are the only harnesses. No test or lint check inspects instruction content.
- Herdr tests must `session stop` before deleting a temp HOME; a deleted socket dir leaks a live server.

## Common tasks

| Work | Check |
|---|---|
| CLI | `node cli/golem.js help` |
| Instructions/templates | `node test/instruction-workflow.test.mjs` |
| Installed render drift | `golem sync --check --all` |
| Dashboard | `npm run check:dashboard` |
| Collaboration | `npm run test:collaboration` |
| Any diff | `git diff --check` |
