# REPO-MAP.md
> Last verified: 2026-09-08 @ 850218d — maintained via golem:docs-maintenance.

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

`cli/golem.js` owns launch, worker, dashboard, sync, and diagnostic verbs.
`lib/session-role.js` owns role definitions; retired names are migration input only.

### Instruction ownership

`substrate/skills/lead/` owns orchestration and local code grounding;
`spec-writing/` owns spec authorship; `tracker/` owns record operations and the lean
spec/task/doc templates. Embedded prompts in `shims/pi/golem.ts`, tool contracts in
`lib/golem-tool-contracts.js`, and the server's idea-promotion scaffold are consumers too.

### Dashboard

`dashboard/server/index.js` exposes REST/WebSocket routes, including native-session
`terminal` and `message` routes for peek and steering. `tracker-db.js` owns persistence;
`comment-dispatch.js` routes comment feedback. Agents use API/MCP, not direct database writes.
Ticket `state` is the single lifecycle.

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
  worker version is 0.84.3 with Node.js 22.19+.
- Mutable runtime state belongs outside the repository. Never commit credentials or journals.

## Common tasks

| Work | Check |
|---|---|
| CLI | `node cli/golem.js help` |
| Instructions/templates | `node test/instruction-workflow.test.mjs` |
| Installed render drift | `golem sync --check --all` |
| Dashboard | `npm run check:dashboard` |
| Harness delivery | `node test/cross-harness-matrix.test.mjs` |
| Any diff | `git diff --check` |
