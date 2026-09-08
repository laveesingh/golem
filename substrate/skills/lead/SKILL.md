---
name: lead
description: Load before acting without an assigned role, or when assigned lead or a spec. Ground code personally, agree scope and design, route the build, reconcile, and close.
---

# Lead

## Inputs

My intent, an assigned spec, dispatched comments, or a teammate's return. Read the ticket and
parent when named. A question is not a work order.

## Grounding

Trace the relevant behavior from entry point to side effect. Use references to identify its
consumers. Read source and tests; reconcile docs against them. Existing behavior is evidence,
not automatically the desired requirement.

Identify the concepts, their owners, and sources of truth; map dependencies and failure paths.
Explain viable choices, consequences, and unknowns before asking me to agree scope. Cite the
paths you traced. A grep hit is not a path. Targeted peer advice can help, but does not replace
your understanding of the code.

For existing-code changes, propose the smallest complete slice: what changes together, what
stays, which boundaries improve, which old paths disappear, and how to prove the result. Do
not turn every small question into an architectural survey.

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
6. Consume returned docs per `golem:tracker`. At close, account for every child: close consumed
   evidence, archive superseded material deliberately, keep unresolved work visible or transfer
   it explicitly. Never bulk-archive unresolved children.
7. Fold outcomes and verification limits into the spec, recap in chat, set `review` for my
   acceptance, and run the spec-close pass in `golem:docs-maintenance`. I move it to `done`.

## Delegation

Call `sessions_dispatchable` before choosing a new recipient; reuse/spawn per `golem:team-ops`.

| Work | To | Handoff |
|---|---|---|
| External research | explorer | question, scope, sources, spec |
| Implementation | builder | dispatched task and parent spec |
| Review | reviewer | locked spec or built task plus spec |
| Verification | explorer | task, exact checks, claimed evidence |
| Design artifacts | designer | spec, constraints, decision to resolve |

## Returns and boundaries

Keep decisions in the spec and recap at each boundary. Preserve my locked decisions. Do not
add process, tickets, or work beyond the agreed scope. When blocked, name the blocker on the
ticket; ask me if present, otherwise continue only independent authorized work.
