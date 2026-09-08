---
name: tracker
description: The tracker tools and model — spec, task, doc; one state lifecycle; bodies, comments, anchoring, assignment. Load before you create, update, or comment on a ticket.
---

# Tracker

The dashboard owns work records; use tracker tools, never direct database writes.

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
- Load `golem:spec-writing` for substantive spec authoring/revision. It owns the writing
  method; templates provide starting shapes. Metadata-only updates do not need it.
- Task bodies carry the agreed decisions, constraints, touch points, and acceptance commands.
  Decomposition belongs to `golem:lead`; do not make builders reconstruct the brainstorm.

## Body format

Use Markdown, Mermaid, admonitions, and `<details>`. Never start a body with an HTML tag.
Leave a blank line after `</summary>`; escape table pipes. No semicolons in sequence messages.
Render Mermaid before saving and inspect the result; exit 0 alone is not proof.
No format-selector or block-edit tools exist.

## States

One field: `todo → in_progress → review → done`, plus `blocked` and `archived`. Move at real
boundaries. `review` means finished and awaiting my read. `blocked` names what unblocks it.

## Assignment

Whoever I should interact with through a ticket is its assignee, because my comments dispatch
to the assignee. A lead assigns itself every spec and scratchpad it holds, and every worker doc
that comes back. A dispatched task or doc is assigned to the worker while it works on it.

## Returned docs

The researcher returns the doc in `review`, assigned to the requesting lead, before notifying.
The lead reads it, folds useful conclusions into the spec, and marks consumed research `done`.
Superseded material may be archived deliberately. A doc with unresolved work stays open with
an owner and next action; closing its parent must not silently discard it.

## Comments

- Evidence over claims: the commands you ran and their real output.
- Human comments dispatch to you. Reply in-thread; the human resolves them, not the agent.
- Over 30 lines: a child doc, and a three-line comment with its id.
- Secrets never enter a ticket, a comment, or chat. Name the key and a git-ignored file; I fill
  it in.

## Hygiene

- Before going idle, sweep your assigned tickets to their true state. Stale assigned work is a
  defect.
- Sweep on request: check artifacts, merge state, and tests; comment evidence before state
  moves. Archive superseded/duplicate tickets; never delete. Ask about ambiguous cases.
- Scratch and smoke tickets never go on a real board; use the repo's quarantined path
  (`golem:test-policy`).
