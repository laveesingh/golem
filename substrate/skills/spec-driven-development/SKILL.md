---
name: spec-driven-development
description: Load when the human authorizes you to coordinate a named spec through SDD — grounding, gates, bounded docs, decomposition, review, and closure. Skill access or ordinary assignment alone is not authorization.
---

# Spec-driven development

The reusable spec workflow for an authorized coordinator. Usually the lead plans (gates 1–4) and
hands the locked spec to an orchestrator (gates 5–7); a standalone session runs all of it; a role
the human explicitly authorizes runs this method without adopting the lead persona. What counts
as authorization, and its limits, are Global Rules § Delegation. Within it, `golem:team-ops`
holds supported team operations.

## Ground before commitment

Trace concepts and owners, dependencies and failure paths, contracts, affected consumers, and
blast radius. Read source and behavior tests; existing behavior is evidence, not a requirement.
Propose one bounded slice with changes, exclusions, removed paths, and proof. Ask me only what
grounding cannot answer.

## Gates

1. Claim the spec, set `in_progress`, open the branch (`golem:git-conventions`), and author it
   with `golem:spec-writing`.
2. Ground, then agree requirements and scope with me. Design starts only after my go-ahead; an
   explicit request to draft design is that go-ahead. Never re-ask for an authorized stage.
3. Fold locked decisions into the spec. Only I reopen a locked call; conflicting evidence asks.
4. Obtain one independent spec review; fold accepted findings. No re-review.
5. Decompose into detailed tasks (`golem:tracker` § Writing); one task when one fits. Carry the
   exact `golem ticket` block commands (tracker owns the grammar) into implementation tasks.
6. Dispatch, consume the closing report, obtain one implementation review, then independent
   verification by another session. Re-run evidence before accepting it.
7. Reconcile every child (`golem:tracker` § Returned docs), fold outcomes and verification
   limits into the spec, set `review` for my acceptance, and run the spec-close pass in
   `golem:docs-maintenance`. I move it to `done`.

## Bounded documents

Size supporting docs by explanation and ownership, not counts. Small choices stay in the spec
behind collapsible blocks; several substantive choices use a linked workshop; independent work
slices become child specs, with the parent keeping shared integration obligations and status.
Workshops are proportionate and authorized here; unexpected research or scope expansion still
asks me first. When a discussion moves or settles, fold the current call into the parent and
preserve decision ids, rationale, alternatives, and comment context where it lives.

## Boundaries

Stay inside the authorized spec: a new decision, conflicting lock, or scope change stops and
asks me. Spec-close doc maintenance follows `golem:docs-maintenance`.