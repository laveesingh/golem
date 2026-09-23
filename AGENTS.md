# Golem — root workspace

This directory is the golem root: the source repo for the **golem v4 Claude Code plugin**, the **dashboard + tracker**, and the thin **`golem` CLI**. It is also a local plugin marketplace (`.claude-plugin/marketplace.json`).

**Codebase map:** [REPO-MAP.md](REPO-MAP.md) — read it before exploring.

**Project memory:** [docs/memory.jsonl](docs/memory.jsonl) — append-only lessons, newest last. Read
the tail before starting anything non-trivial; append at spec close only when a future session
working on something else would be wrong without the record. Swept via `golem:docs-maintenance`.

## Primary goal: greenfield quality through brownfield slices

Keep Golem usable while improving one complete, bounded behavior at a time. Use the existing
spec-driven workflow, not a parallel analysis process.

Before changing a slice, the lead grounds its concepts and ownership (ontology), dependencies
and failure paths (topology), and affected consumers. Agree scope, desired boundaries, behavior
changes, and exclusions with the human. Rewrite where justified; remove superseded paths and
repair the affected consumers together. The boy-scout rule applies inside that agreed scope,
not as permission for unrelated cleanup.

Protect the result with isolated, repeatable behavior and failure tests plus real integration
checks. Passing local tests must not hide broken consumers or untested behavior.

## Layout

| What | Where |
|------|-------|
| v4 plugin source | `plugin/` — skills, hooks, channel MCP |
| Dashboard + tracker (SQLite, REST, web UI) | `dashboard/` — start with `golem dashboard` |
| `golem` CLI | `cli/golem.js` (`npm link` surfaces it; verbs: `dashboard`, `migrate-home`, `doctor`, `status`, `help`) |
| Project namespaces | `golem-projects/<name>/` (independent repos, gitignored) |
| Local marketplace manifest | `.claude-plugin/marketplace.json` |
| Runtime state (outside the repo) | `~/.golem/` — `projects.json`, `sessions.json`, `channels.json`, `journals/<project_id>/`, `tracker.db`, `gates/` (ADR-4; `~/.config/golem` is a compat symlink to it post-migration — path resolution lives in `lib/golem-home.js`) |

## Journaling

The plugin hooks journal every tool call + lifecycle event to **central** `~/.golem/journals/<project_id>/hook.jsonl` — zero repo footprint. Project root is resolved by walking up from `$PWD` to the nearest `CLAUDE.md` or `.git`; sub-agents inherit routing via the same `$PWD`-walk.

## Installing the plugin

As of TKT-0575 (P3, ADR-3), Claude Code loads golem from the **workspace
render**, not the repo checkout directly:

```bash
golem sync --target cc && golem sync --target cc-marketplace
claude plugin marketplace add ~/.golem/renders/cc-marketplace
claude plugin install golem@golem-workspace --scope user
```

`plugin/` stays committed in the repo (it's the dev-checkout fallback and the
rollback target — see below) but is no longer the install source; it's a
generated, git-diff-checkable copy of `substrate/`, regenerated via `golem
sync --target cc --out ./plugin --force` when you want to prove the render
round-trips.

**Updating**: edit `substrate/`, then `golem sync --target cc` re-renders
`~/.golem/renders/cc-plugin/` and stamps the version from root
`package.json`. Bump that version, re-sync, then `claude plugin update
golem@golem-workspace` + `/reload-plugins`.

**Rollback** (repo checkout, if the workspace render ever breaks):

```bash
claude plugin marketplace add /Users/laveesingh/Documents/software/experiments/golem
claude plugin install golem@golem-local --scope user
```


See `substrate/README.md` for the channel-consumer launch (`golemc`) and the full setup.

## Work Choreography

The `lead` owns a workstream end to end per `golem:lead`;
builders, explorers, and reviewers work
dispatched tickets and report back — durable report on the ticket first, then
`session_notify` to the delegating session. Specs, tasks, and docs live in the
tracker (`golem:tracker`); `state` is the single lifecycle. The event ledger is
durable audit history, not a wake-up or subscription path.

## Repo-specific agent rules

These are the golem-repo specifics that the global skills deliberately do not hardcode.

**Scratch tickets** (`golem:test-policy`) — smoke/scratch tickets MUST go through
`dashboard/scripts/_scratch.mjs`. They land in the quarantined `smoketests-000000` project
(`created_by: 'smoke'`, `SMOKE-` title prefix) so they never pollute a real board or burn
per-project ticket numbers. Archive them in a `finally` block.

**Worktree dependencies** (`golem:git-conventions`) — copy-on-write these from the main checkout
rather than installing:

```bash
cp -Rc node_modules .worktrees/<TICKET>-<slug>/node_modules
cp -Rc mcp/channel/node_modules .worktrees/<TICKET>-<slug>/mcp/channel/node_modules
```

**Post-merge steps** (`golem:git-conventions`) — after landing a branch on main:

- If `substrate/`, `mcp/channel/`, or compiler/render behavior changed:
  `golem sync --target cc` and `golem sync --target cc --out ./plugin --force`. Bump the root
  `package.json` version when plugin behavior changed — **the render updating is not the same as
  the installed plugin updating.**
- If `substrate/instructions/AGENTS.md` changed, the pi render also carries instructions, roles,
  and skills — sync `--target pi` too, unless uncommitted Pi work in `shims/pi/` is active in
  the checkout (the pi render bundles that shim source). `golem sync --check --all` reports
  every target.
- If dashboard server behavior changed, restart the dashboard from the main checkout.

**Shared runtimes to avoid inside a worktree** (the generic rule is in
`golem:git-conventions`) — `golem sync` or any render writing shared plugin/global outputs;
restarting the shared dashboard; port 7420, docker stacks, named volumes, container names;
`~/.golem` as ticket code.

## Parallel Work = Worktrees

When a dispatch brief explicitly names `workspace: worktree`, follow the
worktree directive: one ticket branch in `.worktrees/<ticket>/`, self-contained
checks only, `branch:` in the closing brief, and merge ownership per
`golem:git-conventions` § Spec branches and merge ownership (the builder merges
into the spec branch; the owner lands `main`). Ad-hoc worktrees remain
prohibited without an explicit directive.
