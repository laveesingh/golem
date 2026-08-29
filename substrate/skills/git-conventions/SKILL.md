---
name: git-conventions
description: Use when opening a branch, writing a commit, or creating a PR. Not needed for read-only git status, log, or diff.
---

# Git conventions

## Branching strategy (Default: Per-Spec Branches)

Always create a dedicated branch for each spec ticket by default — do not wait for explicit human instructions to branch out.

- **Spec Branches (Default)**:
  - When starting work on a spec ticket, create a fresh branch off `main` (or the project's base branch):
    ```bash
    git checkout -b <type>/<kebab-slug>
    ```
  - **Naming**: `<type>/<kebab-slug>`
    - `type` ∈ `feat | fix | refactor | infra | docs`
    - `kebab-slug` ≤ 3 words, concise and descriptive (e.g. `feat/substrate-ui`, `fix/dead-assignee`).
- **Stacked Task Branches & PRs (When applicable)**:
  - For complex or parallel tasks under a spec, builders branch off the spec branch (`<type>/<spec-slug>-<task-slug>`).
  - Open stacked PRs targeting the parent spec branch when staged or incremental review is beneficial.
  - When all task work is complete and verified, open the primary PR from the spec branch targeting `main`.

## Worktree guidance

- Do not use git worktrees unless the human or dispatch brief explicitly includes `workspace: worktree`.

## Commit guidance

- **Atomic Boundaries**: Commit at coherent units of work (fixes, subtasks, component additions).
- **Message Format**: `<type>(<scope>): <imperative subject>`
  - Subject line ≤ 100 chars in present imperative tense (e.g., `feat(dashboard): add live terminal peek`).
  - `scope` is optional (affected module or component).
  - Body provides clear technical details of what changed and why.
- **Clean Staging**: Stage explicitly (`git add <files>`). Never use blind `git add -A` that could sweep untracked scratch files or teammate edits.

## PR Conventions

Every PR created must include these four sections in order:

```markdown
## Summary
One or two sentences: what this PR does and why it matters.

## What changed
One bullet per logical change. Skip bullets the diff already makes obvious.

## Test plan
- [ ] `<exact test command>` passes.
- [ ] Manual: <steps the diff's tests don't cover>.

## Notes for review
Known limitations, deferred follow-ups, trade-offs. Empty if none.
```
