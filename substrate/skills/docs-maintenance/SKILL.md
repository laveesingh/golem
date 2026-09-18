---
name: docs-maintenance
description: Load when you bootstrap a project's agent docs, after a structural change, at spec close to fix what a feature invalidated, or to sweep docs and project memory for drift. Covers AGENTS.md, docs/, REPO-MAP.md, docs/memory.jsonl, and why the hook journal is not memory.
---

# Docs maintenance

A project owns three layers of durable knowledge, all ordinary files in git, so a colleague
without golem gets them too. Golem derives a fourth at session start; nobody writes that one.

| Layer | What | Lives |
|---|---|---|
| L1 invariants | what stays true if the code were rewritten in another language | root `AGENTS.md` |
| L2 durable knowledge | architecture, conventions, `REPO-MAP.md`, ADRs | `docs/` behind a "read when…" index |
| L3 episodic memory | what a session learned | `docs/memory.jsonl`, append-only |
| L4 current state | live sessions, recent closes, recent commits | derived at session start |

**The hook journal is not memory.** `~/.golem/journals/<project_id>/hook.jsonl` is hook
telemetry: one line per tool call, machine-local, never swept, no evidence field. Hooks write it;
agents only read it, and not every harness writes it. A lesson goes in `docs/memory.jsonl`,
never there.

## Canonical project instructions

Every harness reads one source: `AGENTS.md`, with `CLAUDE.md` holding only `@AGENTS.md`, and
project skills in `.agents/skills/` with `.claude/skills` a symlink to it. Move a rule into the
substrate only when it should govern every project.

## L1 — `AGENTS.md`

Admission test: would this still be true if the codebase were rewritten in another language?
Why the project exists, what must never happen, boundaries that outlive an implementation. If
no, it belongs in L2. Keep it short; every line is paid on every session.

## L2 — `docs/` and the map

Living docs (`REPO-MAP.md`, architecture notes, conventions) are replaced when reality moves.
Dated artifacts (ADRs, research, design records) are written once and superseded, never edited;
the audit leaves them alone.

`docs/` needs an index whose rows are triggers, not topics: `| architecture.md | Read when you
need services, request lifecycle, trust boundaries. |`.

`REPO-MAP.md` is the one hand-curated map, ≤ 3 KB, directory granularity, one line per thing
the code cannot say about itself ("Engine is single-threaded per instance" is signal; "Engine
orchestrates tasks" is noise). Header: `> Last verified: YYYY-MM-DD @ <short-sha> — maintained
via golem:docs-maintenance.` Sections: Directory structure · Key modules & entry points · Data
flow · Constraints & gotchas · Common tasks. Referenced from `AGENTS.md`. Hand-written, never
generated.

## L3 — `docs/memory.jsonl`

One line per record: `{"ts","scope":"gateway|project|global","claim","evidence":"GOL-123 |
commit abc1234","author"}`. JSONL, because concurrent appends merge and arrays do not. The
evidence reference is what keeps it from becoming rumour.

Admission bar: a future session working on something else would be wrong without this. Write
what surprised you or what you had to discover the hard way. "Implemented X per spec Y" is a log
line, not a lesson. Written at spec close by the lead, not by each builder. The read window is
bounded, so the sweep promotes or discards.

## Modes

**Bootstrap** — only when I ask for it. Lay down `AGENTS.md` with an invariants section,
`docs/` with a trigger index and `adr/0000-template.md` (Status · Context · Decision ·
Consequences, with the rejected alternative), `REPO-MAP.md`, an empty `docs/memory.jsonl`, and
the pointers in `AGENTS.md`. Then the verify pass. A section with nothing true to say does not
exist.

**Incremental** — after your own change, update only if you added, moved, or removed a module
or top-level directory; added or removed an entry point (route, CLI verb, MCP tool, hook,
exported service); found an invariant or gotcha; or changed the data flow. Refactors, bug
fixes, tests, renames, and dependency bumps are not triggers; say "no map trigger". Touch only
the affected sections, re-stamp, verify.

**At spec close** — run by the lead. Do not ask whether you broke a doc; check:

```bash
# directories that moved
git diff --name-only <base>..HEAD | xargs -n1 dirname | sort -u
# docs that name any of them, ancestors included, stopping before the top level
for d in $(git diff --name-only <base>..HEAD | xargs -n1 dirname | sort -u); do
  while [ "$(dirname "$d")" != "." ]; do
    grep -rl -- "$d" docs/ AGENTS.md REPO-MAP.md 2>/dev/null
    d=$(dirname "$d")
  done
done | sort -u
```

Then walk the incremental triggers, append an ADR if the work made a choice with a rejected
alternative, and append an L3 record only if it clears the bar. Usually nothing does.

**Audit** — when asked, after a big refactor, or when a doc has lied twice. Living docs only:
directory section versus the tree; every path, entry point, and command exists; spot-check
two or three invariants; delete stale claims; re-stamp.

**Sweep** — when `docs/memory.jsonl` passes the read window or a record stops being true.
Every record gets one outcome: promote (it is now how the codebase works: write it into the L2
doc or an ADR, then drop the line), discard (superseded or never true), keep (still a live
lesson). The sweep is the only writer allowed to delete lines.

## Precedence and the one store

A living description that disagrees with the code is stale: fix it in the same session. An
approved future design is not stale because the implementation has not reached it.

The project has exactly one memory file. No `LESSONS.md`, no notes directory, no tracker table
for what a session learned, and no redirect into the hook journal.

## Verify pass, after every write

- `wc -c REPO-MAP.md` at or under budget.
- Every path, command, and test name you touched exists.
- The `AGENTS.md` pointer lines resolve.
- Stamp date and sha are current.
- If updating a doc felt like a chore, it is too detailed. Cut until updates are cheap.
