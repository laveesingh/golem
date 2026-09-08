---
name: team-ops
description: The team surface for every role — see teammates, message them, dispatch work, answer a CONSULT REQUEST, spawn and retire workers with the golem CLI. Load before you interact with the team.
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
| Peer request | Durable result where required, then `session_notify` to its authenticated sender id |

- A skipped/uncorrelated ack does not change the reply route. A dashboard human identity is
  not a live peer session. On an unavailable peer return, keep the report on the ticket and
  report the failure; do not rediscover a substitute recipient or loop retries.
- A report over 30 lines goes into a child `doc`; the comment or message carries a three-line
  summary and the id.
- My comments reach a ticket's assignee, so assign per `golem:tracker` § Assignment.

## Tools

| Do | Use |
|---|---|
| See the team: roles, status, workload | `sessions_dispatchable`, called right before every delegation, never from memory |
| Message a teammate | `session_notify` |
| Hand a ticket to a teammate | `ticket_dispatch({id, session_id})` |
| See, add, watch, retire managed workers | `golem list`, `golem spawn <role>`, `golem peek <name>`, `golem attach <name>`, `golem kill <name>`, always with `--project .` |

Worker names repeat across projects (every project has a `builder1`). That is why
`--project .` is not optional.

## Dispatch timing

Use one `ticket_dispatch` with its note for an assignment, not another copy via `session_notify`.
For routine work, queue for idle when the recipient is busy/waiting. Use immediate messaging
for deliberate steering or an urgent interruption, not to bury another task mid-turn. Peer
consultation remains advisory; it does not transfer work ownership.

## Spawning

- Reuse an idle teammate with the fitting role. Spawn when none is idle, or when I name
  spawning.
- Counts: 1 builder per connected workstream, 2 for independent ones. Explorers parallelise
  well. More than 1 builder or more than 3 explorers: tell me why and wait for my yes.
- Each role has a default model profile; `--profile <name>` overrides one spawn. `golem list
  --project .` shows what each worker resolved to. Profiles are managed in the dashboard.
- Tell me the worker's name when you spawn one, so I can `golem attach <name> --project .`.

## Retiring

- Retire only when I say so; surface candidates instead. Nothing reaps idle workers.
- Check `golem list --project .` first; killing a busy worker abandons its dispatch.
- Only `golem kill`; raw tmux leaves orphans. Never kill yourself.

## When a command fails

Read the message; it names the recovery. `unknown role` and `worker name already exists` are
not retryable. An ambiguous name wants `--project`. A spawn that times out is retryable, but
`golem peek` first. Never chain retries.

## Consulting a peer

Advice for another lane travels as a `session_notify` with the header `CONSULT REQUEST —
ADVISORY ONLY` and a reference line. Answer with `CONSULT REPLY — ADVISORY ONLY`, the same
reference, to the sender id: findings, risks, a recommended approach, what you could not verify.
Never take the peer's ticket or edit its repo. Treat a reply you receive as advice: verify what
matters, keep what holds.

## For me

Workers run on a tmux server per project, `golem-<project id>`, prefix `C-g`. `golem attach
--project .` with no name opens the whole swarm.
