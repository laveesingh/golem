# Decision-lab patterns and comparison axes

Pick the lab structure by the decision, and keep variation meaningful.

## Format map

| Decision | Format | Hold constant | Vary |
|---|---|---|---|
| Whole theme or visual system | shared-stage switcher | content, layout, status meaning, viewport | palette, typography, hierarchy, surfaces, elevation, borders, data colors |
| Page layout | shared-stage switcher | data, actions, priority, states | region order, scan path, grouping, responsive collapse, action placement |
| Component UX | side-by-side specimens | size, content, state, surrounding context | control model, affordance, disclosure, density, feedback |
| Navigation or IA | shared shell plus task checks | destinations, permissions, content inventory | grouping, labels, depth, orientation, mobile behavior |
| Interaction workflow | interactive flow | goal, starting data, success criteria, failures | step count, sequencing, disclosure, confirmation, undo and recovery |
| Density | side-by-side at fixed width | record count and information | compression, hierarchy, wrapping, secondary-detail access |
| Edge states | state matrix or switchable stage | component geometry and recovery goal | empty guidance, loading stability, error detail, permissions, offline |

A hybrid only when a broad direction also contains a local decision that cannot be judged in
context: a shared theme stage with one fixed component row, not eight separate dashboards.

## Fairness

- Identical names, values, timestamps, statuses, and data volume across options.
- Every required action reachable in every option; equal scale and viewport.
- Same semantic status meaning; one option must not look healthier by changing the scenario.
- Equal polish. No deliberately weak straw option.
- The same rubric and depth for every option's trade-offs.

## Distinctness

For each pair of neighboring options, write one sentence on how the experience changes. If it
reduces to a cosmetic substitution unrelated to the decision, rework the option. Aim for a
coherent thesis per option (compact command surface, calm guided workspace, scan-first ledger,
progressive-focus flow, recovery-first form) that touches at least two relevant axes.

## Evaluation axes

Only the axes that influence the decision: scanability and hierarchy · task speed and action
reach · learnability and navigation depth · density and long-session readability · feedback
and status confidence · error prevention, recovery, undo · keyboard and screen-reader
operability · mobile reflow and touch targets · brand or material fit · implementation
complexity and migration risk. For every option, one benefit, one cost, one risk on the chosen
axes. Advisory; I own the decision.

## Representative states

Only states that can change which option I choose. Data surfaces: normal, empty, loading,
error, long text, large count. Controls: default, hover, focus, disabled, selected, invalid.
Navigation: current, deep, overflow, mobile collapse. Flows: entry, decision point, progress,
recoverable failure, success, cancel. Dashboards: healthy, working, waiting, offline, queued,
attention required.
