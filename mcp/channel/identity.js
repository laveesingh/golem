import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Caller identity resolution for one MCP child per Golem session.
 * invocation boundary carrying a per-call id. Its process environment is the
 * binding. Keep the marker separate from GOLEM_CEO_SESSION_ID: ordinary CC
 * launchers also set that variable and must retain their existing behaviour.
 */
function pidAlive(pid) {
  if (!pid || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function liveBridgesForParent({ home, parentPid = process.ppid }) {
  try {
        const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bridges = Array.isArray(json?.bridges) ? json.bridges : [];
    return bridges.filter((bridge) => (
      bridge && bridge.session_id &&
      (!bridge.pid || pidAlive(bridge.pid))
    ));
  } catch {
    return [];
  }
}

export function sessionsForParent({ home, parentPid } = {}) {
  return liveBridgesForParent({ home, parentPid });
}

/**
 * infer which sibling called, so ambiguity is an error, never a newest-row
 * guess. Injected ids share the shim's local-plugin trust boundary.
 */
export function resolveCallerSessionId({ injectedId, home, parentPid } = {}) {
  if (typeof injectedId === 'string' && injectedId.trim()) {
    return { sessionId: injectedId.trim(), source: 'injected' };
  }
  const candidates = liveBridgesForParent({ home, parentPid });
  if (candidates.length === 1) {
    return { sessionId: candidates[0].session_id, source: 'single_bridge' };
  }
  if (candidates.length > 1) {
    return {
      sessionId: null,
      error: `golem: cannot determine which session is calling (${candidates.length} multiple sibling sessions share this channel server, no caller id injected); refusing to write. Restart the session, or upgrade the golem plugin.`,
    };
  }
  return {
    sessionId: null,
    error: 'golem: cannot determine which session is calling (no live channel row, no caller id injected); refusing to write. Restart the session, or upgrade the golem plugin.',
  };
}

/**
 * Sibling bridge rows share one endpoint, so newest is valid only for endpoint
 * delivery. It must never be used to choose a caller identity.
 */
/**
 * Which directory should ambient project context be rendered for?
 *
 * Registry first, cwd only as a last resort — the precedence `currentProjectId`
 * documents. Extracted from the `project_context` handler so it can be tested
 * without a live server: it is a pure function of session id, registry, cwd and
 * the filesystem, and every bug it has had was reachable that way.
 *
 * Returns null when the project cannot be determined. Callers MUST treat that as
 * an error rather than falling back to cwd. The server
 * starts at the plugin bundle root and the session id is empty, so a fallback
 * renders a confident, plausible-looking payload for the wrong directory — which
 * is worse than refusing, because an error routes the agent elsewhere.
 *
 * The walk mirrors `rootFrom()` in tracker-context.sh and must keep doing so:
 * stop at $HOME, and match only `.git` or `CLAUDE.md`. Matching `AGENTS.md` or
 * walking past home finds a dotfiles repo — a very common setup — and then
 * renders that repo's commits as if they were the project's.
 *
 * @returns {string|null}
 */
export function resolveProjectCwd({ sessionId, home, cwd, homeDir } = {}) {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8'));
    const row = (reg?.sessions || []).find((s) => s && sessionId && s.session_id === sessionId);
    if (row?.project_path && fs.existsSync(row.project_path)) return row.project_path;
  } catch { /* no registry — fall through to the walk */ }

  const stopAt = homeDir ?? os.homedir();
  let dir = path.resolve(cwd || '.');
  for (let i = 0; i < 64 && dir !== path.dirname(dir) && dir !== stopAt; i += 1) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'CLAUDE.md'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}
