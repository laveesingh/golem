# Golem

Golem is a local-first orchestration layer for agentic coding harnesses. It adds
shared roles, a SQLite-backed tracker and dashboard, session discovery, durable
delivery, lifecycle journals, and evidence-based verification without replacing
the native harness.

The canonical source is [`substrate/`](substrate/). Harness adapters render it
into the native surfaces each harness supports. The dashboard is the tracker’s
single writer; hooks, shims, and MCP tools connect live sessions to it.

## Supported harnesses

| Harness | Current support | Start with |
| --- | --- | --- |
| Claude Code | Tier A development-channel delivery; plain `claude` can pull work only | `golem claude` |
| Pi | Tier A worker with typed delivery; Node.js 22.19+ and Pi 0.85.1 | `golem pi` |
| Gemini CLI | Unsupported; no adapter or release contract is shipped | — |

The built-in roles are `lead`, `builder`, `explorer`, and `reviewer`.

## Requirements

- Golem requires Node.js 22.19 or newer and npm. Pi uses the pinned `@earendil-works/pi-coding-agent` 0.85.1 release.
- Git.
- At least one supported coding harness installed separately.

## Install from a source checkout

The npm package is not the install path. Clone this repository and link its
CLI:

```sh
git clone https://github.com/laveesingh/golem.git
cd golem
npm ci
npm link
golem doctor
golem dashboard
```

Keep `golem dashboard` running. It serves the tracker and dashboard at
<http://dashboard.golem.localhost:7420>. The `*.localhost` name is reserved for
loopback by RFC 6761; no `/etc/hosts` entry is needed. The dashboard has no
authentication, so do not use `golem dashboard --public` on an untrusted network.

Choose a harness in another terminal. Run its sync command after the source
checkout install and before its first launch.

### Claude Code

```sh
golem sync --target cc
golem sync --target cc-marketplace
claude plugin marketplace add ~/.golem/renders/cc-marketplace
claude plugin install golem@golem-workspace --scope user
golem claude
```

`golem claude` supplies Claude Code's development-channel launch. A plain
`claude` session has Golem tools but must pull work. After a render update, run
`claude plugin update golem@golem-workspace` and `/reload-plugins` in existing
sessions.






### Pi

Install the supported Pi release separately, then render and launch a native
Pi session:

```sh
golem sync --target pi
golem pi --provider <provider> --model <model>
```

Use `golem pi --role builder`, `--role explorer`, `--role reviewer`, or
`--role lead` for a validated role preset. Pi keeps its own profile,
providers, authentication, models, extensions, and sessions; Golem does not
copy or rewrite that configuration.

## Work model

The tracker is the source of truth for cross-session work. Ticket lifecycle is
`state` only: `todo`, `in_progress`, `blocked`, `review`, `done`, or `archived`.
Comments and dispatch preserve planned work. On Pi and interactive Claude,
`golem agent list/notify`, `golem message inspect`, and `golem schedule ...`
provide direct coordination and agent-managed follow-up. The event ledger is
audit history, not a message subscription.

Sessions register their project, harness, role, and delivery capability.
Golem runs on Pi and Claude Code only.

For architecture and source ownership, use [`REPO-MAP.md`](REPO-MAP.md) rather
than this README as the repository map.

## Dashboard and CLI

The dashboard serves the ticket board, session roster, chat, dispatch controls,
REST API, and WebSocket updates.

```sh
golem dashboard
golem dashboard:restart
golem status
golem doctor
golem help
```

| Command | Purpose |
| --- | --- |
| `golem dashboard` | Start the dashboard in the foreground. |
| `golem dashboard:restart` | Replace the registered dashboard with a detached instance. |
| `golem status [--json]` | Report dashboard health and its canonical URL. |
| `golem doctor` | Check dependencies, local state, renders, integrations, and dashboard reachability. |
| `golem agent list\|notify ...` | List agents or send an idempotent immediate/delayed/recurring notification. |
| `golem agent role <role\|clear>` | Set or clear an agent's role. Built-ins are `lead`, `builder`, `explorer`, and `reviewer`. |
| `golem message inspect <id>` | Inspect delivery without inferring work completion. |
| `golem schedule list\|inspect\|cancel ...` | Manage follow-up reminders explicitly. |
| `golem migrate-home` | Move legacy local state to `~/.golem`, with a backup and rollback. |

Use `golem sync --check --all` to inspect render drift. Edit `substrate/`, not
the generated `plugin/` tree. The committed `plugin/` tree is the generated CC
round-trip and rollback copy; the live install uses `~/.golem/renders/`.

## Local state and safety

Mutable state normally lives in `~/.golem/`:

- `tracker.db` — tickets, comments, dispatch records, and events.
- `projects.json`, `sessions.json`, and `session-facts.json` — project and live-session registries.
- `journals/<project_id>/hook.jsonl` — lifecycle and tool-event history.
- `renders/` and `substrate.lock` — generated harness output and drift metadata.
- `dashboard.json`, endpoint leases, and harness bridge registries — live routing.

`GOLEM_HOME` overrides the state root. Existing XDG installations can be moved
explicitly with `golem migrate-home`.

Journals and tracker data may contain prompts, model output, tool arguments,
paths, and other sensitive local context. Protect the state directory. Read
[PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) before exposing services
or sharing diagnostics.

## Development

```sh
npm ci
npm test
npm run dashboard:build
npm run check:dashboard
npm run test:release
git diff --check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution rules,
[`REPO-MAP.md`](REPO-MAP.md) for code ownership, and
[`substrate/README.md`](substrate/README.md) for harness render details.

## License

[MIT](LICENSE)
