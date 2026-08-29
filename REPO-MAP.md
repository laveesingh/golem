# REPO-MAP.md
> Last verified: 2026-08-27 @ a18bb6c — maintained via golem:docs-maintenance.

## Directory structure

- `cli/` — the `golem` entry point and command dispatch.
- `lib/` — shared runtime, role, compiler, delivery, and harness helpers.
- `substrate/` — canonical instructions, roles, skills, hooks, and Claude plugin sources.
- `plugin/` — generated CC round-trip and rollback copy; never hand-edit it.
- `dashboard/server/` — Fastify API and tracker single writer.
- `dashboard/web/` — dashboard UI; output is `dashboard/dist/`.
- `mcp/channel/` — tracker MCP server and dashboard REST client.
- `shims/` — Codex hook, OpenCode bridge, and Pi extension.

## Key modules and entry points

### `cli/golem.js`
- Implements `dashboard`, `doctor`, `status`, `sync`, `role`, harness launchers,
  worker commands, and home migration.

### `lib/session-role.js`
- Source of built-in roles: `lead`, `builder`, `explorer`, `reviewer`.
- Retired names are migration input only; they are not current role choices.

### `dashboard/server/`
- `index.js` exposes REST/WebSocket routes, including `/api/native-sessions/:sessionId/terminal` for live worker scrollback and `/api/native-sessions/:sessionId/message` for mid-turn steer/brief dispatch.
- `tracker-db.js` owns persistence; `comment-dispatch.js` owns comment dispatch.
  Agents use API/MCP, never direct database writes.
- Ticket lifecycle is the `state` field: `todo`, `in_progress`, `blocked`,
  `review`, `done`, or `archived`.

### `lib/compiler/`
- Renders `substrate/` into harness outputs with lockfiles, drift checks,
  tamper detection, and orphan pruning.

### `lib/typed-worker-endpoint.js`
- Shared authenticated envelope protocol for typed Codex and Pi delivery.

## Data flow

Hooks and shims register projects and sessions under `~/.golem/`. The dashboard
reads those registries, owns tracker writes, and routes validated dispatch to a
native channel or typed endpoint.

## Constraints and gotchas

- `AGENTS.md` is the project instruction source; `CLAUDE.md` imports it. Edit
  canonical sources, not compatibility or generated copies.
- `substrate/` is authoritative; renders are install output. Claude uses
  `~/.golem/renders/`; committed `plugin/` is rollback.
- OpenCode is bound to this checkout: its config contains absolute paths to the
  MCP server and `shims/opencode/index.js`.
- Separately launched Codex is pull-only. `golem codex` is the managed private
  bridge and is version-gated. Pi is a typed Tier-A worker and requires Node.js
  22.19+ with Pi 0.84.3.
- Mutable state belongs outside the repository under `~/.golem/`; do not commit
  journals, tracker databases, credentials, or generated runtime state.

## Common tasks

| Task | Files | Verify with |
|------|-------|-------------|
| CLI or runtime | `cli/`, `lib/` | `node cli/golem.js help` |
| Substrate/render | `substrate/`, `lib/compiler/` | `golem sync --check --all` |
| Dashboard | `dashboard/server/`, `dashboard/web/` | `npm run check:dashboard` |
| Harness delivery | `mcp/channel/`, `shims/`, `lib/typed-worker-endpoint.js` | `node test/cross-harness-matrix.test.mjs` |
| Any change | affected files | `git diff --check` |
