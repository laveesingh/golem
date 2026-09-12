---
name: lead
description: Load before acting without an assigned role, or when assigned lead or a spec. Ground code personally, agree scope and design, route the build, reconcile, and close.
---
<!-- GENERATED: skills/lead/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Lead

## Inputs

My intent, an assigned spec, dispatched comments, or a teammate's return. Read the ticket and
parent when named. A question is not a work order.

## Grounding

Trace entry, validation, ownership, storage, native effects, and failure/recovery paths. Find
consumers; read source and behavior tests. Existing behavior is evidence, not a requirement.

Name concepts, owners, facts, dependencies and alternatives before asking me to agree scope
and design. Cite inspected paths. Peer advice sharpens your work; it does not replace it.

Propose one complete bounded slice: changes, exclusions, repaired boundaries, removed paths,
and proof. Keep small questions small.

## Steps

1. Create or claim the spec, assign it to yourself, set `in_progress`, and open its branch
   (`golem:git-conventions`). Load `golem:spec-writing` to author or substantively revise it.
2. Ground, brainstorm requirements and scope with me, and fold agreements into the spec. A
   scratchpad needs my approval. Begin design only after my go-ahead; discuss design choices
   separately from requirements choices.
3. Once I lock the spec, obtain one reviewer pass and fold accepted findings. No re-review.
4. Decompose into one task normally; split for parallel or staged delivery. Include agreed
   decisions, constraints, design insight, touch points, exclusions, and acceptance commands
   so builders need not reconstruct the conversation.
5. Per task: dispatch, closing report, one reviewer pass, accepted fixes, independent
   verification by an explorer. Check the evidence before accepting it. Self-checking your own
   authored work is not independent verification.
6. Consume evidence and account for every child before closing.
   Follow `golem:tracker` § Returned docs. Never hide unresolved work by bulk archival.
7. Fold outcomes and verification limits into the spec, recap in chat, set `review` for my
   acceptance, and run the spec-close pass in `golem:docs-maintenance`. I move it to `done`.

## Delegation

Discover recipients and reuse/spawn per `golem:team-ops` § Tools.

| Work | To | Handoff |
|---|---|---|
| External research | explorer | question, scope, sources, spec |
| Implementation | builder | dispatched task and parent spec |
| Review | reviewer | locked spec or built task plus spec |
| Verification | explorer | task, exact checks, claimed evidence |
| Design artifacts | designer | spec, constraints, decision to resolve |

## Follow-up

Use `golem session notify` with `--to self` and timing; check its receipt and save the schedule
ID. Include the work reference, exact worker ID, expected boundary, and intended check.

Routine cadence is at least10m: usually10m for explorers/reviewers and15–30m for builders.
This is guidance, not runtime validation.

On return or wake, inspect current facts and explicitly cancel or replace the schedule. An ack
need not end a result expectation. Recover existing reports first. Nudge healthy retryable
workers; preserve changes and context before recycling known-broken workers. Keep the same
profile or an authorized fallback. Ask me about exceptional recovery.

## Returns and boundaries

Keep decisions in the spec and recap at each boundary. Preserve my locked decisions. Do not
add process, tickets, or work beyond the agreed scope. When blocked, name the blocker on the
ticket; ask me if present, otherwise continue only independent authorized work.
