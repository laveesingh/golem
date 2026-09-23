# REPO-MAP.md
> Last verified: 2026-09-23 @ MERGE (GOL-365, GOL-369) — maintained via golem:docs-maintenance.

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

`cli/golem.js` owns launch, worker, dashboard, sync, and diagnostic verbs.
`cli/collaboration.js` owns session discovery, notify, inspection, and schedules.
`cli/ticket.js` owns flat `golem ticket` authoring over tracker REST.
`lib/session-role.js` owns role definitions; retired names are migration input only.

### Instructions

`substrate/skills/spec-driven-development/` owns the reusable spec method. `lead/` owns
orchestration and grounding; `spec-writing/` authors specs; `tracker/` owns records, templates,
and ticket CLI guidance; `team-ops/` owns team operations and reminders.

### Dashboard

`dashboard/server/index.js` exposes REST/WebSocket routes. `tracker-db.js` owns persistence;
`html-body.js` (stable block ids) and `md-body.js` (id-less blocks) patch via strict anchors
(`body-anchor.js`); `mermaid-check.js` reports broken diagrams after commit, 2s bound.
`notification-schedules.js` and `notification-schedule-runtime.js` own durable schedules;
`comment-dispatch.js` routes feedback. Agents never touch SQLite directly. `body_revision`
gates body writes.

### Compiler and delivery

`lib/compiler/` renders substrate with drift/tamper checks and orphan pruning; `lint.js` only
reports the total word count. `lib/typed-worker-endpoint.js` owns the authenticated Pi envelope
protocol. `lib/dashboard-process.js` owns dashboard stop/start for one checkout.

## Data flow

Hooks/shims register projects and sessions under `~/.golem/`. The dashboard reads those
registries, owns tracker writes, and dispatches to native channels or typed endpoints.

## Constraints & gotchas

- Project rules come from `AGENTS.md`; shared rules come from `substrate/`, never renders.
- Claude installs from `~/.golem/renders/`; rendering does not update or reload the plugin.
- Supported Pi worker version is 0.85.1 with Node.js 22.19+.
- Runtime state, credentials, and journals stay outside the repository.
- Pi and Claude Code are the only harnesses. No test or lint check inspects instruction content.
- `dashboard/scripts/smoke-settings.mjs` writes the real `~/.claude` and renders; run it deliberately.

## Common tasks

| Work | Check |
|---|---|
| CLI | `node cli/golem.js help` |
| Instructions/templates | `node test/instruction-workflow.test.mjs` |
| Installed render drift | `golem sync --check --all` |
| Dashboard | `npm run check:dashboard` |
| Collaboration | `npm run test:collaboration` |
| Any diff | `git diff --check` |
