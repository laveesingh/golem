---
name: transcript-workflow-review
description: Load when reviewing AI session transcripts across harnesses for evidence-backed workflow, instruction, and tool improvements — retrospectives, comparison, or a chosen corpus. Never assess personality or performance.
---
<!-- GENERATED: skills/transcript-workflow-review/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Transcript workflow review

Find changes to the system around me that the transcripts support. Report what they show,
what stays uncertain, and which changes need my approval. Read-only.

## Scope

- Use only the transcripts and locations I supplied or approved. A store below is a candidate
  until I approve it.
- Fix the review question, source roots, window (default: last three days), exclusions, and
  the output shape.
- Keep it about workflows, instructions, tools, and constraints. Never assess personality,
  motives, health, intelligence, or general performance.

## Sources and how to read them

| Harness | Store | Read |
|---|---|---|
| Claude Code | `~/.claude/projects/<munged-cwd>/*.jsonl` | top-level `user` and `assistant` records: text, `tool_use`, `tool_result`, thinking. Sub-agents sit in sidechain files linked by parent `tool_use` id |
| Codex | `~/.codex/sessions/**/*.jsonl` | `session_meta` (cwd), `event_msg` user and agent messages, `response_item` |
| Pi | `~/.pi/agent/sessions/--<cwd-with-dashes>--/<timestamp>_<id>.jsonl` | first line is a header with cwd and id; then tree entries with `id` and `parentId`; roles `user`, `assistant`, `toolResult`, `bashExecution`, `custom`. Walk `parentId` from the leaf for the active path; abandoned branches are rework evidence. `compaction` and `branch_summary` mark summarized history |
| Other | what I name | inspect the schema before interpreting |

Inventory first: count files, group by source, project, harness, date, and main-versus-sub-agent.
Stream with `jq`; never load a corpus wholesale. Leave memory files, file-history snapshots, and
tool-result directories out unless I authorize them.

## Method

1. Pick the substantive sessions for the question.
2. Record observable events: the request, the context supplied, corrections, tool behavior,
   outcome, unresolved work.
3. Compare across sessions, projects, harnesses. Look for repeats, counterexamples, and other
   explanations.
4. Classify each finding: preference (I consistently ask for a style) · agent or instruction
   failure (ignored, misread, invented, over-scoped, acted without authority) · tool failure ·
   external constraint · mixed or unknown. A correction from me is strong evidence something
   went wrong, not automatically a stable preference.
5. Promote a finding only when it recurs, is high impact, or is a clear incident.

For a broad retrospective look for: repeated asks to be shorter or to answer the actual
question; retries, permission loops, handoff ping-pong, duplicate work; rollbacks and manual
cleanup; premature action, weak verification, delegation mismatch; golem or MCP failures.

## Report

For each finding: the pattern, session dates or aliases with a short paraphrase, the
classification and the alternative explanation, confidence in plain words, the consequence,
and the smallest useful change. Few promoted findings over a long list. Short quotes only when
the wording matters; no raw tool output. Then ask me once which candidates to adopt, test, or
discard.

## Boundaries

- Never keep raw transcript content outside the authorized location. Redact secrets, private
  paths, and personal information. Do not invent time saved or costs.
- Propose durable changes as candidates. Edit nothing until I approve; then put the change in
  the narrowest source that fits.
