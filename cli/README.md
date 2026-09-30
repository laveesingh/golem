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
| `golem context [--project P] [--team T] [--session S] [--caller ID] [--json]` | Inspect read-only selected scope, provenance, candidates and unavailable evidence. |
| `golem agent list [--scope team\|project\|all] [--json]` | List agents: id, name, role, team, host, status, herdr state, model, delivery. JSON rows are in `.items`. |
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

## Management scope and JSON

Agent, team and session management share `--project`, `--team`, `--session`
and `--caller` selectors where applicable. Exact target IDs establish their
parents before caller or cwd inference. Explicit parent selectors constrain the
target; conflicting parents return exit2 with candidates and a corrected command.
`--caller` selects context or `self`, not authentication.

A registered caller's canonical logical team wins over its physical pane.
A human shell can infer a team from its actual inherited herdr pane/workspace;
UI focus is never evidence. Cwd supplies a project only, even with one team.
An explicit team never falls back to another team for a missing name. An inferred
team prefers that team, then permits a unique match in the selected project.

`golem context` is read-only. Applicable mutations and attach accept `--dry-run`:
they return an operation plan, required capabilities and resolution diagnostics
without migration, registry writes, native creation or UI effects. Exit2 means
missing/conflicting scope; a resolved dry-run is not completed execution.

`agent list`, `team list` and `session list --json` have one schema-v2 receipt:
`{schema_version:2,items:[...],resolution:{...}}`, including empty/global results.
Row fields and text tables remain unchanged. Scripts migrate bare-array operations
to `.items`; provenance is query-level, never duplicated on rows. REST roster
arrays and MCP readers keep their existing contracts. Object receipts add
`resolution`; attach sends native terminal output to stderr in JSON mode.

```sh
golem agent list --scope all --json | jq '.items[] | .session_id'
golem team list --scope all --json | jq '.items[] | .team_id'
golem session list --json | jq '.items[] | .name'
golem context --project <project-id> --json
golem agent create builder --team <team-id> --dry-run --json
```

## Physical session controls

`session start [name] --project P` starts the stable owned container or allocates
an opaque handle. Existing unowned containers require `session adopt <name>
--project P`. `session inspect [name]` reads associations, import/provisioning
facts and native state without starting anything. Unknown native evidence stays
unknown, not empty.

`session stop <name>` retains native registration, project mapping and logical
team definitions/memberships; it does not promise conversation resumption.
`session close <name>` stops/deletes the physical container, including contained
external panes, and closes definitions only after confirmed outcomes. Self-close
requires `--force`. Partial results return exit1 with target outcomes and operation
IDs; retry resumes instead of guessing resources or duplicating completed work.
All mutations and attach support `--dry-run`; positional name and `--session`
must agree. Stable association tombstones make repeated close a no-op.

## Runtime compatibility

Pi 0.99.1 and Node.js 22.19+ are the tested baseline. `golem pi` warns on
other versions, then attempts the normal launch. Missing executables/renders,
process failures, invalid arguments and actual protocol errors still fail.
Warnings go to stderr, not machine-readable stdout.

Claude provider configuration is advisory. An initialized native channel can
attempt delivery with Bedrock, Vertex, Foundry or a custom API endpoint; actual
native rejection remains a failure. Legacy provider labels do not prove MCP
initialization. Old channel processes may still refuse until restarted.

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

Schedule occurrence receipts expose `compatibility_warnings` separately from
delivery state. Warnings are not native receipt, consumption or work completion.
Cancelled, ended and historical blocked schedules are not automatically revived
by a compatibility-policy update.

## Removed v3 commands

The old `spawn`, `list`, `peek`, `attach`, `kill`, `role`, `sessions dedup` and `session list/notify` verbs are replaced by `golem agent ...` above.
`install`, `cleanup`, `reinstall`, `project`, `dispatch`, `ack` are retired with v4. The new harness uses native Claude Code sessions and a central SQLite tracker in the dashboard; there is no CEO, no Substrator, and no symlinked agents/skills/commands.
