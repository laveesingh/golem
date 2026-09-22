#!/usr/bin/env node
// golem channel server — pushes briefs / interrupts / halts / gate verdicts
// into a live `golem-ceo` Claude Code session, and exposes a `GET /events`
// SSE stream so the dashboard can subscribe to CEO acks.
//
// v3 multi-CEO topology:
//   - Each CEO session spawns its own channel-server child (one MCP per CEO).
//   - GOLEM_CHANNEL_PORT=0 (the launcher's default) → bind a random free port,
//     so multiple CEOs coexist without EADDRINUSE.
//   - On listen, the channel server registers itself in
//     ~/.config/golem/channels.json keyed by CLAUDE_CODE_SESSION_ID. The
//     dashboard reads that registry and opens one SSE per session.
//   - Every broadcast payload carries `session_id` so the dashboard can route
//     the message into the right CEO's chat lane.
//
// See plugin/README.md for setup. Authoritative protocol
// docs: https://code.claude.com/docs/en/channels-reference.md
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as tracker from './tracker-client.js';

import { resolveCallerSessionId, resolveProjectCwd, sessionsForParent } from './identity.js';
import { readClaudeSessionRecord } from '../../lib/claude-session-context.js';
import { SESSION_ROLES, pushRoleBriefDirect, setSessionRole } from '../../lib/session-role.js';
import { releaseEndpointLeases, renewEndpointLease, upsertSessionFact } from '../../lib/session-facts.js';

const VERSION = '0.1.0';
// Port selection (multi-CEO safe by default):
//   - Default is 0 → kernel-assigned ephemeral port. This lets any number of
//     channel servers coexist without EADDRINUSE — critical because Claude
//     Code probes this plugin MCP standalone (e.g. `claude mcp list`) with no
//     env set, often while a real CEO session already holds a fixed port.
//   - Set GOLEM_CHANNEL_PORT explicitly (e.g. to 7421) only for single-CEO
//     smoke tests or legacy callers that need a known, pinnable port.
// An empty/unset/blank value resolves to 0. A non-numeric value also falls
// back to 0 rather than NaN (which would crash listen()).
const _rawPort = process.env.GOLEM_CHANNEL_PORT;
const PORT =
  _rawPort != null && _rawPort.trim() !== '' && Number.isFinite(Number(_rawPort))
    ? Number(_rawPort)
    : 0;
const HOST = '127.0.0.1';
const ALLOWED_SENDERS = new Set(
  (process.env.GOLEM_CHANNEL_ALLOWED_SENDERS || 'dashboard,cli,curl')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);


// Identity for chat-routing and dispatch.
//
// The id everything else keys by — `/rename`, `claude agents --json`, the
// dashboard, the tracker — is the session's LOGICAL id. On a RESUMED session
// Claude Code spawns this MCP child with a FRESH per-run `CLAUDE_CODE_SESSION_ID`
// that does NOT equal that logical id; keying the channel off the env var then
// makes channels.json diverge from every other registry (breaking name lookup,
// dispatch, and chat routing for resumed sessions).
//
// The logical id (and the user's chosen /rename name) live in the parent claude
// process's per-session file at ~/.claude/sessions/<pid>.json. This MCP child is
// a DIRECT child of that claude process, so process.ppid points straight at it.
// Prefer that file; fall back to the env ids only when it is unreadable.
function readParentSessionFile() {
  try {
    const j = readClaudeSessionRecord(process.ppid);
    if (j && typeof j === 'object') return j;
  } catch { /* missing / unreadable — fall through */ }
  return null;
}
function deriveSessionId() {
  const bound = launcherBoundSessionId();
  if (bound) {
    if (typeof injectedSessionId === 'string' && injectedSessionId.trim() && injectedSessionId.trim() !== bound) {
      return { sessionId: null, error: 'golem: injected caller identity conflicts with the launcher binding; refusing the tool call.', reject: true };
    }
    return { sessionId: bound, source: 'launcher_binding' };
  }

  const resolved = resolveCallerSessionId({ home: tracker.golemHome() });
  return { ...resolved, sessionId: resolved.sessionId || null };
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const rawArgs = req.params.arguments || {};
  const injectedSessionId = rawArgs.__golem_session_id;
  const args = Object.fromEntries(Object.entries(rawArgs).filter(([key]) => !key.startsWith('__golem_')));
  const caller = resolveToolCaller(injectedSessionId);

  if (caller.reject) {
    return { isError: true, content: [{ type: 'text', text: caller.error || 'golem: caller identity is invalid; refusing the tool call.' }] };
  }


  if (name === 'ack') {
    const payload = {
      kind: args.kind || 'unknown',
      gate_id: args.gate_id,
      summary: typeof args.summary === 'string' ? args.summary : '',
      ts: new Date().toISOString(),
    };
    if (args.envelope_id) {
      try {
        await tracker.acknowledgeEnvelope(String(args.envelope_id), {
          target_session_id: caller.sessionId, kind: payload.kind, summary: payload.summary,
        });
        payload.envelope_id = String(args.envelope_id);
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `ack: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
    broadcast('ack', payload);
    return { content: [{ type: 'text', text: 'ack broadcast' }] };
  }

  if (name === 'session_role') {
    const role = args.role === 'clear' ? null : args.role;
    if (role != null && !SESSION_ROLES.includes(role)) {
      return { isError: true, content: [{ type: 'text', text: `invalid role: ${args.role}` }] };
    }
    if (!SESSION_ID) {
      return { isError: true, content: [{ type: 'text', text: 'session_role: no current session id' }] };
    }
    try {
      const row = setSessionRole(SESSION_ID, role, { by: 'self:mcp' });
      if (role) await pushRoleBriefDirect(SESSION_ID, role, row);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, session_id: row.session_id, role: row.role }, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] };
    }
  }

  if (name === 'project_context') {
    // Deliberately shells out to the same script the SessionStart hook runs,
    // rather than reimplementing the payload here. Two implementations of
    // "what does a session need to know" would drift, and the drift would be
    // invisible because each looks correct on its own.
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const script = [
        path.join(here, '..', '..', 'hooks', 'tracker-context.sh'),
        path.join(here, '..', '..', 'substrate', 'hooks', 'tracker-context.sh'),
      ].find((p) => fs.existsSync(p));
      if (!script) {
        return { isError: true, content: [{ type: 'text', text: 'project_context: tracker-context.sh not found relative to this server.' }] };
      }
      // Rules and rationale live with the function, which is unit-tested in
      // test/sync-enforcement.test.mjs — all three bugs this logic had were
      // reachable without a live server, and all shipped unguarded.
      const projectCwd = resolveProjectCwd({ sessionId: SESSION_ID, home: tracker.golemHome(), cwd: process.cwd() });
      if (!projectCwd) {
        return { isError: true, content: [{ type: 'text', text: 'project_context: cannot determine the project — this session has no registry row and the working directory is not inside a project. Refusing to render context for the wrong directory.' }] };
      }
      const out = execFileSync('bash', [script], {
        cwd: projectCwd,
        encoding: 'utf8',
        input: JSON.stringify({ session_id: SESSION_ID || '', cwd: projectCwd }),
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 3000, // a hung script must not block stdio
      });
      const ctx = JSON.parse(out)?.hookSpecificOutput?.additionalContext || '';
      return { content: [{ type: 'text', text: ctx.trim() || '(no project context available)' }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `project_context: ${String(err?.message ?? err)}` }] };
    }
  }

  // --- Session-to-session notification --------------------------------------
  // Validate an exact immutable session_id against the current dispatchable
  // surface. Names and labels are intentionally not routing keys: a rename or
  // duplicate label must never redirect an active handoff.
  if (name === 'session_notify') {
    const to = typeof args.to === 'string' ? args.to.trim() : '';
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!to) return { isError: true, content: [{ type: 'text', text: 'session_notify: exact `to` session_id is required.' }] };
    if (!text) return { isError: true, content: [{ type: 'text', text: 'session_notify: `text` is required.' }] };

    let sessions;
    try {
      sessions = await tracker.listDispatchable(); // no project ⇒ all live sessions
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `session_notify: could not list live sessions — ${err instanceof Error ? err.message : String(err)}` }] };
    }
    sessions = Array.isArray(sessions) ? sessions : [];

    const target = sessions.find((s) => s && s.session_id === to);
    if (!target) return { isError: true, content: [{ type: 'text', text: `session_notify: no live dispatchable session has exact session_id "${to}". Labels/names are not accepted; call sessions_dispatchable before choosing a new recipient.` }] };
    if (target.reachable === false) {
      return { isError: true, content: [{ type: 'text', text: `session_notify: target session_id "${target.session_id}" has no live channel (unreachable) — it cannot receive a push right now.` }] };
    }

    const message = args.ticket ? `${args.ticket}: ${text}` : text;
    try {
      const senderId = caller.sessionId;
      if (!senderId) return { isError: true, content: [{ type: 'text', text: 'session_notify: no trusted caller session id.' }] };
      const delivery = await tracker.notifySession({ session_id: target.session_id, text: message, sender_id: senderId, project_id: target.project_id || null });
      return { isError: delivery?.ok === false, content: [{ type: 'text', text: JSON.stringify({ ok: delivery?.ok !== false, session_id: target.session_id, delivery }, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `session_notify: delivery failed — ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }


  // --- Golem tracker tools ---------------------------------------------------
  // Each delegates to the HTTP client and returns compact JSON the agent can act
  // on. Identity defaults are injected here so the agent rarely passes ids.
  if (name.startsWith('ticket_') || name === 'sessions_dispatchable') {
    const displayCache = new Map();
    const displayForRef = async (ref) => {
      if (typeof ref !== 'string' || !/^TKT-/.test(ref)) return ref;
      if (displayCache.has(ref)) return displayCache.get(ref);
      try {
        const ticket = await tracker.getTicket(ref);
        const display = ticket?.display_id || null;
        displayCache.set(ref, display);
        return display;
      } catch {
        return null;
      }
    };
    const publicTicketIds = async (value, ticketDisplayId = null) => {
      if (Array.isArray(value)) return Promise.all(value.map((v) => publicTicketIds(v)));
      if (!value || typeof value !== 'object') return value;
      const out = { ...value };
      const display = out.display_id || ticketDisplayId;
      const canonical = typeof out.id === 'string' && /^TKT-/.test(out.id) ? out.id : null;
      if (display && canonical) {
        out.id = display;
      }
      if (display && typeof out.ticket_id === 'string' && /^TKT-/.test(out.ticket_id)) out.ticket_id = display;
      for (const key of ['parent_id', 'from_ticket', 'to_ticket', 'current_in_progress_ticket']) {
        if (typeof out[key] === 'string') out[key] = await displayForRef(out[key]);
      }
      for (const key of ['comments', 'children', 'links', 'events', 'active_unacked_dispatches']) {
        if (Array.isArray(out[key])) out[key] = await Promise.all(out[key].map((v) => publicTicketIds(v, display)));
      }
      if (out.ticket && typeof out.ticket === 'object') out.ticket = await publicTicketIds(out.ticket);
      return out;
    };
    const jsonResult = async (value) => ({
      content: [{ type: 'text', text: JSON.stringify(await publicTicketIds(value), null, 2) }],
    });
    try {
      const sessionId = caller.sessionId;
      const defaultProject = tracker.currentProjectId(sessionId);
      const writeTools = new Set([
        'ticket_create', 'ticket_update', 'ticket_comment',
        'ticket_comment_update', 'ticket_comment_reply', 'ticket_dispatch',
      ]);
      if (writeTools.has(name) && !sessionId) throw new Error(caller.error);

      // Resolve the `project` query value for LIST-style tools. `all:true` or
      // project "*" ⇒ list across all projects (omit the filter). Otherwise an
      // explicit project wins, else the session's current project.
      const resolveListProject = () => {
        if (args.all === true || args.project === '*') return undefined;
        if (args.project) return args.project;
        return defaultProject ?? undefined;
      };

      if (name === 'ticket_list') {
        const params = {};
        const proj = resolveListProject();
        if (proj) params.project = proj;
        if (args.mine === true) {
          if (!sessionId) throw new Error('ticket_list mine:true — no current session id (GOLEM_CEO_SESSION_ID/CLAUDE_CODE_SESSION_ID unset)');
          params.assignee = sessionId;
        } else if (args.assignee != null) {
          params.assignee = args.assignee;
        }
        if (args.state != null) params.state = args.state;
        if (args.kind != null) params.kind = args.kind;
        return await jsonResult(await tracker.listTickets(params));
      }

      if (name === 'ticket_get') {
        if (!args.id) throw new Error('ticket_get: id is required');
        return await jsonResult(await tracker.getTicket(args.id));
      }

      if (name === 'ticket_create') {
        const project_id = args.project || defaultProject;
        if (!project_id) throw new Error('ticket_create: could not resolve a project — pass project:"<contract-id>"');
        const body = {
          project_id,
          title: args.title,
          body: args.body,
          ...(args.body_format ? { body_format: args.body_format } : {}),
          kind: args.kind,
          priority: args.priority,
          state: args.state,
          labels: args.labels,
          parent_id: args.parent_id,
          assignee: args.assignee,
          source_ref: args.source_ref,
          created_by: sessionId ?? undefined,
        };
        return await jsonResult(await tracker.createTicket(body));
      }

      if (name === 'ticket_update') {
        if (!args.id) throw new Error('ticket_update: id is required');
        const patch = { actor: sessionId ?? undefined };
        for (const k of ['state', 'title', 'body', 'body_format', 'expected_revision', 'kind', 'priority', 'labels', 'parent_id', 'assignee']) {
          if (args[k] !== undefined) patch[k] = args[k];
        }
        return await jsonResult(await tracker.updateTicket(args.id, patch));
      }

      if (name === 'ticket_comment') {
        if (!args.id) throw new Error('ticket_comment: id is required');
        if (!sessionId) throw new Error('ticket_comment: no current session id to record as author');
        const comment = {
          author: sessionId,
          body: args.body,
          quote: args.quote,
          prefix: args.prefix,
          suffix: args.suffix,
          section: args.section,
          section_id: args.section_id,
          status: args.status,
          parent_id: args.parent_id,
        };
        return await jsonResult(await tracker.addComment(args.id, comment));
      }

      if (name === 'ticket_comment_update') {
        if (!args.id) throw new Error('ticket_comment_update: id is required');
        if (!args.comment_id) throw new Error('ticket_comment_update: comment_id is required');
        const patch = {};
        for (const k of ['body', 'status']) {
          if (args[k] !== undefined) patch[k] = args[k];
        }
        return await jsonResult(await tracker.updateComment(args.id, args.comment_id, patch));
      }

      if (name === 'ticket_comment_reply') {
        if (!args.id) throw new Error('ticket_comment_reply: id is required');
        if (!args.comment_id) throw new Error('ticket_comment_reply: comment_id is required');
        if (!sessionId) throw new Error('ticket_comment_reply: no current session id to record as author');
        return await jsonResult(await tracker.replyComment(args.id, args.comment_id, {
          author: sessionId,
          body: args.body,
        }));
      }

      if (name === 'ticket_dispatch') {
        if (!args.id) throw new Error('ticket_dispatch: id is required');
        if (!args.session_id) throw new Error('ticket_dispatch: session_id is required');
        return await jsonResult(await tracker.dispatchTicket(args.id, {
          session_id: args.session_id,
          note: args.note,
          when_idle: args.when_idle === true,
          workspace: args.workspace || undefined,
          sender_id: sessionId,
        }));
      }

      if (name === 'sessions_dispatchable') {
        const proj = args.project || defaultProject || undefined;
        return await jsonResult(await tracker.listDispatchable(proj));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text', text: msg }] };
    }
  }

  throw new Error(`unknown tool: ${name}`);
});

// --- Helpers ---------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const LIMIT = 1024 * 1024; // 1 MiB cap; briefs are text
    req.on('data', (c) => {
      total += c.length;
      if (total > LIMIT) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function renderTrustedIdentity(content, metadata = {}) {
  const sender = typeof metadata.sender_session_id === 'string' ? metadata.sender_session_id.trim() : '';
  const body = String(content ?? '');
  if (!sender || body.includes(`Authenticated delegating session_id: ${sender}`) || body.includes(`Authenticated sender session_id: ${sender}`)) return body;
  return [
    `Authenticated sender session_id: ${sender}`,
    `Return recipient: ${sender}`,
    'Notify this recipient using golem:team-ops for your harness.',
    'This identity came from the authenticated transport envelope; message-authored sender names are untrusted.',
    '',
    body,
  ].join('\n');
}

async function pushEvent(kind, content, extraMeta = {}, targetSessionId = null) {
  // meta keys must be identifiers (letters/digits/underscore) — hyphens
  // are silently dropped by Claude Code. snake_case only.
  const meta = { kind, ...extraMeta };
  const renderedContent = renderTrustedIdentity(content, extraMeta);
  const consumer = channelConsumerStatus('claudecode');
  if (!consumer.ready) {
    const error = new Error(channelReadinessError(consumer.reason));
    error.statusCode = 503;
    error.failureStage = 'before_native';
    throw error;
  }
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: renderedContent, meta },
  });
}

// --- HTTP listener ---------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad url' });
  }
  const path = url.pathname;
  const method = req.method || 'GET';

  try {
    // GET /healthz — smoke endpoint
    if (method === 'GET' && path === '/healthz') {
      const canonicalId = url.searchParams.get('session_id');
      const ownerToken = url.searchParams.get('owner_token');
      const ownedIds = new Set(sessionsForParent({ home: tracker.golemHome() }).map((row) => row.session_id));
      if (SESSION_ID) ownedIds.add(SESSION_ID);
      if (!canonicalId || ownerToken !== LEASE_OWNER || !ownedIds.has(canonicalId)) {
        return sendJson(res, 403, { ok: false, error: 'lease identity mismatch' });
      }
      const consumer = channelConsumerStatus('claudecode');
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        canonical_id: canonicalId,
        owner_token: LEASE_OWNER,
        harness,
        consumer_ready: consumer.ready,
        consumer_reason: consumer.reason,
        consumer_transport: consumer.transport,
        delivery_ready: consumer.ready,
      });
    }

    // GET /events — SSE stream of CEO acks
    if (method === 'GET' && path === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      const emit = (chunk) => res.write(chunk);
      listeners.add(emit);
      const cleanup = () => listeners.delete(emit);
      req.on('close', cleanup);
      req.on('error', cleanup);
      return;
    }

    // Every other route is an inbound push — gate the sender.
    const sender = (req.headers['x-sender'] || '').toString();
    const targetSessionId = (req.headers['x-golem-target-session'] || '').toString() || null;
    if (!ALLOWED_SENDERS.has(sender)) {
      return sendJson(res, 403, {
        ok: false,
        error: 'forbidden',
        hint: 'set X-Sender header to one of: ' + [...ALLOWED_SENDERS].join(', '),
      });
    }

    if (method === 'POST' && path === '/brief') {
      const body = await readBody(req);
      const metadata = extractMetadata(body);
      await pushEvent('brief', extractContent(body), metadata, targetSessionId || metadata.target_session_id || null);
      return sendJson(res, 202, { ok: true, kind: 'brief' });
    }

    // POST /role — identity only (dashboard/CLI role assignment). Never a work brief.
    if (method === 'POST' && path === '/role') {
      const body = await readBody(req);
      await pushEvent('role_assign', extractContent(body), {}, targetSessionId);
      return sendJson(res, 202, { ok: true, kind: 'role_assign' });
    }

    if (method === 'POST' && path === '/interrupt') {
      const body = await readBody(req);
      await pushEvent('interrupt', extractContent(body), {}, targetSessionId);
      return sendJson(res, 202, { ok: true, kind: 'interrupt' });
    }

    if (method === 'POST' && path === '/halt') {
      const body = await readBody(req);
      await pushEvent('halt', extractContent(body) || 'halt requested', {}, targetSessionId);
      return sendJson(res, 202, { ok: true, kind: 'halt' });
    }


    // /gates/:id/(approve|deny|cancel)
    const gateMatch = /^\/gates\/([A-Za-z0-9._-]+)\/(approve|deny|cancel)$/.exec(path);
    if (method === 'POST' && gateMatch) {
      const gateId = gateMatch[1];
      const verdict = gateMatch[2];
      const body = await readBody(req);
      const note = extractContent(body);
      const kind = `gate_${verdict}`;
      const content = note || `${verdict} ${gateId}`;
      await pushEvent(kind, content, { gate_id: gateId });
      return sendJson(res, 202, { ok: true, kind, gate_id: gateId });
    }

    return sendJson(res, 404, { ok: false, error: 'not found', path, method });
  } catch (err) {
    // Never crash on a bad client request.
    const msg = err instanceof Error ? err.message : String(err);
    try {
      const status = Number(err?.statusCode) >= 400 && Number(err?.statusCode) <= 599
        ? Number(err.statusCode)
        : 500;
      sendJson(res, status, { ok: false, error: msg,
        ...(method === 'POST' && path === '/brief'
          ? { failure_stage: err?.failureStage || 'after_native', retryable: err?.failureStage === 'before_native' }
          : {}),
      });
    } catch {
      // headers already sent; nothing else to do.
    }
  }
});

server.on('clientError', (_err, socket) => {
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch {
    // socket already closed
  }
});

function extractContent(raw) {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // If JSON with a 'content' or 'brief' field, use that; otherwise treat the
  // whole parsed value (or raw text) as the brief body.
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.content === 'string') return parsed.content;
      if (typeof parsed.brief === 'string') return parsed.brief;
      return JSON.stringify(parsed);
    }
    if (typeof parsed === 'string') return parsed;
  } catch {
    // not JSON — fall through
  }
  return trimmed;
}

function extractMetadata(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    for (const key of ['envelope_id', 'sender_session_id', 'target_session_id']) {
      if (typeof parsed[key] === 'string' && parsed[key]) out[key] = parsed[key];
    }
    return out;
  } catch {
    return {};
  }
}

// --- Boot ------------------------------------------------------------------
mcp.oninitialized = () => {
  MCP_INITIALIZED = true;
  if (BOUND_PORT != null) {
    try { registerChannel(BOUND_PORT, { logMissing: false }); } catch { /* heartbeat retries */ }
  }
};

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : PORT;
  BOUND_PORT = boundPort;
  // stderr only — stdout is reserved for MCP stdio framing.
  process.stderr.write(
    `[golem-channel] http://${HOST}:${boundPort} (v${VERSION}) session=${SESSION_ID || '(none)'}\n`,
  );
  try { registerChannel(boundPort); } catch (err) {
    process.stderr.write(`[golem-channel] register failed: ${err.message}\n`);
  }
  // Re-assert registration on an interval. registerChannel only fires once at
  // listen — if this session's entry is ever lost afterward (a cross-process
  // write race, a manual edit, file corruption), it would never come back.
  // A periodic re-register makes the registry self-healing: any loss is
  // corrected within HEARTBEAT_MS. registerChannel is idempotent (it filters
  // this session's stale rows before re-adding). unref() so the timer never
  // keeps the process alive on its own.
  const HEARTBEAT_MS = Number(process.env.GOLEM_CHANNEL_HEARTBEAT_MS) || 30_000;
  setInterval(() => {
    try { registerChannel(boundPort); } catch { /* transient — next tick retries */ }
  }, HEARTBEAT_MS).unref();
});

// Cleanup hooks — the channel registry should not grow ghosts when the CEO
// dies or restarts. The stale-PID GC in the dashboard is a backstop, not a
// primary cleanup path.
function shutdown(code = 0, why = 'signal') {
  try { process.stderr.write(`[golem-channel] shutdown (${why})\n`); } catch { /* stderr gone */ }
  {
    unregisterChannel();
    try { server.close(); } catch { /* ignore */ }
  }
  process.exit(code);
}
process.on('SIGINT',  () => shutdown(0, 'SIGINT'));
process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
process.on('SIGHUP',  () => shutdown(0, 'SIGHUP'));
process.on('beforeExit', () => {
  {
    unregisterChannel();
  }
});
// TKT-0369: the channel died mid-session with zero trace (no stderr, no crash
// report) — every abnormal exit must say why, or the next death is
// undiagnosable. Claude Code persists this stderr into its MCP log.
process.on('uncaughtException', (err) => {
  try { process.stderr.write(`[golem-channel] uncaughtException: ${err?.stack || err}\n`); } catch { /* stderr gone */ }
  shutdown(1, 'uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  try { process.stderr.write(`[golem-channel] unhandledRejection: ${msg}\n`); } catch { /* stderr gone */ }
  shutdown(1, 'unhandledRejection');
});
process.on('exit', (code) => {
  // Sync-safe on 'exit'; catches any path the handlers above missed.
  try { process.stderr.write(`[golem-channel] exit code=${code}\n`); } catch { /* stderr gone */ }
});

// SDK 1.29.0's StdioServerTransport does not translate stdin EOF into
// transport.onclose. Observe EOF directly so a host disappearing without a
// signal cannot leave the HTTP channel registered as a zombie.
process.stdin.once('end', () => shutdown(0, 'mcp stdin closed by host'));
await mcp.connect(new StdioServerTransport());
// TKT-0369: if the host closes the MCP stdio transport without killing us, the
// HTTP server would keep this process alive as a ZOMBIE channel — registered in
// channels.json, accepting briefs, but unable to deliver the notifications push
// (the transport is gone). Shut down cleanly instead so the registry reflects
// reality. (onclose is supported: @modelcontextprotocol/sdk 1.29.0
// Protocol._onclose invokes this.onclose.)
mcp.onclose = () => shutdown(0, 'mcp transport closed by host');
