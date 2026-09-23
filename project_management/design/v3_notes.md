# Golem · v3 Notes

Pre-design scratch for v3. Becomes `design_v3.md` once the open brainstorms below converge.

---

## Themes on the table

1. **Project registry** — work with projects outside `golem-projects/` (e.g. trialroomai). **Direction committed.** See §1.
2. **Multi-CEO sessions** — one CEO per project so multiple projects run iterative teams in parallel (Claude Code allows only one team per session). **Direction committed.** See §2.
3. **Teammate health monitoring** — the CEO must detect spawned teammates that idle for the wrong reasons (permission prompts, faulty settings, deadlocked SendMessage loops) rather than blocking on `Agent(…)` indefinitely. **Direction committed.** See §3.

---

## §1. Project registry — committed direction

### Problem

`v2` only discovers projects under `$GOLEM_ROOT/golem-projects/<name>/`. External projects (e.g. `~/Documents/software/trialroomai/`) can't be brought into the substrate without moving / symlinking them, which loses their existing git history & tooling identity.

### Shape

A single JSON registry file, written by two paths (CEO during bootstrap / retrofit + explicit `golem` CLI), read by one consumer (dashboard discovery).

**Location:** `~/.config/golem/projects.json` (XDG-style, machine-wide). Rationale: independent of `$GOLEM_ROOT`, survives a substrate-repo rebase, single file = atomic writes.

**Shape:**

```json
{
  "version": 1,
  "projects": [
    {
      "id": "factscroll",
      "name": "FactScroll",
      "path": "/Users/.../golem-projects/factscroll",
      "kind": "project",
      "registered_at": "2026-05-12T15:00:00Z",
      "registered_by": "ceo" | "cli",
      "last_seen_ok": "2026-05-13T09:00:00Z"
    },
    {
      "id": "trialroomai",
      "name": "TrialRoom AI",
      "path": "/Users/.../trialroomai",
      "kind": "external",
      "registered_at": "...",
      "registered_by": "cli"
    }
  ]
}
```

`kind` discriminates:
- `project` — under canonical `golem-projects/` (still auto-discovered; registry entry optional, only present if the CEO recorded it).
- `external` — anywhere else. Registry entry is the only way the dashboard knows about it.
- `idea` — under `golem-ideas/` (not registry-tracked; auto-discovered).

### Write paths

**Implicit — CEO during bootstrap / retrofit.** Adds a step to:
- `golem-ceo.md` §A.2 (Bring-up): after `git init` + initial commit, append a registry entry with `kind=project` (or `kind=external` if the project path is outside `$GOLEM_ROOT/golem-projects/`).
- `golem-ceo.md` §A.4 (Retrofit): after substrator returns, same append.

Implemented as a tiny helper that the CEO calls via Bash (`golem register --path <abs> --name <pretty> --kind <project|external>`).

**Explicit — `golem` CLI subcommands.** Manual control for cases the CEO didn't cover (pre-existing harness, deregistration, listing, fixing a stale path).

```
golem register   --path <abs> [--name <pretty>] [--kind project|external]
golem unregister <id>
golem list       [--kind <kind>]
```

Both paths converge on the same `registry.js` helper (lock-file + atomic temp+rename, since multiple CEOs could write concurrently in v3).

### Read path

`dashboard/server/projects.js` adds a `discoverFromRegistry()` step alongside the existing `discoverRoot()` + `discoverProjects()` (golem-projects scan) + ideas scan. Order of resolution:

1. Root workspace (`$GOLEM_ROOT`), if present.
2. Auto-scan `golem-projects/*/` (preserves current behaviour for in-tree projects).
3. Read registry; append every entry whose `path` isn't already discovered.
4. Auto-scan `golem-ideas/*/`.

De-dup by absolute `path`. Entries whose path no longer exists get logged once and skipped (`last_seen_ok` is the dashboard's hook to remember when the path was last valid — useful for warning before unregistration).

### Watcher implications

Chokidar's `watchedPaths()` already iterates `projects` and watches each `hookFile` / `summaryFile` / `trackerDir` / `gatesDir`. External projects join the same loop. No structural change.

### Hard rules

- Never rewrite an existing entry on `register` — error if the `id` or `path` collides. User must `unregister` first.
- Atomic write only (temp file + `rename(2)`). Never partial-write the JSON.
- Pretty-print + stable key order so the file is git-friendly if the user wants to version it.

---

## §2. Multi-CEO sessions — committed direction

The core constraint (verified, docs-cited at https://code.claude.com/docs/en/agent-teams#limitations): a single Claude Code session holds **one** active team at a time. To run iterative teams across projects in parallel, we need one CEO session per project. The CEO persona itself doesn't change — it's the same persona running independently in N sessions.

Two registries hold all the durable joint state. Locks are session-bound; project metadata is independent of who's working on it.

### §2.1 Lifecycle and locking model

**One project ↔ at most one live CEO claim.** Enforced as a registry invariant, not a convention.

**Claiming is mandatory.** Codified in the CEO persona as a Critical rule: after Step 2 (classify brief), once the CEO knows which project it will work on, it MUST acquire a lock before any sub-agent dispatch. Lock acquisition failure → push back to the user via `respond`, close with the reflex, yield. No retries. No silent proceed.

**`$GOLEM_ROOT` is a regular project.** Auto-registered with `id: "golem-root"`, `kind: "root"`. Same claim semantics — meta-work on the substrate itself requires claiming `golem-root`. Removes the "special case" carve-out.

**Ideation reordered.** Barebones project namespace (journal, .claude/hooks, stub CLAUDE.md) is created and claimed BEFORE Scout/Prospector/Smelter run, so every persona's events get journalled from event #1. Substrator's mandate stays unchanged for the "full harness lay-down" phase; the barebones bootstrap is a CEO-direct Bash step (mkdir + cp from template + git init).

**Mid-session rebinding allowed.** `release` then `claim` a different project. If the second claim fails, the CEO is unbound and must push back.

**Lock release on session end.** SessionEnd hook in `$GOLEM_ROOT/.claude/settings.json` (and per-project settings.json) calls `golem session release` for the current session_id. Best-effort.

**Crash recovery via PID liveness, no heartbeat.** Every `claim` call performs `kill -0 <stored_pid>` on any conflicting entry; dead → GC the stale row, proceed. Heartbeat-based GC kept as a future fallback (§4); not needed for single-machine v3.

**Team names must be project-namespaced.** CEO persona examples rewritten:

```
TeamCreate(team_name: "specs-<project_id>")
TeamCreate(team_name: "arch-<project_id>")
TeamCreate(team_name: "tdd-<project_id>-tkt-<ticket_id>")
```

Reason: Claude Code's team registry at `~/.claude/teams/<name>/` is machine-global, so two CEOs running team-spawn on different projects with un-namespaced `team_name` collide.

### §2.2 CLI surface

```
golem session start   [--project <id|path>] [--root] [--detach]
the v3 session roster command [--json] (now `golem agent list`)
golem session stop    <session-id|--all> [--force]
golem session claim   <project|--root> [--session-id <uuid>]
golem session release [--session-id <uuid>] [<project>]

golem project register   <path> [--name <pretty>] [--id <slug>]
golem project unregister <id|path> [--force]
golem project list       [--json]
golem project info       <id>

golem dashboard           (unchanged)
golem status              (combined snapshot — sessions + projects + dashboard URL)
```

| Caller | Commands |
|---|---|
| **User** (interactive) | `session start / list / stop`, `project register / unregister / list / info`, `dashboard`, `status` |
| **CEO** (Bash, in-session) | `session claim`, `session release`, `project register` (on bootstrap/retrofit) |

**Canonical CEO incantations** (the persona's hot path — single mechanical call each):

```bash
golem session claim <project>
golem session release
golem project register <abs-path> --name "<pretty>" [--id <slug>]
```

The session_id is read from the auto-set `$CLAUDE_CODE_SESSION_ID` env var when `--session-id` is omitted. The CEO does NOT pass `--pid` — PID is recorded once at spawn time and consulted internally by the CLI for liveness checks.

### §2.3 Exit-code contract (load-bearing)

Every CLI command returns `0` on success or a documented non-zero code with stable stderr-JSON. The CEO's "push-back on conflict" rule depends on parseable output.

| Code | Meaning |
|---|---|
| `0`  | OK |
| `2`  | Bad invocation (missing arg, unknown project) |
| `10` | Lock conflict (another live session holds the claim) |
| `11` | Stale lock GC'd; retry succeeds (only emitted under `--no-auto-gc`) |
| `12` | Wrong-session release attempt (session_id mismatch) |
| `20` | Registry write failed (disk / permissions / lock contention) |
| `30` | Project not registered |

On code `10`, stderr emits a single JSON line:

```json
{"error":"lock_conflict","project":"factscroll","held_by":{"session_id":"…","pid":12345,"since":"2026-05-13T10:01:00Z","cwd":"/Users/.../experiments"}}
```

The CEO reads this with `Read` (no shell pipes) and includes the held_by info in its `respond` push-back.

### §2.4 Session-id propagation (verified)

Docs verified:

- **`claude --session-id <uuid>`** is documented (https://code.claude.com/docs/en/cli.md). Caller supplies a UUID; Claude Code uses it as the session_id for the new conversation. **Pre-assignment works.**
- **`CLAUDE_CODE_SESSION_ID`** is automatically set in every Bash subprocess Claude Code spawns (https://code.claude.com/docs/en/env-vars.md). Matches the `session_id` in hook payloads, updated on `/clear`. **The CEO reads its own session_id from this env var.**
- **`SessionStart` hook** fires with `session_id` in the common-fields payload — already journalled. Belt-and-suspenders only; the wrapper already knows the session_id because it generated it.

Resulting mechanism:

1. `golem session start` generates a UUID-v4, appends a row to `sessions.json` with `pid = -1` placeholder, then `fork()` + `exec("claude", "--session-id", <uuid>, "--append-system-prompt-file", …)`. Parent updates the row with the real child PID once `exec` returns.
2. Inside the CEO, the persona-canonical Bash calls (`golem session claim <project>`, `golem session release`) read `$CLAUDE_CODE_SESSION_ID` to identify themselves. No `--session-id` flag needed in the hot path.

The PID concern (`getppid()` ambiguity through wrapper shells) is resolved by recording PID once at spawn time, not on every claim. PID is only used internally for liveness checks against conflicting sessions.

### §2.5 Registry shapes

**`~/.config/golem/projects.json`** — durable project metadata, no claim state:

```json
{
  "version": 1,
  "projects": [
    { "id":"golem-root", "name":"Golem Root", "path":"/Users/.../experiments",          "kind":"root",     "registered_at":"..." },
    { "id":"factscroll", "name":"FactScroll", "path":"/Users/.../golem-projects/factscroll", "kind":"project",  "registered_at":"..." },
    { "id":"trialroomai","name":"TrialRoom AI","path":"/Users/.../trialroomai",          "kind":"external", "registered_at":"..." }
  ]
}
```

`golem-root` is auto-registered on first `session start` (idempotent).

**`~/.config/golem/sessions.json`** — ephemeral session state with claim as a join field:

```json
{
  "version": 1,
  "sessions": [
    {
      "session_id": "uuid",
      "pid": 12345,
      "boot_time": "2026-05-13T10:00:00Z",
      "claimed_project": "factscroll",
      "claimed_at": "2026-05-13T10:01:00Z",
      "last_seen_at": "2026-05-13T10:30:00Z",
      "dashboard_url": "http://localhost:4173"
    }
  ]
}
```

Claim is a field on the session row, not a separate table — one-to-at-most-one, killing the session row cleans the claim atomically. "Is project X claimed?" scans `sessions.json`.

Both files: atomic write via temp + `rename(2)`, with `flock(2)` to serialise concurrent writers (machine-local; cheap).

### §2.6 Critical-path flows

**Flow A — clean session start, bound at spawn**

```
user $ golem session start --project factscroll
        ├─ project lookup: id=factscroll, path=…/factscroll ✓
        ├─ generate UUID-v4
        ├─ sessions.json append: {session_id, pid:-1, claimed_project:factscroll, ...}
        ├─ atomic conflict check: any OTHER session.claimed_project=factscroll? kill -0 → fail with code 10
        ├─ exec `claude --session-id <uuid> --append-system-prompt-file …/golem-ceo.md`
        └─ post-exec: update sessions.json with real PID
```

**Flow B — rootless start, claim later (ideation)**

```
user $ golem session start
        └─ session row created with claimed_project=null

user: "explore async-meeting tools"
CEO:
  1. classify ideation
  2. name the project → "async-meeting-tools"
  3. mkdir golem-projects/async-meeting-tools + barebones harness (journal, hooks, stub CLAUDE.md)
  4. $ golem project register <path> --name "Async Meeting Tools"
  5. $ golem session claim async-meeting-tools
  6. → Scout / Prospector / Smelter, all journalled from event #1
  7. On Smelter pick → dispatch substrator (full mode) to flesh out the harness
```

**Flow C — mid-session rebind**

```
CEO: factscroll done, user: "now help on trialroomai"
CEO: $ golem session release
CEO: $ golem session claim trialroomai
       ├─ ok → continue
       └─ conflict → push back, do NOT auto-reclaim factscroll
```

**Flow D — crash recovery**

```
CEO segfaults; no SessionEnd fires.
Next CEO: $ golem session claim factscroll
  ├─ read sessions.json, find stale entry
  ├─ kill -0 <stale_pid> → process dead
  ├─ GC stale row (atomic rewrite)
  └─ proceed
```

**Flow E — clean session end**

```
CEO closes normally.
SessionEnd hook → journal-event.sh session-end
  → at end of the hook script: golem session release --session-id $CLAUDE_CODE_SESSION_ID
                                              ↳ no-op if already released
```

### §2.7 First-cut scope vs deferred

**Ship first:**
- `golem session start [--project X]`
- the v3 session roster command (now `golem agent list`)
- `golem session claim <project>` / `release`
- `golem project register / unregister / list`
- Auto-registration of `golem-root`
- SessionEnd hook → `golem session release`
- Persona rewrite: claim-as-Critical-rule, namespaced team names, ideation reorder

**Defer (no architectural rework needed to add later):**
- `golem session stop` (user can `kill <pid>` for now)
- `golem project info`
- `golem status`
- `--json` everywhere
- Heartbeat-based GC fallback (PID liveness covers v3)

### §2.8 Resolved open questions

- ✓ **`claude --session-id <uuid>` works** for pre-assignment.
- ✓ **`CLAUDE_CODE_SESSION_ID`** is the canonical env var the CEO reads inside Bash.
- ✓ **PID propagation is a non-issue** — recorded once at spawn, never passed by the CEO.
- ✓ **Root workspace** is a regular project, not a special case.
- ✓ **Mid-session rebind** is supported.
- ✓ **Team-name namespacing** is required.

### §2.9 Still-open (dashboard-side, not blocking CLI)

- Channel server routing — needs `session_id`-keyed connection map; brief routing keyed by target session_id (chosen by dashboard's chat drawer).
- Chat drawer UX — per-CEO tab, persistent drawer that follows the current project view, or per-project drawer. To settle when we get to frontend.
- "Unbound CEO" UI affordance — how the dashboard surfaces a session that hasn't claimed anything yet.

---

## §3. Teammate health monitoring — committed direction

### §3.1 The failure-class taxonomy (from the CEO's field notes)

Observed and anticipated failure modes the CEO must defend against, grounded in `golem-projects/factscroll/docs/agent-notes/team-mechanics-2026-05-13.md` and `golem-projects/archive/factscroll/docs/agent-notes/substrate-bug-fork-bomb-deny.md`:

| # | Failure | When it fires | Hook-visible? |
|---|---|---|---|
| **F1** | **Dead-on-arrival permission modal.** Malformed `.claude/settings.json` (observed: an empty-parentheses deny rule for the bash fork-bomb pattern) → Claude Code surfaces a `Settings Warning` confirmation prompt at startup. Teammate process exists but is parked on TTY input forever. | At sub-agent spawn, before turn 1 | **No** — process is parked before any hook fires |
| **F2** | **Synchronous-backend silent termination.** Claude Code's `Agent(team_name=…)` silently picks one of two backends (synchronous subagent vs tmux-backed teammate). On the synchronous backend, a teammate that ends turn 1 (often because the prompt told it to "wait for SendMessage") is **terminated** by `end_turn`. SendMessage to a terminated name still persists to the inbox (no error signal); message orphans. | Turn 1 to ~turn 3 | Partially — one `Stop` event fires, then silence; visually indistinguishable from normal idle |
| **F3** | **Genuine mid-work stall.** Teammate doing real work hits a model error, API quota, network blip, or mid-tool-call permission denial. | Mid-team | Yes — last hook timestamp ages |
| **F4** | **Deadlocked SendMessage loop.** A waits B, B waits A. Both teammates show recent idle but no `send-message` traffic. | Late in a loop | Yes — both teammates idle, both inboxes have unread peer-messages |
| **F5** | **TmuxDelete orphan processes.** `TeamDelete` removes team config + inbox dirs but does NOT kill tmux-backed teammate processes. Orphans consume CPU / memory indefinitely. Re-creating a team with the same name does not re-attach orphans; status bar still shows them as live. | After (apparent) team success | No — orphans sit silent |

The CEO's note also documented the two-backend distinction:

- **Synchronous subagent backend.** `Agent(...)` blocks until the subagent yields. Transcripts under `~/.claude/projects/<session>/subagents/agent-<id>.jsonl`. `end_turn` = termination.
- **Tmux-backed teammate.** `Agent(...)` returns immediately ("Spawned successfully ... will receive instructions via mailbox"). Teammate runs in a tmux session (e.g. `tmux -L claude-swarm-<pid>`). Transcripts under `~/.claude/projects/<project>/<uuid>.jsonl`. `end_turn` is true idle; SendMessage wakes the recipient. The heuristic that selects between backends is empirically not yet identified.

### §3.2 Direction — Monitor + CEO procedural responsibility

The CEO acts as a real-world team lead: actively supervising via Claude Code's `Monitor` tool, intervening on detectable signals, and following procedural rules for the cases Monitor can't catch. No new external infrastructure (no sidecar, no MCP server, no dashboard watchdog).

#### §3.2.1 Primary mechanism: Monitor per team

After every `TeamCreate + Agent(...)` for an iterative loop, the CEO starts a `Monitor` watching the team. The script polls every ~5 s and emits a stdout line — which becomes a new conversation turn for the CEO — on each meaningful transition. The signal set:

1. **Inbox length increment** for any teammate (with truncated body).
2. **`isActive` transition** for any teammate (e.g. `pa: true → false`).
3. **Transcript `mtime` stale > 120 s while `isActive=true`** — stall alert.
4. **Verdict tokens** detected in any new transcript line (`approve`, `request-changes`, `block`).
5. **Convergence exit** — when both members have `isActive=false` AND no inbox has an unread peer-message, Monitor exits cleanly.

On each event the CEO applies a decision table:

| Signal | CEO action |
|---|---|
| Inbox+1 normal handoff | Log only (continue waiting) |
| Verdict token (`approve` / `request-changes` / `block`) | Log; convergence may be imminent |
| `isActive: true → false` unexpectedly (no convergence) | Diagnose: re-spawn with corrective prompt OR mark team failed |
| Stall alert (mtime > 120 s while active) | Polite `SendMessage` nudge ("still working?") before assuming hung |
| Stall persists across two nudges | Treat as F3/F4; escalate via `respond` + escalation memo |
| Both members `isActive=false` but inboxes still have unread peer-messages | Team is on synchronous-backend with orphaned messages — re-spawn the addressee |

**Decision: F2/F3/F4 are detected through Monitor and handled by the CEO inline.** This replaces the earlier sketches of out-of-band watchdog process / dashboard liveness derivation / per-teammate self-watchdog skill — all three are subsumed.

#### §3.2.2 Backend-aware spawn handling

The CEO branches on the `Agent()` tool-return shape to know which backend it landed on:

- Tool-return text begins with **"Spawned successfully ... will receive instructions via mailbox"** → tmux backend. `Agent()` already returned; start Monitor immediately, wait for events.
- Tool-return contains an `agentId` and synchronous subagent payload → synchronous backend. The call already blocked-and-returned; Monitor would have nothing to watch.

Pattern-matching tool-return text is fragile but the docs offer nothing cleaner today; codify with a comment that it's a known fragility.

#### §3.2.3 Procedural cover for F1 and F5 — persona-only

For F1 (permission-modal dead-on-arrival) and F5 (orphan tmux processes after TeamDelete) we are **not** adding new infrastructure (no static lint, no `golem team teardown` CLI). The cost / benefit of building those is not yet justified — the failures have been observed once each and may not recur once the underlying causes are fixed (the malformed deny rule is already removed from the template).

Instead, the CEO persona and `golem-handoff-protocol` skill carry explicit procedural rules:

- **F1 procedural rule.** On any team-spawn that lands with Monitor flagging mtime-stale > 120 s within the first 3 min AND `isActive` never transitioned to true, the CEO must `tmux capture-pane` on the swarm socket to diagnose. If a "Settings Warning" modal is visible: dismiss via `tmux send-keys Enter`, then file a substrate-bug memo + escalate to user with the offending rule. **If the failure mode recurs across multiple bring-ups, revisit the static-lint decision.**
- **F5 procedural rule.** The CEO post-team-convergence checklist (codify in `golem-handoff-protocol` and CEO persona §6):
  1. After convergence, `SendMessage({type: "shutdown_request"})` to every teammate.
  2. Wait for `shutdown_response`.
  3. Read `~/.claude/teams/<team_name>/config.json`; verify every member has `isActive: false`.
  4. Call `TeamDelete()`.
  5. Verify with `ps -ef | grep agent-id` — expected empty.
  6. If any step fails, kill stragglers explicitly via tmux session kill.
- **Prevention via instructions (not infra).** Adjust persona / skill copy so teammate spawn prompts produce real work on turn 1 (the PAR "pre-bake review" pattern from the agent-notes) rather than instructing teammates to "wait for the first SendMessage." This is wording-level guidance — not enforced by a lint — and is revisitable if synchronous-backend silent termination keeps biting.

If F1 or F5 recur after these procedural fixes, escalate to infra: a `golem lint-settings` CLI for F1 prevention, a `golem team teardown` CLI for F5 hygiene.

#### §3.2.4 Tradeoffs the design accepts

The CEO's own note flagged these honestly; they are real costs of the Monitor-primary approach:

- **Context-window cost.** Each Monitor event = one CEO conversation turn. A 4-min team convergence may emit 10–20 events; a 30-min dev team may emit 30–50. Each costs context tokens + a model call. Mitigation: strict, canonical filter (the §3.2.1 signal set is the spec; not hand-written per dispatch).
- **Filter discipline.** The Monitor command should be a packaged script, not hand-rolled per spawn. Worth shipping `golem/substrate/scripts/team-monitor.sh <team_name>` so the CEO invokes it via a single `Monitor(command: "bash …/team-monitor.sh specs-factscroll")` instead of writing the grep/awk inline every time.
- **Autonomy-contract shift.** The current persona rule says "Agent calls are synchronous; main thread blocks." That is true on the synchronous backend, false on the tmux backend. Persona text needs the branch: on tmux-backend spawn, `Agent()` returns immediately → start Monitor → wait for Monitor-delivered events → respond as they arrive.
- **Monitor's own failure modes.** Monitor scripts can crash or be timed out (max 1 h, or `persistent: true`). Persona rule: if no Monitor event has arrived for ≥ 10 min during a known-live team, the CEO must directly `Read` the team config + a teammate transcript to confirm Monitor is still functioning. If it's dead, restart it.
- **Stall threshold is project-dependent.** 120 s suits PA↔PAR-class loops. Long-thinking dev-team turns may need 300 s+. Configurable per spawn via the Monitor wrapper script (or per-team override file). Default starts at 120 s.

### §3.3 What this replaces from the earlier brainstorm

- Direction A (out-of-band watchdog process) — **dropped**. Monitor covers it more cleanly and uses a Claude Code primitive instead of new infra.
- Direction B (dashboard-side derived `stalled` status) — **dropped** for the supervision role. A dashboard `stalled` indicator may still be useful as an observability affordance for the human user, but it is not the CEO's primary mechanism.
- Direction C (per-teammate self-watchdog skill) — **dropped**. Pushes responsibility to the wrong layer; the team lead supervises, not the teammates.

### §3.4 Investigations still worth doing (not blocking)

These don't block the committed direction but would tighten it:

- **Identify the backend-selection heuristic.** Three controlled dispatches: (a) `TeamCreate` immediately followed by parallel `Agent()` calls in same turn, (b) `TeamCreate` immediately followed by sequential `Agent()` calls, (c) `Agent(team_name=…)` when the team was created in a prior turn. Goal: knowing in advance which backend a spawn will land on, so the CEO can avoid the synchronous backend deliberately.
- **Does the `Notification` event surface the permission-modal class?** If yes, F1 becomes hook-detectable and Monitor can flag it inside ~5 s instead of waiting 120 s for the mtime-stale signal. (Intuition: probably no — the modal blocks before any hook can run — but worth a quick check.)
- **Soft-timeout norms per team-type.** PA↔PAR may converge in 5 min; dev team may take 30+. Encoding a per-team-type expected-duration would let the CEO recognise "this is taking longer than the type usually does" earlier than the raw 120 s mtime threshold.

---

## §4. To revisit / parked

- **Rolling per-agent hook frontmatter to the remaining 15 personas.** Mechanical task; pending. Should be done as part of v3's first sub-pass once registry lands.
- **`teammate-idle` wiring for future teammate personas** (TA, TAR, dev-team members). Same wave as the previous bullet.
- **Test-specs as local files** (carried from v2_notes N-003) — still not done. Probably becomes a v3.X work item once core v3 lands.
- **Modus Operandi (Quick / Defer / Thorough)** (carried from v2_notes N-001) — also still deferred.

---

## §5. Decisions log

**Locked (committed direction):**

- `D-v3-001` — Registry shape: two files, `~/.config/golem/projects.json` (durable, no claim state) + `~/.config/golem/sessions.json` (ephemeral, claim as field on session row). Atomic write via temp + `rename(2)`, serialised with `flock(2)`. (§1, §2.5)
- `D-v3-002` — CEO-per-project session model with locking. Claim is mandatory and codified as a Critical persona rule. Push-back-on-conflict, no retries, lock release on SessionEnd. Crash recovery via PID liveness (`kill -0`). (§2.1)
- `D-v3-003` — `$GOLEM_ROOT` is a regular project (auto-registered as `golem-root`, kind `root`). No special case. (§2.1)
- `D-v3-004` — Mid-session rebinding supported via `release` + `claim`. If the second claim fails, CEO is unbound and pushes back. (§2.1)
- `D-v3-005` — Team-name namespacing: every iterative-team `team_name` includes the `project_id`. Rewrite persona examples + handoff-protocol skill. (§2.1)
- `D-v3-006` — Ideation reordered: barebones project namespace + claim happens BEFORE Scout/Prospector/Smelter. CEO does the barebones bootstrap directly via Bash. Substrator's mandate stays single-mode (full harness lay-down). `golem-ideas/` workspace kind is retired. (§2.1)
- `D-v3-007` — Session_id propagation: pre-assign UUID via `claude --session-id <uuid>` at spawn; CEO reads `$CLAUDE_CODE_SESSION_ID` in Bash calls. Verified against Claude Code docs (§2.4).
- `D-v3-008` — CLI surface as specified in §2.2. Exit-code contract (§2.3) is part of the public CLI contract.
- `D-v3-009` — Teammate health supervision uses Claude Code's `Monitor` primitive, one invocation per team, with the canonical signal set in §3.2.1. The CEO is the team lead — it reads Monitor events as conversation turns and intervenes per the §3.2.1 decision table. Replaces the earlier watchdog-process / dashboard-liveness / per-teammate-self-watchdog directions. (§3.2)
- `D-v3-010` — F1 (permission-modal dead-on-arrival) and F5 (orphan tmux processes after `TeamDelete`) are handled by **procedural rules in the CEO persona + handoff-protocol skill**, not by new CLI / infrastructure. Static lint of `.claude/settings.json` and a `golem team teardown` CLI are explicitly deferred until either failure recurs in practice. (§3.2.3)
- `D-v3-011` — Persona / skill copy will be updated to favour the "produce real work on turn 1" pattern (the PAR pre-bake review) over "wait for first SendMessage" instructions, to reduce synchronous-backend silent-termination (F2) risk. Wording-only guidance, not enforced by a lint. Revisitable if F2 keeps biting. (§3.2.3)
- `D-v3-012` — Backend-aware spawn handling: CEO branches on the `Agent()` tool-return shape ("Spawned successfully ... mailbox" → tmux; `agentId` payload → synchronous) to decide whether to start Monitor and supervise. Codified with a comment that pattern-matching tool-return text is a known fragility. (§3.2.2)
- `D-v3-013` — Monitor wrapper script lives at `golem/substrate/scripts/team-monitor.sh <team_name>`; the canonical CEO invocation is `Monitor(command: "bash …/team-monitor.sh <team_name>")` rather than hand-rolled grep/awk per dispatch. (§3.2.4)

**Open (still to decide):**

- `D-v3-102` — Channel routing: session_id-keyed connection map on the channel server; brief-routing target chosen by dashboard's chat drawer (not auto-inferred from brief content).
- `D-v3-103` — Dashboard chat drawer UX (per-CEO tab vs persistent drawer following project view vs per-project drawer).
- `D-v3-104` — "Unbound CEO" UI affordance.

**Revisit triggers (decisions deliberately deferred — committed if these trigger):**

- `D-v3-200` — `golem lint-settings <project-path>` CLI for F1 prevention. Trigger: F1 (permission-modal dead-on-arrival) recurs on any bring-up after `D-v3-010` is in effect.
- `D-v3-201` — `golem team teardown <team_name>` CLI for F5 hygiene. Trigger: orphan tmux processes observed after a clean `TeamDelete` on more than one occasion.
- `D-v3-202` — Investigate Claude Code's backend-selection heuristic with controlled dispatches. Trigger: F2 silent-termination recurs after `D-v3-011` wording fixes are in place. (Until then, Monitor + procedural recovery is sufficient.)
- `D-v3-203` — Hook-based F1 detection if `Notification` event surfaces the permission-modal class. Trigger: investigation confirms the event is emitted before the modal blocks.
