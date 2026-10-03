# REPO-MAP.md
> Last verified: 2026-10-03 @ 5bb4fe5 — maintained via golem:docs-maintenance.

## Directory structure

- `cli/` — JS bins → native/emitted bootstrap → commands.
- `lib/` — runtime/compiler plus leaf TypeBox `contracts/`.
- `substrate/` — instruction, role, skill, hook, and plugin sources.
- `plugin/` — generated CC rollback copy; never hand-edit.
- `dashboard/` — Fastify tracker/API, web source, and built UI.
- `mcp/channel/` — tracker MCP server and REST client.
- `shims/` — Pi extension.
- `contracts/` — generated pilot schemas + release provenance.
- `tools/`, `test/` — gates/Vitest; `docs/testing-runner.md`.

## Key modules & entry points

### CLI and collaboration

`lib/management-*.js` controls native panes, not process ownership.
`cli/collaboration.js` schedules/messages; `cli/ticket.js` authors tracker.
`lib/session-role.ts`: roles; retired names only migrate.
Config: `lib/golem-config.ts` uses `read-versioned.ts`; hooks use `config-role-default.ts`.

### Instructions

`substrate/skills/`: spec methods, role methods, tracker authoring and team operations.

### Dashboard

`index.js` owns REST/WS; `contract-pilot.ts` owns health/create; `tracker-db.js` owns SQLite.
`share-tunnel.js` owns one cloudflared quick tunnel to the dashboard via
`~/.golem/share-tunnel.json`: Share hands out `/read/<id>` links, Stop kills the tunnel.
`html-body.js`/`md-body.js` patch strict anchors via `body-anchor.js`; `mermaid-check.js`
validates diagrams. `notification-schedule*.js` schedules; `comment-dispatch.js` routes feedback.
Agents never write SQLite directly.

### Compiler and delivery

`lib/compiler/` renders substrate with drift/tamper checks; instruction-size lint is retired.
`lib/typed-worker-endpoint.js` owns Pi envelopes; `lib/herdr-driver.js` native hosting.
`lib/team-registry.js` never treats worker cache as membership authority.
`lib/runtime-compatibility.js` keeps policy warnings separate from native outcomes.

## Data flow

Hooks/shims register sessions under `~/.golem/`. The dashboard owns tracker writes and
native/typed dispatch. Sharing tunnels the dashboard itself; Stop ends every shared link at once.

## Constraints & gotchas

- Project rules come from `AGENTS.md`; shared rules come from `substrate/`, never renders.
- Claude installs from `~/.golem/renders/`; rendering does not update or reload the plugin.
- Pi 0.99.1 / Node 22.19+ baselines; labels warn, never veto delivery.
- Pi and Claude Code are the only harnesses. No test or lint check inspects instruction content.
- Herdr tests must `session stop` before deleting a temp HOME; a deleted socket dir leaks a live server.

## Common tasks

| Work | Check |
|---|---|
| CLI | `node cli/golem.js help` |
| Source check/tests | `npm run check` / `npm test` |
| Installed render drift | `golem sync --check --all` |
| Dashboard | `npm run check:dashboard` |
| Collaboration | `npm run test:collaboration` |
| Any diff | `git diff --check` |
