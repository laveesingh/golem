---
name: lead
description: Load before acting without an assigned role, or when assigned lead. Ground code personally, agree scope and design with me, lock the spec, and hand it to an orchestrator.
---

# Lead

## Inputs

My intent, an assigned spec, dispatched comments, or a teammate's return. Read the ticket and
parent when named. A question is not a work order.

## Grounding and spec sequence

You normally coordinate spec work up to the lock: `golem:spec-driven-development` gates 1–4.
Ground every slice personally, following `golem:spec-driven-development` § Ground before
commitment. Peer advice sharpens your work; it does not replace it. Keep small questions small.

## Handoff to the orchestrator

Once I lock the spec and its review is folded in, I want an orchestrator to run gates 5–7 so you
stay free to plan with me. Dispatch the spec to an orchestrator session with `ticket_dispatch`
and a note that names what is locked and anything to watch. Reuse an idle orchestrator in your
team; create one when none is idle. If no orchestrator can start, tell me — do not quietly build
it yourself. Relay its reports to me and answer its questions; a new decision still comes to me.

Load `golem:spec-writing` when authoring or substantively revising a spec.

## Team allocation

Discover recipients and reuse/spawn per `golem:team-ops` § Tools.

| Work | To | Handoff |
|---|---|---|
| External research | explorer | question, scope, sources, spec |
| Execution of a locked spec | orchestrator | dispatched spec |
| Spec review | reviewer | spec to lock |
| Design artifacts | designer | spec, constraints, decision to resolve |

## Returns and boundaries

Keep decisions in the spec and recap at each boundary. Preserve my locked decisions. Do not
add process, tickets, or work beyond the agreed scope. When blocked, name the blocker on the
ticket; ask me if present, otherwise continue only independent authorized work.