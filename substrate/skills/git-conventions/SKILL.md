---
name: git-conventions
description: Load when you open a branch, write a commit, or create a PR. Not needed for read-only git.
---

# Git conventions

## Branches

- Every spec gets its own branch off `main`: `<type>/<kebab-slug>`, type in `feat`, `fix`,
  `refactor`, `infra`, `docs`; slug at most three words (`feat/substrate-ui`,
  `fix/dead-assignee`).
- Tasks under a spec build on the spec branch. For parallel or staged tasks, branch off it as
  `<type>/<spec-slug>-<task-slug>` and open a stacked PR into the spec branch.
- The spec branch opens the PR into `main` when its tasks are verified. I land `main`.
- No git worktrees unless I, or the dispatch brief, say `workspace: worktree`.

## Commits

- One coherent unit per commit: a fix, a subtask, a component.
- `<type>(<scope>): <imperative subject>`, subject at most 100 characters; the body says what
  changed and why.
- Stage explicitly with `git add <files>`. Never `git add -A`: it sweeps scratch files and other
  agents' edits.

## Pull requests

Four sections, in this order:

```markdown
## Summary
What this PR does and why, in one or two sentences.

## What changed
One bullet per logical change. Skip what the diff makes obvious.

## Test plan
- [ ] `<exact command>` passes.
- [ ] Manual: <steps the tests do not cover>.

## Notes for review
Limitations, deferred follow-ups, trade-offs. "None" if none.
```
