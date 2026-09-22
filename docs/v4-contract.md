# Golem v4 Contract — "thin layer over native Claude Code"

Binding decisions for the v4 build. All v4 work conforms to this file; deviations
require updating this file first. v4 is ADDITIVE — substrate/, personas, teams,
and `golem session` remain untouched while v4 is proven. The `golem` CLI itself
was retired and rewritten as a thin Node wrapper (`cli/golem.js`) in TKT-0011.

## Shape

- **No `/golem` command, no CEO persona, no session wrapper.** Every Claude Code
  session is a potential dispatcher. Behavior comes from a ~20-line router in the
  user's home `CLAUDE.md` (written by the orchestrator, not by builder agents)
  that frontloads the skills below.
- **One user-level plugin (`golem`)** carries all mechanics: hooks, skills,
  agents, channel MCP. Zero per-project scaffold. `cd any-repo && claude` is the
  entire on-ramp.
- **Main thread model:** whatever the user runs (currently Fable). **All spawned
  agents/subagents: `model: opus`** (agent frontmatter and Agent-tool calls).

## Layout (in this repo)

```
.claude-plugin/marketplace.json   # repo doubles as a local plugin marketplace
plugin/                           # the golem plugin
  .claude-plugin/plugin.json
  hooks/hooks.json                # references scripts via ${CLAUDE_PLUGIN_ROOT}
  hooks/session-register.sh       # SessionStart: register + title
  hooks/journal-route.sh          # all journal events → central journal
  hooks/notify.sh                 # Notification → ntfy push
  skills/<name>/SKILL.md          # 6 skills, see below
  agents/{worker,reviewer,researcher}.md
  mcp/channel/                    # channel server (copied from substrate/channels/golem/)
  .mcp.json                       # wires the channel MCP for every session
```

Builders MUST verify plugin.json / marketplace.json / in-plugin hooks.json
schemas and install commands against current official docs
(code.claude.com/docs/en/plugins*) before writing them. No guessing.

## Identity & registries (all under `~/.golem/`)

- **project_id** = `<dirname-slug>-<6-char sha256 of absolute path>`
  (slug: lowercase, non-alnum → `-`). Stable, collision-safe, derivable by any
  script from the project root path alone.
- **Project root resolution** (hooks): walk up from `$PWD` to nearest `.git` or
  `CLAUDE.md`; fallback `$CLAUDE_PROJECT_DIR`. Same rule as v3.
- `projects.json` — entries auto-upserted by the SessionStart hook:
  `{id, name, path, kind: "auto", registered_by: "hook", first_seen, last_seen}`.
  Manual project entries created by the retired v3 `golem project register`
  keep `kind` as-is; the hook never overwrites a manual `name`.
- `sessions.json` retains the cross-harness identity/recency rows.
  `channels.json` adds explicit harness plus consumer/delivery readiness reason
  codes: Claude Code becomes channel-eligible only after MCP initialization
  under a supported Anthropic provider configuration. Endpoint liveness alone
  never implies delivery.

## Central artifacts (zero repo footprint)

- **Journals:** `~/.golem/journals/<project_id>/hook.jsonl` (+
  `summary.jsonl`). Line schema unchanged from v3:
  `{ts, event, session_id, cwd, payload}` — plus `project_id` and `project_path`
  fields so readers never re-derive.
- **Milestones** are journal lines: `{ts, event: "milestone", session_id,
  project_id, text}`. Appended by the model per the AGENTS spine and role
  skills (single `echo >> ` append). Dashboard renders them in the project
  chat/timeline.
- **Gates:** `~/.golem/gates/<project_id>/<gate_id>.md` — same YAML
  frontmatter format as v3 golem-gates, new location.
- **Legacy coexistence rule:** if the resolved project root contains
  `.claude/hooks/journal-event.sh` (a v3-wired project, including this repo),
  the plugin's journal hook EXITS silently — v3 wiring owns that project until
  the delete-list phase. Dashboard reads central journals first, falls back to
  in-repo `journal/`.

## PLAN.md

- Lives at `<project root>/PLAN.md`. Created by the dispatcher for
  feature-sized+ work. Format: an H1, optional context paragraph, then a single
  flat GitHub-checkbox list (`- [ ]` / `- [x]`), one line per item. Dashboard
  progress = checked/total. No nesting, no tables.

## Skills (in plugin; invoked as `golem:<name>`)

Bar for content: *only what a fresh frontier model would get wrong* — formats,
paths, budgets, exact commands. No philosophy, no generic engineering advice.
Target ≤ 40 lines each.

| skill | contents |
|---|---|
| `lead` / `building` / `exploring` | role-specific SOPs for intake and design through orchestration and close, implementation, and evidence-backed verification. `managing` and `planning` merged into `lead` in GOL-103 |
| `verify-done` | exact evidence commands (test cmd from repo, `gh pr view --json state,mergeable`, CI check) ; "an agent's claim is not evidence" |
| `test-policy` | budget ~10–20 journey-level integration/e2e tests; what counts; unit-test fan-out banned unless complex pure logic |
| `gates` | gate file format + central path; how channel/dashboard verdicts clear it; when to gate (user said so at intake, or missing secret) |
| `pr-conventions` | branch naming, commit message + trailer, PR body shape (port tersely from v3 golem-pr-creation) |
| `journaling` | central journal path derivation, line schemas, milestone format |

## Notifications

`notify.sh` posts `{title, message}` to `https://ntfy.sh/$GOLEM_NTFY_TOPIC`
(topic from env or `~/.golem/ntfy_topic` file). Silent no-op when unset.
Fired on Notification hook (needs-input / idle) and gate creation.

## Dashboard (v4 additions, keep all current features working)

1. **Native sessions:** poll `claude agents --json` and read
   `~/.claude/sessions/*.json`; merge into the snapshot so ALL sessions appear
   (not only substrated ones). Liveness = pid + native status, not mtime.
2. **Projects:** registry-driven (auto + manual entries), with central
   journal/gates paths + legacy in-repo fallback.
3. **PLAN.md progress:** parse checkboxes from each project's PLAN.md → render
   N/M progress per project.
4. **Milestones:** render `event:"milestone"` journal lines in project timeline/chat.

## Safety rails for builders

- Hooks must NEVER block or slow a session: `set -u`, fail → `exit 0`, no
  network calls on the hot path except notify.sh (background it with `&`).
- Registry writes use the existing atomic mkdir-lock pattern from
  `substrate/channels/golem/index.js`.
- Don't touch: `substrate/` (except read), `~/.claude/settings.json`,
  the user's home `CLAUDE.md` (orchestrator-owned), anything in v3 projects.
- Verify every Claude-Code-specific fact against official docs before use.
