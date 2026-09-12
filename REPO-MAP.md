# REPO-MAP.md
> Last verified: 2026-09-12 @ 076e1a8 — maintained via golem:docs-maintenance.

## Directory structure

- `cli/` — CLI entry points and command dispatch.
- `lib/` — shared runtime, roles, compiler, delivery, and harness helpers.
- `substrate/` — instruction, role, skill, hook, and plugin sources.
- `plugin/` — generated CC round-trip/rollback copy; never hand-edit.
- `dashboard/server/` — Fastify API and tracker single writer.
- `dashboard/web/` — UI source; `dashboard/dist/` is its build output.
- `mcp/channel/` — tracker MCP server and REST client.
- `shims/` — Codex hook, OpenCode bridge, Pi extension.

## Key modules & entry points

### CLI and roles

`cli/golem.js` owns launch, worker, dashboard, sync, and diagnostic verbs; `cli/collaboration.js`
owns session discovery, idempotent notify, delivery inspection, and schedule management.
`lib/session-role.js` owns role definitions; retired names are migration input only.

### Instruction ownership

`substrate/skills/lead/` owns orchestration and grounding; `spec-writing/` owns spec
authorship; `tracker/` owns records and templates. `shims/pi/golem.ts`, tool contracts,
and the idea-promotion scaffold are consumers.

### Dashboard

`dashboard/server/index.js` exposes REST/WebSocket routes. `tracker-db.js` owns persistence;
`notification-schedules.js` owns schedule transactions and `notification-schedule-runtime.js`
feeds occurrences into the shared delivery outbox. `comment-dispatch.js` routes feedback.
Agents use API/CLI/MCP, not direct database writes. Ticket `state` is the single lifecycle.

### Compiler and delivery

`lib/compiler/` renders substrate with drift/tamper checks and orphan pruning.
`lib/typed-worker-endpoint.js` owns the shared authenticated Codex/Pi envelope protocol.

## Data flow

Hooks/shims register projects and sessions under `~/.golem/`. The dashboard reads those
registries, owns tracker writes, and dispatches to native channels or typed endpoints.

## Constraints & gotchas

- Project rules come from `AGENTS.md`; `CLAUDE.md` imports it. Shared rules come from
  `substrate/`, not renders. Pi/Claude are current priorities, not the only existing adapters.
- Claude installs from `~/.golem/renders/`. Updating a render does not update an installed
  plugin or reload a running session.
- OpenCode remains checkout-bound through absolute shim/MCP paths.
- Standalone Codex is pull-only; managed `golem codex` is version-gated. Pi's supported
  worker version is 0.85.1 with Node.js 22.19+.
- Mutable runtime state belongs outside the repository. Never commit credentials or journals.

## Common tasks

| Work | Check |
|---|---|
| CLI | `node cli/golem.js help` |
| Instructions/templates | `node test/instruction-workflow.test.mjs` |
| Installed render drift | `golem sync --check --all` |
| Dashboard | `npm run check:dashboard` |
| Collaboration | `npm run test:collaboration` |
| Schedule store/clock | `node test/notification-schedule.test.mjs` |
| Any diff | `git diff --check` |
