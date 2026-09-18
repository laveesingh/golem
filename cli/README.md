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
| `golem session list [--project <id-or-path>] [--all] [--json]` | Discover live canonical sessions and delivery readiness. |
| `golem session notify --to <id\|self> --message-file <path\|-> [--request-id <uuid>] [--json]` | Send an idempotent notification; `--message` accepts direct text instead. |
| `golem message inspect <id> [--content] [--json]` | Inspect delivery, not task completion; content is opt-in. |
| `golem schedule list [--all] [--json]` | List your durable notification schedules. |
| `golem schedule inspect <id> [--content] [--json]` | Inspect cadence and current occurrence delivery. |
| `golem schedule cancel <id> [--human] [--json]` | Stop future emission; it cannot recall an in-flight occurrence or cancel a task. |
| `golem help` | Show usage. |

## Notification workflow

Run `golem session notify --help` for the input and exit contracts. File `-` reads
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

The old `session` operations are replaced by `session list/notify` above.
`install`, `cleanup`, `reinstall`, `project`, `dispatch`, `ack` are retired with v4. The new harness uses native Claude Code sessions and a central SQLite tracker in the dashboard; there is no CEO, no Substrator, and no symlinked agents/skills/commands.
