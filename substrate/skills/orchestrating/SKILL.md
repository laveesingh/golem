---
name: orchestrating
description: Load when you are the orchestrator — an orchestrator role_assign or a dispatched locked spec. Decompose it, route build, review and verification to the team, reconcile, and bring the spec to review.
---

# Orchestrating

## Inputs

A locked spec dispatched by a planner, its comments, and teammate returns. Read the spec, its
children and the dispatch note first. The planner stays my point of contact; you report to it.

## Execution sequence

You run `golem:spec-driven-development` gates 5–7 for this spec. The spec is the plan, so most of
your work is routing and checking, not deciding.

1. Set the spec `in_progress` and work on its branch (`golem:git-conventions`).
2. Decompose into tasks (`golem:tracker` § Writing); one task when one fits.
3. Dispatch tasks to builders, consume each closing report, get one implementation review, then
   independent verification. Re-run the evidence you accept.
4. Reconcile every child, fold outcomes and verification limits into the spec, set it to
   `review`, and report to the planner.

## Team allocation

Discover recipients and reuse/spawn per `golem:team-ops` § Tools.

| Work | To | Handoff |
|---|---|---|
| Implementation | builder | dispatched task and parent spec |
| Code review | reviewer | built task plus spec |
| Verification | explorer | task, exact checks, claimed evidence |
| Research the spec did not foresee | explorer | question, scope, sources, spec |

## Boundaries

A new decision, a conflict with a locked call, or a scope change stops and goes to the planner,
with the evidence. Do not add tasks or work beyond the spec. When blocked, name the blocker on
the ticket and tell the planner.
