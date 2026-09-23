# golem CLI

Minimal Node CLI for the golem v4 harness. (The v3 bash CLI was retired in v4.)

## Install

From the repo root:

```bash
npm link        # makes `golem` available globally
# or, without installing:
npx golem <command>
```

## Surviving commands

| Command | What it does |
| --- | --- |
| `golem claude|cc [--backend native|ollama] [--model <id>] [-- <claude args...>]` | Launch Claude Code with Golem's channel; optionally use Ollama and select its model. |
| `golem dashboard [--public]` | Start the admin dashboard on `http://dashboard.golem.localhost:7420`. Pass extra args through to `npm start`. |
| `golem doctor` | Sanity-check the environment. |
| `golem status [--json]` | Probe the dashboard `/api/health` endpoint and print the canonical URL. |
| `golem agent list [--scope team\|project\|all] [--json]` | List agents: id, name, role, team, host, status, herdr state, model, delivery. |
| `golem agent create <role> [--team <team>] [--json]` | Start a managed agent in the caller's team (`--team` picks another). |
| `golem agent read <agent> [--lines N]` | Print an agent's terminal output. |
| `golem agent attach <agent>` | Attach to an agent's terminal. |
| `golem agent stop <agent> [--json]` | End an agent; the record stays, marked ended. |
| `golem agent notify --to <id\|self> --message-file <path\|-> [--request-id <uuid>] [--json]` | Send an idempotent notification; `--message` accepts direct text instead. |
| `golem agent role <role\|clear> [<agent>] [--json]` | Set or clear an agent's role. |
| `golem agent dedup [--apply]` | Dry-run named-session duplicate cleanup. |
| `golem message inspect <id> [--content] [--json]` | Inspect delivery, not task completion; content is opt-in. |
| `golem schedule list [--all] [--json]` | List your durable notification schedules. |
| `golem schedule inspect <id> [--content] [--json]` | Inspect cadence and current occurrence delivery. |
| `golem schedule cancel <id> [--human] [--json]` | Stop future emission; it cannot recall an in-flight occurrence or cancel a task. |
| `golem help` | Show usage. |

## Notification workflow

Run `golem agent notify --help` for the input and exit contracts. File `-` reads
stdin. Unbound human mutations require `--human`; a bound agent cannot use it to
bypass broken identity. Pi uses live native ancestry/leases; Claude uses its
logical/resumed native record, including `CLAUDE_CONFIG_DIR`.

Add `--after 15m` for one delayed notification or `--every 15m` for recurrence;
with both, `--after` controls the first occurrence. Durations require integer
`ms`, `s`, `m`, `h`, or `d`; `0s` is allowed for the first delay. Runtime timing
is tick/readiness based, not an exact-time alarm. Routine reminder cadence lives
in the lead workflow, not a CLI minimum.

Save the message or schedule ID. After a lost response, inspect it or retry the **same**
request ID and content/timing. A fresh ID means a new message. Exit0 means durable
admission, never job completion; exit3 means uncertainty. The CLI checks server
idempotency support before sending, so an older dashboard cannot silently ignore
the request ID. Existing notify tools remain compatible during the staged cutover.

## Removed v3 commands

The old `spawn`, `list`, `peek`, `attach`, `kill`, `role`, `sessions dedup` and `session list/notify` verbs are replaced by `golem agent ...` above.
`install`, `cleanup`, `reinstall`, `project`, `dispatch`, `ack` are retired with v4. The new harness uses native Claude Code sessions and a central SQLite tracker in the dashboard; there is no CEO, no Substrator, and no symlinked agents/skills/commands.
