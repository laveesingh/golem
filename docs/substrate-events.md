# Substrate Events And Active Messaging

Golem keeps two durable records:

- Central hook journals at `~/.golem/journals/<project_id>/hook.jsonl` for local history.
- The dashboard tracker ledger in `~/.golem/tracker.db` for ticket, lifecycle, activity, custom, and
  spec-tree audit rows plus UI refresh.

Hooks remain fail-open. `substrate/hooks/journal-route.sh` writes the journal line first, then
best-effort forwards to `POST /api/bus/ingest`; if the dashboard is down, the event is spooled
locally under `~/.golem/spool/`.

## Event classes and topics

The ledger stores a global sequence id and class metadata:

| Class | Sources | Use |
|-------|---------|-----|
| `tracker` | ticket/comment/dispatch/phase mutations | durable work history |
| `lifecycle` | session start/end, prompts, stop, compaction, notifications | session telemetry |
| `custom` | unrecognized hook events | extension history |
| `activity` | tool and agent lifecycle hooks | operational diagnostics |

Tracker events default to `ticket/<display_id>`. Child ticket events mirror onto
`spec/<parent-display-id>/tree`. These topics are audit/UI partitions, not subscriptions and do
not wake a model.

## Ingest contract

`POST /api/bus/ingest` accepts one event or a batch. Recognized fields include `uuid`/`event_uuid`,
`event`, `type`, `session_id`, `project_id`, `cwd`, and arbitrary payload data. Source UUIDs are
idempotency keys; duplicates are skipped. `GET /api/bus/stats` reports row counts and oldest
sequence; `POST /api/bus/prune` applies retention policy.

## Active handoffs

Cross-session coordination uses ordinary notification envelopes. Pi and interactive Claude agents
use `golem session list/notify` and exact immutable session IDs; compatibility tools remain for
other harnesses. Labels and names are display data, not routing keys. Claude background sessions do
not consume development-channel messages and are rejected before notification admission.

For delegated work, write the durable report/comment first, then notify the authenticated delegator
with the report location, outcome, and next action. The dispatch envelope carries the sender id so
a renamed lead remains the correct return target. Large reports stay in the tracker.

User-facing answers are delivered via the harness's native chat response — no tool is used.
Delegated returns and consultation replies use the supported notify surface with the authenticated
exact session id.

Delayed and recurring notifications add one `notification_schedules` row and emit immutable ordinary
envelopes through the same retry/outbox path. Schedule state controls timing only; it never classifies
results, changes tickets, or retargets a worker. Cancellation fences future emission and safe retries,
but cannot recall an owned or accepted occurrence.

Consultation uses the same path: `CONSULT REQUEST — ADVISORY ONLY`, `CONSULT REPLY — ADVISORY ONLY`,
or `CONSULT STATUS — ADVISORY ONLY`, each carrying a unique reference and sent to the exact
authenticated sender id. No dedicated consult route/tool, subscription, digest, passive table, or
next-turn hook exists.

## Harness normalization

Claude Code hooks and the Pi extension normalize into the same script stdin shape: `session_id`,
`cwd`, `harness`, optional tool fields, and raw payload. Adapters record documented hook
fields through the canonical locked session-fact writer. `SubagentStop`
records the child observation without changing the parent session status. Adapters remain
non-blocking and fail-open.

Pi typed delivery uses the extension-owned canonical actor binding. GOL-124
factors its loopback transport and lifecycle into `lib/typed-worker-endpoint.js`: each lease
authenticates the canonical session and owner token, advertises a protocol version and readiness,
bounds envelope bytes, and rejects stale owners and duplicate work. Dashboard records `claimed →
accepted → settled|interrupted|recovery_required`; only pre-acceptance failure is replayable.

Acceptance retains the original retry plus its exact queue and comment owners. The adapter records
terminal state and reports it through the authenticated lifecycle callback before those owners are
settled. Ticket rows and retries use one total per-session order; a duplicate terminal retry that
only settles bookkeeping consumes neither a native opportunity nor the cooldown. Passive cursors,
subscriptions, and next-turn digests are retired and are not reintroduced by this lifecycle.

Claude Code and Pi retain the active-message contract.
