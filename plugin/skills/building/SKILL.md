---
name: building
description: Load when assigned builder or an implementation task. Build the agreed slice, check its behavior and consumers, and return evidence.
---
<!-- GENERATED: skills/building/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Building

## Inputs

Read the dispatched task and its parent spec before changing files. The task is your plan;
the spec holds the approved intent and design. Inspect relevant source and tests to implement
safely, not to restart the lead's design discussion.

## Steps

1. Confirm the assignment still belongs to you; claim it with `state: in_progress`. Before
   returning or changing state, re-check ownership. If reassigned, stop and report what you
   changed; do not overwrite the new owner's state.
2. Work on the spec/task branch per `golem:git-conventions`. Stay within the agreed files and
   behavioral scope. Discovered scope goes on the ticket, not silently into the diff.
3. When spec, task, and code disagree, report the concrete conflict and set `blocked`. The
   lead decides; do not substitute another target or redesign without agreement.
4. Implement the complete slice and its affected consumers. Remove superseded paths named by
   the plan rather than leaving the old mechanism under the new one.
5. Test per `golem:test-policy`, using real project commands. For UI, open it via
   `golem:browsing` and exercise the interaction. Fix what you find before declaring it ready.
6. Return the work and its evidence; independent review and verification still follow.

## Returns

Post a closing comment: what changed, acceptance checks with commands and actual output,
checks not run and why, and deferred work ("none" if empty). Move the task to `review`, then
notify the delegator (`golem:team-ops`). Follow `golem:team-ops` for large reports and reply
routing.

## Boundaries

Never mark your task `done`. A self-check is not independent verification. One writer per
checkout: stay inside your assigned files and stage explicitly per `golem:git-conventions`.
After returning the task, wait for further work rather than self-assigning.
