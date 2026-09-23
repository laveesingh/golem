#!/usr/bin/env bash
# GENERATED: hooks/session-register.sh — rendered by `golem sync` from substrate/ — edit the source, not this file.
#
# session-register.sh — SessionStart hook for the golem v4 plugin.
#
# Responsibilities:
#   1. Resolve the project root (walk up from $PWD to .git/CLAUDE.md; fallback
#      $CLAUDE_PROJECT_DIR).
#   2. Derive a stable project_id = <dirname-slug>-<6 hex of sha256(abs path)>.
#   3. Atomically upsert ~/.config/golem/projects.json with an auto entry —
#      NEVER overwriting an existing entry's name/kind (manual entries win),
#      only bumping last_seen.
#   4. Atomically upsert ~/.config/golem/sessions.json with this session.
#   5. Check project-scoped substrate drift for this (project, harness) and, if
#      dirty, launch a detached render. This is fail-open and logs only.
#   6. Emit NO sessionTitle — naming is left entirely to the user's /rename
#      (auto-titling clobbered the chosen name on every resume).
#
# Safety: set -u, bash-3.2 compatible (macOS default), every failure exits 0
# and never blocks the session. Uses the same atomic mkdir-lock pattern as
# plugin/mcp/channel/index.js.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=./_golem-home.sh
. "$SCRIPT_DIR/_golem-home.sh"

CONFIG_DIR="$GOLEM_HOME_DIR"
PROJECTS_JSON="$CONFIG_DIR/projects.json"
SESSIONS_JSON="$CONFIG_DIR/sessions.json"

# --- read hook payload from stdin -----------------------------------------
PAYLOAD="$(cat 2>/dev/null || true)"

SESSION_ID=""
RAW_SESSION_ID=""
SESSION_NAME=""
CWD="$PWD"
# harness: which agentic harness this session runs under. CC sends no such
# field (defaults to claudecode). Additive — old readers
# ignore it.
HARNESS="claudecode"
MODEL=""
if command -v jq >/dev/null 2>&1 && [ -n "$PAYLOAD" ]; then
  SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null || true)"
  RAW_SESSION_ID="$SESSION_ID"
  _pcwd="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null || true)"
  [ -n "$_pcwd" ] && CWD="$_pcwd"
  _ph="$(printf '%s' "$PAYLOAD" | jq -r '.harness // empty' 2>/dev/null || true)"
  [ -n "$_ph" ] && HARNESS="$_ph"
  MODEL="$(printf '%s' "$PAYLOAD" | jq -r '.model // .modelID // .model_id // .session.model // .session.modelID // .info.model // .info.modelID // empty' 2>/dev/null || true)"
fi

# Claude Code resume/reload can pass a fresh per-run id in the hook payload.
# The stable logical id and /rename name live in the long-lived parent session
# file keyed by the parent pid. Prefer that id so sessions.json, channels.json,
# and ~/.claude/sessions agree on one identity.
if [ "$HARNESS" = "claudecode" ] && command -v jq >/dev/null 2>&1; then
  PARENT_SESSION_FILE="${HOME:-}/.claude/sessions/${PPID:-}.json"
  if [ -f "$PARENT_SESSION_FILE" ]; then
    _sid="$(jq -r '.sessionId // .session_id // empty' "$PARENT_SESSION_FILE" 2>/dev/null || true)"
    _sname="$(jq -r '.name // empty' "$PARENT_SESSION_FILE" 2>/dev/null || true)"
    [ -n "$_sid" ] && SESSION_ID="$_sid"
    [ -n "$_sname" ] && SESSION_NAME="$_sname"
  fi
fi

# --- resolve project root --------------------------------------------------
# Walk up from CWD until a CLAUDE.md or .git marker; fall back to
# CLAUDE_PROJECT_DIR, then CWD.
project_root() {
  local dir="$CWD"
  while [ "$dir" != "/" ] && [ "$dir" != "${HOME:-/nonexistent}" ] && [ -n "$dir" ]; do
    # Worktree remap: if .git is a file, parse gitdir to find the main repo root.
    # A git worktree's .git file contains "gitdir: <main>/.git/worktrees/<name>".
    # This must win over the CLAUDE.md stop (a worktree checks out CLAUDE.md too).
    if [ -f "$dir/.git" ]; then
      local gitdir
      gitdir="$(sed -n 's/^gitdir:[[:space:]]*//p' "$dir/.git" 2>/dev/null || true)"
      if [ -n "$gitdir" ]; then
        local main_root="${gitdir%/.git/worktrees/*}"
        if [ -d "$main_root" ]; then
          printf '%s\n' "$main_root"
          return 0
        fi
      fi
    fi
    if [ -f "$dir/CLAUDE.md" ] || [ -d "$dir/.git" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  printf '%s\n' "${CLAUDE_PROJECT_DIR:-$CWD}"
}

ROOT="$(project_root)"
[ -z "$ROOT" ] && exit 0
[ "$ROOT" = "${HOME:-/nonexistent}" ] && exit 0  # home is global rules, not a project
DIRNAME="$(basename "$ROOT")"

# --- derive project_id -----------------------------------------------------
# slug: lowercase, every run of non-alphanumeric -> single '-', trimmed.
slug() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

sha6() {
  # first 6 hex chars of sha256 of the absolute path string
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 2>/dev/null | cut -c1-6
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum 2>/dev/null | cut -c1-6
  else
    # last-resort: cksum (not sha, but deterministic) — keeps id stable.
    printf '%s' "$1" | cksum 2>/dev/null | awk '{printf "%06x", $1}' | cut -c1-6
  fi
}

SLUG="$(slug "$DIRNAME")"
[ -z "$SLUG" ] && SLUG="project"
HASH="$(sha6 "$ROOT")"
PROJECT_ID="${SLUG}-${HASH}"

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- atomic mkdir-lock helper ---------------------------------------------
# Mirrors plugin/mcp/channel/index.js withChannelLock(): mkdir a lock
# dir, run the critical section, rmdir. Stale locks (>5s) are reclaimed.
with_lock() {
  local lock="$1"; shift
  local tries=50 i=0
  mkdir -p "$(dirname "$lock")" 2>/dev/null || true
  while [ "$i" -lt "$tries" ]; do
    if mkdir "$lock" 2>/dev/null; then
      "$@"
      local rc=$?
      rmdir "$lock" 2>/dev/null || true
      return $rc
    fi
    # stale-lock reclaim
    if [ -d "$lock" ]; then
      local age
      age="$(($(date +%s) - $(stat -f %m "$lock" 2>/dev/null || stat -c %Y "$lock" 2>/dev/null || echo 0)))"
      if [ "$age" -gt 5 ] 2>/dev/null; then
        rmdir "$lock" 2>/dev/null || true
      fi
    fi
    i=$((i + 1))
    # brief spin without `sleep` (sleep may be permission-gated); busy-wait ~20ms
    local end=$(( $(date +%s%N 2>/dev/null || echo 0) ))
    : "$end"
  done
  return 1
}

mkdir -p "$CONFIG_DIR" 2>/dev/null || exit 0

# --- upsert projects.json --------------------------------------------------
# jq is required to do this safely; without it we skip the registry write but
# still emit the session title.
upsert_projects() {
  [ -f "$PROJECTS_JSON" ] || printf '%s\n' '{"version":1,"projects":[]}' > "$PROJECTS_JSON"
  local tmp="$PROJECTS_JSON.tmp.$$"
  jq \
    --arg id "$PROJECT_ID" \
    --arg name "$DIRNAME" \
    --arg path "$ROOT" \
    --arg now "$NOW" \
    '
    (.version // 1) as $v
    | (.projects // []) as $ps
    # Match an existing entry by path (preferred) or id.
    | ([ $ps[] | select(.path == $path or .id == $id) ] | length > 0) as $exists
    | {
        version: $v,
        projects: (
          if $exists then
            [ $ps[]
              | if (.path == $path or .id == $id)
                then . + {last_seen: $now}        # bump only; preserve name/kind/id
                else . end
            ]
          else
            $ps + [{
              id: $id, name: $name, path: $path,
              kind: "auto", registered_by: "hook",
              first_seen: $now, last_seen: $now
            }]
          end
        )
      }
    ' "$PROJECTS_JSON" > "$tmp" 2>/dev/null && mv "$tmp" "$PROJECTS_JSON" 2>/dev/null
  rm -f "$tmp" 2>/dev/null || true
}

# --- upsert sessions.json --------------------------------------------------
# Key by session_id. pid: the SessionStart payload carries no session pid, and
# $PPID inside this hook is the immediate shell that exec'd the script, not the
# long-lived claude session. We record it best-effort as `hook_ppid`; readers
# should treat session_id as the stable key, not pid.
upsert_sessions() {
  [ -z "$SESSION_ID" ] && return 0
  [ -f "$SESSIONS_JSON" ] || printf '%s\n' '{"version":1,"sessions":[]}' > "$SESSIONS_JSON"
  local tmp="$SESSIONS_JSON.tmp.$$"
  jq \
    --arg sid "$SESSION_ID" \
    --arg raw_sid "$RAW_SESSION_ID" \
    --arg pid "${PPID:-}" \
    --arg pid_root "$ROOT" \
    --arg pid_proj "$PROJECT_ID" \
    --arg harness "$HARNESS" \
    --arg name "$SESSION_NAME" \
    --arg model "$MODEL" \
    --arg now "$NOW" \
    '
    (.version // 1) as $v
    | ($pid | tonumber? // null) as $pidn
    | (.sessions // []) as $orig
    | ($orig | map(
        if (.session_id != $sid and $pidn != null and (.hook_ppid // null) == $pidn)
        then . + {session_id: $sid, resume_rekeyed_from: .session_id}
        else . end
      )) as $rekeyed
    | ($rekeyed | map(select(.session_id != $raw_sid or $raw_sid == "" or $raw_sid == $sid))) as $filtered
    | (reduce $filtered[] as $s ([]; if $s.session_id == $sid then (map(select(.session_id != $sid)) + [$s]) else . + [$s] end)) as $ss
    | ([ $ss[] | select(.session_id == $sid) ] | length > 0) as $exists
    | {
        version: $v,
        sessions: (
          if $exists then
            [ $ss[]
              | if .session_id == $sid
                then . + {last_seen_at: $now, project_id: $pid_proj, project_path: $pid_root, harness: $harness, name: (if $name == "" then (.name // null) else $name end), model: (if $model == "" then (.model // null) else $model end)}
                else . end
            ]
          else
            $ss + [{
              session_id: $sid,
              hook_ppid: ($pid | tonumber? // null),
              project_id: $pid_proj,
              project_path: $pid_root,
              harness: $harness,
              name: (if $name == "" then null else $name end),
              model: (if $model == "" then null else $model end),
              boot_time: $now,
              last_seen_at: $now
            }]
          end
        )
      }
    ' "$SESSIONS_JSON" > "$tmp" 2>/dev/null && mv "$tmp" "$SESSIONS_JSON" 2>/dev/null
  rm -f "$tmp" 2>/dev/null || true
}

if command -v jq >/dev/null 2>&1; then
  with_lock "$PROJECTS_JSON.lock" upsert_projects || true
  with_lock "$SESSIONS_JSON.lock" upsert_sessions || true
  # Additive canonical authority. The legacy view above remains for older
  # installs/readers; all new presence decisions consume this fact instead.
  FACT_WRITER="$SCRIPT_DIR/../lib/session-facts-write.js"
  [ -f "$FACT_WRITER" ] || FACT_WRITER="$SCRIPT_DIR/../../lib/session-facts-write.js"
  if [ -f "$FACT_WRITER" ] && command -v node >/dev/null 2>&1 && [ -n "$SESSION_ID" ]; then
    _fact="$(jq -cn --arg id "$SESSION_ID" --arg raw "$RAW_SESSION_ID" --arg h "$HARNESS" --arg p "$ROOT" --arg n "$SESSION_NAME" --arg m "$MODEL" --arg at "$NOW" '{canonical_id:$id,harness:$h,locator:{raw_session_id:(if $raw=="" then $id else $raw end)},continuation_key:$id,project_path:$p,name:(if $n=="" then null else $n end),model:(if $m=="" then null else $m end),status:"idle",observed_at:$at}')"
    node "$FACT_WRITER" "$_fact" >/dev/null 2>&1 || true
  fi
fi

# --- project-scoped substrate sync-on-register -----------------------------
# Fast path: one `golem sync --check --project ... --harness ...` runs inline.
# Dirty path: full render runs detached so session start is not held hostage.
# Any failure logs and exits 0; registration must never break a session.
sync_on_register() {
  local cli="${GOLEM_CLI:-}"
  if [ -z "$cli" ]; then
    cli="$(command -v golem 2>/dev/null || true)"
  fi
  local log_dir="$CONFIG_DIR/logs"
  local log_file="$log_dir/sync-on-register.log"
  mkdir -p "$log_dir" 2>/dev/null || return 0

  if [ -z "$cli" ]; then
    printf '%s sync-on-register: golem CLI not found; skipping project sync for %s (%s)\n' "$NOW" "$ROOT" "$HARNESS" >> "$log_file" 2>/dev/null || true
    return 0
  fi

  local h="$HARNESS"
  [ "$h" = "claudecode" ] && h="cc"

  "$cli" sync --check --project "$ROOT" --harness "$h" >> "$log_file" 2>&1
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    return 0
  fi
  if [ "$rc" -eq 1 ]; then
    (
      printf '%s sync-on-register: drift detected; rendering %s for %s\n' "$NOW" "$h" "$ROOT"
      "$cli" sync --project "$ROOT" --harness "$h"
    ) >> "$log_file" 2>&1 &
    return 0
  fi

  printf '%s sync-on-register: check failed rc=%s for %s (%s); fail-open\n' "$NOW" "$rc" "$ROOT" "$h" >> "$log_file" 2>/dev/null || true
  return 0
}

sync_on_register || true

# --- global substrate freshness repair -------------------------------------
# Entirely detached and fail-open: stale global renders should self-heal, but a
# broken sync must never block SessionStart.
global_sync_on_register() {
  local cli="${GOLEM_CLI:-}"
  if [ -z "$cli" ]; then
    cli="$(command -v golem 2>/dev/null || true)"
  fi
  [ -z "$cli" ] && return 0
  local log_dir="$CONFIG_DIR/logs"
  local log_file="$log_dir/global-sync-on-register.log"
  mkdir -p "$log_dir" 2>/dev/null || return 0
  (
    for target in cc cc-marketplace; do
      "$cli" sync --check --target "$target" >> "$log_file" 2>&1
      local rc=$?
      if [ "$rc" -eq 1 ]; then
        printf '%s global-sync-on-register: drift detected; rendering %s\n' "$NOW" "$target" >> "$log_file" 2>/dev/null || true
        "$cli" sync --target "$target" --force >> "$log_file" 2>&1 || true
      elif [ "$rc" -ne 0 ]; then
        printf '%s global-sync-on-register: check failed rc=%s for %s; fail-open\n' "$NOW" "$rc" "$target" >> "$log_file" 2>/dev/null || true
      fi
    done
  ) >/dev/null 2>&1 &
  return 0
}

global_sync_on_register || true

# --- naming: intentionally NONE --------------------------------------------
# We deliberately do NOT emit sessionTitle. SessionStart fires on resume/compact
# too, so auto-titling to the repo dirname clobbered the user's /rename on every
# `/resume` (and forced a re-rename). Sessions are now named only by the user via
# /rename; the channel server reads that name from ~/.claude/sessions/<pid>.json
# and stamps it into the channel registry, so the dashboard and consult
# name-resolution pick it up without this hook setting a title.

exit 0
