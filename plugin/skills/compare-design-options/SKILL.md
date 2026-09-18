---
name: compare-design-options
description: Load to build an interactive standalone HTML decision lab that compares 2–4 UI or UX directions before implementation — themes, layouts, component UX, navigation, flows, density, empty and error states. Not for technical approaches.
---
<!-- GENERATED: skills/compare-design-options/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Compare design options

Turn an unresolved design choice into a realistic comparison in the browser, so I can choose
by looking instead of by reading. Read `references/lab-patterns.md` before you pick the format
and the axes.

## Ground in the real product

1. Read the repository instructions and the codebase map, then the actual shell, target views,
   tokens, data shapes, interactions, and responsive rules. Read source; do not guess.
2. Use real product terms and representative content. Name unknowns.
3. State the decision in one sentence: what I must choose, what stays invariant, which axes
   may vary.

Touch no production UI file, token, route, or store. The only artifact is one isolated file
under `docs/design/` unless I name another location.

## Shape the comparison

- 2–4 distinct options. Each has a name, one thesis, and a real difference on the decision's
  axes; merge two that differ only by a token value. Include the current direction as a
  labeled baseline when it matters. State each option's benefit, cost, and risk; declare no
  winner.
- The smallest format: a shared-stage switcher for a theme or page composition; side-by-side
  for a local decision; an interactive flow only when sequencing is the decision.
- Hold content constant: same data, copy, actions, states, viewport. Include only the
  interactions and edge states that can change the decision.

## Build and check

One self-contained HTML file: inline CSS, JS, SVG; no build step, no external dependencies.
Structured option data so every direction renders the same content. Semantic controls, a
visible active-option indicator, keyboard access, sufficient contrast.

Open it in your own Chrome (`golem:browsing`): switch through every option, walk the keyboard
path, check desktop and mobile widths, read the console. Fix what you see first.

## Hand off

Give me the file path, the option names, and the trade-offs in a few lines. Ask for one winner
or a specific hybrid (a base option plus the elements to borrow). Implementing the winner is a
separate go.
