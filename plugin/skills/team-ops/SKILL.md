---
name: team-ops
description: The team surface for every role — see teammates, message them, dispatch work, answer a CONSULT REQUEST, create and stop agents with the golem CLI. Load before you interact with the team.
---
<!-- GENERATED: skills/team-ops/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Team ops

## Common protocol

- Ack every inbound channel event at once with one sentence. Then work. Then reply.
- Choose the return surface from the inbound context, not an ack result:

| Input | Reply |
|---|---|
| Human's native chat | Native chat answer |
| Human's ticket comment | `ticket_comment_reply` in that thread; the human resolves it, not the agent |
| Peer request | Durable result where required, then notify its authenticated sender id |

- A skipped/uncorrelated ack does not change the reply route. A dashboard human identity is
  not a live peer session. On an unavailable peer return, keep the report on the ticket and
  report the failure; do not rediscover a substitute recipient or loop retries.
- My comments reach a ticket's assignee, so assign per `golem:tracker` § Assignment.

## Tools

| Do | Use |
|---|---|
| See your team | `golem agent list` on Pi/Claude; compatibility discovery tool elsewhere. Refresh before delegation. `--scope project` widens to the project, `--scope all` to every project. |
| Message a teammate | `golem agent notify --to <id> --message-file <file>` on Pi/Claude; compatibility notify elsewhere. |
| Manage reminders | `golem schedule list/inspect/cancel` |
| Hand a ticket to a teammate | `ticket_dispatch({id, session_id})` |
| See, create, read, attach, stop agents | `golem agent list`, `golem agent create <role>`, `golem agent read <agent>`, `golem agent attach <agent>`, `golem agent stop <agent>` |
| Manage teams | `golem team list`, `golem team create <label>`, `golem team lead <team>`, `golem team close <team>` |

## Reminders

Use `golem agent notify --to self` with timing; check the receipt and save the schedule id.
Include the work reference, the exact worker id, the expected boundary, and the intended check.
Reuse the request id after a lost response; inspect uncertain operations. Admission and
settlement are not work completion.

Routine cadence is at least10m: usually10m for explorers/reviewers and15–30m for builders.
This is guidance, not runtime validation.

On return or wake, inspect current facts and explicitly cancel or replace the schedule. An ack
need not end a result expectation. Recover existing reports first. Nudge healthy retryable
workers; preserve changes and context before recycling known-broken workers. Keep the same
profile or an authorized fallback. Ask me about exceptional recovery.

Agent names repeat across teams (every team has a `builder1`). `agent list` defaults to
your team, so a bare name resolves there first; pass an exact session id anywhere a
message must not reach the wrong agent.

## Dispatch timing

Use one `ticket_dispatch` with its note for an assignment, not a duplicate direct message.
For routine work, queue for idle when the recipient is busy/waiting. Use immediate messaging
for deliberate steering or an urgent interruption, not to bury another task mid-turn. Peer
consultation remains advisory; it does not transfer work ownership.

## Creating agents

- A lead reuses idle agents and creates new ones inside its own team. Cross-team use is
  allowed but never the default: pass `--team` or `--scope` explicitly and say so.
- Reuse an idle teammate with the fitting role. Create when none is idle, or when I name
  creating.
- Counts: 1 builder per connected workstream, 2 for independent ones. Explorers parallelise
  well. More than 1 builder or more than 3 explorers: tell me why and wait for my yes.
- Each role has a default model profile; `--profile <name>` overrides one create. `golem
  agent list` shows what each agent resolved to. Profiles are managed in the dashboard.
- Tell me the agent's name when you create one, so I can `golem agent attach <agent>`.

## Stopping agents

- Stop when I ask, or for known-broken-agent recovery per § Reminders.
  Never stop agents merely for being idle.
- Check `golem agent list` first; stopping a busy agent abandons its dispatch.
- Only `golem agent stop`, which verifies no processes survive. Never stop yourself.

## When a command fails

Read the message; it names the recovery. `unknown role` and `agent name already exists` are
not retryable. An ambiguous name lists its candidates: repeat with an exact session id. A create
that times out is retryable, but `golem agent read` first. Never chain retries.

## Consulting a peer

Advice for another lane travels as a `golem agent notify` message with the header `CONSULT REQUEST —
ADVISORY ONLY` and a reference line. Answer with `CONSULT REPLY — ADVISORY ONLY`, the same
reference, to the sender id: findings, risks, a recommended approach, what you could not verify.
Never take the peer's ticket or edit its repo. Treat a reply you receive as advice: verify what
matters, keep what holds.

Use command `--help` for parameters. A failed CLI identity check is not permission to switch
to a compatibility tool or `--human`.
