---
name: tracker
description: The tracker tools and model — spec, task, doc; one state lifecycle; bodies, comments, anchoring, assignment. Load before you create, update, or comment on a ticket.
---

# Tracker

The tracker is the source of truth for work. The dashboard owns the database; use the tracker
tools, never direct writes.

## Tools

| Tool | Use |
|---|---|
| `ticket_list({mine:true})` | work assigned to you; filters: state, kind, assignee, project |
| `ticket_get({id})` | body, comments, children, events |
| `ticket_create({title, kind, body, parent_id?})` | new ticket; kind defaults to `task`; fill the kind's template |
| `ticket_update({id, ...})` | metadata and state; `body` replaces the whole body, so read first and rewrite in full |
| `ticket_comment({id, body, ...})` | progress and evidence; anchor with a quote, prefix and suffix, or a section |
| `ticket_comment_reply`, `ticket_comment_update` | thread a reply; resolve, reopen, or edit |
| `ticket_dispatch`, `sessions_dispatchable` | team transport: `golem:team-ops` |

## Three kinds

| Kind | Is | Template |
|---|---|---|
| `spec` | the living design doc for a workstream | `templates/spec.md` |
| `task` | one unit of work; its body is the plan | `templates/task.md` |
| `doc` | a supporting page: research, survey, scratchpad | `templates/doc.md` |

Tasks and docs hang under their spec via `parent_id`; a spec can parent child specs.

## Writing

- The body is a living document. Fold decisions and outcomes in at boundaries, and batch
  edits, because every edit rewrites the whole body.
- Decisions live in the spec's decision blocks and nowhere else. A scratchpad doc explores;
  only its insights move into the spec.
- Tasks: decompose a locked spec into one task normally, more when tasks can run in parallel or
  land in stages with each stage working and verifiable. Parallel tasks need parallel builders
  (`golem:team-ops` § Spawning). A task body carries what the builder cannot see: the decisions
  it implements, the touch points, the acceptance commands.
- Bodies: Markdown plus fenced mermaid, GitHub admonitions, and `<details>` with a blank line
  after `</summary>`. Never start a body with an HTML tag. No `;` inside sequenceDiagram text;
  escape `|` in table cells. Render each mermaid block before you save; the CLI exits 0 on
  broken diagrams.

## States

One field: `todo → in_progress → review → done`, plus `blocked` and `archived`. Move at real
boundaries. `review` means finished and awaiting my read. `blocked` names what unblocks it.

## Assignment

Whoever I should interact with through a ticket is its assignee, because my comments dispatch
to the assignee. A lead assigns itself every spec and scratchpad it holds, and every worker doc
that comes back. A dispatched task or doc is assigned to the worker while it works on it.

## Comments

- Evidence over claims: the commands you ran and their real output.
- My comments dispatch to your session. Reply in the thread or on the same block; I resolve.
- Over 30 lines: a child doc, and a three-line comment with its id.
- Secrets never enter a ticket, a comment, or chat. Name the key and a git-ignored file; I fill
  it in.

## Hygiene

- Before going idle, sweep your assigned tickets to their true state. Stale assigned work is a
  defect.
- A sweep on request: judge each open ticket's true state from evidence (a merged PR on
  `main`, files present, tests green), comment the evidence, then move it. Archive superseded
  or duplicate tickets; never delete. Leave ambiguous ones open with a question for me.
- Scratch and smoke tickets never go on a real board; use the repo's quarantined path
  (`golem:test-policy`).
