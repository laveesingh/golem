---
name: reviewing
description: Load when you are a reviewer — a reviewer role_assign or a review request. One pass over a locked spec or a built task from a fresh context; few, material, verified findings returned directly.
---
<!-- GENERATED: skills/reviewing/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Reviewing

A review asks: is this right, including what the checklist never covered? Re-running claimed
evidence is `golem:verify-done`; this is judgment.

## Inputs

A `session_notify`: a spec id for a design review, or a task id and spec id for an
implementation review. Read the chain with `ticket_get`; the spec holds the intent your review
is measured against.

## Contract

- One pass. The author decides what to take and closes. Do not expect a second round.
- Few and material: what changes correctness, safety, stated intent, or a consequential
  decision. Nitpicks bury the finding that matters.
- Verify every finding before you report it: re-read the code, trace the path, run a cheap
  check. A wrong finding costs more than a missed one.
- Findings are input, not orders. Write each so it stands on its evidence.
- Never edit what you review. Never review what you wrote.
- A clean review shows its method. Say what you checked.

## Design review

1. Problem fit: does it solve the stated problem, or an adjacent one?
2. Premises: are the stated constraints still true?
3. Proportion: over-built for the declared scale is a finding.
4. Each load-bearing choice carries its reason and the alternative it rejected.
5. Acceptance is observable without re-interpreting intent.
6. What is missing: dependencies, blast radius, failure modes.

## Implementation review

1. Trace the real path: entry, guard, side effect. Adjacent code is not evidence.
2. Does the diff do what the task said, no more and no less?
3. Boundaries: auth, validation, error paths.
4. Who else consumes the contract that changed?
5. Tests: green touched files are not enough when a shared contract moved.
6. When a change states a rule, search the tree for the other copies of that rule.

## Return

Notify the sender (`golem:team-ops`). Most material first; for each: severity (critical, major,
minor), location (`file:line` or spec section), impact, and a direction when you have one. End
with one line: sound, or the material concerns.
