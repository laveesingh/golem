# Golem design lab

A place to look at UX directions before anything is built. Each round is one self-contained
HTML file: inline CSS and JS, no build step, no network, no dependency on the running
dashboard. Open it from the file system.

```sh
open design-lab/index.html
```

## Rounds

| Round | File | Decision |
|---|---|---|
| 1 · App shell | `index.html` | Where the workspace switcher lives, and where everything above a workspace (preferences, model profiles, roles, harnesses) goes. Three directions: compact sidebar, workspace rail, header-led. |

## Where the reasoning lives

Decisions, concept maps, and the decision log live in the Golem spec **GOL-431 "UX rebuild —
concepts, topology, and end-to-end slices"**. The lab holds only what the tracker cannot
render: interactive prototypes. Rule: reasoning in specs, pixels in the lab.

## How a round is built

- **Lab chrome** on the left: direction cards with benefit, cost, and risk; screen, scenario,
  appearance, density, and viewport controls. Keyboard: `⌥1`–`⌥3` directions, `⌥D` theme,
  `Esc` closes a menu.
- **Stage** on the right: a browser frame around the Golem app at a fixed width, scaled to fit.
- **Shells** (`SHELLS` in the script) wrap **screens** (`SCREENS`). Every direction renders the
  same screen content, so only the shell varies.
- **Fixtures** use real Golem vocabulary — workspaces, specs, tasks, docs, agents, teams,
  review inbox, schedules, model profiles — with invented data. Scenarios change counts and
  who is working; they never change the layout.
- **URL hash** carries the state (`#d=b&screen=agent&scenario=busy&theme=dark`), so a link
  reproduces what you see.

## Adding to a round

- A new direction: add an entry to `DIRECTIONS` and a function to `SHELLS` with the same id.
- A new screen: add a function to `SCREENS`, an `<option>` to the screen select, and a path to
  `URLS`.
- A new scenario: add an entry to `SCENARIOS` and an `<option>` to the scenario select.

## Boundaries

No production file, token, route, or store is touched. Picking a winner, or a hybrid, is a
separate decision; implementing it is a separate go.
