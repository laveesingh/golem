<!-- GENERATED: README.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Golem harness substrate

This directory is the canonical source for Golem's harness artifacts. The
compiler renders it into Claude Code, Codex, OpenCode, and Pi surfaces. Edit
`substrate/`; do not hand-edit the generated `plugin/` tree.

For the complete source-checkout install, start with the root
[`README.md`](../README.md). The short path is:

```bash
npm ci
npm link
golem doctor
golem dashboard
```

The root install script also restores the channel server's production
dependencies. Keep the dashboard running before using tracker tools or dispatch.

## Current harnesses and roles

- **Claude Code** — `golem claude` launches native Claude Code with the
  development channel. A plain `claude` session can pull tracker work but does
  not receive channel pushes.
- **Codex** — `golem sync --target codex` renders the ordinary pull-only
  plugin. `golem codex` launches the version-gated managed private bridge.
- **OpenCode** — opt-in through `~/.golem/config.json`; its MCP server and
  runtime shim point to this checkout by absolute path.
- **Pi** — `golem sync --target pi` renders the native extension. `golem pi`
  provides typed-worker delivery and requires Pi 0.84.3 with Node.js 22.19+
  or newer.

The built-in roles are `lead`, `builder`, `explorer`, and `reviewer`. Role
cards live in `roles/`; shared operational instructions live in
`instructions/AGENTS.md`.

## Claude Code installation

The live Claude Code install comes from the workspace render, not directly from
this checkout:

```bash
golem sync --target cc
golem sync --target cc-marketplace
claude plugin marketplace add ~/.golem/renders/cc-marketplace
claude plugin install golem@golem-workspace --scope user
golem claude
```

The marketplace render points at `~/.golem/renders/cc-plugin/`. The compiler
copies the channel server's locked production dependencies into that render, so
the installed plugin does not depend on the source checkout at runtime.

After changing `substrate/`, re-render and update the installed plugin:

```bash
golem sync --target cc
golem sync --target cc-marketplace
claude plugin update golem@golem-workspace
```

Running sessions need `/reload-plugins`. The render version comes from the root
`package.json`; changing plugin behavior therefore requires the normal project
release/version process. Do not update `plugin/` by hand.

If the workspace render is broken, the committed `plugin/` directory is the
rollback copy. After `npm link`, it is also available through the linked source
package:

```bash
claude plugin marketplace add "$(npm root -g)/@laveesingh/golem"
claude plugin install golem@golem-local --scope user
```

Tracker tools use the live dashboard URL from `~/.golem/dashboard.json`; start
it with `golem dashboard` before calling them.

## Channel delivery

A `golem claude` launch selects the development channel for push delivery. The
raw equivalent is:

```bash
claude --dangerously-load-development-channels plugin:golem@golem-workspace
```

The launch flag is required for a Claude session to consume pushes. The
channel server exposes `ack`, tracker tools, `session_notify`, and
`sessions_dispatchable`. The dashboard remains the tracker database's single
writer. Ticket lifecycle is the `state` field: `todo`, `in_progress`,
`blocked`, `review`, `done`, or `archived`.

Coordination is durable tracker work plus exact-session notifications. The
retired stream and subscription surfaces are not part of the current MCP
contract.

## OpenCode checkout binding

OpenCode is not a portable copy of this plugin. When enabled,
`golem sync --target opencode` renders skills and merges these checkout-backed
entries into `~/.config/opencode/opencode.jsonc`:

- `mcp.golem` runs `mcp/channel/index.js` from this checkout.
- `plugin[]` loads `shims/opencode/index.js` through an absolute `file://` URL.
- `skills.paths` points at the Golem render under `~/.golem/renders/opencode/`.

Keep this checkout in place. If it moves, run the sync command again to refresh
the absolute paths. See [`docs/opencode.md`](../docs/opencode.md) for the
runtime bridge and project-scoped render contract.

## File map

```text
substrate/
  instructions/AGENTS.md  # universal instructions rendered per harness
  roles/                  # lead, builder, explorer, reviewer cards
  skills/                 # progressive operational skills
  hooks/                  # registration, journaling, notifications, context
  mcp.json                # Claude plugin MCP wiring
  plugin-meta.json        # Claude plugin metadata source
  README.md              # this source/render document

mcp/channel/              # tracker MCP server and HTTP client source
shims/opencode/           # OpenCode lifecycle and delivery bridge
shims/codex/              # Codex lifecycle hook
shims/pi/                 # Pi extension source
```

`~/.golem/` owns mutable runtime state: tracker database, projects and session
registries, journals, generated renders, endpoint leases, logs, and bridge
records. It is outside the repository and must not be committed.

## Source and render checks

Useful checks from the repository root are:

```bash
golem sync --check --all
golem sync --target cc --out ./plugin --check
npm run dashboard:build
npm run check:dashboard
```

The first command checks installed global renders and known project renders. The
second checks the committed CC round-trip without writing global state. The
source checkout is the authority; a generated render is an output to inspect,
not an authoring location.
