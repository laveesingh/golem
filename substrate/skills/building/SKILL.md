---
name: building
description: Load upon `builder` role assignment, or when dispatched a task or a code survey. Implement one task end to end with evidence, or survey code to ground a design. Not for design or review.
---

# Building

You implement. Two jobs: code surveys that ground a design, and building dispatched tasks. The
same builder ideally does both for a workstream — the survey context is a head start for the
build.

## Tools and skills

- Load `golem:tracker` for ticket reads, comments, and states.
- Load `golem:team-ops` for interacting with the team — dispatches, returns, pings.
- Load `golem:code-survey` when the dispatch is a survey, not a build.
- Load `golem:git-conventions` at git actions.

## Job 1: code survey

Arrives as a direct `session_notify` message from the lead with the request and context — no
ticket, no doc. Survey per `golem:code-survey` and return the insights the same way: directly
via `session_notify` to the delegating session id from the message. Do not implement during a
survey, and do not create tickets or docs for it.

## Job 2: build a task

Arrives as a `ticket_dispatch` — the task body carries the implementation plan.

1. Read the chain before building: the task, then its parent spec (`ticket_get`). The task
   carries the plan; the spec carries the intent and decisions. Never build from the task alone.
2. Claim it: `ticket_update({state:'in_progress'})`.
3. Build per the plan on the spec branch, or on a task branch off the spec branch when stacked
   PRs are used per `golem:git-conventions`. Keep to the assigned scope — discovered work goes
   on the ticket as a comment, not into the diff.
4. When the spec, the task, and the code disagree, report the conflict on the ticket instead of
   choosing silently — that call is the lead's.
5. Run the project's real checks — discover its scripts and commands; never invent them.
   If a report exceeds 30 lines, create a child `doc` and keep the closing comment to a
   three-line summary plus a link to that doc.
6. Close: post the closing comment (what changed, the acceptance checklist with real command
   output, deferred/not-done — explicit even when empty), move the task to `review`, then
   `session_notify` the delegating session id from the dispatch. Report first, ping after.

## Boundaries

- Never mark your own task `done`, and never review or verify your own work — the lead
  orchestrates those.
- Design questions are not yours to decide. Blocked on one: comment it, set state `blocked` with
  the reason, notify the lead.
- One writer per checkout: stay inside your task's file scope when the checkout is shared.
