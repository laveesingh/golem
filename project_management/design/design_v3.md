# Golem · Design v3

> **Predecessors:**
> [`design_v1.md`](./design_v1.md) — mission, philosophy, agent roster, persona patterns, skills catalog, tracker layout.
> [`design_v2.md`](./design_v2.md) — dashboard, channel server, per-agent frontmatter hooks, agent_id keying, team-spawning contract, workspace topology.
>
> This is the canonical design for v3. Sections unchanged from v1 / v2 are referenced rather than restated.

This doc supersedes `v3_notes.md` (which remains as the brainstorm scratchpad). Everything here is locked-in design.

---

<!-- Status note (2026-05-14): The originally Phase-2-deferred items
     (D-v3-102/103/104) have been promoted into v3 after the multi-CEO
     workflow exposed real bugs (dashboard chat singleton + stale-session
     ghosts). The §15 narrative below has been rewritten accordingly; the
     decisions log in §17 marks them Shipped. -->

## 1. What v3 delivers

v2 was about **observing one CEO running one project**. v3 is about **running many projects safely in parallel**, with the team-lead actively supervising the teams it spawns. Three load-bearing themes:

1. **Project registry + external projects.** Projects can live anywhere on disk, not only under `golem/golem-projects/`. A `~/.config/golem/projects.json` registry holds the authoritative list. The dashboard reads it on top of its existing auto-scan.
2. **Multi-CEO sessions with lock-based exclusivity.** Each CEO session claims at most one project at a time. Claude Code's "one team per session" ceiling forces one CEO per active iterative team — so a multi-project workflow needs multiple CEOs, with a shared `~/.config/golem/sessions.json` registry preventing two CEOs from touching the same project.
3. **Active team supervision via `Monitor`.** The CEO is a real team lead — it `Monitor`s every team it spawns, intervenes on stalls / orphaned messages / mid-flight failures, and follows a closing checklist on convergence. No external watchdog process or new MCP server.

What `v3` is **not**:
- Not a dashboard frontend reshape. The chat drawer becoming per-CEO and the channel server gaining session-routing are flagged as Phase 2 work (§16) and deliberately deferred until terminal-only multi-CEO is shaken out.
- Not a persona-roster change. Same 18 personas as v2.
- Not a substrate template change beyond removing the malformed deny rule (already done in v2).

---

## 2. Workspace topology (post-restructure)

v2 spread the substrate across `~/Documents/software/experiments/` (CEO workspace files: `CLAUDE.md`, `.claude/`, `journal/`, `golem-projects/`) plus `~/Documents/software/experiments/golem/` (the substrate repo: `substrate/`, `dashboard/`, `project_management/`). v3 consolidates everything under `golem/`, which is now the substrate repo, the CEO workspace, AND the parent of any in-tree projects:

```
~/Documents/software/experiments/golem/                ← $GOLEM_ROOT (single tree)
├── CLAUDE.md                                          ← project-root marker for the CEO workspace
├── .mcp.json                                          ← registers the golem channel MCP server
├── .claude/
│   ├── settings.json                                  ← journaling-only hooks
│   └── hooks/                                          (journal-event.sh, journal-summarise.sh)
├── journal/                                           ← gitignored; CEO meta-activity events
├── substrate/
│   ├── personas/    (golem-ceo.md)
│   ├── agents/      (per-persona MDs, symlinked into ~/.claude/agents/)
│   ├── skills/      (golem-handoff-protocol, golem-summarise-session, golem-gates, …)
│   ├── commands/    (golem.md slash-command)
│   ├── templates/project-bootstrap/                   ← canonical seed for a new project
│   ├── channels/golem/                                ← MCP channel server (Node, :7421)
│   ├── bin/golem                                      ← CLI; symlinked to ~/.local/bin/golem
│   └── scripts/                                       ← team-monitor.sh and other helpers
├── dashboard/                                         ← Fastify + WS + React-via-CDN
├── project_management/design/                         ← this doc lives here
└── golem-projects/                                    ← gitignored; in-tree projects, each its own git repo
    └── <name>/                                        ← own CLAUDE.md, .claude/, tracker/, journal/, ...
```

**External projects** live anywhere on disk and are surfaced via the registry. They are NOT under `golem-projects/` and are not gitignored by the substrate repo (they have their own git history).

**`~/.config/golem/`** (XDG-style, machine-wide) holds runtime state:

```
~/.config/golem/
├── projects.json                                       ← durable project list
└── sessions.json                                       ← live CEO sessions + claims
```

These files are written by the CLI; gitignored from the substrate repo by virtue of being outside it.

`golem-ideas/` is **retired**. Ideation runs inside a regular project namespace under `golem-projects/<name>/docs/ideation/`. See §10.

---

## 3. Registries

Two files at `~/.config/golem/`. Both are pretty-printed JSON, atomically written via temp + `rename(2)`, serialised with `flock(2)` so concurrent CEOs / CLI invocations don't corrupt them.

### 3.1 `projects.json` — durable project metadata, no claim state

```json
{
  "version": 1,
  "projects": [
    { "id": "golem-root",  "name": "Golem Root",  "path": "/Users/.../experiments/golem",                "kind": "root",     "registered_at": "2026-05-14T12:00:00Z" },
    { "id": "factscroll",  "name": "FactScroll",  "path": "/Users/.../experiments/golem/golem-projects/factscroll", "kind": "project",  "registered_at": "2026-05-14T12:00:00Z" },
    { "id": "trialroomai", "name": "TrialRoom AI","path": "/Users/.../trialroomai",                      "kind": "external", "registered_at": "2026-05-14T12:30:00Z" }
  ]
}
```

Fields:
- `id` — primary key. Slug; lowercase, hyphenated, ≤ 32 chars. Generated from `--id` flag if passed, otherwise from `--name`, otherwise from the basename of `path`.
- `name` — pretty display name. Defaults to title-cased `id`.
- `path` — absolute path. Resolved on register (`realpath`).
- `kind` — `root` | `project` | `external`. Determines dashboard discovery semantics.
- `registered_at` — ISO 8601 UTC.

Invariants:
- `id` is unique.
- `path` is unique (resolved absolute).
- Exactly one `kind: root` entry exists (auto-registered for `$GOLEM_ROOT` on first CLI invocation).
- An entry whose `path` no longer exists is **logged** but **not auto-removed** — explicit `golem project unregister` is required to drop it.

### 3.2 `sessions.json` — ephemeral CEO sessions, claim as a field

```json
{
  "version": 1,
  "sessions": [
    {
      "session_id": "550e8400-e29b-41d4-a716-446655440000",
      "pid": 12345,
      "boot_time": "2026-05-14T12:00:00Z",
      "claimed_project": "factscroll",
      "claimed_at": "2026-05-14T12:01:00Z",
      "last_seen_at": "2026-05-14T12:30:00Z",
      "dashboard_url": "http://localhost:4173"
    }
  ]
}
```

Fields:
- `session_id` — UUID-v4 generated by `golem session start`, passed to `claude --session-id <uuid>`. Primary key.
- `pid` — OS PID of the `claude` child process. Recorded once at spawn; used by other CLI invocations for liveness checks (`kill -0`).
- `boot_time` — when `golem session start` ran. Useful for the dashboard.
- `claimed_project` — `null` (unbound) OR a `project_id` from `projects.json`. At most one session may claim a given project; enforced by `claim`.
- `claimed_at` — when the lock was acquired. `null` when `claimed_project` is `null`.
- `last_seen_at` — optional, refreshed by SessionStart / each journal-hook fire (cheap belt-and-suspenders for GC). Not load-bearing — PID liveness is the primary GC signal.
- `dashboard_url` — informational; set by the dashboard server when it discovers the session (deferred to Phase 2).

Invariants:
- `session_id` is unique.
- At most one row has `claimed_project == X` for any non-null `X`.
- Rows whose `pid` is no longer alive (`kill -0` fails) are stale and GC-able. The next `claim` operation that finds a conflict caused by a stale row removes it inline.

### 3.3 Atomic-write contract

```
1. Acquire flock(path + ".lock", LOCK_EX).
2. Read the canonical file (or empty schema if missing).
3. Apply the operation (append / mutate / GC).
4. Write to <path>.tmp.
5. rename(<path>.tmp, <path>)  ← atomic on POSIX
6. Release lock.
```

Every CLI subcommand that touches a registry follows this. Crash mid-operation leaves the canonical file unchanged.

### 3.4 Auto-registration of `golem-root`

The first time any `golem` CLI subcommand runs, an idempotent helper ensures `projects.json` contains the `golem-root` entry pointing at `$GOLEM_ROOT`. No user action required.

---

## 4. The `golem` CLI

### 4.1 Command reference

| Command | Purpose | Caller |
|---|---|---|
| `golem install`                                       | One-time global setup (symlinks, `.mcp.json`, npm deps). v2 behaviour. | user |
| `golem cleanup [--purge]`                             | Reverse `install`. v2 behaviour. | user |
| `golem reinstall`                                     | Cleanup + install. v2 behaviour. | user |
| `golem doctor`                                        | Sanity-check the environment. v2 behaviour, extended in v3 to also check registry files. | user |
| `golem dashboard`                                     | Start the dashboard. v2 behaviour. | user |
| `golem help`                                          | Print help. | user |
| **v3 — sessions** | | |
| `golem session start [--project <id\|path>] [--detach]` | Spawn a CEO (`claude --session-id <uuid> --append-system-prompt-file …`). If `--project` is passed, claim it pre-spawn. | user |
| the v3 session roster command (now `golem agent list`)      | Show live sessions + claim state. | user |
| `golem session stop <session-id\|--all> [--force]`    | Kill a session (TERM, then KILL). Removes its registry row. | user |
| `golem session claim <project\|--root> [--session-id <uuid>]` | Acquire a lock for the current session. If `--session-id` is omitted, read `$CLAUDE_CODE_SESSION_ID`. | CEO (via Bash) or user |
| `golem session release [--session-id <uuid>] [<project>]` | Release the current session's claim. Optional positional verifies that the claim being released matches. | CEO / SessionEnd hook |
| **v3 — projects** | | |
| `golem project register <path> [--name <pretty>] [--id <slug>] [--kind project\|external]` | Add a project to `projects.json`. `--kind` defaults to `project` if the path is under `$GOLEM_ROOT/golem-projects/`, else `external`. | CEO (during bootstrap / retrofit) or user |
| `golem project unregister <id\|path> [--force]`       | Remove an entry. Errors if any live session has it claimed (override with `--force`). | user |
| `golem project list [--kind <kind>] [--json]`         | List registered projects. | user |
| `golem project info <id>`                             | Print one project's metadata + current claim if any. | user |
| **v3 — combined view** | | |
| `golem status [--json]`                               | Combined snapshot: registered projects, live sessions, dashboard URL, channel-server reachability. | user |

### 4.2 Exit-code contract

Every command returns one of these. Non-zero exits emit a single-line JSON to stderr with structured error info.

| Code | Meaning |
|---|---|
| `0`  | OK |
| `2`  | Bad invocation (missing arg, unknown command) |
| `10` | Lock conflict (another live session holds the claim) |
| `11` | Stale lock GC'd in-line; the operation succeeded (informational; the CEO retries no-op) |
| `12` | Wrong-session release (session_id mismatch) |
| `20` | Registry write failed (permissions, flock contention) |
| `30` | Project / session not registered |
| `40` | Operation refused (e.g. unregister-while-claimed without --force) |

Stderr-JSON example on code `10`:

```json
{
  "error": "lock_conflict",
  "project": "factscroll",
  "held_by": {
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "pid": 12345,
    "since": "2026-05-14T12:01:00Z"
  }
}
```

The CEO persona reads this via the `Read` tool (NOT shell pipes) and surfaces the conflict details verbatim in its `respond` push-back.

### 4.3 Canonical CEO incantations

The CEO persona's hot path uses exactly three subcommands. Each is a single mechanical Bash call.

```bash
golem session claim <project>             # uses $CLAUDE_CODE_SESSION_ID from env
golem session release                     # ditto
golem project register <abs-path> --name "<pretty>"   # on bootstrap / retrofit
```

No `--session-id`, no `--pid`. The env var carries identity; the CLI looks up the PID it recorded at spawn time.

---

## 5. CEO session lifecycle

### 5.1 The exclusivity invariant

> One project is claimed by at most one live CEO session.

Enforced by `golem session claim`. Violated only transiently (stale-pid rows pending GC); GC is inline on every claim attempt.

### 5.2 Claim mandate (Critical persona rule)

After classifying a brief (CEO persona Step 2), once the CEO has resolved which project it intends to work on:

```bash
golem session claim <project_id>
```

**Required**, no exceptions. On non-zero exit:
- Push back to the user via `respond` with the held_by details.
- Do NOT enter the autonomy loop.
- Do NOT retry.
- Close with the reflex; yield.

For root-workspace meta-work (e.g. user asks to edit a persona), the call is `golem session claim --root` (or `--id golem-root`). Treats `$GOLEM_ROOT` exactly like any other project.

### 5.3 Release paths

Three paths, all converging on the same `release` operation:

1. **Explicit (CEO).** When switching projects mid-session, the CEO calls `golem session release` before `golem session claim <new>`.
2. **SessionEnd hook (best-effort).** `$GOLEM_ROOT/.claude/hooks/journal-event.sh` adds a tail step on `session-end`: `golem session release --session-id $CLAUDE_CODE_SESSION_ID` (no-op if already released). Fires on clean exits.
3. **Stale-PID GC (crash recovery).** Any `claim` operation that finds a conflicting entry checks `kill -0 <stored_pid>`. Dead → GC the stale row, proceed with the claim. Sufficient for single-machine; no heartbeat needed.

### 5.4 Mid-session rebinding

Supported. `release` then `claim <other>`. If the second `claim` fails, the CEO is now unbound and must push back — **no auto-reclaim of the previous project**. Rebinding is a user-instructed action; the CEO doesn't make the call on its own.

### 5.5 Crash recovery

Stale rows survive a CEO crash because `SessionEnd` hook didn't fire. The PID-liveness check on the next `claim` attempt is the recovery mechanism. No watchdog required; no heartbeat required.

---

## 6. Session-ID propagation (verified)

Both bits verified against Claude Code docs (https://code.claude.com/docs/en/cli.md, https://code.claude.com/docs/en/env-vars.md):

1. **`claude --session-id <uuid>`** is documented — caller-supplied UUID becomes the session_id for the new conversation. Compatible with `--append-system-prompt-file`. `golem session start` generates a UUID-v4, registers it in `sessions.json`, then exec's `claude --session-id <uuid> --append-system-prompt-file …`. The wrapper knows the session_id before the child even runs.
2. **`CLAUDE_CODE_SESSION_ID`** is automatically set in every Bash subprocess Claude Code spawns. Matches the `session_id` in hook payloads; updated on `/clear`. The CEO's `golem session claim/release` calls read this env var — no flag needed in the hot path.

The PID is recorded once at spawn time by the parent wrapper. Subsequent `claim` / `release` calls identify themselves by session_id only.

---

## 7. Team-spawning contract (carried from v2)

Unchanged in v3, but the persona examples are rewritten to use namespaced team names (§8) and to fold in the supervision flow (§9). For each iterative loop:

```
TeamCreate(team_name: "<phase>-<project_id>[-<ticket_id>]", description: "...")
Agent(subagent_type: "...", name: "...", team_name: "...", ...)   ← N times
... team converges ...
TeamDelete()
```

Leaf one-shots (Substrator, UX, Diagnoser, Documentarian, etc.) use plain `Agent(...)` with **no** `team_name` and **no** `TeamCreate`. Wrapping a one-shot in a team is an anti-pattern (already codified in `golem-handoff-protocol`).

---

## 8. Team-name namespacing

Required because `~/.claude/teams/<name>/` is **machine-global**. Two CEOs running team-spawn on different projects with un-namespaced `team_name` collide.

New convention, with the `project_id` injected:

| Phase | Old (v2) | v3 |
|---|---|---|
| Product Architect ↔ Reviewer | `specs-bringup`            | `specs-<project_id>` |
| Tech Architect ↔ Reviewer    | `arch-bringup`             | `arch-<project_id>` |
| TDD / dev team               | `tdd-tkt-<ticket_id>`      | `tdd-<project_id>-tkt-<ticket_id>` |

The `project_id` is the registry's primary key, known to the CEO post-claim. Mechanical search-and-replace in `golem-ceo.md` and `golem-handoff-protocol/SKILL.md`.

---

## 9. Team supervision (Monitor + procedural)

### 9.1 Failure-class taxonomy

Grounded in the CEO's field notes (`golem-projects/factscroll/docs/agent-notes/team-mechanics-2026-05-13.md` and `golem-projects/archive/factscroll/docs/agent-notes/substrate-bug-fork-bomb-deny.md`).

| # | Class | When it fires | Hook-visible? |
|---|---|---|---|
| **F1** | **Dead-on-arrival permission modal.** Malformed `.claude/settings.json` → CC "Settings Warning" confirmation prompt blocks every spawn before turn 1. | At sub-agent spawn | **No** — process is parked before any hook fires |
| **F2** | **Synchronous-backend silent termination.** Claude Code silently picks one of two backends (`Agent(team_name=…)`); on the synchronous one, a teammate's `end_turn` after a "wait for SendMessage" turn-1 instruction terminates the teammate. SendMessage to a terminated name persists to the inbox silently. | Turn 1 to ~turn 3 | Partially — single `Stop`, then silence |
| **F3** | **Genuine mid-work stall.** Model error, API quota, network blip, mid-tool-call permission denial. | Mid-team | Yes — last hook timestamp ages |
| **F4** | **Deadlocked SendMessage loop.** A waits B; B waits A. Both `isActive=true` but neither produces work. | Late in a loop | Yes — both teammates idle, both inboxes have unread peer-messages |
| **F5** | **TmuxDelete orphan processes.** `TeamDelete` does NOT kill tmux-backed teammate processes. Orphans consume CPU/memory indefinitely. | After (apparent) team success | No — orphans silent |

The two-backend runtime distinction (synchronous subagent vs tmux-backed teammate) is documented in `team-mechanics-2026-05-13.md` and forms part of §9.4 below.

### 9.2 Monitor as the primary supervision mechanism

For every iterative-team spawn, after `TeamCreate + Agent(...)`, the CEO starts a `Monitor` watching the team. The Monitor's stdout lines become CEO conversation turns; the CEO reads each, applies a decision table, and intervenes.

The wrapper script lives at `substrate/scripts/team-monitor.sh <team_name>`. Canonical invocation:

```
Monitor(
  description: "team supervision: <team_name>",
  command: "bash $GOLEM_ROOT/substrate/scripts/team-monitor.sh <team_name>",
  timeout_ms: 3600000,
  persistent: false
)
```

The script polls every ~5 s, maintaining prev-state for: inbox length per teammate, `isActive` per teammate, transcript `mtime` per teammate. It emits one stdout line on each meaningful transition (see §13).

### 9.3 Decision table

| Signal Monitor emits | CEO action |
|---|---|
| Inbox+1 (normal hand-off) | Log only; continue waiting |
| Verdict token (`approve` / `request-changes` / `block`) in a transcript | Log; convergence may be imminent — read the relevant transcript |
| `isActive: true → false` for a teammate WITHOUT a verdict token | F2 suspected — re-spawn with a corrective prompt (productive turn 1) OR escalate |
| Stall alert (`mtime` > 120 s while `isActive=true`) | First nudge: `SendMessage` polite "still working?" |
| Stall alert persists across two nudges | Treat as F3/F4 — escalate via `respond` + escalation memo |
| Both members `isActive=false` AND inboxes carry unread peer-messages | Synchronous-backend orphan — re-spawn the addressee |
| Both members `isActive=false` AND inboxes clean | Convergence — proceed to §9.6 teardown |

Stall threshold (`120 s`) is the default. PA↔PAR-class loops fit; long-thinking dev-team turns may want 300 s+. Configurable via env var read inside the wrapper script.

### 9.4 Backend-aware spawn handling

Claude Code's `Agent(team_name=…)` silently picks between two backends. The CEO discriminates by inspecting the tool-return text immediately after the call:

| Tool-return shape | Backend | What the CEO does |
|---|---|---|
| Starts with `Spawned successfully ... will receive instructions via mailbox` | **Tmux-backed teammate** — `Agent()` returned immediately; teammate is alive in `tmux -L claude-swarm-<pid>`, awaiting messages | Start `Monitor`; wait for events |
| Contains `agentId: ...` payload (synchronous reply) | **Synchronous subagent** — the call already blocked-and-returned; the agent has terminated | Treat as a leaf-style return — Monitor would have nothing to watch. Read the relevant hand-off log directly |

Pattern-matching tool-return text is fragile; the persona carries a comment noting this and a `golem doctor` check should later validate the assumption against Claude Code's docs.

### 9.5 F1 procedural rule (no static lint)

Pre-spawn settings.json lint is **NOT** built in v3 — deferred until F1 recurs in practice (decision `D-v3-200`). Instead, the CEO persona carries:

> If Monitor reports a stall alert within the first 3 minutes of a team spawn AND `isActive` never transitioned to `true`, the CEO must `tmux capture-pane` on the swarm socket to diagnose. If a "Settings Warning" modal is visible: dismiss via `tmux send-keys Enter`, file a substrate-bug memo at `docs/agent-notes/substrate-bug-<date>.md`, escalate to user with the offending rule, then `TeamDelete` and re-dispatch.

### 9.6 F5 teardown checklist (procedural)

`golem team teardown` CLI is **NOT** built in v3 — deferred (decision `D-v3-201`). Codified instead as the CEO's mandatory closing sequence after every iterative-team convergence:

1. `SendMessage({type: "shutdown_request"})` to every teammate.
2. Wait for `shutdown_response`.
3. Read `~/.claude/teams/<team_name>/config.json`; verify every member has `isActive: false`.
4. `TeamDelete()`.
5. Verify with `ps -ef | grep agent-id` — expected empty.
6. If any step fails, kill stragglers explicitly via `tmux kill-session -t claude-swarm-<pid>`.

Codified in `golem-ceo.md` §B.2 / B.4 / §D and in `golem-handoff-protocol/SKILL.md`.

### 9.7 Productive-turn-1 norm (wording-only)

The PAR pre-bake-review pattern (from `team-mechanics-2026-05-13.md` §addendum) becomes the canonical template:

> Every teammate's spawn prompt must produce a concrete artefact on turn 1 — a write, a read+SendMessage, anything observable. Never instruct a teammate to "wait for the first SendMessage" as its turn-1 action. The PAR pre-bake-review pattern is the canonical example: read available context, form an opinion, SendMessage your peer, then yield.

This is wording-only guidance in `golem-handoff-protocol` and the teammate personas. Not enforced by a lint; revisitable (decision `D-v3-202`) if F2 keeps biting.

### 9.8 Monitor's own failure modes (defence)

Monitor scripts can crash, hit the timeout (`1h` max), or be silently throttled. Persona rule: if no Monitor event has arrived for ≥ 10 min during a known-live team, the CEO must directly `Read` the team's `config.json` + a teammate transcript to verify Monitor is still functioning. If Monitor died, restart it.

---

## 10. Ideation reorder (corrected)

v3_notes proposed "barebones project bootstrap by CEO, then Scout/Prospector/Smelter, then full substrator". v3 simplifies to **substrator-first, ideation-inside**:

```
Brief: "explore X" / "is there something in Y"
        │
        ▼
1. CEO synthesises a tentative project name (or asks via gate if too vague).
2. CEO creates the project directory + dispatches Substrator (full mode):
     Bash(command: "mkdir -p ~/Documents/software/experiments/golem/golem-projects/<name>")
     Bash(command: "tar -C $GOLEM_ROOT/substrate/templates/project-bootstrap/ -cf - . | tar -C ~/Documents/software/experiments/golem/golem-projects/<name>/ -xf -")
     Bash(command: "cd ~/.../<name> && chmod +x .claude/hooks/*.sh && git init && git add -A && git commit -m 'chore: substrate bootstrap'")
     (substitute placeholders {{PROJECT_NAME}}, {{STACK_PRIMARY}}=tbd, {{DATE}})
   Then dispatch:
     Agent(subagent_type: "golem-substrator", description: "Bootstrap substrate harness for <name>", prompt: …)
3. CEO calls: golem project register <abs-path> --name "<pretty>"
4. CEO calls: golem session claim <name>
5. Ideation pipeline runs INSIDE the project, all leaves writing to docs/ideation/:
     Agent(subagent_type: "golem-scout",      description: …, prompt: "write to <name>/docs/ideation/scout-<date>.md")
     Agent(subagent_type: "golem-prospector", description: …, prompt: "read scout-<date>.md, write prospector-<date>.md")
     Agent(subagent_type: "golem-smelter",    description: …, prompt: "read prior, write smelter-pick-<date>.md")
6. On Smelter pick → proceed to §B (Product Architect, etc.) inside the same project.
   On no pick / ideation-only → CEO writes a "shelved" memo to docs/agent-notes/, closes with the reflex.
```

Consequences:
- **`golem-ideas/` is retired.** No separate workspace kind. The dashboard discovery only knows `root` and `project` (external is a project subtype).
- **Every persona writes journal/hook.jsonl from event #1.** No invisible Scout pass. The journal is uniformly populated for the project's whole life including its ideation phase.
- **Tentative names can be renamed later.** The substrate's `id` is a slug; if Smelter picks a different brand, the user can `golem project unregister <old>` + reproject the directory + `golem project register <new>`. Acceptable rough edge for v3.
- **Aborted-ideation projects leave a harness behind.** Acceptable — they're cheap (template copy + 1 commit), and the archive is a useful record.

Persona / skill changes (§11 / §12) reflect this throughout.

---

## 11. CEO persona changes

Exhaustive edit list for `substrate/personas/golem-ceo.md`:

1. **New Critical rule — Project-lock contract (NON-NEGOTIABLE).** After Step 2 classify-brief, once the project is resolved, the CEO MUST `golem session claim <project_id>`. On non-zero exit: `respond` with held_by details, do not enter autonomy loop, close with the reflex, yield. No retries. Place between "Team-spawning contract" and "Bash discipline" in the Critical rules section.
2. **New Critical rule — Team supervision (NON-NEGOTIABLE).** After every iterative-team spawn, the CEO MUST start `Monitor` watching the team. Reference §9 in the persona text; spell out the decision table inline.
3. **New Critical rule — Closing-sequence checklist.** F5 teardown protocol from §9.6.
4. **Updated rule — Agent calls are no longer always synchronous.** Branch on tool-return text per §9.4.
5. **§A.1 (Ideation) rewritten** per §10 of this doc.
6. **§A.2 (Bring-up) updated** to insert `golem project register` + `golem session claim` between the substrator dispatch and B.2.
7. **§A.3 (Continuation) updated** to require `golem session claim` before any work on the project.
8. **§A.4 (Retrofit) updated** to `golem project register --path <external> --kind external` after Substrator returns, then `golem session claim`.
9. **§B / §C / §D — team_name examples** rewritten with `<project_id>` namespacing per §8.
10. **§B.2 / §B.4 / §D — supervision examples** show the canonical `Monitor` invocation immediately after `TeamCreate + Agent×N`. Closing-sequence checklist embedded at the end of each.
11. **§F (Autonomy loop) updated** to release-then-claim on mid-session project switch.
12. **"What you do NOT do" extended:**
   - No autonomy-loop entry without a successful `golem session claim`.
   - No team spawn without subsequent `Monitor`.
   - No `TeamDelete` without the §9.6 closing sequence.
   - No `golem-ideas/` directory creation — ideation lives inside the project.

---

## 12. `golem-handoff-protocol` skill changes

`substrate/skills/golem-handoff-protocol/SKILL.md`:

1. **§"Iterative team hand-off (Option 2)" Step 1** — already includes `TeamCreate`. Append a callout that **every teammate's spawn prompt must do productive turn-1 work** (§9.7). Include the PAR pre-bake-review pattern as the canonical example.
2. **Anti-patterns** — extend with two new entries:
   - "Instructing a teammate to 'wait for the first SendMessage' on turn 1. On the synchronous backend this terminates the teammate; on the tmux backend it's wasteful." (F2 prevention.)
   - "Calling `TeamDelete` without first sending `shutdown_request` to teammates. Tmux-backed teammates do not exit on `TeamDelete`; orphans accumulate." (F5 prevention.)
3. **New §"Team supervision"** — explains the Monitor flow + decision table + closing checklist, mirroring §9. Personas read the skill on every turn; this is where the procedural rules live in cross-persona form.
4. **§"Common pitfalls" → new bullet** for the backend-detection fragility (§9.4).

---

## 13. The Monitor wrapper script

`substrate/scripts/team-monitor.sh <team_name>` — single source of truth for the supervision signal set. Standalone bash (no Python), polls every 5 s, emits one line per meaningful transition.

State tracked across polls:
- `inbox_count[member]` — number of `read: false` entries in `~/.claude/teams/<team>/inboxes/<member>.json`.
- `is_active[member]` — `config.json` field per member.
- `transcript_mtime[member]` — most recent `mtime` of the member's transcript jsonl (one per member; located under `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` per the v2 finding).

Emission rules:
- On startup, emit a single `monitor: armed for <team_name>` line so the CEO knows Monitor is running.
- On `inbox_count[member]` increment: emit `inbox <member>+1 from <peer>: <truncated body>`.
- On `is_active[member]` transition: emit `isActive <member>: <prev>→<new>`.
- On `transcript_mtime[member]` unchanged for > 120 s while `is_active[member] == true`: emit (at most once per stall window) `stall <member>: mtime stale ${age}s`.
- On a new transcript line matching `approve|request-changes|block` (case-insensitive, word boundaries): emit `verdict <member>: <token>` plus the line.
- On both `is_active` false AND all inbox counts zero: emit `converged` and exit 0.

Exit conditions:
- Convergence (above) → exit 0.
- Timeout (caller passes `timeout_ms`; default 1h via Monitor) → exit 124. Monitor surfaces this as a terminal notification.
- `team_name` config missing for > 30 s → emit `team-config-missing` and exit 1. (Defends against premature TeamDelete.)

Configurable stall threshold via optional positional argument: `team-monitor.sh <team_name> [stall_ms]` (default `120000`). The `GOLEM_TEAM_STALL_MS` env var is kept as a legacy fallback, but the positional form is preferred — an env-var-assignment prefix on a Bash command defeats Claude Code permission prefix-matching.

Filter discipline: every emitted line MUST match the documented rules — no raw transcript echoing. Each line is a CEO conversation turn; noise is expensive.

---

## 14. SessionEnd hook → `golem session release`

`.claude/hooks/journal-event.sh` adds a tail step on `session-end`:

```bash
# Append at the end of the script, just before `exit 0`:
if [[ "$EVENT_TYPE" == "session-end" ]] && command -v golem >/dev/null 2>&1; then
  golem session release --session-id "${CLAUDE_CODE_SESSION_ID:-}" 2>/dev/null || true
fi
```

Failures are silent (logged via the script's stderr); the registry GC on the next `claim` is the safety net. The hook fires from both `$GOLEM_ROOT/.claude/settings.json` (for the CEO's own SessionEnd) and from project-level settings.json files in `golem-projects/<name>/.claude/settings.json` (since sub-agent SessionEnds also pass through). In all cases, the release is keyed by `$CLAUDE_CODE_SESSION_ID` — the registry only releases its OWN session, so sub-agent sessions naturally no-op.

---

## 15. Dashboard side — shipped in v3 (Phase 2 promoted)

What v3 ships in the dashboard (now including the Phase 2 chat work):

**Registry surfacing** (originally Phase 1):
- `dashboard/server/config.js` paths already updated to point at `$GOLEM_ROOT/golem-projects/`. ✓
- `dashboard/server/projects.js` extended to ALSO read `~/.config/golem/projects.json` and surface every entry whose `path` isn't already discovered by the auto-scan. De-dup by absolute path. Entries whose path doesn't exist on disk are logged-and-skipped.
- `dashboard/server/orchestrator.js` reads `~/.config/golem/sessions.json` AND `~/.config/golem/channels.json`; PID-liveness filter strips ghosts whose pid is dead so the UI never surfaces stale rows even if no CLI command has run a GC pass.
- Journal store cross-references the dead-session set: a CEO whose pid the registry knows is dead is demoted to `done` regardless of journal mtime — closes the "ACTIVE forever" failure mode when Claude exits before SessionEnd fires.

**Multi-CEO chat routing** (originally `D-v3-102` / `D-v3-103` / `D-v3-104`, all shipped):
- **Channel server is now per-session.** `substrate/channels/golem/index.js` reads `CLAUDE_CODE_SESSION_ID` on boot, binds an ephemeral port (`GOLEM_CHANNEL_PORT=0` is the CLI default), and registers `{session_id, host, port, pid}` to `~/.config/golem/channels.json` via an atomic mkdir-locked write. Cleanup on SIGINT/SIGTERM/SIGHUP/beforeExit removes the row. Every `ack` / `respond` broadcast carries `session_id` so the dashboard can route the message into the right lane.
- **Dashboard chat backend (`chat.js`) is now a multiplexer.** Instead of a single SSE consumer it maintains a `session_id → SSE` map driven by the channels registry; it reconciles on a 3s poll (new CEO joins → new consumer; CEO disappears → consumer torn down). Each message recorded carries `session_id`.
- **Dashboard brief proxy (`brief.js`) routes by session_id.** `/api/brief`, `/api/interrupt`, `/api/halt`, `/api/gates/:id/:decision` accept a `session_id` body field (or `?session=` query). Server resolves the target channel from `channels.json`. Single-CEO case stays auto-routed for backwards compat; zero-CEO falls back to the legacy `CONFIG.channelUrl` probe.
- **Frontend renders sessions as chips on the orchestrator rail.** Each chip shows `claim · session_id_short · status` and is clickable → opens the chat drawer keyed to that session. Inside the drawer a session-tab strip lets the user switch between live CEOs without closing. Unbound CEOs render with an explicit `<unbound>` claim label and a dashed chip border — that's the `D-v3-104` affordance.
- New REST: `GET /api/channels` lists the channel registry for debug + frontend tab-strip enrichment.

The original deferral note read *"workaround for v3 terminal-first usage: the user opens a terminal per CEO and types briefs directly. The dashboard remains read-only for chat."* That workaround is no longer required — multi-CEO chat is end-to-end functional in v3.

---

## 16. Implementation phases

### Phase 1 (this design, ship-ready)

1. **`substrate/bin/golem` extension** — add `session start/list/stop/claim/release` and `project register/unregister/list/info` and `status`. Implement registry I/O with flock + atomic write. PID-liveness GC. Stable stderr-JSON. Auto-register `golem-root`. ~600 lines of bash, structured per existing command-handler style.
2. **`substrate/scripts/team-monitor.sh`** — per §13.
3. **`.claude/hooks/journal-event.sh`** — append `golem session release` tail step on `session-end` (§14).
4. **`substrate/personas/golem-ceo.md`** — apply all §11 edits.
5. **`substrate/skills/golem-handoff-protocol/SKILL.md`** — apply all §12 edits.
6. **Persona path-updates** — Scout / Prospector / Smelter / Meta now reference `golem-projects/<name>/docs/ideation/` paths instead of `golem-ideas/<name>/`. Mechanical edit.
7. **`dashboard/server/projects.js`** — read `~/.config/golem/projects.json` on top of auto-scan, append-and-dedup by path.
8. **`dashboard/server/orchestrator.js`** — read `~/.config/golem/sessions.json`, list one CEO per row.
9. **Self-test pass** — `golem doctor` extended, smoke-test each new subcommand, verify happy path of claim/release with a dummy session.

### Phase 2 (promoted into v3 — was deferred, now shipped)

- Channel server `session_id`-keyed routing (D-v3-102). **Shipped.**
- Dashboard chat drawer UX restructure (D-v3-103). **Shipped — per-session chips on rail + tab strip inside drawer.**
- Unbound-CEO UI affordance (D-v3-104). **Shipped — `<unbound>` chip + dashed border.**

### Phase 2 (still deferred, post-Phase-1 learnings)

- Optional: `golem team teardown` CLI if F5 recurs.
- Optional: `golem lint-settings` CLI if F1 recurs.
- Optional: backend-selection investigation if F2 recurs.

---

## 17. Decisions log

Locked (committed direction):

- `D-v3-001` — Two registry files at `~/.config/golem/`: `projects.json` (durable, no claim state) + `sessions.json` (ephemeral, claim as field on session row). Atomic write via temp + `rename(2)`, serialised with `flock(2)`. (§3)
- `D-v3-002` — CEO-per-project session model with locking. Claim is mandatory and codified as a Critical persona rule. Push-back-on-conflict, no retries, lock release on SessionEnd. Crash recovery via PID liveness (`kill -0`). (§5)
- `D-v3-003` — `$GOLEM_ROOT` is a regular project (auto-registered as `golem-root`, kind `root`). No special case. (§3.4, §5.2)
- `D-v3-004` — Mid-session rebinding supported via `release` + `claim`. If the second claim fails, CEO is unbound and pushes back. (§5.4)
- `D-v3-005` — Team-name namespacing: every iterative-team `team_name` includes the `project_id`. (§8)
- `D-v3-006` — Ideation reordered: substrator runs FIRST (full harness); ideation runs INSIDE the project. `golem-ideas/` workspace kind is retired. (§10)
- `D-v3-007` — Session_id propagation via `claude --session-id <uuid>` at spawn + CEO reads `$CLAUDE_CODE_SESSION_ID` in Bash. Verified. (§6)
- `D-v3-008` — CLI surface (§4) is the public contract. Exit-code contract (§4.2) is part of it.
- `D-v3-009` — Team supervision uses Claude Code's `Monitor` primitive, one invocation per team, canonical signal set in §13. CEO intervenes per the §9.3 decision table. (§9)
- `D-v3-010` — F1 (permission-modal dead-on-arrival) and F5 (orphan tmux processes after `TeamDelete`) handled procedurally in persona + skill; **no new CLI / infrastructure**. Revisit if either recurs. (§9.5, §9.6)
- `D-v3-011` — Productive-turn-1 norm enforced through wording in personas / skill, not lint. Revisitable. (§9.7)
- `D-v3-012` — Backend-aware spawn handling via tool-return text inspection. Known fragility. (§9.4)
- `D-v3-013` — Monitor wrapper at `substrate/scripts/team-monitor.sh`; CEO uses single canonical invocation. (§13)
- `D-v3-014` — Directory restructure: `$GOLEM_ROOT = ~/Documents/software/experiments/golem/`. All in-tree projects under `golem/golem-projects/`. External projects anywhere on disk + registry. (§2)
- `D-v3-015` — Dashboard registry reads (`projects.json`, `sessions.json`, `channels.json`) ship in v3; channel-server routing + per-CEO drawer ALSO shipped (revised from original Phase-2 deferral). PID-liveness filter strips ghost CEOs from both the sessions list and the journal-derived agents table. (§15)
- `D-v3-102` — **Shipped.** Channel server reads `CLAUDE_CODE_SESSION_ID`, binds an ephemeral port via `GOLEM_CHANNEL_PORT=0` (the CLI's new default), and registers `{session_id, host, port, pid}` to `~/.config/golem/channels.json`. Dashboard `chat.js` multiplexes one SSE consumer per session; `brief.js` routes by `session_id`. (§15)
- `D-v3-103` — **Shipped.** Each live CEO renders as a clickable chip on the orchestrator rail; the drawer carries a session-tab strip when more than one CEO is live, with messages filtered to the active session. (§15)
- `D-v3-104` — **Shipped.** Unbound CEOs render with `<unbound>` claim label + dashed chip border. (§15)

Revisit triggers (deferred-with-tripwire):

- `D-v3-200` — `golem lint-settings <project-path>` CLI for F1 prevention. Trigger: F1 recurs.
- `D-v3-201` — `golem team teardown <team_name>` CLI for F5 hygiene. Trigger: orphans observed > once.
- `D-v3-202` — Backend-selection-heuristic investigation. Trigger: F2 recurs after `D-v3-011` wording fixes.
- `D-v3-203` — Hook-based F1 detection via `Notification` event. Trigger: investigation confirms the event is emitted before the modal blocks.
