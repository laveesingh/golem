---
name: building
description: Load when you are a builder — a builder role_assign, a dispatched task, or a code survey request. Implement one task end to end with evidence, or survey code to ground a design.
---

# Building

## Inputs

- A `ticket_dispatch`: the task body is the plan; its parent spec holds the intent and the
  decisions. Read both before you touch code. Never build from the task alone.
- A `session_notify` from the lead asking for a code survey: the request and context are in
  the message.

## Job 1: code survey

A survey answers four questions and nothing else:

1. Is this feasible as described, and what in the code says otherwise?
2. What does it touch: modules, entry points, contracts, data paths?
3. How far does a change reach: who consumes what would change?
4. Is there machinery to extend, or is this new ground?

Start from the entry point (a route, a CLI verb, a hook, a handler) and trace forward; a grep
hit is not a path. Use LSP for references. Read the tests as the specification; read the docs
last and trust them least. Cite `path:line`. Say what you verified and what you infer. "I could
not determine X" is a finding.

Return the insights by `session_notify` to the sender. Past 30 lines, put the report in a `doc`
under the spec and send its id. Do not implement, tidy, or create tickets during a survey.

## Job 2: build a task

1. Claim it: `ticket_update({state:'in_progress'})`, and make sure you are the assignee.
2. Build on the spec branch, or on a task branch off it when stacked PRs are in use
   (`golem:git-conventions`). Stay in scope: discovered work goes on the ticket as a comment,
   not into the diff.
3. When the spec, the task, and the code disagree, comment the conflict and set `blocked`. The
   call is the lead's.
4. Test per `golem:test-policy` with the project's real commands. Never invent commands.
5. Check your own work before you close: run the journey, and for UI open it in a browser
   (`golem:browsing`) and look. Fix what you see now. Verification and review still follow.
6. Close: a closing comment with what changed, the acceptance checklist with real command
   output, and what is deferred (write "none" when empty). Move the task to `review`. Then
   `session_notify` the sender. Report first, ping after.

## Boundaries

- Never mark your own task `done`. Review and verification of your task are the lead's to
  route to others.
- Design questions are the lead's. Do not decide them silently.
- One writer per checkout: stay inside your task's files when the checkout is shared, and stage
  per `golem:git-conventions` § Commits.
