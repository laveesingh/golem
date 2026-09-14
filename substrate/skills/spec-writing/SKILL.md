---
name: spec-writing
description: Load when writing or substantively revising a spec, including folding human feedback into requirements or design. Shape a readable living agreement, not tracker operations or implementation.
---

# Spec writing

## Start from the current question

Use `golem:tracker` for storage, comments, and lifecycle; `golem:spec-driven-development` owns
the work sequence. The template at `../tracker/templates/spec.md` is a starting shape, not a
required final outline.

Begin with the purpose, current stage, and what I must decide next. Classify the reader before
you write: my reading path carries purpose, current reality, implications, and the next
decision; agent-facing material may be denser. Ground explanations in source and evidence, but
keep detailed evidence behind a collapsed block or supporting doc. Explain choices and
consequences where I need them, not in a detached research dump. Preserve raw intent verbatim
when included; label excerpts as excerpts.

## Evolve the agreement

1. While scoping, describe the problem, grounded constraints, alternatives, desired behavior,
   and exclusions. Label proposed requirements as proposed. Do not fill future sections just
   because the template contains them.
2. Turn accepted choices into requirements and scope. Start design only after my go-ahead.
   An explicit request to draft design is that go-ahead: read and fold the current agreement
   first, then proceed. Ask for missing requirements, not redundant permission. Explain how the
   agreed result works and surface design choices without silently reopening requirements.
3. For existing-code work, include concepts and owners, dependency/failure paths, affected
   consumers, desired boundaries, obsolete paths to remove, and transition needs where they
   change the decision. Scale detail to the slice.
4. Keep acceptance observable: the action, expected outcome, and how it will be checked. Name
   preserved behavior, intentional changes, failures, and affected consumers. Distinguish a
   proposed check from evidence already run. Tasks receive exact implementation commands.

## Decisions stay discoverable

Distinguish **scope/requirements** decisions from **design** decisions. Give each a stable label
within the document. A compact index near the top names open choices and points to their detail;
it is not a second decision record.

For an open decision, explain context, options, trade-offs, and your recommendation. For an
agreed decision, retain the call, reason, rejected alternative, and source of agreement in a
collapsed block near the relevant discussion. Keep each explanation once. Fold the call into
affected requirements or design; do not leave the agreement only in comments.

Only I can reopen a locked decision. If new evidence conflicts with it, explain the impact and
ask rather than silently revising the call.

## Keep the document usable

Omit empty or irrelevant blocks; adapt heading order to the discussion. Prefer a small table
for comparisons and diagrams for relationships the prose cannot explain clearly. No diagram
or subsection quotas. Give each diagram one concern and a caption.

Follow `golem:tracker` § Body format. Those constraints apply to every doc kind.

Read the current body and comments before revising. Preserve unrelated content, agreement
history, and comment context. Current tools replace whole bodies; do not invent block-edit
operations. After a substantive update, make the current stage and next decision clear again.
