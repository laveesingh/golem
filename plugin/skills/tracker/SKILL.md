---
name: tracker
description: The tracker tools and model — spec, task, doc; one state lifecycle; bodies, comments, anchoring, assignment. Load before you create, update, or comment on a ticket.
---
<!-- GENERATED: skills/tracker/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Tracker

The dashboard owns work records; never direct database writes. These MCP tools are the
shared read surface; Pi and Claude
author through `golem ticket` (§ Ticket CLI).

## Tools

| Tool | Use |
|---|---|
| `ticket_list({mine:true})` | work assigned to you; filters: state, kind, assignee, project |
| `ticket_get({id})` | body, comments, children, events |
| `ticket_create({title, kind, body, parent_id?})` | new ticket; kind defaults to `task`; fill the kind's template |
| `ticket_update({id, ...})` | metadata and state; `body` is the Markdown full-body path — html needs expected_revision via `golem ticket` |
| `ticket_comment({id, body, ...})` | progress and evidence; anchor with a quote, prefix and suffix, or a section |
| `ticket_comment_reply`, `ticket_comment_update` | thread a reply; resolve, reopen, or edit |
| `ticket_dispatch` | team transport — discovery, recipients and returns per `golem:team-ops` |

## Three kinds

| Kind | Is | Template |
|---|---|---|
| `spec` | the living design doc for a workstream | `templates/spec.md` |
| `task` | one unit of work; its body is the plan | `templates/task.md` |
| `doc` | a supporting page: research, survey, scratchpad | `templates/doc.md` |

Tasks and docs hang under their spec via `parent_id`; a spec can parent child specs.

## Writing

- The body is a living document; fold changes in place (§ Editing).
- Load `golem:spec-writing` for substantive spec authoring/revision — it owns the writing
  method; templates provide starting shapes.
- Task bodies carry the agreed decisions, constraints, touch points, and acceptance commands.
  Decomposition belongs to the authorized coordinator (`golem:spec-driven-development`); do
  not make builders reconstruct the brainstorm.

## Ticket CLI

`golem ticket` is the authoring family; `--help` has syntax and examples.

## Editing

Every edit costs tokens twice, sent and read back. Keep both small.

- Edit from what you hold; `get-outline` or `get-block --anchor` only for an unknown part.
- One change, one `patch-blocks` call: `--expected-revision`, `--op`, `--anchor` (unique text;
  add `--prefix` or `--suffix` if it repeats), content on a quoted heredoc. Never put a body
  in a file.
- Do not re-read after a write; its `body_revision` is the next expected revision.
  `replace-body` only for conversion or a rewrite I ask for.
- Broken Mermaid still saves; fix each `mermaid_errors` entry with one `edit`. Never render.

## Body format

Markdown is the default (blank line after `</summary>`; escape table pipes). HTML is
spec-only, via `--body-format html`.

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
- Over 30 lines: a child doc; the comment or return message carries a three-line summary and
  the id.
- Secrets never enter a ticket, a comment, or chat. Name the key and a git-ignored file; I fill
  it in.

## Hygiene

- Before going idle, sweep your assigned tickets to their true state. Stale assigned work is a
  defect.
- Sweep on request: check artifacts, merge state, and tests; comment evidence before state
  moves. Archive superseded/duplicate tickets; never delete. Ask about ambiguous cases.
- Scratch and smoke tickets never go on a real board; use the repo's quarantined path
  (`golem:test-policy`).
