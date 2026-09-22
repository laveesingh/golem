// golem tracker client — a thin HTTP client of the dashboard's tracker REST API.
//
// The dashboard server owns the SQLite tracker DB and is the SINGLE WRITER; this
// module never touches the DB directly. It only speaks HTTP to whatever URL the
// live dashboard self-registered in `<config>/golem/dashboard.json`. The golem
// channel MCP (index.js) wraps these functions as agent-facing tools so live
// Claude sessions can read/write tickets — the cross-project source of truth for
// work, replacing PLAN.md.
//
// Identity helpers (currentSessionId / currentProjectId) let the MCP tools inject
// sensible defaults so the agent rarely has to pass ids by hand.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { resolveCallerSessionId, sessionsForParent } from './identity.js';
import { createGolemClient, GolemClientError } from '../../lib/golem-client.js';
import { readClaudeSessionRecord } from '../../lib/claude-session-context.js';

export { GolemClientError };

// --- golem-home resolution (TKT-0573, ADR-4) --------------------------------
// This is a hand-maintained MIRROR of lib/golem-home.js's golemHome(). This
// package runs from the INSTALLED plugin copy with its own node_modules — it
// cannot import the repo module — so keep the resolution order in sync by
// hand if either side changes:
//   1. GOLEM_HOME env       — explicit override.
//   2. XDG_CONFIG_HOME env  — legacy override (test isolation); outranks the
//      ~/.golem auto-detect so isolated runs never leak into production state.
//   3. ~/.golem             — once it exists as a real directory.
//   4. ~/.config/golem      — pre-migration default.
// Exported so index.js (same package) reuses this instead of duplicating it
// a second time.
export function golemHome() {
  if (process.env.GOLEM_HOME) return process.env.GOLEM_HOME;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'golem');
  const migrated = path.join(os.homedir(), '.golem');
  try {
    if (fs.statSync(migrated).isDirectory()) return migrated;
  } catch { /* not migrated yet */ }
  return path.join(os.homedir(), '.config', 'golem');
}

const DEFAULT_BASE_URL = 'http://dashboard.golem.localhost:7420';

/**
 * Resolve the dashboard base URL.
 * Reads `<config>/golem/dashboard.json` (written by the dashboard's self-
 * registration block, shape `{url,host,port,pid,started_at}`) and returns its
 * `url`. Falls back to the dashboard's canonical URL
 * (http://dashboard.golem.localhost:7420) when the file is missing/unreadable
 * or carries no usable url.
 * @returns {string}
 */
export function dashboardBaseUrl() {
  const file = path.join(golemHome(), 'dashboard.json');
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (doc && typeof doc.url === 'string' && doc.url.trim()) {
      return doc.url.replace(/\/+$/, '');
    }
    if (doc && doc.host && doc.port) {
      return `http://${doc.host}:${doc.port}`;
    }
  } catch {
    // missing / unreadable / malformed — fall through to the default bind.
  }
  return DEFAULT_BASE_URL;
}

/**
 * The session id of the live Claude session running this MCP child.
 * Mirrors index.js: golem's launcher exports GOLEM_CEO_SESSION_ID before exec'ing
 * claude (Claude Code does NOT reliably stamp CLAUDE_CODE_SESSION_ID onto MCP-child
 * env), with CLAUDE_CODE_SESSION_ID as a forward-compat fallback.
 * @returns {string|null}
 */
export function currentSessionId(injectedId) {
  return resolveCallerSessionId({ home: golemHome() }).sessionId;
  return null;
}

/**
 * Derive the canonical contract project_id from an absolute project-root path.
 * project_id = `<slug>-<first 6 hex of sha256(absPath)>`, where slug is the
 * lowercased basename with non-alnum runs collapsed to '-' and trimmed. This
 * BYTE-MATCHES the plugin hooks (session-register.sh / journal-route.sh) and the
 * dashboard's project-id.js (projectIdFor) — keep it in lockstep with those.
 * @param {string} absRoot
 * @returns {string}
 */
function projectIdForPath(absRoot) {
  const abs = path.resolve(absRoot);
  const slug =
    path
      .basename(abs)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project';
  const hex = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 6);
  return `${slug}-${hex}`;
}

/**
 * Best-effort project_id for the current session.
 *   1. Read `<config>/golem/sessions.json`, find the row whose
 *      `session_id === currentSessionId()`, and return its `project_id` (the
 *      authoritative value the SessionStart hook wrote — legacy projects can
 *      have non-derived ids, so the registry wins).
 *   2. Fallback: derive from `process.cwd()` using the SAME `<slug>-<6hex>`
 *      scheme the hooks use. NOTE: the hooks derive from the project ROOT
 *      (walking up to the nearest `.git`/`CLAUDE.md`); this fallback uses cwd
 *      verbatim, so it only matches when the session's cwd *is* the project
 *      root. The registry lookup is the reliable path; this is a last resort.
 * Returns null when neither yields a value.
 * @returns {string|null}
 */
export function currentProjectId(sessionId) {
  const sid = sessionId ?? currentSessionId();
  if (sid) {
    try {
      const file = path.join(golemHome(), 'sessions.json');
      const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const rows = Array.isArray(reg?.sessions) ? reg.sessions : [];
      const row = rows.find((s) => s && s.session_id === sid);
      if (row && typeof row.project_id === 'string' && row.project_id) {
        return row.project_id;
      }
    } catch {
      // no registry / unreadable — fall through to cwd derivation.
    }
  }
  try {
    return projectIdForPath(process.cwd());
  } catch {
    return null;
  }
}

// --- HTTP plumbing ---------------------------------------------------------

function requireProjectScope(value, operation) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GolemClientError(
      `${operation}: project_id is required at the MCP-to-REST boundary; ` +
        'pass project:"<contract-id>" or ensure the session is registered to a project',
      { code: 'GOLEM_INVALID_ARGUMENT', retryable: false },
    );
  }
  return value.trim();
}

/**
 * Compatibility request wrapper. Transport and structured error semantics live
 * in the harness-neutral client; dashboard discovery remains process-local.
 */
async function request(method, pathname, {
  params,
  body,
  requiredBodyFields = [],
  verbatimError = false,
  caller_session_id = null,
} = {}) {
  return createGolemClient({ baseUrl: dashboardBaseUrl() }).request(method, pathname, {
    params,
    body,
    requiredBodyFields,
    verbatimError,
    caller_session_id,
  });
}

// --- API wrappers (one per dashboard tracker route) ------------------------

/** GET /api/tickets?project&state&assignee&kind&includeArchived */
export function listTickets(params = {}) {
  const query = { ...params };
  if (query.project != null) query.project = requireProjectScope(query.project, 'listTickets');
  return request('GET', '/api/tickets', { params: query });
}

/** GET /api/tickets/:id */
export function getTicket(id) {
  if (!id) throw new GolemClientError('getTicket: id is required', { code: 'GOLEM_INVALID_ARGUMENT' });
  return request('GET', `/api/tickets/${encodeURIComponent(id)}`);
}

/** POST /api/tickets {project_id,kind?,title,body?,priority?,labels?,parent_id?,assignee?,created_by?} */
export function createTicket(body = {}) {
  // `project_id` is routing scope required by the legacy REST contract, not
  // caller identity. Identity scrubbers may remove actor-like fields, but must
  // never remove this field from a scoped tracker request.
  const project_id = requireProjectScope(body.project_id, 'createTicket');
  return request('POST', '/api/tickets', {
    body: { ...body, project_id },
    requiredBodyFields: ['project_id'],
  });
}

/** PATCH /api/tickets/:id {…patch, actor?} */
export function updateTicket(id, patch) {
  if (!id) throw new GolemClientError('updateTicket: id is required', { code: 'GOLEM_INVALID_ARGUMENT' });
  return request('PATCH', `/api/tickets/${encodeURIComponent(id)}`, { body: patch });
}

/** POST /api/tickets/:id/comments {author,body,quote?,prefix?,suffix?,section?,section_id?,status?,parent_id?} */
export function addComment(id, input = {}) {
  if (!id) throw new GolemClientError('addComment: id is required', { code: 'GOLEM_INVALID_ARGUMENT' });
  return request('POST', `/api/tickets/${encodeURIComponent(id)}/comments`, { body: input });
}

/** PATCH /api/tickets/:id/comments/:cid {body?,status?} */
export function updateComment(id, commentId, patch) {
  if (!id) throw new GolemClientError('updateComment: id is required', { code: 'GOLEM_INVALID_ARGUMENT' });
  if (!commentId) throw new GolemClientError('updateComment: commentId is required', { code: 'GOLEM_INVALID_ARGUMENT' });
  return request('PATCH', `/api/tickets/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, { body: patch });
}

/** POST /api/tickets/:id/comments/:cid/reply {author,body} */
export function replyComment(id, commentId, body) {
  if (!id) throw new GolemClientError('replyComment: id is required', { code: 'GOLEM_INVALID_ARGUMENT' });
  if (!commentId) throw new GolemClientError('replyComment: commentId is required', { code: 'GOLEM_INVALID_ARGUMENT' });
  return request('POST', `/api/tickets/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/reply`, { body });
}

/** POST /api/tickets/:id/dispatch {session_id,note?,mode?} — when_idle:true maps to mode 'when_idle'. */
export function dispatchTicket(id, { session_id, note, when_idle, workspace, sender_id } = {}) {
  if (!id) throw new GolemClientError('dispatchTicket: id is required', { code: 'GOLEM_INVALID_ARGUMENT' });
  return request('POST', `/api/tickets/${encodeURIComponent(id)}/dispatch`, {
    body: { session_id, note, mode: when_idle ? 'when_idle' : 'now', workspace: workspace || undefined, sender_id: sender_id || undefined },
  });
}

/** GET /api/sessions/dispatchable?project */
export function listDispatchable(project) {
  return request('GET', '/api/sessions/dispatchable', {
    params: project ? { project } : {},
  });
}

/**
 * POST /api/brief {session_id,text} — push a channel brief to ONE live session.
 * Pure notification: the dashboard routes it to the target's channel; there are
 * no ticket state/assignment side effects. Returns the dashboard's delivery
 * result ({ok,status,body,target}); throws on a non-2xx (e.g. 502 = the target
 * channel could not be reached).
 */
export function postBrief(sessionId, text) {
  if (!sessionId) throw new GolemClientError('postBrief: sessionId is required', { code: 'GOLEM_INVALID_ARGUMENT' });
  return request('POST', '/api/brief', { body: { session_id: sessionId, text } });
}

export function notifySession({ session_id, text, sender_id, project_id } = {}) {
  return request('POST', '/api/messages/notify', { body: { session_id, text, sender_id, project_id } });
}

// Durable non-ticket control handoff. The dashboard selects the typed
// envelope adapter and preserves the legacy route
// for CC/OC. The MCP client never manufactures an envelope id locally.
export function deliverControlMessage({ session_id, sender_id, project_id, kind, content, metadata, legacy } = {}) {
  return request('POST', '/api/messages/control', {
    body: { session_id, sender_id, project_id, kind, content, metadata, legacy },
  });
}

/** Correlated channel lifecycle updates. The dashboard validates target identity. */
export function acknowledgeEnvelope(id, body) {
  if (!id) throw new GolemClientError('acknowledgeEnvelope: id is required', { code: 'GOLEM_INVALID_ARGUMENT' });
  return request('POST', `/api/message-envelopes/${encodeURIComponent(id)}/ack`, { body, caller_session_id: body?.target_session_id });
}
