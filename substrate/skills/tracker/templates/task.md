# Task: <one-line result>

## Goal

The observable result when this is done, in one or two sentences. Point at the parent spec for
intent — do not restate it.

Implements <GOL-XXX>: D<n>, D<n>.

## Context

What the builder needs and cannot see: the decisions this implements, design-lab or scratchpad
insight, gotchas. Name the contracts and consumers the change touches, the behavior that must
be preserved, and what transitions or removals the slice carries. Verify from source; comment
when a note is stale.

## Plan

Ordered, concrete steps, enough to start without re-deriving the design. Show dependencies and
how a step handles failure or removal, not only the happy path.

1. <step>
2. <step>

## Acceptance

Exact setup, commands, and expected observations: preserved and changed behavior, failures,
negative cases, and affected consumers. Report each check as ran (with output) or not run
(why, and who owns the next action). State cleanup and how the result is returned as evidence.

- [ ] `<command>` → <expected observation>

## Out of scope

Explicit, even when "nothing". Discovered scope goes on the ticket as a comment, not into the
diff.