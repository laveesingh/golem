# opencode harness (P4, TKT-0576)

golem's substrate compiler renders to more than one agentic harness. Alongside
the Claude Code adapter (`--target cc`), there is an **opencode** adapter
(`--target opencode`). It is **additive and off by default** — a fresh install
never touches opencode until you opt in via the harness toggle, so it can't
break the CC path.

## Enabling

The toggle lives in `~/.golem/config.json` (created on demand; absent → all
non-default harnesses disabled):

```json
{
  "harnesses": {
    "claudecode": { "enabled": true },
    "opencode":   { "enabled": true, "modelMap": {}, "testedVersion": null }
  }
}
```

With `opencode.enabled = false` (the default), `golem sync --target opencode`
reports the harness as **disabled and skips** — it is never treated as drift.
`golem doctor` shows the same disabled status.

Then render:

```bash
golem sync --target opencode
```

## Checkout-bound launch

OpenCode is bound to this source checkout. The managed
`~/.config/opencode/opencode.jsonc` merge points `mcp.golem` at the checkout's
`mcp/channel/index.js` and adds the checkout's `shims/opencode/index.js` as an
absolute `file://` plugin entry. Keep this repository in place while using the
integration; if it moves, run `golem sync --target opencode` again. Golem does
not provide a portable OpenCode package.

After the sync completes, launch the native client normally:

```bash
opencode
```

## What it renders

opencode reads golem's pieces from **three** rendered locations (unlike the CC
plugin, which is one bundle), plus checkout-backed MCP and shim entries in the
managed config merge:

| Piece  | Rendered to | How opencode finds it |
|--------|-------------|-----------------------|
| Agents | `~/.config/opencode/agent/<name>.md` | opencode's **fixed** global agent dir — there is no config key to add extra agent search paths, so the files must live there physically. |
| Skills | `~/.golem/renders/opencode/skills/<name>/SKILL.md` | that dir is appended to the `skills.paths` array in `opencode.jsonc`. |
| Instructions | `~/.config/opencode/AGENTS.md` and `tracker-context.md` | managed global instructions and the tracker-context snapshot in opencode's config directory. |
| MCP    | `mcp.golem` in `opencode.jsonc` | a `local` server pointing at the repo's `mcp/channel/index.js` (referenced by absolute path — no copy, unlike the CC plugin bundle). |
| Shim   | `plugin[]` in `opencode.jsonc` | a `file://` plugin pointing at the repo's `shims/opencode/index.js`; it maps lifecycle events and owns the SDK bridge. |

All three compiler render passes use the same engine (lockfile / tamper-detection / orphan
pruning) as the CC target, keyed independently by output dir.

## Dialect translation

Agent **frontmatter** is *translated*, not copied — a Claude Code agent's
`tools:` + `model:` frontmatter is invalid under opencode:

- `mode: subagent` for rendered Golem subagents.
- `permission: { edit: deny }` for read-only roles (reviewer, explorer);
  writers (builder) get no permission block. This mirrors the one
  security-meaningful boundary — read-only agents cannot edit — rather than
  attempting a full 1:1 tool-map.
- `model` is **omitted** so the opencode session's own default model is
  inherited. (The typical opencode setup runs GPT auth with no Anthropic
  models available, so pinning `model: opus` would break the agent.
  `harnesses.opencode.modelMap` is currently reserved and not consumed.)

Agent and skill **bodies** are copied but run through the compiler's
`{{#if opencode}}` / `{{#if claudecode}}` templating, so the two CC-specific
bits render their opencode variant:

- The hook journal (`golem:docs-maintenance`) uses the same scripts under opencode. The shim
  maps lifecycle, chat, and tool events into those scripts, so
  `~/.golem/journals/<project_id>/hook.jsonl` is written without Claude Code's
  native hook manifest.
- `skills/git-conventions` — the `🤖 Generated with [Claude Code]` PR trailer
  becomes `[opencode]`.

Rendering the CC branch and dropping the opencode branch leaves every existing
substrate file **byte-identical** to its pre-templating form, so the CC render
is unaffected.

## Config merge safety

`opencode.jsonc` is merged with `jsonc-parser` (comment-preserving), touching
the managed `mcp.golem`, `skills.paths`, and golem shim entry in `plugin[]`,
your own keys, comments, and formatting survive, and arrays are appended to
rather than replaced. An existing file is backed up; a newly created file is
removed if validation fails. When the opencode binary is available, the result is validated with the real
`opencode debug config`; validation failure restores the previous file and fails
the sync. If the binary is unavailable, the merge is retained with a warning and
has not been runtime-validated. On successful validation the backup is removed.

## Version pinning & doctor

Sync records the running `opencode --version` in
`harnesses.opencode.testedVersion`; `golem doctor` warns on later skew and
reports render drift. An unchanged config can be repinned without rerunning
`opencode debug config`, so the pin is a compatibility target rather than proof
that every sync path validated against that version.

## Caveats

- `mcp.golem` references the repo checkout by absolute path; if you move the
  golem repo, re-run `golem sync --target opencode` to refresh the path.

## Project-scoped renders

P6 adds project-scoped substrate artifacts. A canonical substrate file can opt in
with `scope: project` in frontmatter; default is `scope: global`. Global opencode
sync ignores project-scoped files. Project sync renders only those files:

| Piece  | Project render path |
|--------|---------------------|
| Agents | `<project>/.opencode/agents/<name>.md` |
| Skills | `<project>/.opencode/skills/<name>/SKILL.md` |

Session registration triggers the check for opencode sessions through the P5
shim: `session.created` calls `session-register.sh` with `harness:"opencode"`,
and the script runs `golem sync --check --project <root> --harness opencode`.
Dirty renders run detached; failures log to `~/.golem/logs/sync-on-register.log`
and never block session start.

Current artifact-set decision for P6: no real project-scoped substrate content is
shipped yet. The mechanism is verified with scratch-only fixtures so golem does
not start writing generated files into real user repos before an explicit policy
decision.

## Dispatch bridge

P5.5 makes live opencode sessions dispatchable without forking the dashboard
dispatch path. The opencode shim owns a tiny localhost bridge because it is the
only process with both the active `ses_*` id and opencode's SDK `client`; the MCP
channel server remains the dashboard-facing endpoint for the shared active
`session_notify`, `ack`, and tracker protocol. Consultation is an
ordinary `session_notify` message with an explicit advisory header and unique
reference; there are no consult wrapper tools or passive subscriptions.

Runtime flow:

- `session.created` starts/updates `~/.golem/opencode-bridges.json` with the
  `ses_*` id, opencode process pid, bridge port, cwd, and status.
- On plugin startup, the shim seeds bridge/session rows only for sessions that
  `client.session.status()` reports as active. If opencode returns no active ids,
  the shim falls back to the single most-recent top-level session only when it was
  updated recently, so persistent opencode history is not resurrected as live.
- The MCP channel process is a child of the opencode process. It resolves bridge
  rows by `process.ppid`, registers its own HTTP port in
  `~/.golem/channels.json`, and watches bridge membership/name changes so late
  sessions appear immediately; a 30-second heartbeat remains the recovery
  backstop.
- Dashboard dispatch still POSTs to the registered channel server. For opencode
  parents, the channel server forwards the push to the shim bridge; the shim
  injects the canonical `<channel source="golem" kind="...">...</channel>` text
  into the live session with `client.session.promptAsync(...)`.
  That live bridge is the OpenCode consumer-readiness signal; Claude Channels'
  Anthropic authentication and MCP initialization rules do not apply to it.
- `session.idle`, busy `session.status`, `chat.message`, and tool events update
  the bridge and `sessions.json` status/recency so `sessions_dispatchable` can
  show idle/busy and queue `when_idle` dispatches the same way it does for Claude
  Code sessions.
  `session.status` carries `status` as an OBJECT (`{type:"idle"|"retry"|"busy"}`);
  the shim collapses it to the plain string the dashboard compares against
  (`retry` counts as `busy`).
- The shim also records the active opencode model in `~/.golem/sessions.json`.
  It first queries the per-session value in opencode's SQLite database, then
  falls back to the runtime state file (`~/.local/state/opencode/model.json`,
  `recent[0].modelID`). Model changes are refreshed on shim-visible
  session/chat/tool/status activity; there is no idle heartbeat that fakes recent
  activity.
- `session.updated` (parentID-guarded) refreshes the registry `name` from
  `info.title` — the only real-time source of the session title (auto-generated
  after the first message, updated on rename). Events from child/subagent
  sessions can only update existing rows, never insert, so they cannot create
  phantom sessions or dispatch endpoints.
- `session.deleted`, `server.instance.disposed`, channel liveness, and opencode
  bridge pid liveness drive death. A live channel can bridge a bounded
  bridge-loss window from recent registry activity; stale activity alone does
  not create a dispatch endpoint.

The bridge is fail-open: HTTP or SDK errors are logged to
`~/.golem/logs/opencode-shim.log` and must not crash or stall opencode.
