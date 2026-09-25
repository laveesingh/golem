# REPO-MAP.md
> Last verified: 2026-09-25 @ bda674d — maintained via golem:docs-maintenance.

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

`cli/golem.js` dispatches verbs; `cli/agent.js` and `cli/team.js` own managed workers/teams.
`cli/collaboration.js` owns schedules/messages; `cli/ticket.js` authors via tracker REST.
`lib/session-role.js` owns role definitions; retired names are migration input only.

### Instructions

`substrate/skills/`: `spec-driven-development/` (spec method), `lead/`, `spec-writing/`,
`tracker/` (records, templates, ticket CLI), `team-ops/` (teams, agents, reminders).

### Dashboard

`dashboard/server/index.js` owns admin REST/WS; `tracker-db.js` owns SQLite tickets and
share grants. `share-public.js` serves only token documents on a separate loopback listener;
`share-tunnel.js` bounds/verifies cloudflared reuse via `~/.golem/share-tunnel.json` (never :7420).
`html-body.js`/`md-body.js` patch strict anchors via `body-anchor.js`; `mermaid-check.js`
validates diagrams. `notification-schedule*.js` schedules; `comment-dispatch.js` routes feedback.
Agents never touch SQLite directly.

### Compiler and delivery

`lib/compiler/` renders substrate with drift/tamper checks; `lint.js` only reports word count.
`lib/typed-worker-endpoint.js` owns the Pi envelope protocol. `lib/herdr-driver.js` hosts managed
agents (one herdr session per project); `lib/team-registry.js` owns `teams.json`.

## Data flow

Hooks/shims register sessions under `~/.golem/`. The dashboard owns tracker writes and
native/typed dispatch. Sharing issues a per-document grant; only the public listener is tunneled.

## Constraints & gotchas

- Project rules come from `AGENTS.md`; shared rules come from `substrate/`, never renders.
- Claude installs from `~/.golem/renders/`; rendering does not update or reload the plugin.
- Supported Pi worker version is 0.85.1 with Node.js 22.19+.
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
