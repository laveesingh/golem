# Golem — root workspace

This directory is the golem root: the source repo for the **golem v4 Claude Code plugin**, the **dashboard + tracker**, and the thin **`golem` CLI**. It is also a local plugin marketplace (`.claude-plugin/marketplace.json`).

## Layout

| What | Where |
|------|-------|
| v4 plugin source | `plugin/` — agents (`worker`/`reviewer`/`researcher`), 9 `golem:*` skills, hooks, channel MCP |
| Dashboard + tracker (SQLite, REST, web UI) | `dashboard/` — start with `golem dashboard` |
| `golem` CLI | `cli/golem.js` (`npm link` surfaces it; verbs: `dashboard`, `doctor`, `status`, `help`) |
| Project namespaces | `golem-projects/<name>/` (independent repos, gitignored) |
| Local marketplace manifest | `.claude-plugin/marketplace.json` |
| Runtime state (outside the repo) | `~/.config/golem/` — `projects.json`, `sessions.json`, `channels.json`, `journals/<project_id>/`, `tracker.db`, `gates/` |

## Journaling

The plugin hooks journal every tool call + lifecycle event to **central** `~/.config/golem/journals/<project_id>/hook.jsonl` — zero repo footprint. Project root is resolved by walking up from `$PWD` to the nearest `CLAUDE.md` or `.git`, so this file also acts as the root-workspace marker; sub-agents inherit routing via the same `$PWD`-walk.

## Headless Chrome for testing (TKT-0187)

A non-headless Chrome on 9222 is visible on the user's screen. CDP actions
(`page.click`, `page.keyboard.press`, `page.bringToFront`) cause the OS to
activate that window and steal focus from the user's terminal / editor.

**Rule:** agents (and any smoke / probe script) MUST use a per-process
**headless** Chrome, not a shared non-headless instance on 9222.

Use the shared helper at `dashboard/scripts/_chrome.mjs`:

```js
import { acquireChrome } from './_chrome.mjs';
const { browser, cleanup } = await acquireChrome(); // spawns or connects to a headless instance on a unique port
// ... do CDP work ...
await cleanup(); // kills the spawned Chrome if we started it
```

`acquireChrome` picks a unique port per process (no collision with other
agents or with the user's 9222 Chrome), spawns `--headless=new` on that
port, refuses to connect to a non-headless Chrome, and cleans up the
spawned child on process exit. All `dashboard/scripts/smoke*.mjs` have
been migrated to this helper.

## Installing the plugin

```bash
claude plugin marketplace add /Users/laveesingh/Documents/software/experiments/golem
claude plugin install golem@golem-local --scope user
```

Updates are version-gated: bump `version` in `plugin/.claude-plugin/plugin.json`, then `claude plugin update golem@golem-local` + `/reload-plugins`. See `plugin/README.md` for the channel-consumer launch (`golemc`) and the full setup.