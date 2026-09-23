#!/usr/bin/env bash
# SessionStart hook — assemble tracker context and a compact role
# card. Fail-open: emit the rendered tracker context, or the substrate source if
# sync is stale, rather than breaking session start.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=./_golem-home.sh
. "$SCRIPT_DIR/_golem-home.sh"

SESSION_ID="${CLAUDE_CODE_SESSION_ID:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session)
      SESSION_ID="${2:-}"
      shift 2
      ;;
    --session=*)
      SESSION_ID="${1#--session=}"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD="$(cat 2>/dev/null || true)"
fi
if [ -z "$SESSION_ID" ] && command -v jq >/dev/null 2>&1 && [ -n "$PAYLOAD" ]; then
  SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // .sessionID // empty' 2>/dev/null || true)"
fi
START_DIR="$PWD"
if command -v jq >/dev/null 2>&1 && [ -n "$PAYLOAD" ]; then
  PAYLOAD_CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // .directory // empty' 2>/dev/null || true)"
  if [ -n "$PAYLOAD_CWD" ]; then
    START_DIR="$PAYLOAD_CWD"
  fi
fi

ctx=""

# Resolve the role card BEFORE assembling, so the payload budget can account for
# it. It used to be concatenated afterwards, which meant a large overlay card
# blew the ceiling the node block thought it was enforcing.
#   1. overlay  -> $GOLEM_HOME_DIR/roles/<role>.md   (per-user override)
#   2. custom   -> $GOLEM_ROLES_DIR/<role>.md         (env override)
#   3. default  -> $SCRIPT_DIR/../roles/<role>.md     (packaged card)
# Same precedence as lib/session-role.js#readRoleCard. Fail-open: no card is fine.
CARD=""
if [ -n "$SESSION_ID" ] && command -v jq >/dev/null 2>&1; then
  SESSIONS_JSON="$GOLEM_HOME_DIR/sessions.json"
  ROLE="$(jq -r --arg sid "$SESSION_ID" '(.sessions // [])[] | select(.session_id == $sid) | .role // empty' "$SESSIONS_JSON" 2>/dev/null | head -n 1 || true)"
  # A managed agent's launcher passes its role in GOLEM_ROLE, which is set before
  # the first SessionStart can read sessions.json (GOL-382 R11).
  [ -z "$ROLE" ] && ROLE="${GOLEM_ROLE:-}"
  # A session nobody assigned boots with the configured default role (GOL-382 R3):
  # roles.default in config.json; a missing key means lead, null or "" means none.
  # Only on a harness SessionStart payload: the Pi shim calls this script for
  # ambient context and injects its own card.
  if [ -z "$ROLE" ] && [ -n "$PAYLOAD" ]; then
    HOOK_EVENT="$(printf '%s' "$PAYLOAD" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
    if [ "$HOOK_EVENT" = "SessionStart" ]; then
      if [ -f "$GOLEM_HOME_DIR/config.json" ]; then
        ROLE="$(jq -r '(.roles // {}) | if has("default") then (.default // "") else "lead" end' "$GOLEM_HOME_DIR/config.json" 2>/dev/null || printf 'lead')"
      else
        ROLE="lead"
      fi
    fi
  fi
  # A role name also names a file below; accept only registry-shaped names.
  printf '%s' "$ROLE" | grep -Eq '^[a-z][a-z0-9-]{1,31}$' || ROLE=""
  if [ -n "$ROLE" ]; then
    for candidate in "$GOLEM_HOME_DIR/roles/$ROLE.md" "${GOLEM_ROLES_DIR:+$GOLEM_ROLES_DIR/$ROLE.md}" "$SCRIPT_DIR/../roles/$ROLE.md"; do
      if [ -n "$candidate" ] && [ -f "$candidate" ]; then
        CARD="$candidate"
        break
      fi
    done
  fi
fi

if command -v node >/dev/null 2>&1; then
  MAP_BLOCK="$(node - "$GOLEM_HOME_DIR" "$START_DIR" "$CARD" <<'NODE' 2>/dev/null || true
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const [home, start, cardPath] = process.argv.slice(2);
// Shed order, by RE-FETCHABILITY rather than size: commits are one
// dependency-free command a session can run itself and recently-closed needs
// node:sqlite plus the tracker schema. The live recipient pool is deliberately
// absent from boot context; delegation flows fetch it just in time.
const sections = new Map();
function rootFrom(dir) {
  let cur = path.resolve(dir);
  const homeDir = process.env.HOME || '';
  for (let i = 0; i < 64; i++) {
    if (cur === homeDir) break;
    const gitPath = path.join(cur, '.git');
    // Worktree remap: if .git is a file, parse gitdir to find the main repo root.
    if (fs.existsSync(gitPath)) {
      try {
        const st = fs.statSync(gitPath);
        if (st.isFile()) {
          const content = fs.readFileSync(gitPath, 'utf8');
          const m = content.match(/^gitdir:\s*(.+)$/m);
          if (m) {
            const mainRoot = m[1].trim().replace(/\/\.git\/worktrees\/[^/]+$/, '');
            if (fs.existsSync(mainRoot)) return mainRoot;
          }
        }
      } catch (_) { /* fall through */ }
    }
    if (fs.existsSync(gitPath) || fs.existsSync(path.join(cur, 'CLAUDE.md'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(dir);
}
function projectId(root) {
  const slug = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return `${slug}-${crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 6)}`;
}
const root = rootFrom(start);
const derivedId = projectId(root);
const lines = [];
let registryId = derivedId;
try {
  const projects = JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8')).projects || [];
  const project = projects.find((p) => p && (p.id === derivedId || path.resolve(p.path || '') === root));
  if (project?.id) registryId = project.id;
  const servers = Array.isArray(project?.lsp?.servers) ? project.lsp.servers : [];
  if (project?.lsp?.available && servers.length) lines.push(`LSP: ${servers.join(', ')}`);
} catch {}
// Recently closed work, as POINTERS ONLY — id plus one-line title, never body.
// Summarising these into prose would reintroduce exactly the lossy re-encoding
// the reference model exists to remove; an id is something the agent can pull.
// node:sqlite is built in from Node 22 and needs no dependency, which matters
// because this runs from a render that has no node_modules. On older Node the
// require throws and the field is simply omitted.
try {
  // node:sqlite is built in from Node 22. On an older runtime the require throws
  // and the field would vanish with no signal at all, so say so rather than
  // leaving a silently incomplete payload.
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    lines.push('', '(recently-closed unavailable: needs Node 22+ for node:sqlite)');
    throw new Error('no node:sqlite');
  }
  const dbPath = path.join(home, 'tracker.db');
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let rows;
    try {
      // Schema-coupled on purpose: the hook must still work with the dashboard
      // down, and a read does not violate single-writer. But tracker-db.js has a
      // live migration ladder, so a rename here vanishes the field silently.
      // test/sync-enforcement.test.mjs covers this query for that reason.
      // Specs only. The design says "recent SPEC closes" because a spec is the
      // unit a fresh session needs to orient against; listing every closed work
      // item spends the same budget restating pieces of one feature, and the
      // work-item titles are meaningless without the spec they hang off.
      rows = db.prepare(
        "SELECT display_id, kind, title FROM tickets WHERE project_id = ? AND state = ? AND kind = 'spec' ORDER BY done_at DESC LIMIT 8",
      ).all(registryId, 'done');
    } finally {
      db.close();
    }
    if (rows.length) {
      // Fold whitespace before clipping. Titles are agent-authored free text and
      // this is the only field that carries it into system context, so a title
      // containing a newline would otherwise inject a second, structurally
      // identical section that reads exactly like a derived one.
      sections.set('recent-closes', ['', 'Recently closed:',
        ...rows.map((r) => `  ${r.display_id} (${r.kind}) ${String(r.title).replace(/\s+/g, ' ').slice(0, 72)}`)]);
    }
  }
} catch {}

// Recent commits. The densest freshness signal available, derived so it cannot
// go stale, and the only field that also captures work done outside golem.
// Its value is exactly the quality of the commit messages in this repo — do not
// try to summarise or clean them up here.
//
// NB for anyone editing this heredoc: it lives inside a command substitution,
// and bash still tracks paren nesting and quote pairs through the body even
// though the delimiter is quoted. Writing a bare dollar-paren pair or a lone
// apostrophe in a JS comment here breaks the whole script with an EOF error
// pointing at the last line of the file, which is a long way from the cause.
// Budgeted on cumulative characters, not on line count. Capping count x
// per-line-length bounds one pathological commit but not the aggregate: 40 lines
// of realistic 150-char subjects is ~1,300 tokens on its own. This repo happens
// to have terse subjects, which is exactly the input the design says cannot be
// relied on. So: take up to 40, stop at CHAR_CAP, and say when truncated.
let commitLines = [];
try {
  const log = execFileSync('git', ['log', '--oneline', '-40'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (log) commitLines = log.split('\n').map((l) => `  ${l.slice(0, 110)}`);
} catch {}

// Resize, then restate — do not drop the section wholesale. Whole-section
// dropping was adopted to stop the header lying about how many entries it listed,
// but as the ONLY lever it produced a cliff on the ordinary path: every packaged
// role card is 241-298 bytes, so being 33 bytes over budget cost all 2,600 chars
// of commits. Fitting to the remaining budget keeps the header honest, because it
// is computed from what was actually kept.
// Fit against the ASSEMBLED payload, not a precomputed entry budget. The header
// is part of what this section costs and its own length changes with the number
// of entries kept, so any budget computed before the header exists is wrong by
// roughly its length. That was not a rounding error: overshooting by ~30 chars
// made the next branch delete the whole ~700-char recently-closed section, after
// which commits refit and expanded — trading the field that needs node:sqlite
// plus the tracker schema for the one that is a single dependency-free command.
function commitsFitting(fits) {
  let best = null;
  for (let n = 1; n <= commitLines.length; n += 1) {
    const header = n < commitLines.length
      ? `Recent commits (${n} of ${commitLines.length}):`
      : 'Recent commits:';
    const candidate = ['', header, ...commitLines.slice(0, n)];
    if (!fits(candidate)) break;
    best = candidate;
  }
  return best;
}

// The role card is part of the payload, so it is part of the budget. It used to
// be concatenated by bash after this block, which is how a 2KB overlay card could
// push the total past a ceiling this code believed it was enforcing.
// Measured in UTF-16 code units, which is what .length counts. The payload
// carries em dashes and similar, so the byte size runs ~11 higher than this
// figure — immaterial against a ~880-token target, but it is why a byte-based
// reading of the output can look like a violation when it is not.
const PAYLOAD_MAX = 3600; // ~880 tokens at ~4.09 chars/token
const CARD_MAX = 1200;    // a card is never droppable, so it must be truncatable

// Card first: it is the session identity, and identity should be the first thing
// read. That is a decision, not a side effect of where the code happens to
// concatenate. It is also never dropped — a session without its role card does
// not know what it is — which is exactly why it needs its own ceiling.
let card = [];
try {
  if (cardPath && fs.existsSync(cardPath)) {
    let body = fs.readFileSync(cardPath, 'utf8').trimEnd();
    if (body.length > CARD_MAX) body = `${body.slice(0, CARD_MAX)}\n(role card truncated — see the card on disk)`;
    card = ['', body];
  }
} catch {}

// Aggregate ceiling. Capped parts do not make a capped whole.
const dropped = [];
const build = (commits) => [
  ...card,
  ...lines,
  ...(sections.has('recent-closes') ? sections.get('recent-closes') : []),
  ...(commits || []),
  ...(dropped.length ? ['', `(${dropped.join(', ')} omitted — payload budget)`] : []),
].join('\n');

// Shed in one direction only: commits first, by shrinking; then commits entirely;
// then recently-closed. Never resurrect an earlier section by dropping a later
// one — that is the inversion this used to have.
//
// The commits-gone case is unreachable while every other section stays capped
// (card 1200, closes 8 rows): the fixed part stays well below 3,600
// against 3,600, so at least a few entries always fit. It stays as a backstop
// precisely because its unreachability rests on a conjunction of separately
// maintained caps, which is the invariant a future field would break silently.
const commits = commitsFitting((c) => build(c).length <= PAYLOAD_MAX);
if (!commits && commitLines.length) dropped.push('commits');
if (build(commits).length > PAYLOAD_MAX && sections.has('recent-closes')) {
  sections.delete('recent-closes');
  dropped.push('recent-closes');
}
process.stdout.write(build(commits));
NODE
)"
  if [ -n "$MAP_BLOCK" ] && command -v jq >/dev/null 2>&1; then
    MAP_ESC="$(printf '\n\n%s' "$MAP_BLOCK" | jq -Rs . 2>/dev/null || true)"
    if [ -n "$MAP_ESC" ]; then
      MAP_ESC="${MAP_ESC#\"}"
      MAP_ESC="${MAP_ESC%\"}"
      ctx="$ctx$MAP_ESC"
    fi
  fi
fi

# Gate on the RESULT, not on whether node exists. "node is missing" and "node ran
# and produced nothing" are the same outcome for the payload, and only the first
# was covered — a node that exits non-zero lost the card silently.
if [ -z "${MAP_BLOCK:-}" ] && [ -n "$CARD" ] && command -v jq >/dev/null 2>&1; then
  # No node means no assembled payload, but the role card needs neither. Every
  # other field degrades independently, and moving the card into the node block
  # had quietly made it the one field that did not — a session without node lost
  # its identity as well as its context.
  CARD_ESC="$( { printf '\n\n'; cat "$CARD"; } | jq -Rs . 2>/dev/null || true)"
  if [ -n "$CARD_ESC" ]; then
    CARD_ESC="${CARD_ESC#\"}"
    CARD_ESC="${CARD_ESC%\"}"
    ctx="$ctx$CARD_ESC"
  fi
fi

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$ctx" 2>/dev/null || true
