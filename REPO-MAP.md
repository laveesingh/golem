# REPO-MAP.md
> Last verified: 2026-09-23 @ af90a61 (GOL-363/365/369) — maintained via golem:docs-maintenance.

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

`cli/golem.js` owns launch, agent/team, dashboard, sync, and diagnostic verbs.
`cli/agent.js` owns the agent toolkit (list, create, read, attach, stop, notify,
role, dedup); `cli/team.js` owns team create, list, lead, and close.
`cli/collaboration.js` owns inspection, schedules, and messages.
`cli/ticket.js` owns flat `golem ticket` authoring over tracker REST.
`lib/session-role.js` owns role definitions; retired names are migration input only.

### Instructions

`substrate/skills/`: `spec-driven-development/` (spec method), `lead/`, `spec-writing/`,
`tracker/` (records, templates, ticket CLI), `team-ops/` (teams, agents, reminders).

### Dashboard

`dashboard/server/index.js` exposes REST/WebSocket routes. `tracker-db.js` owns persistence;
`html-body.js` (stable block ids) and `md-body.js` (id-less blocks) patch via strict anchors
(`body-anchor.js`); `mermaid-check.js` reports broken diagrams after commit, 2s bound.
`notification-schedule*.js` own durable schedules; `comment-dispatch.js` routes feedback.
Agents never touch SQLite directly.

### Compiler and delivery

`lib/compiler/` renders substrate with drift/tamper checks; `lint.js` only reports word count.
`lib/typed-worker-endpoint.js` owns the Pi envelope protocol. `lib/herdr-driver.js` hosts managed
agents (one herdr session per project); `lib/team-registry.js` owns `teams.json`.

## Data flow

Hooks/shims register projects and sessions under `~/.golem/`. The dashboard reads those
registries, owns tracker writes, and dispatches to native channels or typed endpoints.

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
