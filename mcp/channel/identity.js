import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Caller identity resolution for one MCP child per Golem session.
 * GOL-365: Pi and Claude are the only harnesses. A Claude Code MCP child is
 * bound to exactly one session — its launcher export or parent session file is
 * the binding (see index.js deriveSessionId). There are no sibling bridges, so
 * sessionsForParent() is empty by construction and injected ids are accepted
 * only for callers that carry the launcher binding.
 */

/**
 * Resolve the caller's session id for a tracker write.
 *
 * An injected id is trusted only inside the MCP request boundary (index.js
 * strips `__golem_session_id` before dispatch and passes it here explicitly);
 * a CLI shell has no such channel, so it stays unbound unless the launcher
 * exported the session id.
 *
 * @returns {{ sessionId: string|null, source?: string, error?: string }}
 */
export function resolveCallerSessionId({ injectedId, home, parentPid } = {}) {
  if (typeof injectedId === 'string' && injectedId.trim()) {
    return { sessionId: injectedId.trim(), source: 'injected' };
  }
  if (process.env.GOLEM_CEO_SESSION_ID) {
    return { sessionId: process.env.GOLEM_CEO_SESSION_ID, source: 'launcher_binding' };
  }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8'));
    const row = (j?.sessions || []).find((s) => s && s.pid === process.ppid);
    if (row?.session_id) return { sessionId: row.session_id, source: 'parent_session_row' };
  } catch { /* no registry — fall through */ }
  return {
    sessionId: null,
    error: 'golem: cannot determine which session is calling (no launcher binding, no caller id injected); refusing to write. Restart the session, or upgrade the golem plugin.',
  };
}

/**
 * GOL-365: sibling rows were the old shared-bridge concept. One MCP child per
 * session means there are no siblings; the empty result keeps the callers'
 * loops simple.
 */
export function sessionsForParent({ home, parentPid } = {}) {
  return [];
}

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