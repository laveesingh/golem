import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import url from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { CONFIG } from './config.js';
import { createState } from './state.js';
import { ROLES } from './roles.js';
import { pushBrief, pushInterrupt, pushHalt, channelHealth, listChannels } from './brief.js';
import { createChat } from './chat.js';
import { readNativeSessionPeek } from './native-session-peek.js';
import { openTrackerDb } from './tracker-db.js';
import { readChannels } from './channels.js';
import { applyGateVerdict } from './projects.js';
import { listIdeas, createIdea, popIdea } from './ideas.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..', 'web');
// The tracker genre templates live OUTSIDE dashboard/ (in the plugin source
// tree at plugin/skills/tracker/templates/). Resolve the repo root two levels
// up from this file (dashboard/server/index.js → dashboard/ → repo root) and
// point at that dir. Used by GET /api/templates.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'plugin', 'skills', 'tracker', 'templates');

// Legacy markdown tracker columns (kept in /api/meta for API stability; the UI
// no longer renders the markdown board).
const TRACKER_COLUMNS = ['triage', 'open', 'in-progress', 'review', 'blocked', 'done'];

// ── Canonical project_id scheme (WS2) ───────────────────────────────────────
// Tickets, the projects list, and native sessions are reconciled on ONE id:
// the CONTRACT project_id `<slug>-<6hex>` derived from the absolute project
// root (see project-id.js → projectIdFor). It is what every project summary
// exposes as `project_id`, what native-sessions.js derives, and therefore what
// tickets must carry as `project_id`. The dashboard registry `id` (dir name like
// `sudoku`, or a hand-set external id like `trialroom-ai`) is NOT canonical and
// is deliberately NOT used to key tickets — it diverges across project kinds.
// `/api/tickets?project=` and `/api/sessions/dispatchable?project=` both expect
// this contract id. We tolerate a registry-`id` being passed by resolving it to
// the contract id via the projects list before querying (resolveProjectId).

// The golem config dir — same resolution as tracker-db.js / channels.js
// (XDG_CONFIG_HOME ?? ~/.config, then /golem). Used for dashboard.json.
function golemConfigDir() {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'golem');
}

/** Read the pid previously recorded by a dashboard instance, if any. */
function readPreviousDashboardPid() {
  const target = path.join(golemConfigDir(), 'dashboard.json');
  try {
    const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (doc && typeof doc.pid === 'number') return doc.pid;
  } catch {}
  return null;
}

/** Spawn lsof to find the pid listening on a TCP port. Falls back to fuser. */
function findListenerPid(port) {
  const lsof = spawnSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-FpcL'], { encoding: 'utf8' });
  if (lsof.error) {
    const fuser = spawnSync('fuser', [port + '/tcp'], { encoding: 'utf8' });
    if (fuser.error) {
      return { pid: null, error: `cannot identify process holding port ${port} (lsof/fuser unavailable)` };
    }
    const m = String(fuser.stdout).match(/\d+/);
    return { pid: m ? Number(m[0]) : null, error: null };
  }
  for (const line of String(lsof.stdout).split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      if (!Number.isNaN(pid)) return { pid, error: null };
    }
  }
  return { pid: null, error: `lsof found no LISTEN process on port ${port}` };
}

/** Return true if a process with this pid is still alive. */
function isProcessAlive(pid) {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

/** Short sleep helper for polling during graceful shutdown waits. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Look up the command name of a process for clearer error messages. */
function getProcessComm(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
  return (result.stdout || '').trim() || 'unknown';
}

async function main() {
  const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const state = createState();
  // TKT-0107: tracker is opened BEFORE state.init() so the composite
  // last_activity_at signal in the sidebar can read maxTicketUpdatedAt.
  // (state.init(tracker) needs the tracker reference; previously init()
  // took no args and the tracker wasn't wired in.)
  // WS2: the dashboard is the SINGLE WRITER of the tracker DB. Open it once
  const chat = createChat();
  chat.start();

  // WS2: the dashboard is the SINGLE WRITER of the tracker DB. Open it once
  // here (it auto-inits / migrates). GOLEM_TRACKER_DB override flows through
  // openTrackerDb → defaultDbPath. Closed in shutdown() below.
  const tracker = openTrackerDb();

  // Load the dashboard state (projects, plans, milestones, channels). State
  // init does an initial rediscover that consumes the tracker reference for
  // per-project last-ticket-updated lookup. The auto-archive sweep (TKT-0105)
  // and the discoverProjects call (TKT-0107) both need it.
  await state.init(tracker);

  // Resolve a caller-supplied `project` query value to the canonical contract
  // project_id. Accepts either the contract id (passed straight through) OR a
  // dashboard registry id (e.g. `sudoku`, `trialroom-ai`) which we map to its
  // project_id via the projects list. Unknown values pass through unchanged so
  // a not-yet-discovered project still filters correctly on its raw id.
  function resolveProjectId(value) {
    if (!value) return null;
    for (const p of state.projects()) {
      if (p.project_id === value) return value; // already canonical
      if (p.id === value && p.project_id) return p.project_id; // registry id → contract id
    }
    return value;
  }

  // WS2: all streams across every project (no all-streams helper on the DB,
  // and discovered projects may lag behind tickets an agent just created — so
  // read the table directly rather than iterating the projects list).
  function listAllStreams() {
    return tracker.raw().prepare('SELECT * FROM streams ORDER BY created_at ASC, id ASC').all();
  }

  await fastify.register(websocket);
  await fastify.register(fastifyStatic, {
    root: WEB_ROOT,
    prefix: '/',
    cacheControl: false,
    // Force browsers to revalidate every asset on each load. Without this the
    // browser will hold onto JSX/CSS via Last-Modified/ETag for the session
    // and dashboard edits won't show up without a hard refresh. The dashboard
    // is an internal-only dev surface — no point in any caching.
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  });

  // SPA fallback (TKT-0146): client-side routes are path-based now
  // (/tickets/<id>, /project/<id>, /dashboard, …). A refresh or deep link on
  // such a path would otherwise 404 because the static plugin only serves real
  // files. For non-API GETs, serve index.html and let the router boot the right
  // view. API/websocket misses still get a real 404.
  fastify.setNotFoundHandler(async (req, reply) => {
    const url = (req.url || '').split('?')[0];
    if (url.startsWith('/api/') || url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not found' });
    }
    if (req.method !== 'GET') {
      return reply.code(404).send({ error: 'not found' });
    }
    try {
      const idx = fs.readFileSync(path.join(WEB_ROOT, 'index.html'));
      reply.type('text/html; charset=utf-8');
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      return reply.send(idx);
    } catch (err) {
      req.log.error({ err }, 'SPA fallback: index.html missing');
      return reply.code(500).send({ error: 'index.html not found' });
    }
  });

  // ---- REST API ----

  fastify.get('/api/health', async () => ({
    ok: true,
    projects_root: CONFIG.projectsRoot,
    project_count: state.projects().length,
    server_time: new Date().toISOString(),
  }));

  fastify.get('/api/meta', async () => ({
    roles: ROLES,
    columns: TRACKER_COLUMNS,
    config: {
      projectsRoot: CONFIG.projectsRoot,
      ideasRoot: CONFIG.ideasRoot,
      golemRoot: CONFIG.golemRoot,
      channelUrl: CONFIG.channelUrl,
      agentActiveWindowMs: CONFIG.agentActiveWindowMs,
      agentIdleTimeoutMs: CONFIG.agentIdleTimeoutMs,
      ceoLiveWindowMs: CONFIG.ceoLiveWindowMs,
    },
  }));

  fastify.get('/api/projects', async () => state.projects());

  fastify.get('/api/workspaces', async () => state.workspaces());

  // WS2: fold the tracker tables into every snapshot so a fresh client renders
  // the board immediately (no extra round-trip). v4 snapshot carries projects,
  // native_sessions, channels, recent_milestones; the tracker DB adds tickets
  // and streams.
  function trackerSnapshot() {
    return {
      tickets: tracker.listTickets({}),
      streams: listAllStreams(),
    };
  }

  fastify.get('/api/snapshot', async () => ({
    ...state.snapshot(),
    ...trackerSnapshot(),
    chat: chat.snapshot(),
  }));

  fastify.get('/api/chat', async () => chat.snapshot());

  // ---- Orchestrator intrusion proxy (dashboard → golem MCP channel server) ----

  // Accept either { brief: "..." } / { text: "..." } / raw string, or any
  // serialisable JSON the user wants to attach. We forward what we get.
  function extractBody(req) {
    const b = req.body;
    if (b == null) return '';
    if (typeof b === 'string') return b;
    if (typeof b.brief === 'string') return b.brief;
    if (typeof b.text === 'string') return b.text;
    return b;
  }

  function bodyToText(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (typeof body.brief === 'string') return body.brief;
    if (typeof body.text === 'string') return body.text;
    try { return JSON.stringify(body); } catch { return String(body); }
  }

  // Record the user/system message FIRST so the chat lane updates even if the
  // channel server is unreachable. On forward failure, emit a system note so
  // the user sees what went wrong instead of a silent vanish.
  function noteForwardFailure(label, result) {
    const detail = result?.error || `status ${result?.status ?? '?'}`;
    chat.record('system', 'error', `${label} not delivered — channel ${detail}. Is the CEO session running?`);
  }

  // session_id is taken from the body OR the ?session= query string. The
  // frontend always passes it through the body so a single brief can be
  // routed to a specific CEO; query string is for curl convenience.
  function extractSessionId(req) {
    const sid = (req.body && typeof req.body === 'object' && typeof req.body.session_id === 'string'
      ? req.body.session_id
      : null) ?? (typeof req.query?.session === 'string' ? req.query.session : null);
    return sid && sid.trim() ? sid.trim() : null;
  }

  fastify.post('/api/brief', async (req, reply) => {
    const body = extractBody(req);
    const sessionId = extractSessionId(req);
    chat.record('user', 'brief', bodyToText(body), sessionId ? { session_id: sessionId } : {});
    const result = await pushBrief(body, sessionId);
    if (!result.ok) {
      noteForwardFailure('brief', result);
      return reply.code(502).send(result);
    }
    return result;
  });
  fastify.post('/api/interrupt', async (req, reply) => {
    const body = extractBody(req);
    const sessionId = extractSessionId(req);
    chat.record('user', 'interrupt', bodyToText(body), sessionId ? { session_id: sessionId } : {});
    const result = await pushInterrupt(body, sessionId);
    if (!result.ok) {
      noteForwardFailure('interrupt', result);
      return reply.code(502).send(result);
    }
    return result;
  });
  fastify.post('/api/halt', async (req, reply) => {
    const body = extractBody(req);
    const sessionId = extractSessionId(req);
    chat.record('system', 'halt', bodyToText(body) || 'halt requested', sessionId ? { session_id: sessionId } : {});
    const result = await pushHalt(body, sessionId);
    if (!result.ok) {
      noteForwardFailure('halt', result);
      return reply.code(502).send(result);
    }
    return result;
  });
  // v4: brief / interrupt / halt are delivered over per-session channels.
  // Gate verdicts (v3 docs/agent-notes/gates/ flow) were removed in TKT-0009.
  fastify.get('/api/channel/health', async (req) => channelHealth(typeof req.query?.session === 'string' ? req.query.session : null));
  fastify.get('/api/channels', async () => listChannels());

  fastify.get('/api/projects/:id', async (req, reply) => {
    const p = state.project(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    return state
      .projects()
      .find((x) => x.id === req.params.id);
  });

  // v4: PLAN.md progress for a single project. Returns {total, done, items}
  // (+ title). 404 if the project is unknown; {total:0,...} if it has no plan.
  fastify.get('/api/projects/:id/plan', async (req, reply) => {
    const p = state.project(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const plan = state.projectPlan(req.params.id);
    if (!plan) return { title: null, total: 0, done: 0, items: [] };
    return plan;
  });

  // TKT-0194: apply a human verdict to a gate (approve | deny | cancel).
  // Writes the new status to the gate file and returns the new state. The
  // dashboard refreshes the projects list (which re-reads gates on the
  // next request) to show the updated verdict.
  fastify.post('/api/projects/:id/gates/:gateId/:decision', async (req, reply) => {
    const p = state.project(req.params.id);
    if (!p) return reply.code(404).send({ error: 'project_not_found' });
    try {
      const result = await applyGateVerdict(p.gatesDir, req.params.gateId, req.params.decision);
      return result;
    } catch (err) {
      if (err && err.status) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  // v4: all native Claude Code sessions on this machine (merged CLI + registry,
  // pid-checked). Already inside /api/snapshot as native_sessions[]; this is a
  // convenience route + the polling target for any external scripting.
  fastify.get('/api/native-sessions', async () => state.nativeSessions());

  // v4 (fix round 2, defect 1): per-session peek for the native-session drawer.
  // Returns { session, events, milestones, transcript_path, note } where events
  // are the recent central-journal hook lines filtered by this session_id.
  fastify.get('/api/native-sessions/:sessionId/peek', async (req) => {
    const sessionId = req.params.sessionId;
    const session = state.nativeSessions().find((s) => s.session_id === sessionId) ?? null;
    return readNativeSessionPeek(sessionId, session);
  });

  // ---- WS2: tracker REST (the dashboard is the SINGLE WRITER) ----
  // Every mutation persists via `tracker` then broadcasts a WS delta.

  // GET /api/tickets — consolidated/filtered board feed. No `project` = all
  // projects. The DB filter key is `project_id`; the REST param is `project`.
  fastify.get('/api/tickets', async (req) => {
    const q = req.query ?? {};
    const filter = {};
    if (q.project != null) filter.project_id = resolveProjectId(q.project);
    if (q.state != null) filter.state = q.state;
    if (q.assignee != null) filter.assignee = q.assignee;
    if (q.kind != null) filter.kind = q.kind;
    if (q.stream != null) filter.stream_id = q.stream;
    if (q.includeArchived != null) {
      filter.includeArchived = q.includeArchived === 'true' || q.includeArchived === true || q.includeArchived === '1';
    }
    return tracker.listTickets(filter);
  });

  // POST /api/tickets — create. 400 on validation error.
  fastify.post('/api/tickets', async (req, reply) => {
    const b = req.body ?? {};
    try {
      const ticket = tracker.createTicket({
        project_id: b.project_id,
        kind: b.kind,
        title: b.title,
        body: b.body,
        priority: b.priority,
        labels: b.labels,
        stream_id: b.stream_id,
        parent_id: b.parent_id,
        assignee: b.assignee,
        created_by: b.created_by,
      });
      broadcastWS({ type: 'ticket-created', ticket });
      return reply.code(201).send(ticket);
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // GET /api/tickets/:id — ticket (+ comments/links from getTicket) plus its
  // event history. 404 if unknown.
  fastify.get('/api/tickets/:id', async (req, reply) => {
    const ticket = tracker.getTicket(req.params.id);
    if (!ticket) return reply.code(404).send({ error: 'not_found' });
    return { ...ticket, events: tracker.listEvents({ ticket_id: req.params.id }) };
  });

  // PATCH /api/tickets/:id — partial update. 404 if missing, 400 on invalid.
  fastify.patch('/api/tickets/:id', async (req, reply) => {
    const id = req.params.id;
    if (!tracker.getTicket(id)) return reply.code(404).send({ error: 'not_found' });
    try {
      const ticket = tracker.updateTicket(id, req.body ?? {});
      broadcastWS({ type: 'ticket-updated', ticket });
      return ticket;
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // TKT-0105: POST /api/tickets/:id/move — atomic state + rank change used by
  // drag-and-drop. Body: { state, before_id?, after_id?, actor? }. The endpoint
  // computes the new rank from the neighbour tickets (midpoint if both given,
  // otherwise appends to the target state). Replaces the old "PATCH with
  // {state}" path for drag operations (Phase B tracker-board.jsx still calls
  // PATCH; follow-up ticket will switch it to /move).
  fastify.post('/api/tickets/:id/move', async (req, reply) => {
    const id = req.params.id;
    if (!tracker.getTicket(id)) return reply.code(404).send({ error: 'not_found' });
    try {
      const ticket = tracker.moveTicket(id, req.body ?? {});
      broadcastWS({ type: 'ticket-updated', ticket });
      return ticket;
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // TKT-0105: POST /api/tickets/auto-archive/sweep — manual trigger for the
  // 14-day done → archived sweep. Returns the list of archived ticket ids.
  // The same sweep runs automatically every 6 hours (see setInterval below).
  fastify.post('/api/tickets/auto-archive/sweep', async (req) => {
    const ids = runAutoArchiveSweep();
    if (ids.length > 0) {
      broadcastWS({ type: 'tickets-batch-archived', ids });
    }
    return { archived: ids.length, ids };
  });

  // TKT-0106: ticket asset upload. Validates MIME, size, and filename; stores
  // content-addressed under CONFIG.assetsDir; returns the public URL.
  fastify.post('/api/ticket-assets', async (req, reply) => {
    const b = req.body ?? {};
    const { filename, mime, base64 } = b;
    if (!filename || typeof filename !== 'string') return reply.code(400).send({ error: 'filename required' });
    if (!mime || !CONFIG.assetAllowedMime.includes(mime)) {
      return reply.code(400).send({ error: `mime must be one of ${CONFIG.assetAllowedMime.join(', ')}` });
    }
    if (typeof base64 !== 'string' || !base64) return reply.code(400).send({ error: 'base64 required' });
    // Decode + size check (raw bytes, NOT the base64 string length).
    const buf = Buffer.from(base64, 'base64');
    if (buf.length === 0) return reply.code(400).send({ error: 'empty payload' });
    if (buf.length > CONFIG.assetMaxBytes) {
      return reply.code(413).send({ error: `payload too large (${buf.length} > ${CONFIG.assetMaxBytes})` });
    }
    // Sanitise filename to extension (rest ignored). Map mime → ext.
    const ext = ({
      'image/png':  'png',
      'image/jpeg': 'jpg',
      'image/gif':  'gif',
      'image/webp': 'webp',
    })[mime];
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    fs.mkdirSync(CONFIG.assetsDir, { recursive: true });
    const relPath = `${hash}.${ext}`;
    const fullPath = path.join(CONFIG.assetsDir, relPath);
    if (!fs.existsSync(fullPath)) fs.writeFileSync(fullPath, buf);
    return { url: `/api/ticket-assets/${relPath}`, filename, mime, size: buf.length };
  });

  // TKT-0106: serve a content-addressed asset. Reject anything that doesn't
  // match the hash.ext pattern (defends against ../etc/passwd etc.).
  fastify.get('/api/ticket-assets/:name', async (req, reply) => {
    const name = req.params.name;
    if (!/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(name)) {
      return reply.code(400).send({ error: 'invalid asset name' });
    }
    const fullPath = path.join(CONFIG.assetsDir, name);
    if (!fullPath.startsWith(CONFIG.assetsDir + path.sep) && fullPath !== CONFIG.assetsDir) {
      return reply.code(400).send({ error: 'path traversal' });
    }
    if (!fs.existsSync(fullPath)) return reply.code(404).send({ error: 'not_found' });
    const ext = name.split('.').pop();
    const mime = ({ png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' })[ext];
    const stream = fs.createReadStream(fullPath);
    reply.header('Content-Type', mime);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable'); // hash-based, safe to cache forever
    return reply.send(stream);
  });

  // POST /api/tickets/:id/comments — add a comment. Broadcasts both the comment
  // delta AND a ticket-updated (addComment bumps the ticket's updated_at).
  // POST /api/tickets/:id/comments — add a comment (plain or inline anchored).
  // Body: { author, body, quote?, prefix?, suffix?, section?, section_id?, tag?, status?, parent_id?, block_id? }
  fastify.post('/api/tickets/:id/comments', async (req, reply) => {
    const id = req.params.id;
    const b = req.body ?? {};
    try {
      const comment = tracker.addComment(id, {
        author: b.author,
        body: b.body,
        quote: b.quote,
        prefix: b.prefix,
        suffix: b.suffix,
        section: b.section,
        section_id: b.section_id,
        tag: b.tag,
        status: b.status,
        parent_id: b.parent_id,
        block_id: b.block_id,
      });
      broadcastWS({ type: 'ticket-comment', ticket_id: id, comment });
      const ticket = tracker.getTicket(id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      return reply.code(201).send(comment);
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // PATCH /api/tickets/:id/comments/:cid — update a comment (status, tag, body).
  fastify.patch('/api/tickets/:id/comments/:cid', async (req, reply) => {
    const { id, cid } = req.params;
    const b = req.body ?? {};
    try {
      const comment = tracker.updateComment(id, cid, {
        body: b.body,
        tag: b.tag,
        status: b.status,
        block_id: b.block_id,
      });
      broadcastWS({ type: 'ticket-comment-updated', ticket_id: id, comment });
      const ticket = tracker.getTicket(id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      return comment;
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // POST /api/tickets/:id/comments/:cid/reply — add a reply to a comment.
  fastify.post('/api/tickets/:id/comments/:cid/reply', async (req, reply) => {
    const { id, cid } = req.params;
    const b = req.body ?? {};
    try {
      const comment = tracker.addComment(id, {
        author: b.author,
        body: b.body,
        parent_id: cid,
        tag: 'note',
      });
      broadcastWS({ type: 'ticket-comment', ticket_id: id, comment });
      const ticket = tracker.getTicket(id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      return reply.code(201).send(comment);
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // POST /api/tickets/:id/links — add a link from this ticket. Re-fetch + send
  // the from-ticket as a ticket-updated delta.
  fastify.post('/api/tickets/:id/links', async (req, reply) => {
    const id = req.params.id;
    const b = req.body ?? {};
    try {
      tracker.addLink(id, b.to_ticket, b.type);
      const ticket = tracker.getTicket(id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      return reply.code(201).send({ from_ticket: id, to_ticket: b.to_ticket, type: b.type });
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // DELETE /api/tickets/:id/links — remove a link. Re-fetch + send the
  // from-ticket as a ticket-updated delta.
  fastify.delete('/api/tickets/:id/links', async (req, reply) => {
    const id = req.params.id;
    const b = req.body ?? {};
    try {
      const result = tracker.removeLink(id, b.to_ticket, b.type);
      const ticket = tracker.getTicket(id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      return result;
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // POST /api/tickets/:id/dispatch — assign a ticket to a live native session
  // and push it a self-contained brief so that session picks the work up.
  //
  // Durable-first (mirrors the gate handler): setDispatched flips assignee +
  // dispatched_to + dispatched_at and records a `dispatched` event BEFORE we
  // touch the channel. The channel push is best-effort — an unreachable session
  // never fails the request, since the assignment is already on disk and the
  // session (or the user) can pick it up on resume.
  fastify.post('/api/tickets/:id/dispatch', async (req, reply) => {
    const id = req.params.id;
    const b = req.body ?? {};
    const sessionId = typeof b.session_id === 'string' && b.session_id.trim() ? b.session_id.trim() : null;
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null;

    const existing = tracker.getTicket(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    if (!sessionId) return reply.code(400).send({ error: 'session_id is required' });

    // 1) Durable write — assign + record the dispatched event. Source of truth.
    tracker.setDispatched(id, { session_id: sessionId, actor: 'human' });

    // 2) Build a clear, self-contained brief so the receiving session knows
    //    exactly what it's been handed and how to pick it up. The tracker MCP
    //    tools (ticket_get, etc.) land in WS3 — naming them now is intentional.
    const briefString =
      `You've been assigned tracker ticket ${id}: "${existing.title}" (project ${existing.project_id}, kind ${existing.kind}).\n\n` +
      `${note ? note + '\n\n' : ''}` +
      `Load it with the golem tracker tools (ticket_get ${id}) to read the full body, acceptance criteria, and comment thread, then pick it up: move it to in_progress, do the work, comment progress, and move it to review/done when complete. ` +
      `If you have blocking questions, create a question-kind ticket in this project assigned to 'human'.`;

    // 3) Best-effort channel push — never fail the request on a push miss.
    let channelResult = null;
    try {
      channelResult = await pushBrief(briefString, sessionId);
    } catch (err) {
      channelResult = { ok: false, error: String(err?.message ?? err) };
    }
    if (channelResult && channelResult.ok) {
      chat.record('user', 'brief', briefString, { session_id: sessionId });
    } else {
      const detail = channelResult?.error || `status ${channelResult?.status ?? '?'}`;
      chat.record('system', 'error', `dispatch of ${id} to ${sessionId} — channel ${detail} (ticket assigned; session will pick it up on resume)`);
    }

    const ticket = tracker.getTicket(id);
    broadcastWS({ type: 'ticket-updated', ticket });
    return { ok: true, ticket, channel: channelResult };
  });

  // GET /api/streams — streams for one project, or all if `project` omitted.
  fastify.get('/api/streams', async (req) => {
    const project = req.query?.project;
    if (project != null) return tracker.listStreams(resolveProjectId(project));
    return listAllStreams();
  });

  // POST /api/streams — create a stream. 400 on validation error.
  fastify.post('/api/streams', async (req, reply) => {
    const b = req.body ?? {};
    try {
      const stream = tracker.createStream({
        project_id: b.project_id,
        name: b.name,
        mode: b.mode,
        description: b.description,
      });
      broadcastWS({ type: 'stream-updated', stream });
      return reply.code(201).send(stream);
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // PATCH /api/streams/:id — update a stream. 404 if missing, 400 on invalid.
  fastify.patch('/api/streams/:id', async (req, reply) => {
    try {
      const stream = tracker.updateStream(req.params.id, req.body ?? {});
      broadcastWS({ type: 'stream-updated', stream });
      return stream;
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // GET /api/sessions/dispatchable — live native sessions in a project that can
  // actually receive a brief: alive === true AND mapping to the requested
  // project (canonical contract id), INTERSECTed with channels.json by
  // session_id (only registered channels are reachable). `project` omitted →
  // all dispatchable sessions (each annotated with its project_id).
  fastify.get('/api/sessions/dispatchable', async (req) => {
    const wanted = req.query?.project != null ? resolveProjectId(req.query.project) : null;
    let channels = [];
    try {
      channels = await readChannels();
    } catch (err) {
      // Don't let a registration/channel read failure go silently latent —
      // the previous bare catch hid a missing-import ReferenceError for ~1 day
      // and presented as a permanently-disabled dispatch field.
      console.error('[dispatchable] readChannels failed:', err);
      channels = [];
    }
    const channelBySession = new Map();
    for (const c of channels) if (c.session_id) channelBySession.set(c.session_id, c);

    const out = [];
    for (const s of state.nativeSessions()) {
      if (!s.alive) continue;
      if (wanted != null && s.project_id !== wanted) continue;
      const ch = channelBySession.get(s.session_id);
      if (!ch) continue; // no channel → not reachable for dispatch
      out.push({
        session_id: s.session_id,
        name: s.name ?? null,
        label: s.name || `session ${String(s.session_id ?? '').slice(0, 8)}`,
        status: s.status ?? null,
        project_id: s.project_id ?? null,
        channel_url: ch.url ?? (ch.host && ch.port ? `http://${ch.host}:${ch.port}` : null),
        started_at: s.started_at ?? null,
        updated_at: s.updated_at ?? null,
      });
    }
    return out;
  });

  // GET /api/templates — genre scaffolds (feature/bug/design-doc/prd/brainstorm/
  // decision) shipped as Markdown bodies. Reads the templates dir at
  // plugin/skills/tracker/templates/ (outside dashboard/), returns one entry per
  // .md file: { id, title, body }. id = filename stem; title = first `# ` heading
  // in the file, or the stem if none. body = the raw markdown, verbatim. Used by
  // the create-ticket composer's template picker.
  fastify.get('/api/templates', async () => {
    let files = [];
    try {
      files = fs.readdirSync(TEMPLATES_DIR)
        .filter((f) => f.endsWith('.md'))
        .sort();
    } catch (err) {
      fastify.log.error({ err }, '[templates] could not read templates dir %s', TEMPLATES_DIR);
      return [];
    }
    const out = [];
    for (const file of files) {
      const id = file.slice(0, -3); // strip .md
      let body = '';
      try {
        body = fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8');
      } catch (err) {
        fastify.log.warn({ err }, '[templates] could not read %s', file);
        continue;
      }
      // First `# ` heading wins; fall back to the id.
      let title = id;
      for (const line of body.split('\n')) {
        const m = /^#\s+(.+?)\s*$/.exec(line);
        if (m) { title = m[1]; break; }
      }
      out.push({ id, title, body });
    }
    return out;
  });

  // TKT-0206: global ideas stack. A FIFO queue of raw thoughts the user
  // drops via the bottom-left anchor in the dashboard. Each idea is a
  // .md file at ~/.config/golem/ideas/ with frontmatter (id, created_at,
  // status) + body. "Popping" deletes the file (the user is taking it
  // forward — likely into a tracker ticket).
  fastify.get('/api/ideas', async () => listIdeas());

  fastify.post('/api/ideas', async (req, reply) => {
    try {
      const idea = await createIdea({ body: req.body?.body || '' });
      return idea;
    } catch (err) {
      if (err && err.status) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  fastify.post('/api/ideas/:id/pop', async (req, reply) => {
    try {
      return await popIdea(req.params.id);
    } catch (err) {
      if (err && err.status) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  // ---- WebSocket ----

  const sockets = new Set();

  fastify.register(async (fast) => {
    fast.get('/ws', { websocket: true }, (socket /*, req*/) => {
      sockets.add(socket);

      // Send full snapshot on connect.
      try {
        socket.send(
          JSON.stringify({
            type: 'snapshot',
            payload: { ...state.snapshot(), ...trackerSnapshot(), chat: chat.snapshot() },
            ts: Date.now(),
          }),
        );
      } catch (err) {
        fastify.log.warn({ err }, 'ws snapshot send failed');
      }

      socket.on('message', (raw) => {
        let msg = null;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ping') {
          try {
            socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          } catch {
            /* ignore */
          }
          return;
        }
        // v3 subscribe-agent removed in TKT-0009.
      });

      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
    });
  });

  function broadcastWS(payloadObj) {
    if (sockets.size === 0) return;
    let payload;
    try {
      payload = JSON.stringify({ ...payloadObj, ts: Date.now() });
    } catch (err) {
      fastify.log.warn({ err }, 'failed to serialise ws payload');
      return;
    }
    for (const sock of sockets) {
      if (sock.readyState !== 1) continue;
      try {
        sock.send(payload);
      } catch {
        sockets.delete(sock);
      }
    }
  }

  // Chat messages → all connected sockets.
  chat.on('message', (m) => {
    broadcastWS({ type: 'chat-message', message: m });
  });

  // Forward state events → all connected sockets.
  state.on('event', (ev) => {
    if (sockets.size === 0) return;
    let payload;
    try {
      payload = JSON.stringify({ ...ev, ts: Date.now() });
    } catch (err) {
      fastify.log.warn({ err }, 'failed to serialise state event');
      return;
    }
    for (const sock of sockets) {
      if (sock.readyState !== 1) continue;
      try {
        sock.send(payload);
      } catch {
        sockets.delete(sock);
      }
    }
  });

  // TKT-0105: 14-day done → archived auto-archive sweep. Runs once on
  // startup, then every 6 hours. The endpoint POST /api/tickets/auto-archive/sweep
  // triggers the same function on demand for tests and admin overrides.
  function runAutoArchiveSweep() {
    try {
      const ids = tracker.autoArchiveDone();
      if (ids.length > 0) {
        fastify.log.info({ count: ids.length }, 'auto-archived done tickets');
        broadcastWS({ type: 'tickets-batch-archived', ids });
      }
      return ids;
    } catch (err) {
      fastify.log.warn({ err }, 'auto-archive sweep failed');
      return [];
    }
  }
  // Run once on startup so a freshly-restarted dashboard catches up.
  setImmediate(() => runAutoArchiveSweep());
  // Periodic sweep every 6 hours. Unref so it doesn't keep the event loop
  // alive on shutdown.
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const sweepTimer = setInterval(runAutoArchiveSweep, SIX_HOURS_MS);
  sweepTimer.unref();

  // Pin to the canonical dashboard URL http://dashboard.golem.localhost:7420.
  // If 7420 is busy, check whether the occupying process is the previous
  // dashboard recorded in ~/.config/golem/dashboard.json. If so, terminate it
  // gracefully and retry once. If it is any other process, refuse to kill it
  // and exit with a clear error. We never walk to higher ports.
  const tryListen = async (port) => {
    const previousPid = readPreviousDashboardPid();

    let bound = false;
    try {
      await fastify.listen({ host: CONFIG.host, port });
      bound = true;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }

    if (bound) {
      fastify.log.info(`dashboard listening on http://${CONFIG.host}:${port}`);
      return port;
    }

    const holder = findListenerPid(port);
    if (!holder.pid) {
      throw new Error(holder.error || `port ${port} is in use but no listener was found`);
    }

    const { pid } = holder;
    if (previousPid && pid === previousPid && isProcessAlive(previousPid)) {
      fastify.log.info(`replacing previous dashboard pid=${previousPid}`);
      try {
        process.kill(previousPid, 'SIGTERM');
      } catch (err) {
        fastify.log.warn({ err }, `SIGTERM to previous dashboard pid=${previousPid} failed`);
      }
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (!isProcessAlive(previousPid)) break;
        await sleep(200);
      }
      if (isProcessAlive(previousPid)) {
        fastify.log.warn(`previous dashboard pid=${previousPid} did not exit after 3s; sending SIGKILL`);
        try {
          process.kill(previousPid, 'SIGKILL');
        } catch (err) {
          fastify.log.warn({ err }, `SIGKILL to previous dashboard pid=${previousPid} failed`);
        }
        await sleep(1000);
      }
      try {
        await fastify.listen({ host: CONFIG.host, port });
        fastify.log.info(`dashboard listening on http://${CONFIG.host}:${port}`);
        return port;
      } catch (err) {
        throw new Error(`port ${port} still in use after replacing previous dashboard: ${err.message}`);
      }
    }

    const comm = getProcessComm(pid);
    console.error(
      `port ${port} is held by pid ${pid} (${comm}) — not the previous dashboard; refusing to kill it. Stop that process and retry.`,
    );
    process.exit(1);
  };

  // Canonical URL is http://dashboard.golem.localhost:7420 (RFC 6761 *.localhost
  // resolves to 127.0.0.1 — no /etc/hosts edit needed).
  const boundPort = await tryListen(CONFIG.port);

  // WS2: self-register so WS3's MCP discovery can find the live dashboard.
  // Atomic write (tmp + rename) into ~/.config/golem/dashboard.json. Best-effort
  // — a write failure logs a warning and must NOT crash the server. We LEAVE the
  // file on shutdown (a stale entry is harmless: consumers health-check the URL).
  try {
    const dir = golemConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'dashboard.json');
    const tmp = path.join(dir, `.dashboard.json.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const doc = {
      url:
        CONFIG.host === '127.0.0.1' && boundPort === 7420
          ? `http://dashboard.golem.localhost:${boundPort}`
          : `http://${CONFIG.host}:${boundPort}`,
      host: CONFIG.host,
      port: boundPort,
      pid: process.pid,
      started_at: new Date().toISOString(),
    };
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, target);
    fastify.log.info(`self-registered at ${target}`);
  } catch (err) {
    fastify.log.warn({ err }, 'dashboard self-registration failed (non-fatal)');
  }

  // Clean shutdown.
  const shutdown = async () => {
    fastify.log.info('shutting down…');
    try {
      chat.stop();
      await state.close();
      tracker.close();
      await fastify.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
