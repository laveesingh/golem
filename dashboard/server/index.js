import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { CONFIG } from './config.js';
import { createState } from './state.js';
import { roleMetaMap } from './roles.js';
import { pushBrief, pushInterrupt, pushHalt, pushControlEnvelope, channelHealth, listChannels } from './brief.js';
import { createChat } from './chat.js';
import { readNativeSessionPeek } from './native-session-peek.js';
import { openTrackerDb } from './tracker-db.js';
import { isChannelDeliveryReady, isTypedWorkerChannel, readChannels } from './channels.js';
import { applyGateVerdict, createGate } from './projects.js';
import { listIdeas, createIdea, popIdea, readIdea } from './ideas.js';
import { initDispatchDrainer } from './dispatch-queue.js';
import { registerSubstrateRoutes } from './substrate.js';
import { teamAssists } from './team-assist.js';
import { golemHome, dashboardJsonPath, journalDirFor, sessionsJsonPath } from '../../lib/golem-home.js';
import { createRole, deleteRole, getRole, listRoleCards, roleChangeBrief, roleMission, setSessionRole, updateRoleMeta, writeRoleCard } from '../../lib/session-role.js';
import { enrichDispatchableRows, spawnWorker, killWorker, peekWorker, peekSessionTerminal, sendWorkerKeys } from '../../lib/worker-manager.js';
import { listWorkers } from '../../lib/worker-registry.js';
import { capturePane, hasSession } from '../../lib/tmux-driver.js';
import { acceptedDelivery, publishDurableEnvelope, settleDurableEnvelope } from './envelope-delivery.js';
import { recordTypedEnvelopeOutcome } from './typed-delivery.js';
import { sameEndpointSecret } from '../../lib/typed-worker-endpoint.js';
import { hasTypedWorkerCapability, readEndpointLeases, readSessionFacts } from '../../lib/session-facts.js';
import {
  clearRoleDefault,
  createProfile,
  deleteProfile,
  loadProfilesStore,
  setRoleDefault,
  updateProfile,
} from '../../lib/model-profiles.js';
import {
  isCatalogCacheExpired,
  readModelCatalogCache,
  readPiModelCatalog,
  writeModelCatalogCache,
} from './model-catalog.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const WEB_SOURCE_ROOT = path.resolve(__dirname, '..', 'web');
const WEB_DIST_ROOT = path.resolve(__dirname, '..', 'dist');
const WEB_ROOT = fs.existsSync(path.join(WEB_DIST_ROOT, 'index.html')) ? WEB_DIST_ROOT : WEB_SOURCE_ROOT;
// The tracker genre templates live OUTSIDE dashboard/, in the substrate
// source tree at substrate/skills/tracker/templates/ (TKT-0574 — plugin/ is
// now a generated render of substrate/, not the SoT). Resolve the repo root
// two levels up from this file (dashboard/server/index.js → dashboard/ →
// repo root) and point at that dir. Used by GET /api/templates.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'substrate', 'skills', 'tracker', 'templates');

function modelProfilesPayload() {
  return loadProfilesStore();
}

function roleCardsWithDefaults() {
  const defaults = modelProfilesPayload().role_defaults;
  return listRoleCards().map((role) => ({
    ...role,
    default_profile: defaults[role.name] ?? null,
  }));
}

function profileRouteError(reply, error) {
  const message = String(error?.message ?? error);
  const code = /not found/i.test(message)
    ? 404
    : /already exists|default model profile|referenced/i.test(message)
      ? 409
      : 400;
  return reply.code(code).send({ error: message });
}

function catalogPayload(catalog, { source, stale = false, fetchedAt = null, error = null } = {}) {
  return {
    providers: catalog?.providers ?? [],
    modelsByProvider: catalog?.modelsByProvider ?? {},
    source: source ?? 'unavailable',
    stale: !!stale,
    fetched_at: fetchedAt ?? null,
    error: error ? String(error) : null,
  };
}

function refreshCatalogPayload() {
  const cached = readModelCatalogCache();
  try {
    const fresh = writeModelCatalogCache(readPiModelCatalog());
    return catalogPayload(fresh.catalog, { source: 'pi', fetchedAt: fresh.fetched_at });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (cached) {
      return catalogPayload(cached.catalog, {
        source: 'cache',
        stale: true,
        fetchedAt: cached.fetched_at,
        error: message,
      });
    }
    return catalogPayload(null, { source: 'unavailable', stale: true, error: message });
  }
}

function readCatalogPayload() {
  const cached = readModelCatalogCache();
  if (cached && !isCatalogCacheExpired(cached)) {
    return catalogPayload(cached.catalog, { source: 'cache', fetchedAt: cached.fetched_at });
  }
  return refreshCatalogPayload();
}

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

/** Look up the command name of a process for clearer error messages. */
function getProcessComm(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
  return (result.stdout || '').trim() || 'unknown';
}

// TKT-0245: build a self-contained brief so the receiving session knows exactly
// what it's been handed and how to pick it up. Extracted from the inline
// construction in the dispatch handler so the drainer (dispatch-queue.js)
// produces byte-identical briefs — no format drift between the two delivery
// paths. `note` is an already-trimmed string or null.
// `workspace` is an optional directive ('worktree' | undefined) that appends
// a workspace setup block to the brief (GOL-316 §2.7).

function ticketSlug(title) {
  return String(title || 'ticket')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function workspaceBlock(ticket) {
  const id = ticket.display_id || ticket.id;
  const slug = ticketSlug(ticket.title);
  const branch = `feat/${id.toLowerCase()}-${slug}`;
  const dir = `.worktrees/${id}-${slug}/`;
  return [
    '',
    '## Workspace: worktree',
    `Branch: \`${branch}\``,
    `Worktree dir: \`${dir}\``,
    '',
    '### Setup',
    '```bash',
    `git worktree add ${dir} -b ${branch} main`,
    `cp -Rc node_modules ${dir}node_modules`,
    `cp -Rc mcp/channel/node_modules ${dir}mcp/channel/node_modules`,
    '```',
    '',
    '### Rules',
    '- Build inside the worktree; commit conventional commits on the branch.',
    '- Rebase on main before handing off for review.',
    '- **Prohibited inside the worktree:** `golem sync`, restarting the dashboard, editing the main checkout, claiming shared runtimes (port 7420, docker stacks).',
    '- Self-contained checks only: unit tests, `node --check`, temp-DB scripts.',
    '',
    '### Hand-off',
    `- Closing brief MUST include \`branch: ${branch}\` line.`,
    '- Ticket → review when done; the orchestrator reconciles via `git merge --no-ff` on main.',
  ].join('\n');
}

function authenticatedReturnBlock(senderSessionId, ticketId) {
  if (!senderSessionId) return [];
  return [
    '',
    '## Return route',
    `Authenticated delegating session_id: ${senderSessionId}`,
    `Return notification: call session_notify({ to: "${senderSessionId}", ticket: "${ticketId}", text: "<outcome, durable report location, and the coordinator's next action>" }).`,
    'This immutable session id came from the trusted handoff envelope. Do not route by a label/name, rediscover a peer, or choose a different lead.',
  ];
}

function buildDispatchBrief(ticket, note, workspace, messageId = null, senderSessionId = null) {
  if (ticket?.kind === 'spec') return buildSpecBrief(ticket, note, workspace, messageId, senderSessionId);
  const id = ticket.display_id || ticket.id;
  let brief = [
    `You've been assigned tracker ticket ${id}: "${ticket.title}" (project ${ticket.project_id}, kind ${ticket.kind}).\n\n` +
    `${note ? note + '\n\n' : ''}` +
    `Load it with the golem tracker tools (ticket_get ${id}) to read the full body, acceptance criteria, and comment thread, then pick it up: move it to in_progress, do the work, comment progress, and move it to review/done when complete. ` +
    `If something blocks you, comment the blocker on the ticket, move it to blocked, and notify the delegating session.` +
    (messageId ? `\n\nDispatch message_id: ${messageId}\nAcknowledge this dispatch first with ack({ kind: 'brief', summary: '<one sentence>', envelope_id: '${messageId}' }).` : ''),
    ...authenticatedReturnBlock(senderSessionId, id),
  ].join('\n');
  if (workspace === 'worktree') brief += workspaceBlock(ticket);
  return brief;
}

function buildSpecBrief(ticket, note, workspace, messageId = null, senderSessionId = null) {
  const id = ticket.display_id || ticket.id;
  const comments = (ticket.comments || []).filter((c) => c.dispatch_state === 'undispatched' || c.dispatch_state === 'dispatched');
  const children = ticket.children || [];
  const commentSection = comments.length
    ? comments.map((c, idx) => [
      `### Comment ${idx + 1}: ${c.id}`,
      `Author: ${c.author || 'unknown'} · state: ${c.dispatch_state}`,
      c.block_id ? `Block: ${c.block_id}` : null,
      c.anchor_kind ? `Anchor: ${c.anchor_kind}` : null,
      c.quote ? `Quote: ${c.quote}` : null,
      '',
      c.body || '',
    ].filter((line) => line != null).join('\n')).join('\n\n')
    : 'No undispatched/dispatched comments.';
  const childSection = children.length
    ? children.map((c) => `- ${c.display_id || c.id}: ${c.title} — ${c.state}`).join('\n')
    : 'No children.';
  const lines = [
    `You've been assigned spec ticket ${id}: "${ticket.title}" (project ${ticket.project_id}).`,
    '',
    note || null,
    'This is a full-context spec dispatch. Re-read the spec, the active comment feedback, and the child summaries before proceeding.',
    '',
    `Spec: ${id}`,
    `State: ${ticket.state}`,
    '',
    '## Spec Body',
    ticket.body || '(empty)',
    '',
    '## Active Comments',
    commentSection,
    '',
    '## Children',
    childSection,
    '',
    `Load it with the golem tracker tools (ticket_get ${id}) to read the full body, comment thread, and links, then pick it up: move it to in_progress, do the work, comment progress, and move it to review/done when complete.`,
    'If something blocks you, comment the blocker on the spec, move it to blocked, and notify the delegating session.',
    messageId ? `Dispatch message_id: ${messageId}\nAcknowledge this dispatch first with ack({ kind: 'brief', summary: '<one sentence>', envelope_id: '${messageId}' }).` : null,
    ...authenticatedReturnBlock(senderSessionId, id),
  ];
  if (workspace === 'worktree') lines.push(workspaceBlock(ticket));
  return lines.filter((line) => line != null).join('\n');
}

function statusForHookEvent(type) {
  switch (type) {
    case 'session-start': return 'idle';
    case 'user-prompt': return 'busy';
    case 'stop': return 'idle';
    case 'session-end': return 'ended';
    default: return null;
  }
}

function updateSessionMaterializedStatusFromIngest(result) {
  const rows = Array.isArray(result?.events) ? result.events : [];
  if (!rows.length) return { updated: 0 };
  let doc;
  const target = sessionsJsonPath();
  try {
    doc = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return { updated: 0 };
  }
  if (!Array.isArray(doc.sessions)) doc.sessions = [];
  let changed = 0;
  for (const row of rows) {
    if (row?.duplicate || row?.class !== 'lifecycle') continue;
    const data = row.data || {};
    const hookEvent = data.hook_event || String(row.type || '').replace(/^hook_/, '').replace(/_/g, '-');
    const status = statusForHookEvent(hookEvent);
    const sessionId = data.session_id;
    if (!status || !sessionId) continue;
    const idx = doc.sessions.findIndex((s) => s?.session_id === sessionId);
    if (idx < 0) continue;
    const prev = doc.sessions[idx] || {};
    doc.sessions[idx] = {
      ...prev,
      status,
      status_updated_at: row.created_at,
      last_seen_at: row.created_at,
      ended_at: status === 'ended' ? row.created_at : (status === 'idle' || status === 'busy' ? null : prev.ended_at),
    };
    changed += 1;
  }
  if (!changed) return { updated: 0 };
  try {
    const tmp = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, target);
  } catch (err) {
    return { updated: 0, error: String(err?.message ?? err) };
  }
  return { updated: changed };
}

function shellQuote(s) {
  return `'${String(s || '').replace(/'/g, `'\\''`)}'`;
}

function reviveCommandFor(session) {
  const cwd = session?.project_root || session?.cwd || REPO_ROOT;
  const name = session?.name || session?.session_id || '';
  return [
    `cd ${shellQuote(cwd)} && golemc`,
    name ? `# then run: /rename ${name}` : null,
  ].filter(Boolean).join('\n');
}

function firstClosingBriefLine(comment) {
  const text = String(comment?.body || '').replace(/<[^>]+>/g, ' ').trim();
  const section = text.split(/\n###\s+/).find((s) => /^What was done\b/i.test(s)) || text;
  const line = section.split('\n').map((l) => l.replace(/^[-*]\s+/, '').trim()).find((l) => l && !/^What was done\b/i.test(l));
  return line || 'Closing brief posted.';
}

function specRetroBody(tracker, spec) {
  const children = (spec.children || []).filter((child) => child.kind !== 'spec');
  const shipped = children.map((child) => {
    const full = tracker.getTicket(child.id);
    const closing = (full?.comments || []).reverse().find((c) => /closing brief/i.test(c.body || ''));
    return `- ${child.display_id || child.id}: ${child.title} - ${closing ? firstClosingBriefLine(closing) : 'No closing brief found.'}`;
  });
  return [
    '## What shipped',
    shipped.length ? shipped.join('\n') : '- No child tickets found.',
    '',
    '## Lessons',
    '- ',
    '',
    '## Proposed doc deltas',
    '- CLAUDE.md: ',
    '- AGENTS.md: ',
    '- REPO-MAP.md: ',
  ].join('\n');
}

function handleSpecClosed(tracker, existing, ticket, actor = 'system') {
  if (!existing || !ticket || existing.kind !== 'spec' || ticket.kind !== 'spec' || existing.state === 'done' || ticket.state !== 'done') return null;
  const fresh = tracker.getTicket(ticket.id);
  if ((fresh.comments || []).some((c) => c.block_id === 'retro')) return null;

  const text = `Spec ${fresh.display_id || fresh.id} closed: ${fresh.title}`;
  const journalDir = journalDirFor(fresh.project_id);
  fs.mkdirSync(journalDir, { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event: 'milestone',
    session_id: actor,
    project_id: fresh.project_id,
    text,
  });
  fs.appendFileSync(path.join(journalDir, 'hook.jsonl'), `${line}\n`, 'utf8');

  const comment = tracker.addComment(fresh.id, {
    author: 'system:spec-close',
    body: specRetroBody(tracker, fresh),
    tag: 'note',
    status: 'open',
    block_id: 'retro',
  });
  return { ticket: tracker.getTicket(fresh.id), comment, milestone: JSON.parse(line) };
}

function ideaSpecBody(body) {
  return [
    '# Spec: Promoted idea',
    '',
    '## 1. Intent (raw thoughts, preserved)',
    '',
    String(body || '').trim() || '(empty idea)',
    '',
    '## 2. Current behavior and constraints',
    '',
    'What the grounded code and research say: relevant existing behavior, the constraints that shape the design, and anything that rules a direction out. Cite paths and sources.',
    '',
    '## 3. Design',
    '',
    'The chosen direction and its important trade-offs, in enough depth that a builder never reconstructs the design conversation.',
    '',
    '## 4. Decisions',
    '',
    'Choices the human committed during the brainstorm. These are locked; reopen only with the human.',
    '',
    '| Decision | Why | Road not taken |',
    '|----------|-----|----------------|',
    '| <decision> | <reason> | <rejected alternative, when it explains the choice> |',
    '',
    '## 5. Scope and non-goals',
    '',
    '- In: <scope>',
    '- Out: <non-goal>',
    '',
    '## 6. Acceptance',
    '',
    '- [ ] <observable behavior or outcome>',
    '',
    '## 7. Open questions',
    '',
    'Unresolved questions for the human. Delete this section when none exist.',
    '',
    '- [ ] <question>',
    '',
    '> [!NOTE]',
    '> No fan-out section here. Child work items render below the spec body automatically.',
  ].join('\n');
}

function gateIdFromBlock(blockId) {
  const m = String(blockId || '').match(/^gate:(.+)$/);
  return m ? m[1] : null;
}

function gateRaiserFromComment(comment) {
  const author = String(comment?.author || '').trim();
  if (author && !['human', 'system'].includes(author)) return author;
  const m = String(comment?.body || '').match(/^Requested by:\s*(\S+)/mi);
  return m ? m[1] : null;
}

function gateVerdictFromText(text) {
  const raw = String(text || '').toLowerCase();
  if (/\b(cancel|cancelled|canceled)\b/.test(raw)) return 'cancel';
  if (/\b(deny|denied|reject|rejected)\b/.test(raw)) return 'deny';
  if (/\b(approve|approved|yes|proceed|go ahead|supplied|done)\b/.test(raw)) return 'approve';
  return null;
}

function hasExplicitLegacyPiDelivery(fact) {
  return fact?.harness === 'pi'
    && !hasTypedWorkerCapability(fact)
    && fact?.delivery?.mode === 'next_turn'
    && fact?.delivery?.push === false;
}

async function deliverControlEnvelope(tracker, {
  project_id = null,
  sender_id,
  recipient_session_id,
  kind,
  content,
  metadata = {},
  legacy,
  envelope: existingEnvelope = null,
  settlement = null,
} = {}) {
  const envelope = existingEnvelope ?? tracker.createControlEnvelope({
    project_id,
    sender_id,
    recipient_session_id,
    kind,
    payload: { content, ...metadata },
  });
  let typedTarget = false;
  try {
    typedTarget = (await listChannels()).some((channel) => (
      channel.session_id === recipient_session_id && isTypedWorkerChannel(channel)
    ));
  } catch { /* a registry read failure does not erase durable capability */ }
  // A live lease is transport reachability, not the definition of a worker's
  // delivery contract. During reload/rebind a typed native worker still needs
  // its original durable envelope held in the generic retry queue. Only an
  // explicitly legacy Tier-B Pi fact may use its old compatibility route.
  if (!typedTarget) {
    try {
      const fact = readSessionFacts().find((entry) => entry?.canonical_id === recipient_session_id);
      typedTarget = hasTypedWorkerCapability(fact)
        || (fact?.harness === 'pi' && !hasExplicitLegacyPiDelivery(fact));
    } catch { /* absent facts preserve legacy behavior without inventing a spool */ }
  }
  const result = await publishDurableEnvelope({
    tracker,
    envelope,
    sessionId: recipient_session_id,
    content,
    legacy,
    typedTarget,
    settlement,
    publish: ({ envelope: targetEnvelope, content: targetContent, legacy: targetLegacy, metadata: typedMetadata }) => (
      pushControlEnvelope({ envelope: targetEnvelope, content: targetContent, legacy: targetLegacy, metadata: typedMetadata }, recipient_session_id)
    ),
  });
  return { ...result, typed_target: typedTarget };
}

async function notifyGateResolved(tracker, comment, patchBody) {
  const gateId = gateIdFromBlock(comment?.block_id);
  if (!gateId || comment?.status !== 'resolved') return null;
  const sessionId = gateRaiserFromComment(comment);
  if (!sessionId) return { ok: false, error: 'gate raiser missing', gate_id: gateId };
  const explicitText = String(patchBody || '').trim();
  const note = explicitText || `Gate ${gateId} resolved.`;
  const verdict = explicitText ? gateVerdictFromText(explicitText) : null;
  const content = verdict
    ? `GATE ${verdict.toUpperCase()} — ${gateId}\n\n${note}`
    : `Gate ${gateId} resolved.\n\n${note}`;
  const { envelope, delivery } = await deliverControlEnvelope(tracker, {
    project_id: comment?.project_id ?? null,
    sender_id: 'human:dashboard',
    recipient_session_id: sessionId,
    kind: 'gate_resolution',
    content,
    metadata: { gate_id: gateId, verdict: verdict || 'brief' },
    legacy: verdict
      ? { path: `/gates/${encodeURIComponent(gateId)}/${verdict}`, body: note }
      : { path: '/brief', body: content },
  });
  if (!acceptedDelivery(delivery)) console.warn(`[gates] resolve notification for ${gateId} to ${sessionId} failed: ${delivery.error || delivery.status}`);
  return { ...delivery, envelope_id: envelope.id, gate_id: gateId, session_id: sessionId, verdict: verdict || 'brief' };
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
  tracker.recomputeAllCommentDispatchStates();

  // Load the dashboard state (projects, plans, milestones, channels). State
  // init does an initial rediscover that consumes the tracker reference for
  // per-project last-ticket-updated lookup. The auto-archive sweep (TKT-0105)
  // and the discoverProjects call (TKT-0107) both need it.
  await state.init(tracker);

  // Resolve a caller-supplied `project` query value to the canonical contract
  // project_id. Accepts either the contract id (passed straight through) OR a
  // dashboard registry id (e.g. `sudoku`, `trialroom-ai`) OR a unique human
  // project name, which we map to its project_id via the projects list.
  // Ambiguous names are rejected rather than silently selecting a workspace.
  // Unknown values pass through unchanged so a not-yet-discovered project
  // still filters correctly on its raw id.
  function resolveProjectId(value) {
    if (!value) return null;
    const requested = String(value).trim();
    if (!requested) return null;
    const projects = state.projects();
    for (const p of projects) {
      if (p.project_id === requested) return requested; // already canonical
      if (p.id === requested && p.project_id) return p.project_id; // registry id → contract id
    }
    const named = projects.filter((p) => p.name === requested && p.project_id);
    if (named.length === 1) return named[0].project_id;
    if (named.length > 1) {
      const ids = [...new Set(named.map((p) => p.project_id))];
      const error = new Error(`project name "${requested}" is ambiguous (${ids.join(', ')}); pass an exact project_id`);
      error.statusCode = 400;
      error.code = 'AMBIGUOUS_PROJECT_NAME';
      throw error;
    }
    return requested;
  }

  function resolveTicketRef(ref) {
    if (!ref) return null;
    return tracker.getTicket(ref) || tracker.getTicketByDisplayId(ref);
  }

  function publicComment(comment, ticket) {
    return comment && ticket?.display_id ? { ...comment, ticket_id: ticket.display_id } : comment;
  }

  function resolveTicketIdField(ref) {
    if (ref == null || ref === '') return ref;
    const ticket = resolveTicketRef(ref);
    if (!ticket) throw new Error(`ticket ref '${ref}' not found`);
    return ticket.id;
  }

  function enforceAttribution(reply, body, field, context) {
    if (String(body?.[field] || '').trim()) return null;
    const message = `${context}: explicit ${field} is required for attribution`;
    if (CONFIG.attributionMode === 'reject') return reply.code(400).send({ error: message, attribution_mode: 'reject' });
    fastify.log.warn({ context, field, attribution_mode: CONFIG.attributionMode }, message);
    reply.header('X-Golem-Attribution-Warning', message);
    return null;
  }

  function deadSessionRevival(ticket, opts = {}) {
    const minAgeMinutes = Math.max(0, Number(opts.minAgeMinutes ?? 5) || 5);
    const pending = tracker.getPendingDispatchForTicket(ticket.id);
    if (!ticket || ticket.kind !== 'spec' || !pending) return { eligible: false, reason: 'not_applicable' };
    const ageMs = Date.now() - (Date.parse(pending.created_at || '') || Date.now());
    if (ageMs < minAgeMinutes * 60_000) {
      return { eligible: false, reason: 'too_new', min_age_minutes: minAgeMinutes, pending_dispatch: pending };
    }
    const sessionId = pending.session_id || ticket.assignee;
    const native = state.nativeSessions().find((s) => s.session_id === sessionId) || null;
    const channel = state.channels().find((c) => c.session_id === sessionId) || null;
    const offline = !native || native.alive === false || !channel;
    if (!offline) return { eligible: false, reason: 'session_live', min_age_minutes: minAgeMinutes, pending_dispatch: pending };
    const label = native?.name || pending.session_label || ticket.assignee_label || `session ${String(sessionId || '').slice(0, 8)}`;
    const project = state.project(ticket.project_id);
    const fallbackSession = { name: label, session_id: sessionId, project_root: project?.path || REPO_ROOT, cwd: project?.path || REPO_ROOT };
    return {
      eligible: true,
      reason: !native || native.alive === false ? 'session_offline' : 'channel_unreachable',
      min_age_minutes: minAgeMinutes,
      age_ms: ageMs,
      pending_dispatch: pending,
      session: native ? { ...native, label } : { ...fallbackSession, label, project_id: ticket.project_id },
      revive_command: reviveCommandFor(native || fallbackSession),
    };
  }

  const NORMALIZED_DELIVERY_REASONS = new Set([
    'ready', 'busy', 'waiting', 'missing_channel', 'endpoint_unhealthy', 'not_ready',
  ]);

  function deriveSessionDelivery(session, channel) {
    const channel_present = !!channel;
    const endpoint_health = channel?.endpoint_health
      ?? (session.fact_observed_at ? 'unreachable' : (session.endpoint_health ?? 'legacy'));
    const delivery_ready = isChannelDeliveryReady(channel);
    const endpointUnhealthy = endpoint_health === 'unreachable'
      || endpoint_health === 'unverified'
      || endpoint_health === 'unhealthy';
    const publishedReason = typeof channel?.delivery_reason === 'string'
      ? channel.delivery_reason
      : channel?.consumer_reason;
    const normalizedReason = NORMALIZED_DELIVERY_REASONS.has(publishedReason)
      ? publishedReason
      : null;
    const delivery_reason = delivery_ready ? 'ready'
      : !channel_present ? 'missing_channel'
      : endpointUnhealthy ? 'endpoint_unhealthy'
      : session.status === 'waiting' ? 'waiting'
      : session.status === 'busy' ? 'busy'
      : normalizedReason ?? 'not_ready';
    return {
      channel_present,
      endpoint_health,
      delivery_ready,
      delivery_reason,
      // Existing routing callers use reachable for immediate eligibility. Keep
      // that meaning while exposing endpoint presence separately above.
      reachable: delivery_ready,
    };
  }

  function hasAuthenticatedHealthyChannel(session) {
    return session.channel_present === true
      && session.endpoint_health === 'healthy'
      && session.delivery_reason !== 'not_ready';
  }

  function enrichSessionRows(rows, channels = []) {
    const channelById = new Map((channels || []).filter((c) => c.session_id).map((c) => [c.session_id, c]));
    const pendingBySession = tracker.countPendingDispatchesBySession();
    const unackedBySession = new Map();
    for (const warning of tracker.activeUnackedWarnings()) {
      const arr = unackedBySession.get(warning.session_id) ?? [];
      arr.push(warning);
      unackedBySession.set(warning.session_id, arr);
    }
    return (rows || []).map((s) => {
      const delivery = deriveSessionDelivery(s, channelById.get(s.session_id));
      return {
        ...s,
        role: s.role ?? null,
        harness: s.harness ?? 'claudecode',
        ...delivery,
        pending_count: pendingBySession.get(s.session_id) ?? 0,
        current_in_progress_ticket: tracker.currentInProgressTicketForSession(s.session_id),
        has_unacked_dispatch: (unackedBySession.get(s.session_id) ?? []).length > 0,
        active_unacked_dispatches: unackedBySession.get(s.session_id) ?? [],
        project_id: s.project_id ?? null,
      };
    });
  }

  function slimTicket(ticket) {
    if (!ticket) return null;
    return {
      id: ticket.id,
      display_id: ticket.display_id ?? null,
      title: ticket.title,
      kind: ticket.kind,
      state: ticket.state,
    };
  }

  function buildTeamRows(projectId, { channels = state.channels(), aliveOnly = false } = {}) {
    const wanted = resolveProjectId(projectId);
    const roles = roleMetaMap();
    return enrichSessionRows(state.nativeSessions(), channels)
      .filter((s) => (!aliveOnly || s.alive) && (!wanted || s.project_id === wanted))
      .map((s) => {
        const inProgress = tracker
          .listTickets({ project_id: wanted, assignee: s.session_id, state: 'in_progress' })
          .map(slimTicket)
          .filter(Boolean);
        const lastActive = s.updated_at ?? s.started_at ?? null;
        const roleMeta = s.role ? roles[s.role] ?? null : null;
        return {
          ...s,
          label: s.name || `session ${String(s.session_id ?? '').slice(0, 8)}`,
          role_meta: roleMeta,
          in_progress_tickets: inProgress,
          workload: {
            in_progress_tickets: inProgress,
            pending_count: s.pending_count ?? 0,
            last_active: lastActive,
          },
        };
      });
  }

  await fastify.register(websocket);
  await registerSubstrateRoutes(fastify);
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
    roles: roleMetaMap(),
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
  // native_sessions, channels, recent_milestones; the tracker DB adds tickets.
  function trackerSnapshot() {
    return {
      // The client owns the archived visibility toggle/search. Include those
      // rows in the canonical snapshot so toggling never depends on a refetch.
      tickets: tracker.listTickets({ includeArchived: true }),
    };
  }

  fastify.get('/api/snapshot', async () => ({
    ...state.snapshot(),
    native_sessions: enrichSessionRows(state.nativeSessions(), state.channels()),
    ...trackerSnapshot(),
    chat: chat.snapshot(),
  }));

  // GOL-425: compact, read-only inspection over durable envelope facts. These
  // routes expose dispatch roots rather than raw event rows; status/attention
  // are derived at query time from delivery, acknowledgement, child-envelope,
  // and dismissal facts.
  const COMMUNICATION_ENVELOPE_STATES = new Set([
    'needs_attention', 'in_flight', 'history', 'queued',
    'awaiting', 'pinged', 'failed', 'escalated', 'healthy',
  ]);
  // Public fact filters intentionally use stable categories. `delivery` also
  // covers root and protocol-child attempt/opportunity/error fact rows.
  const COMMUNICATION_ENVELOPE_FACTS = new Set([
    'assigned', 'queued', 'delivery', 'deadline', 'acknowledged',
    'ack_ping', 'escalation', 'reply', 'completion', 'dismissed',
  ]);

  function communicationQueryString(query, name) {
    if (query[name] == null) return null;
    if (typeof query[name] !== 'string' || !query[name].trim()) throw new Error(`${name} must be a non-empty string`);
    return query[name].trim();
  }

  function communicationTimestamp(query, name) {
    const value = communicationQueryString(query, name);
    if (value == null) return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new Error(`${name} must be a parseable timestamp`);
    return new Date(ms).toISOString();
  }

  function communicationEnvelopeFilter(query = {}) {
    const ticketValue = communicationQueryString(query, 'ticket') || '';
    const ticket = ticketValue ? resolveTicketRef(ticketValue) : null;
    const projectValue = communicationQueryString(query, 'project');
    const sessionValue = communicationQueryString(query, 'session');
    const state = communicationQueryString(query, 'state');
    const fact = communicationQueryString(query, 'fact');
    if (state && !COMMUNICATION_ENVELOPE_STATES.has(state)) throw new Error(`state must be one of: ${[...COMMUNICATION_ENVELOPE_STATES].join(', ')}`);
    if (fact && !COMMUNICATION_ENVELOPE_FACTS.has(fact)) throw new Error(`fact must be one of: ${[...COMMUNICATION_ENVELOPE_FACTS].join(', ')}`);
    const from = communicationTimestamp(query, 'from');
    const to = communicationTimestamp(query, 'to');
    if (from && to && from > to) throw new Error('from must be less than or equal to to');
    let limit = null;
    if (query.limit != null) {
      if (typeof query.limit !== 'string' || !/^[1-9]\d*$/.test(query.limit)) throw new Error('limit must be an integer from 1 to 500');
      limit = Number(query.limit);
      if (!Number.isSafeInteger(limit) || limit > 500) throw new Error('limit must be an integer from 1 to 500');
    }
    return {
      ticket_id: ticket?.id ?? (ticketValue || null),
      project_id: projectValue ? (resolveProjectId(projectValue) || projectValue) : null,
      session_id: sessionValue,
      state,
      fact,
      from,
      to,
      limit,
    };
  }

  fastify.get('/api/communication-health', async (req, reply) => {
    try {
      return tracker.communicationHealth(communicationEnvelopeFilter(req.query ?? {}));
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.get('/api/message-envelopes', async (req, reply) => {
    try {
      const filter = communicationEnvelopeFilter(req.query ?? {});
      const items = tracker.listEnvelopeViews(filter);
      return { items, total: items.length };
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.get('/api/message-envelopes/:id', async (req, reply) => {
    const item = tracker.getEnvelopeView(req.params.id);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    return item;
  });

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
    const content = bodyToText(body);
    chat.record('user', 'brief', content, sessionId ? { session_id: sessionId } : {});
    if (!sessionId) return reply.code(400).send({ error: 'session_id is required' });
    const result = await deliverControlEnvelope(tracker, {
      sender_id: 'human:dashboard', recipient_session_id: sessionId,
      kind: 'brief', content, legacy: { path: '/brief', body },
    });
    const ok = result.delivered || result.retry_queued;
    if (!ok) noteForwardFailure('brief', result.delivery);
    return reply.code(ok ? 200 : (result.delivery?.status || 502)).send({
      ok, queued: result.retry_queued, envelope_id: result.envelope.id, delivery: result.delivery,
    });
  });
  fastify.post('/api/messages/notify', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.sender_id || !b.session_id) return reply.code(400).send({ error: 'notification sender_id and session_id are required' });
    try {
      const result = await deliverControlEnvelope(tracker, {
        project_id: b.project_id ?? null,
        sender_id: b.sender_id,
        recipient_session_id: b.session_id,
        kind: 'session_notify',
        content: String(b.text || ''),
        metadata: { notification_text: String(b.text || '') },
        legacy: { path: '/brief', body: String(b.text || '') },
      });
      return {
        ok: result.delivered || result.retry_queued,
        queued: result.retry_queued,
        envelope_id: result.envelope.id,
        delivery: result.delivery,
      };
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });
  fastify.post('/api/messages/control', async (req, reply) => {
    const b = req.body ?? {};
    const legacy = b.legacy && typeof b.legacy === 'object' ? b.legacy : null;
    const permittedLegacyPaths = new Set(['/brief']);
    const gatePath = typeof legacy?.path === 'string'
      && /^\/gates\/[A-Za-z0-9._-]+\/(approve|deny|cancel)$/.test(legacy.path);
    if (!legacy || (typeof legacy.path !== 'string') || (!permittedLegacyPaths.has(legacy.path) && !gatePath)) {
      return reply.code(400).send({ error: 'control delivery requires a supported legacy route' });
    }
    try {
      const result = await deliverControlEnvelope(tracker, {
        project_id: b.project_id ?? null,
        sender_id: b.sender_id,
        recipient_session_id: b.session_id,
        kind: b.kind,
        content: String(b.content || ''),
        metadata: b.metadata && typeof b.metadata === 'object' ? b.metadata : {},
        legacy: { path: legacy.path, body: legacy.body },
      });
      return {
        ok: result.delivered || result.retry_queued,
        queued: result.retry_queued,
        envelope_id: result.envelope.id,
        delivery: result.delivery,
      };
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });
  fastify.post('/api/interrupt', async (req, reply) => {
    const body = extractBody(req);
    const sessionId = extractSessionId(req);
    const content = bodyToText(body);
    chat.record('user', 'interrupt', content, sessionId ? { session_id: sessionId } : {});
    if (!sessionId) return reply.code(400).send({ error: 'session_id is required' });
    const managedCodex = (await listChannels()).some((channel) => channel.session_id === sessionId && channel.kind === 'codex-supervisor');
    if (managedCodex) {
      const gated = await pushInterrupt(body, sessionId);
      return reply.code(gated.status || (gated.ok ? 200 : 502)).send(gated);
    }
    const result = await deliverControlEnvelope(tracker, {
      sender_id: 'human:dashboard', recipient_session_id: sessionId,
      kind: 'interrupt', content, legacy: { path: '/interrupt', body },
    });
    const ok = result.delivered || result.retry_queued;
    if (!ok) noteForwardFailure('interrupt', result.delivery);
    return reply.code(ok ? 200 : (result.delivery?.status || 502)).send({
      ok, queued: result.retry_queued, envelope_id: result.envelope.id, delivery: result.delivery,
    });
  });
  fastify.post('/api/halt', async (req, reply) => {
    const body = extractBody(req);
    const sessionId = extractSessionId(req);
    const content = bodyToText(body) || 'halt requested';
    chat.record('system', 'halt', content, sessionId ? { session_id: sessionId } : {});
    if (!sessionId) return reply.code(400).send({ error: 'session_id is required' });
    const managedCodex = (await listChannels()).some((channel) => channel.session_id === sessionId && channel.kind === 'codex-supervisor');
    if (managedCodex) {
      const gated = await pushHalt(body, sessionId);
      return reply.code(gated.status || (gated.ok ? 200 : 502)).send(gated);
    }
    const result = await deliverControlEnvelope(tracker, {
      sender_id: 'human:dashboard', recipient_session_id: sessionId,
      kind: 'halt', content, legacy: { path: '/halt', body },
    });
    const ok = result.delivered || result.retry_queued;
    if (!ok) noteForwardFailure('halt', result.delivery);
    return reply.code(ok ? 200 : (result.delivery?.status || 502)).send({
      ok, queued: result.retry_queued, envelope_id: result.envelope.id, delivery: result.delivery,
    });
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

  // GOL-171: new gates fold into spec comments when a spec is identifiable.
  // Legacy gate-file verdicts remain readable/applicable for files already on disk.
  fastify.post('/api/projects/:id/gates', async (req, reply) => {
    const p = state.project(req.params.id);
    if (!p) return reply.code(404).send({ error: 'project_not_found' });
    try {
      console.warn(`[gates] deprecated gate-write API hit for project ${p.project_id || p.id}; routing to spec comment gate`);
      const result = await createGate({ tracker, project: p, gate: req.body ?? {} });
      if (result.mode === 'comment') {
        broadcastWS({ type: 'ticket-comment', ticket_id: result.ticket.id, comment: result.comment });
        broadcastWS({ type: 'ticket-updated', ticket: result.ticket });
        return reply.code(201).send(result);
      }
      return reply.code(201).send(result);
    } catch (err) {
      if (err && err.status) return reply.code(err.status).send({ error: err.message });
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // v4: all native Claude Code sessions on this machine (merged CLI + registry,
  // pid-checked). Already inside /api/snapshot as native_sessions[]; this is a
  // convenience route + the polling target for any external scripting.
  fastify.get('/api/native-sessions', async () => enrichSessionRows(state.nativeSessions(), state.channels()));

  // v4 (fix round 2, defect 1): per-session peek for the native-session drawer.
  // Returns { session, events, milestones, transcript_path, note } where events
  // are the recent central-journal hook lines filtered by this session_id.
  fastify.get('/api/native-sessions/:sessionId/peek', async (req) => {
    const sessionId = req.params.sessionId;
    const session = state.nativeSessions().find((s) => s.session_id === sessionId) ?? null;
    return readNativeSessionPeek(sessionId, session);
  });

  // GOL-4 / GOL-15: live ANSI terminal scrollback for Peek Modal and drawers.
  // GET /api/native-sessions/:sessionId/terminal?lines=500
  // Returns { sessionId, output, text, lines, truncated, ok } with raw ANSI sequences or activity feed fallback.
  fastify.get('/api/native-sessions/:sessionId/terminal', async (req) => {
    const sessionId = req.params.sessionId;
    const lines = Math.min(2000, Math.max(20, Number(req.query?.lines) || 100));
    const session = state.nativeSessions().find((s) => s.session_id === sessionId) ?? null;
    try {
      const peek = await peekSessionTerminal(sessionId, {
        lines,
        projectId: session?.project_id ?? null,
        sessionName: session?.name || session?.label || null,
      });
      if (peek.ok && peek.text) {
        return {
          ...peek,
          sessionId,
          output: peek.text,
          lines,
          truncated: (peek.text.split('\n').length >= lines),
        };
      }
    } catch {}

    // Fallback for non-tmux sessions (e.g. direct Pi/Claude foreground sessions): hook journal lines
    try {
      const journalPeek = readNativeSessionPeek(sessionId, session);
      if (journalPeek?.events?.length > 0) {
        const text = journalPeek.events.map((e) => `[${e.tool || 'event'}] ${JSON.stringify(e.args || e.result || e)}`).join('\n');
        return {
          ok: true,
          sessionId,
          name: session?.name ?? sessionId,
          output: text,
          text,
          lines,
          source: 'journal',
          truncated: false,
        };
      }
    } catch {}

    return {
      ok: false,
      sessionId,
      output: '(no terminal session active)',
      text: null,
      lines,
      truncated: false,
    };
  });

  // GOL-4 / GOL-15: mid-turn steer / pause / halt / kill
  // POST /api/native-sessions/:sessionId/message  { text, mode: 'steer'|'interrupt'|'halt'|'kill' }
  fastify.post('/api/native-sessions/:sessionId/message', async (req, reply) => {
    const sessionId = req.params.sessionId;
    const b = req.body ?? {};
    const text = typeof b.text === 'string' ? b.text.trim() : (typeof b.content === 'string' ? b.content.trim() : typeof b.message === 'string' ? b.message.trim() : '');
    const mode = String(b.mode || 'steer').toLowerCase();
    if (!text && mode !== 'halt' && mode !== 'kill' && mode !== 'pause') return reply.code(400).send({ error: 'text is required for steer/interrupt' });
    const session = state.nativeSessions().find((s) => s.session_id === sessionId) ?? null;
    if (!session && mode !== 'kill') return reply.code(404).send({ error: `session not found: ${sessionId}` });
    const isBusy = session?.status === 'busy' || session?.delivery_state === 'accepted';

    try {
      if (mode === 'steer' || mode === 'brief') {
        const result = await deliverControlEnvelope(tracker, {
          project_id: session?.project_id ?? null,
          sender_id: 'human:dashboard',
          recipient_session_id: sessionId,
          kind: 'brief',
          content: text,
          metadata: { text, steer: isBusy },
          legacy: { path: '/brief', body: text },
        });
        chat.record('user', 'brief', text, { session_id: sessionId, steer: isBusy });
        const ok = result.delivered || result.retry_queued;
        return reply.code(ok ? 200 : (result.delivery?.status || 502)).send({
          ok,
          steered: isBusy && result.delivered,
          queued: result.retry_queued,
          envelope_id: result.envelope?.id,
          delivery: result.delivery,
        });
      }
      if (mode === 'interrupt') {
        const result = await deliverControlEnvelope(tracker, {
          project_id: session?.project_id ?? null,
          sender_id: 'human:dashboard',
          recipient_session_id: sessionId,
          kind: 'interrupt',
          content: text || 'Interrupt requested by human dashboard',
          legacy: { path: '/interrupt', body: text || 'interrupt' },
        });
        try {
          if (session?.name) {
            sendWorkerKeys(session.name, ['C-c'], { projectId: session?.project_id ?? null });
          }
        } catch {}
        const ok = result.delivered || result.retry_queued;
        return reply.code(ok ? 200 : (result.delivery?.status || 502)).send({ ok, queued: result.retry_queued, envelope_id: result.envelope?.id, delivery: result.delivery });
      }
      if (mode === 'halt') {
        const result = await deliverControlEnvelope(tracker, {
          project_id: session?.project_id ?? null,
          sender_id: 'human:dashboard',
          recipient_session_id: sessionId,
          kind: 'halt',
          content: text || 'halt requested from dashboard',
          legacy: { path: '/halt', body: text || 'halt' },
        });
        const ok = result.delivered || result.retry_queued;
        return reply.code(ok ? 200 : (result.delivery?.status || 502)).send({ ok, queued: result.retry_queued, envelope_id: result.envelope?.id, delivery: result.delivery });
      }
      if (mode === 'kill') {
        const workers = listWorkers({});
        const worker = workers.find((w) => w.session_id === sessionId || w.name === sessionId || w.name === session?.name);
        if (worker) {
          const res = await killWorker(worker.name, worker.project_id ? { projectId: worker.project_id } : {});
          return { ok: true, killed: worker.name, worker: res };
        }
        return reply.code(404).send({ error: `no worker found for session ${sessionId} to kill` });
      }
      return reply.code(400).send({ error: `unknown mode: ${mode}` });
    } catch (err) {
      return reply.code(500).send({ error: String(err?.message || err) });
    }
  });

  // GOL-4: interrupt active agent
  fastify.post('/api/native-sessions/:sessionId/interrupt', async (req, reply) => {
    const sessionId = req.params.sessionId;
    const session = state.nativeSessions().find((s) => s.session_id === sessionId) ?? null;
    try {
      deliverControlEnvelope(tracker, {
        project_id: session?.project_id ?? null,
        sender_id: 'human:dashboard',
        recipient_session_id: sessionId,
        kind: 'interrupt',
        content: 'Interrupt requested by human dashboard',
        legacy: { path: '/interrupt', body: 'interrupt' },
      }).catch(() => {});

      try {
        if (session?.name) {
          sendWorkerKeys(session.name, ['C-c'], { projectId: session?.project_id ?? null });
        }
      } catch {}

      return { ok: true, session_id: sessionId };
    } catch (err) {
      return reply.code(500).send({ error: String(err?.message ?? err) });
    }
  });

  // GOL-15: 1-click worker spawn from UI — mirrors `golem spawn`
  // POST /api/workers/spawn  { role, name?, project?, profile? }
  fastify.post('/api/workers/spawn', async (req, reply) => {
    const body = req.body ?? {};
    const role = String(body.role || '').trim();
    const name = body.name != null ? String(body.name).trim() || null : null;
    const project = body.project != null ? String(body.project).trim() || null : null;
    const profile = body.profile != null ? String(body.profile).trim() || null : null;
    if (!role) return reply.code(400).send({ error: 'role is required' });
    try {
      const worker = await spawnWorker({ role, name, project, profile });
      broadcastWS({ type: 'native-sessions-update', native_sessions: enrichSessionRows(state.nativeSessions(), state.channels()), channels: state.channels() });
      return reply.code(201).send(worker);
    } catch (err) {
      return reply.code(500).send({ error: String(err?.message || err) });
    }
  });

  fastify.get('/api/workers', async (req) => {
    const project = req.query?.project ? resolveProjectId(String(req.query.project)) : null;
    const workers = listWorkers({ projectId: project });
    return workers;
  });

  // GOL-16: environment diagnostics — Pi, Claude Code, Codex, model API keys
  fastify.get('/api/diagnostics', async () => {
    const checks = [];
    const hasCommand = (cmd) => {
      try { const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }); return r.status === 0 && String(r.stdout||'').trim().length > 0; } catch { return false; }
    };
    const versionOf = (cmd, args) => {
      try { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 3000 }); if (r.status === 0) return String(r.stdout||'').trim().split('\n')[0].trim().slice(0,120); } catch {}
      return null;
    };
    // Pi
    {
      const v = versionOf('pi', ['--version']);
      const pinned = (await import('../../lib/pi-compatibility.js')).SUPPORTED_PI_VERSION;
      let status='red', detail=v || 'not found on PATH', hint='Install Pi and ensure `pi --version` matches pinned '+pinned+' — see README';
      if (v) {
        if (v.includes(pinned) || v.trim()===pinned) { status='green'; detail=`${v} (pinned ${pinned})`; hint=''; }
        else { status='amber'; detail=`${v} (expected ${pinned})`; hint=`Run golem sync or update Pi to ${pinned}`; }
      }
      checks.push({ id:'pi', label:'Pi', status, detail, hint });
    }
    // Claude Code
    {
      const has = hasCommand('claude');
      const v = has ? versionOf('claude', ['--version']) : null;
      let status = has ? 'green' : 'amber', detail = v || (has ? 'found' : 'not found on PATH'), hint = has ? '' : 'Install Claude Code (https://docs.anthropic.com/claude-code) — optional if using Pi/Codex';
      checks.push({ id:'claude', label:'Claude Code', status, detail, hint });
    }
    // Codex
    {
      const has = hasCommand('codex') || hasCommand('code');
      const v = hasCommand('codex') ? versionOf('codex', ['--version']) : versionOf('code', ['--version']);
      let status = has ? 'green' : 'amber', detail = v || (has ? 'found' : 'not found on PATH'), hint = has ? '' : 'Install Codex (openai) — optional if using Pi/Claude';
      checks.push({ id:'codex', label:'Codex', status, detail, hint });
    }
    // Model API keys
    {
      const keys = [
        ['ANTHROPIC_API_KEY', !!process.env.ANTHROPIC_API_KEY],
        ['OPENAI_API_KEY', !!process.env.OPENAI_API_KEY],
        ['GOOGLE_API_KEY', !!process.env.GOOGLE_API_KEY || !!process.env.GEMINI_API_KEY],
        ['XAI_API_KEY', !!process.env.XAI_API_KEY],
      ];
      const present = keys.filter(([,v])=>v).map(([k])=>k);
      let status = present.length>0 ? 'green' : 'amber';
      let detail = present.length>0 ? present.join(', ') + ' set' : 'no model API keys detected in env';
      let hint = present.length>0 ? '' : 'Set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY — see model profile';
      checks.push({ id:'model-keys', label:'Model API keys', status, detail, hint });
    }
    // Substrate sync
    {
      let status='green', detail='substrate available', hint='';
      try {
        const hasConfig = !!CONFIG.golemRoot;
        if (!hasConfig) { status='amber'; detail='golem root not configured'; hint='Check GOLEM_ROOT env'; }
      } catch (e) { status='amber'; detail='substrate check failed'; hint=String(e.message||e); }
      checks.push({ id:'substrate', label:'Substrate', status, detail, hint });
    }
    const red = checks.filter(c=>c.status==='red').length;
    const amber = checks.filter(c=>c.status==='amber').length;
    const overall = red>0 ? 'red' : amber>0 ? 'amber' : 'green';
    return { checks, overall, generated_at: new Date().toISOString() };
  });

  // GOL-16: workspace setup — scaffold new project or import existing git repo
  fastify.post('/api/projects/scaffold', async (req, reply) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return reply.code(400).send({ error: 'name is required' });
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48) || 'project';
    const dir = path.join(CONFIG.projectsRoot, slug);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const agentsPath = path.join(dir, 'AGENTS.md');
      let exists = false;
      try { await fs.promises.access(agentsPath); exists = true; } catch {}
      if (!exists) {
        const template = `# ${name}\n\nGolem project — ${slug}\n\n## Agent Instructions\n\nSee substrate/AGENTS.md for harness rules.\n`;
        await fs.promises.writeFile(agentsPath, template, 'utf8');
      }
      const projectId = (await import('./project-id.js')).projectIdFor(dir);
      return reply.code(201).send({ ok: true, name, slug, path: dir, project_id: projectId, agents: agentsPath });
    } catch (e) {
      return reply.code(500).send({ error: String(e.message||e) });
    }
  });

  fastify.post('/api/projects/import', async (req, reply) => {
    const p = String(req.body?.path || '').trim();
    if (!p) return reply.code(400).send({ error: 'path is required' });
    const resolved = path.isAbsolute(p) ? p : path.resolve(p);
    try {
      const stat = await fs.promises.stat(resolved);
      if (!stat.isDirectory()) return reply.code(400).send({ error: 'path must be a directory' });
      const insideRoot = resolved.startsWith(CONFIG.projectsRoot);
      let linkPath = resolved;
      if (!insideRoot) {
        const slug = path.basename(resolved).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48) || 'imported';
        linkPath = path.join(CONFIG.projectsRoot, slug);
        try { await fs.promises.symlink(resolved, linkPath); } catch (e) { if (e.code!=='EEXIST') throw e; }
      }
      const projectId = (await import('./project-id.js')).projectIdFor(resolved);
      return reply.code(201).send({ ok: true, path: resolved, link: linkPath, project_id: projectId });
    } catch (e) {
      return reply.code(500).send({ error: String(e.message||e) });
    }
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
    // TKT-0284: negative-kind filter (Tracker excludes specs) + parent_id
    // filter (drawer's children panel). Both mirror the existing pattern —
    // cheap WHERE additions, no new entity.
    if (q.excludeKind != null) filter.exclude_kind = q.excludeKind;
    if (q.parent != null) filter.parent_id = resolveTicketIdField(q.parent);
    if (q.includeArchived != null) {
      filter.includeArchived = q.includeArchived === 'true' || q.includeArchived === true || q.includeArchived === '1';
    }
    return tracker.listTickets(filter);
  });

  // TKT-0284: GET /api/tickets/search — content search across title + body.
  // Params: project (required contract project_id), kind (optional), q (≥2 chars).
  // Returns an array of { id, title, kind, state, updated_at, snippet,
  // title_match, match_start, match_len }. 400 on missing/short q.
  // LIKE-based v1; contract stable for an FTS5 swap if spec volume warrants it.
  fastify.get('/api/tickets/search', async (req, reply) => {
    const q = req.query ?? {};
    const projectId = q.project != null ? resolveProjectId(q.project) : null;
    const qq = q.q != null ? String(q.q) : '';
    if (qq.length < 2) {
      return reply.code(400).send({ error: 'q must be at least 2 characters' });
    }
    const filter = { project_id: projectId, q: qq };
    if (q.kind != null) filter.kind = q.kind;
    return tracker.searchTickets(filter);
  });

  // POST /api/tickets — create. 400 on validation error.
  fastify.post('/api/tickets', async (req, reply) => {
    const b = req.body ?? {};
    const attribution = enforceAttribution(reply, b, 'created_by', 'createTicket');
    if (attribution) return attribution;
    try {
      const ticket = tracker.createTicket({
        project_id: b.project_id,
        kind: b.kind,
        title: b.title,
        body: b.body,
        priority: b.priority,
        labels: b.labels,
        parent_id: resolveTicketIdField(b.parent_id),
        assignee: b.assignee,
        created_by: b.created_by,
        source_ref: b.source_ref,
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
    const ticket = resolveTicketRef(req.params.id);
    if (!ticket) return reply.code(404).send({ error: 'not_found' });
    return { ...ticket, events: tracker.listEvents({ ticket_id: ticket.id }) };
  });

  // PATCH /api/tickets/:id — partial update. 404 if missing, 400 on invalid.
  fastify.patch('/api/tickets/:id', async (req, reply) => {
    const existing = resolveTicketRef(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    try {
      const patch = { ...(req.body ?? {}) };
      const attribution = enforceAttribution(reply, patch, 'actor', 'updateTicket');
      if (attribution) return attribution;
      if (Object.prototype.hasOwnProperty.call(patch, 'parent_id')) patch.parent_id = resolveTicketIdField(patch.parent_id);
      const ticket = tracker.updateTicket(existing.id, patch);
      const closeResult = handleSpecClosed(tracker, existing, ticket, patch.actor || 'human');
      if (closeResult) {
        broadcastWS({ type: 'ticket-comment', ticket_id: closeResult.ticket.id, comment: closeResult.comment });
        broadcastWS({ type: 'ticket-updated', ticket: closeResult.ticket });
        return closeResult.ticket;
      }
      broadcastWS({ type: 'ticket-updated', ticket });
      return ticket;
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // DELETE /api/tickets/:id — remove ticket, comments, and links cleanly from tracker
  fastify.delete('/api/tickets/:id', async (req, reply) => {
    const rawId = req.params.id;
    const resolvedId = tracker.resolveId(rawId);
    if (!resolvedId) return reply.code(404).send({ error: `ticket '${rawId}' not found` });
    try {
      const actor = req.body?.actor || 'human';
      const deleted = tracker.deleteTicket(resolvedId, { actor });
      if (!deleted) return reply.code(404).send({ error: `ticket '${rawId}' not found` });
      broadcastWS({ type: 'ticket-deleted', id: resolvedId, display_id: deleted.display_id, project_id: deleted.project_id });
      return { ok: true, deleted: resolvedId, display_id: deleted.display_id };
    } catch (err) {
      return reply.code(500).send({ error: String(err?.message || err) });
    }
  });

  // GOL-150: POST /api/tickets/:id/transition is gone with the phase machine.
  // PATCH /api/tickets/:id with {state} is the lifecycle path.

  // TKT-0105: POST /api/tickets/:id/move — atomic state + rank change used by
  // drag-and-drop. Body: { state, before_id?, after_id?, actor? }. The endpoint
  // computes the new rank from the neighbour tickets (midpoint if both given,
  // otherwise appends to the target state). Replaces the old "PATCH with
  // {state}" path for drag operations (Phase B tracker-board.jsx still calls
  // PATCH; follow-up ticket will switch it to /move).
  fastify.post('/api/tickets/:id/move', async (req, reply) => {
    const existing = resolveTicketRef(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    try {
      const patch = { ...(req.body ?? {}) };
      const attribution = enforceAttribution(reply, patch, 'actor', 'moveTicket');
      if (attribution) return attribution;
      if (Object.prototype.hasOwnProperty.call(patch, 'before_id')) patch.before_id = resolveTicketIdField(patch.before_id);
      if (Object.prototype.hasOwnProperty.call(patch, 'after_id')) patch.after_id = resolveTicketIdField(patch.after_id);
      const ticket = tracker.moveTicket(existing.id, patch);
      const closeResult = handleSpecClosed(tracker, existing, ticket, patch.actor || 'human');
      if (closeResult) {
        broadcastWS({ type: 'ticket-comment', ticket_id: closeResult.ticket.id, comment: closeResult.comment });
        broadcastWS({ type: 'ticket-updated', ticket: closeResult.ticket });
        return closeResult.ticket;
      }
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
  // Body: { author, body, quote?, prefix?, suffix?, section?, section_id?, tag?, status?, parent_id?, block_id?, anchor_kind? }
  fastify.post('/api/tickets/:id/comments', async (req, reply) => {
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const id = ticketRef.id;
    const b = req.body ?? {};
    const attribution = enforceAttribution(reply, b, 'author', 'addComment');
    if (attribution) return attribution;
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
        anchor_kind: b.anchor_kind,
      });
      broadcastWS({ type: 'ticket-comment', ticket_id: id, comment });
      const ticket = tracker.getTicket(id);
      if (ticket) {
        broadcastWS({ type: 'ticket-updated', ticket });
        for (const c of ticket.comments || []) broadcastWS({ type: 'ticket-comment-updated', ticket_id: id, comment: c });
      }
      return reply.code(201).send(publicComment(comment, ticketRef));
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // PATCH /api/tickets/:id/comments/:cid — update a comment (status, tag, body).
  fastify.patch('/api/tickets/:id/comments/:cid', async (req, reply) => {
    const { cid } = req.params;
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const id = ticketRef.id;
    const b = req.body ?? {};
    try {
      // TKT-0244: only include keys actually present on the request body, so a
      // PATCH {status:'resolved'} (Resolve/Reopen/tag-change/block_id-change)
      // doesn't write body=undefined → toMarkdownBody(undefined)='' and wipe
      // the comment's text + de-anchor its block_id. An explicit {body:''} still
      // clears intentionally (it's present → included → toMarkdownBody('')='').
      const patch = Object.fromEntries(
        ['body', 'tag', 'status', 'block_id', 'anchor_kind'].filter((k) => k in b).map((k) => [k, b[k]])
      );
      const before = tracker.getComment(cid);
      const comment = tracker.updateComment(id, cid, patch);
      if (before?.status !== 'resolved' && comment.status === 'resolved' && gateIdFromBlock(comment.block_id)) {
        await notifyGateResolved(tracker, comment, patch.body || b.resolution || b.verdict || '');
      }
      broadcastWS({ type: 'ticket-comment-updated', ticket_id: id, comment });
      const ticket = tracker.getTicket(id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      return publicComment(comment, ticketRef);
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // POST /api/tickets/:id/comments/:cid/reply — add a reply to a comment.
  fastify.post('/api/tickets/:id/comments/:cid/reply', async (req, reply) => {
    const { cid } = req.params;
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const id = ticketRef.id;
    const b = req.body ?? {};
    const attribution = enforceAttribution(reply, b, 'author', 'replyComment');
    if (attribution) return attribution;
    try {
      const comment = tracker.addComment(id, {
        author: b.author,
        body: b.body,
        parent_id: cid,
        tag: 'note',
      });
      broadcastWS({ type: 'ticket-comment', ticket_id: id, comment });
      const ticket = tracker.getTicket(id);
      if (ticket) {
        broadcastWS({ type: 'ticket-updated', ticket });
        for (const c of ticket.comments || []) broadcastWS({ type: 'ticket-comment-updated', ticket_id: id, comment: c });
      }
      return reply.code(201).send(publicComment(comment, ticketRef));
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  function commentDispatchTarget(ticket, body = {}) {
    const explicit = typeof body.session_id === 'string' && body.session_id.trim() ? body.session_id.trim() : null;
    if (explicit) return explicit;
    const assignee = typeof ticket?.assignee === 'string' && ticket.assignee.trim() ? ticket.assignee.trim() : null;
    return assignee && assignee !== 'human' ? assignee : null;
  }

  function channelFailureDetail(channelResult) {
    return channelResult?.error || `status ${channelResult?.status ?? '?'}`;
  }

  function commentBrief(ticket, comments, { batchId = null } = {}) {
    const list = Array.isArray(comments) ? comments : [comments];
    const label = ticket?.display_id || ticket?.id;
    const title = ticket?.title || ticket?.id || 'ticket';
    const lines = [
      `Comment dispatch for ${label}: ${title}`,
      '',
      'You have been sent human comment feedback on this ticket. Re-read it and address the dispatched comment(s).',
      '',
      batchId ? `Batch id: ${batchId}` : null,
      `Ticket: ${label}`,
      '',
      ...list.flatMap((comment, idx) => [
        `## Comment ${idx + 1}: ${comment.id}`,
        comment.block_id ? `Block: ${comment.block_id}` : null,
        comment.anchor_kind ? `Anchor: ${comment.anchor_kind}` : null,
        comment.quote ? `Quote: ${comment.quote}` : null,
        '',
        comment.body || '',
        '',
      ]),
      'Use the tracker ticket tools or dashboard to reply on the same anchored block/comment so the dispatch flips to addressed.',
    ].filter((line) => line != null);
    return lines.join('\n');
  }

  async function deliverCommentDispatch(ticket, comments, sessionId, { batchId = null, dispatches = [] } = {}) {
    const brief = commentBrief(ticket, comments, { batchId });
    // GOL-101: a managed Codex supervisor is a typed adapter, not a generic
    // channel — brief.js rejects any push without a durable envelope id, so a
    // bare pushBrief could never reach a Codex target. Mint the same kind of
    // envelope ticket dispatch uses.
    // The mint shares the push's failure path: the enqueue already happened, so
    // anything that stops delivery has to reach the rollback below rather than
    // escaping as a 400 with the comments left `dispatched`.
    let envelope = null;
    let channelResult = null;
    let delivered = false;
    let retryQueued = false;
    try {
      envelope = tracker.createControlEnvelope({
        project_id: ticket.project_id ?? null,
        sender_id: 'human:dashboard',
        recipient_session_id: sessionId,
        kind: 'session_notify',
        payload: { content: brief, ticket_id: ticket.id, batch_id: batchId },
      });
      const result = await deliverControlEnvelope(tracker, {
        recipient_session_id: sessionId,
        content: brief,
        legacy: { path: '/brief', body: brief },
        envelope,
        settlement: {
          comment_dispatch: {
            dispatch_ids: dispatches.map((dispatch) => dispatch?.id).filter(Boolean),
            batch_id: batchId ?? null,
          },
        },
      });
      channelResult = result.delivery;
      delivered = result.delivered;
      retryQueued = result.retry_queued;
    } catch (err) {
      channelResult = { ok: false, error: String(err?.message ?? err) };
    }
    let rolledBack = 0;
    if (delivered) {
      chat.record('user', 'brief', brief, { session_id: sessionId });
      tracker.markCommentDispatchesDelivered(dispatches.map((dispatch) => dispatch?.id).filter(Boolean));
    } else if (retryQueued) {
      chat.record('system', 'info', `comment dispatch of ${ticket.id} to ${sessionId} retained for duplicate-safe typed retry`);
    } else {
      const detail = channelFailureDetail(channelResult);
      chat.record('system', 'error', `comment dispatch of ${ticket.id} to ${sessionId} — channel ${detail}`);
      // GOL-101: the enqueue is durable-first, so an undelivered push has to be
      // rolled back or its comments stay `dispatched` forever with no retry —
      // the next batch would find nothing undispatched and silently no-op.
      rolledBack = tracker.cancelCommentDispatches(
        dispatches.map((d) => d?.id).filter(Boolean),
        `delivery_failed: ${detail}`,
      ).cancelled;
    }
    const updated = tracker.getTicket(ticket.id);
    if (updated) {
      broadcastWS({ type: 'ticket-updated', ticket: updated });
      for (const comment of updated.comments || []) {
        broadcastWS({ type: 'ticket-comment-updated', ticket_id: updated.id, comment });
      }
    }
    return { channel: channelResult, ticket: updated, delivered, queued: retryQueued, rolled_back: rolledBack };
  }

  // POST /api/comments/:id/dispatch — enqueue and deliver one comment as a
  // mini-brief to the spec's assigned session (or explicit fallback session_id).
  fastify.post('/api/comments/:cid/dispatch', async (req, reply) => {
    const cid = req.params.cid;
    const b = req.body ?? {};
    try {
      const comment = tracker.getComment(cid);
      if (!comment) return reply.code(404).send({ error: 'comment_not_found' });
      const ticket = tracker.getTicket(comment.ticket_id);
      if (!ticket) return reply.code(404).send({ error: 'ticket_not_found' });
      const sessionId = commentDispatchTarget(ticket, b);
      if (!sessionId) return reply.code(400).send({ error: 'session_id is required when the ticket has no session assignee' });
      const dispatch = tracker.enqueueCommentDispatch(comment, sessionId);
      const delivered = await deliverCommentDispatch(ticket, comment, sessionId, { dispatches: [dispatch] });
      if (!delivered.delivered) {
        return reply.code(502).send({
          error: `comment dispatch to ${sessionId} was not delivered — ${channelFailureDetail(delivered.channel)}`,
          delivered: false,
          rolled_back: delivered.rolled_back,
          channel: delivered.channel,
        });
      }
      return { ok: true, dispatch, ...delivered };
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // POST /api/tickets/:id/comments/batch-dispatch — enqueue all undispatched
  // comments on a ticket using one shared batch_id and deliver one combined
  // brief. GOL-101: any ticket kind, not just specs — every human comment is
  // queued `undispatched` regardless of kind, so a spec-only dispatch left
  // task feedback with no way out.
  fastify.post('/api/tickets/:id/comments/batch-dispatch', async (req, reply) => {
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const id = ticketRef.id;
    const b = req.body ?? {};
    try {
      const ticket = ticketRef;
      if (!ticket) return reply.code(404).send({ error: 'not_found' });
      const sessionId = commentDispatchTarget(ticket, b);
      if (!sessionId) return reply.code(400).send({ error: 'session_id is required when the ticket has no session assignee' });
      const comments = tracker.listUndispatchedCommentsForTicket(id);
      if (comments.length === 0) return { ok: true, batch_id: null, dispatches: [], delivered: false, ticket };
      const batch = tracker.enqueueCommentDispatchBatch(id, sessionId);
      const delivered = await deliverCommentDispatch(ticket, comments, sessionId, {
        batchId: batch.batch_id,
        dispatches: batch.dispatches,
      });
      if (!delivered.delivered) {
        return reply.code(502).send({
          error: `comment dispatch to ${sessionId} was not delivered — ${channelFailureDetail(delivered.channel)}`,
          delivered: false,
          rolled_back: delivered.rolled_back,
          channel: delivered.channel,
        });
      }
      return { ok: true, ...batch, ...delivered };
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  fastify.post('/api/tickets/:id/unacked/:deliveryEventId/dismiss', async (req, reply) => {
    const { deliveryEventId } = req.params;
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const id = ticketRef.id;
    const actor = req.body?.actor || 'human:dashboard';
    try {
      const event = tracker.dismissUnackedDispatchWarning(id, deliveryEventId, { actor });
      const ticket = tracker.getTicket(id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      broadcastWS({ type: 'native-sessions-update', native_sessions: enrichSessionRows(state.nativeSessions(), state.channels()), channels: state.channels() });
      broadcastWS({ type: 'communication-health-updated' });
      return event;
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // POST /api/tickets/:id/links — add a link from this ticket. Re-fetch + send
  // the from-ticket as a ticket-updated delta.
  fastify.post('/api/tickets/:id/links', async (req, reply) => {
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const id = ticketRef.id;
    const b = req.body ?? {};
    try {
      const toTicket = resolveTicketIdField(b.to_ticket);
      tracker.addLink(id, toTicket, b.type);
      const ticket = tracker.getTicket(id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      return reply.code(201).send({ from_ticket: ticketRef.display_id, to_ticket: resolveTicketRef(toTicket)?.display_id || toTicket, type: b.type });
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // DELETE /api/tickets/:id/links — remove a link. Re-fetch + send the
  // from-ticket as a ticket-updated delta.
  fastify.delete('/api/tickets/:id/links', async (req, reply) => {
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const id = ticketRef.id;
    const b = req.body ?? {};
    try {
      const toTicket = resolveTicketIdField(b.to_ticket);
      const result = tracker.removeLink(id, toTicket, b.type);
      const ticket = tracker.getTicket(id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      return result;
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  async function pushDispatchRevoked(ticket, previousSessionId, reason = 'dispatch revoked') {
    if (!ticket || !previousSessionId) return null;
    const label = ticket.display_id || ticket.id;
    const body = `Dispatch revoked for ${label}: ${ticket.title || ''}\n\nReason: ${reason}\n\nStand down unless you receive a new dispatch.`;
    let result = null;
    try {
      result = await pushBrief(body, previousSessionId);
    } catch (err) {
      result = { ok: false, error: String(err?.message ?? err) };
    }
    if (result?.ok) chat.record('system', 'dispatch_revoked', body, { session_id: previousSessionId, ticket_id: ticket.id });
    else chat.record('system', 'error', `dispatch_revoked for ${label} to ${previousSessionId} not delivered — ${result?.error || result?.status || 'unknown error'}`);
    return result;
  }

  fastify.get('/api/tickets/:id/revival', async (req, reply) => {
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const minutes = req.query?.min_age_minutes ?? req.query?.minAgeMinutes;
    return deadSessionRevival(ticketRef, { minAgeMinutes: minutes });
  });

  fastify.post('/api/tickets/:id/revival/redispatch', async (req, reply) => {
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const b = req.body ?? {};
    const sessionId = typeof b.session_id === 'string' && b.session_id.trim() ? b.session_id.trim() : null;
    if (!sessionId) return reply.code(400).send({ error: 'session_id is required' });
    const revival = deadSessionRevival(ticketRef, { minAgeMinutes: b.min_age_minutes ?? b.minAgeMinutes });
    if (!revival.eligible) return reply.code(409).send({ error: `revival_not_eligible:${revival.reason}`, revival });
    const live = state.nativeSessions().find((s) => s.session_id === sessionId);
    const hasChannel = state.channels().some((c) => c.session_id === sessionId && isChannelDeliveryReady(c));
    if (!live || !live.alive || !hasChannel) return reply.code(400).send({ error: 'target session is not live/reachable' });
    try {
      if (revival.pending_dispatch?.id) {
        const cancelled = tracker.cancelQueuedDispatch(revival.pending_dispatch.id, { actor: 'human:revival' });
        await pushDispatchRevoked(ticketRef, cancelled.session_id, 'revival redispatch cancelled queued dispatch');
      }
      const assigned = tracker.setDispatched(ticketRef.id, { session_id: sessionId, actor: 'human:revival' });
      if (assigned.revoked_session_id) await pushDispatchRevoked(assigned, assigned.revoked_session_id, 'redispatched during revival');
      const updated = tracker.getTicket(ticketRef.id);
      const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : 'Revival re-dispatch from dead-session warning.';
      const briefString = buildDispatchBrief(updated, note);
      let channelResult = null;
      try {
        channelResult = await pushBrief(briefString, sessionId);
      } catch (err) {
        channelResult = { ok: false, error: String(err?.message ?? err) };
      }
      if (channelResult?.ok) chat.record('user', 'brief', briefString, { session_id: sessionId });
      tracker.markDispatchDeliveryAttempted(ticketRef.id, {
        session_id: sessionId,
        actor: 'human:revival',
        error: channelResult?.ok ? null : (channelResult?.error || `status ${channelResult?.status ?? '?'}`),
      });
      const ticket = tracker.getTicket(ticketRef.id);
      broadcastWS({ type: 'ticket-updated', ticket });
      broadcastWS({ type: 'dispatch-queue-updated' });
      return { ok: true, ticket, channel: channelResult };
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // POST /api/tickets/:id/dispatch — assign a ticket to a live native session
  // and push it a self-contained brief. The response reports the actual
  // channel attempt separately from the durable assignment/envelope.
  //
  // Durable-first (mirrors the gate handler): setDispatched flips assignee +
  // dispatched_to + dispatched_at and records a `dispatched` event BEFORE we
  // touch the channel. Assignment is durable; an unreachable channel is a
  // failed delivery, not a successful dispatch.
  //
  // TKT-0245: `mode` ('now' | 'when_idle', default 'now'). 'when_idle' queues
  // the dispatch until the target session is idle (the drainer delivers it
  // then); if the target is already idle it falls through to the immediate
  // 'now' path. A bare POST (no mode) behaves exactly as before — the default
  // never changes, so existing MCP calls and older UIs are untouched.
  fastify.post('/api/tickets/:id/dispatch', async (req, reply) => {
    const ticketRef = resolveTicketRef(req.params.id);
    if (!ticketRef) return reply.code(404).send({ error: 'not_found' });
    const id = ticketRef.id;
    const b = req.body ?? {};
    const sessionId = typeof b.session_id === 'string' && b.session_id.trim() ? b.session_id.trim() : null;
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null;
    const senderId = typeof b.sender_id === 'string' && b.sender_id.trim() ? b.sender_id.trim() : null;
    const mode = typeof b.mode === 'string' ? b.mode : 'now';
    const workspace = typeof b.workspace === 'string' && b.workspace.trim() ? b.workspace.trim() : undefined;
    if (mode !== 'now' && mode !== 'when_idle') {
      return reply.code(400).send({ error: `mode must be 'now' or 'when_idle' (got '${mode}')` });
    }

    const existing = ticketRef;
    if (!sessionId) return reply.code(400).send({ error: 'session_id is required' });
    const nativeTarget = state.nativeSessions().find((s) => s.session_id === sessionId);
    // 'when_idle': queue for delivery on idle unless the target is already idle
    // (in which case fall through to the immediate 'now' path — no queue row).
    if (mode === 'when_idle') {
      const target = nativeTarget;
      // TKT-0369: only fall through to the immediate path when the target is
      // idle AND actually reachable — an idle session with a dead channel MCP
      // must queue (the row delivers when the channel re-registers), not burn
      // on an immediate push that cannot succeed.
      let hasChannel = false;
      try { hasChannel = (await listChannels()).some((c) => c.session_id === sessionId && isChannelDeliveryReady(c)); } catch { /* treat as unreachable */ }
      const isIdle = !!target && target.alive && target.status === 'idle' && hasChannel;
      if (!isIdle) {
        const envelope = tracker.createDispatchEnvelope(id, { session_id: sessionId, actor: senderId || 'human', sender_id: senderId });
        const briefString = buildDispatchBrief(existing, note, workspace, envelope.id, envelope.sender_session_id);
        tracker.setEnvelopePayload(envelope.id, { content: briefString, envelope_id: envelope.id, sender_id: envelope.sender_id, reply_to_session_id: envelope.reply_to_session_id, recipient_session_id: envelope.recipient_session_id });
        const queueRow = tracker.queueDispatch(id, { session_id: sessionId, note, workspace, payload: briefString, envelope_id: envelope.id, actor: senderId || 'human' });
        chat.record('system', 'info',
          `queued ${queueRow.id.slice(0, 8)} for ${sessionId} — will deliver when idle`);
        const ticket = tracker.getTicket(id);
        broadcastWS({ type: 'ticket-updated', ticket });
        // TKT-0286: signal every queue-aware surface (Agents page chips, the
        // session peek drawer list, offline orphans) to refetch.
        broadcastWS({ type: 'dispatch-queue-updated' });
        broadcastWS({ type: 'communication-health-updated' });
        return { ok: true, queued: true, delivered: false, queue_id: queueRow.id, envelope_id: queueRow.envelope_id, ticket };
      }
      // target idle + reachable → fall through to immediate delivery below.
    }

    // 1) Durable write — assign + record the dispatched event. Source of truth.
    const assigned = tracker.setDispatched(id, { session_id: sessionId, actor: senderId || 'human' });
    if (assigned.revoked_session_id) await pushDispatchRevoked(assigned, assigned.revoked_session_id, 'redispatched');

    // 2) Build a clear, self-contained brief so the receiving session knows
    //    exactly what it's been handed and how to pick it up. The tracker MCP
    //    tools (ticket_get, etc.) land in WS3 — naming them now is intentional.
    //    (TKT-0245: extracted to buildDispatchBrief so the drainer produces
    //    byte-identical briefs.)
    const envelope = tracker.createDispatchEnvelope(id, { session_id: sessionId, actor: senderId || 'human', sender_id: senderId });
    const briefString = buildDispatchBrief(existing, note, workspace, envelope.id, envelope.sender_session_id);
    tracker.setEnvelopePayload(envelope.id, { content: briefString, envelope_id: envelope.id, sender_id: envelope.sender_id, reply_to_session_id: envelope.reply_to_session_id, recipient_session_id: envelope.recipient_session_id });
    // Snapshot only the comment dispatches that existed when this immutable
    // ticket envelope was prepared. A later batch for the same ticket/session
    // belongs to its own delivery opportunity.
    const immediateCommentDispatches = tracker.listPendingCommentDispatchesForTicket(id, sessionId);
    const immediateCommentDispatchIds = immediateCommentDispatches.map((dispatch) => dispatch.id);

    // 3) Best-effort channel push — never fail the request on a push miss.
    let channelResult = null;
    let immediateTypedTarget = false;
    let retryQueue = null;
    let immediateQueueOwner = null;
    try {
        // A fetch can fail after a typed endpoint has accepted a native turn
        // but before its response reaches us. Preserve the target kind before
        // the request so that ambiguous result still retains this exact
        // tracker envelope for duplicate-safe shared-queue reconciliation.
        immediateTypedTarget = (await listChannels()).some((channel) => (
          channel.session_id === sessionId && isTypedWorkerChannel(channel)
        ));
        if (!immediateTypedTarget) {
          const fact = readSessionFacts().find((entry) => entry?.canonical_id === sessionId);
          immediateTypedTarget = hasTypedWorkerCapability(fact)
            || (fact?.harness === 'pi' && !hasExplicitLegacyPiDelivery(fact));
        }
        // An immediate typed ticket is still durable work. Reserve both the
        // queue row and original-envelope retry *before* transport so a
        // dashboard death after native acceptance is always reclaimable.
        if (immediateTypedTarget) {
          retryQueue = tracker.queueDispatch(id, {
            session_id: sessionId,
            note,
            workspace,
            payload: briefString,
            envelope_id: envelope.id,
            actor: senderId || 'human',
          });
          immediateQueueOwner = crypto.randomUUID();
          if (!tracker.claimQueuePublishing(retryQueue.id, { ownerToken: immediateQueueOwner })) {
            throw new Error('could not reserve immediate typed ticket queue ownership');
          }
        }
        const published = await publishDurableEnvelope({
          tracker,
          envelope,
          sessionId,
          content: briefString,
          legacy: { path: '/brief', body: briefString },
          typedTarget: immediateTypedTarget,
          retryOwnerToken: immediateQueueOwner ?? crypto.randomUUID(),
          settlement: {
            comment_dispatch: immediateCommentDispatchIds.length
              ? {
                  dispatch_ids: immediateCommentDispatchIds,
                  batch_ids: [...new Set(immediateCommentDispatches.map((dispatch) => dispatch.batch_id).filter(Boolean))],
                }
              : null,
            queue: retryQueue ? { id: retryQueue.id, owner_token: immediateQueueOwner } : null,
          },
          publish: ({ content, metadata }) => pushBrief(content, sessionId, metadata),
        });
        channelResult = published.delivery;
        if (immediateTypedTarget && !published.delivered) {
          tracker.releaseQueuePublishing(retryQueue.id, { ownerToken: immediateQueueOwner });
        }
    } catch (err) {
      channelResult = { ok: false, error: String(err?.message ?? err) };
    }
      const immediateDelivered = acceptedDelivery(channelResult);
      // The push is the delivery opportunity. Set this before chat or tracker
      // writes so their failures cannot replay context that already landed.
      if (channelResult && immediateDelivered) {
        chat.record('user', 'brief', briefString, { session_id: sessionId, delivery: channelResult.queued ? 'next_turn' : 'push' });
      } else {
        const detail = channelResult?.error || `status ${channelResult?.status ?? '?'}`;
        chat.record('system', 'error', `dispatch of ${existing.display_id || id} to ${sessionId} — channel ${detail} (ticket assigned; session will pick it up on resume)`);
      }
    tracker.markDispatchDeliveryAttempted(id, {
        session_id: sessionId,
        actor: 'human',
        error: channelResult && immediateDelivered ? null : (channelResult?.error || `status ${channelResult?.status ?? '?'}`),
        envelope_id: envelope.id,
    });
    if (!immediateTypedTarget && channelResult && acceptedDelivery(channelResult)) {
      tracker.markCommentDispatchesDelivered(immediateCommentDispatchIds);
    }

    const ticket = tracker.getTicket(id);
    broadcastWS({ type: 'ticket-updated', ticket });
    broadcastWS({ type: 'communication-health-updated' });
    // Bare 'now' POSTs (the default) keep the exact original response shape so
    // existing callers (MCP ticket_dispatch, older UI) are untouched. The
    // when_idle path that fell through (target was already idle) adds the
    // queued:false / delivered:true hints the plan specifies.
    const delivered = acceptedDelivery(channelResult) && !channelResult?.queued;
    const queued = !!channelResult?.queued || (!!retryQueue && !delivered);
    return { ok: delivered || queued, assignment: { ok: true, ticket }, queued, delivered, envelope_id: envelope.id, ticket,
      delivery: { ok: delivered || queued, queued, mode: retryQueue && !delivered ? 'shared_queue' : (queued ? 'next_turn' : 'push'), status: channelResult?.status ?? 0, error: delivered || queued ? null : (channelResult?.error || `status ${channelResult?.status ?? '?'}`) }, channel: channelResult };
  });

  // GOL-421: channel acknowledgements/replies are correlated to an envelope and
  // only the stored dispatch target may advance its lifecycle.
  fastify.post('/api/message-envelopes/:id/ack', async (req, reply) => {
    try {
      const trustedCaller = typeof req.headers['x-golem-caller-session'] === 'string' ? req.headers['x-golem-caller-session'] : '';
      const envelope = tracker.acknowledgeEnvelope(req.params.id, { ...(req.body ?? {}), target_session_id: trustedCaller });
      const ticket = envelope?.ticket_id ? tracker.getTicket(envelope.ticket_id) : null;
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      broadcastWS({ type: 'communication-health-updated' });
      broadcastWS({ type: 'native-sessions-update', native_sessions: enrichSessionRows(state.nativeSessions(), state.channels()), channels: state.channels() });
      return { ok: true, envelope };
    } catch (err) {
      const msg = String(err?.message ?? err);
      return reply.code(/not found/.test(msg) ? 404 : 403).send({ error: msg });
    }
  });
  // Typed adapters report native terminal lifecycle separately from the
  // synchronous acceptance response. Authenticate against the session's live
  // endpoint lease, then bind the report to the immutable first-accept attempt
  // before applying any stored queue/comment settlement.
  fastify.post('/api/message-envelopes/:id/lifecycle', async (req, reply) => {
    try {
      const envelope = tracker.getEnvelope(req.params.id);
      if (!envelope) return reply.code(404).send({ error: 'message envelope not found' });
      const targetSession = String(req.headers['x-golem-target-session'] || '');
      const ownerToken = String(req.headers['x-golem-endpoint-owner'] || '');
      const lease = readEndpointLeases({ includeExpired: false }).find((candidate) => (
        candidate.canonical_id === targetSession
        && sameEndpointSecret(candidate.owner_token, ownerToken)
      ));
      if (!lease || targetSession !== envelope.target_session_id) {
        return reply.code(403).send({ error: 'typed lifecycle authentication failed' });
      }
      const state = req.body?.state;
      const attemptId = req.body?.attempt_id;
      const acceptedAttemptId = req.body?.accepted_attempt_id;
      if (!['settled', 'interrupted', 'recovery_required'].includes(state)
        || typeof attemptId !== 'string' || !attemptId
        || typeof acceptedAttemptId !== 'string' || !acceptedAttemptId
        || acceptedAttemptId !== envelope.accepted_attempt_id) {
        return reply.code(409).send({ error: 'typed lifecycle report does not match the accepted envelope lineage' });
      }
      const lifecycleBody = {
        ok: state === 'settled',
        accepted: true,
        envelope_id: envelope.id,
        attempt_id: attemptId,
        accepted_attempt_id: acceptedAttemptId,
        delivery_state: state,
        error: req.body?.error ?? null,
      };
      const delivery = {
        ok: lifecycleBody.ok,
        status: 200,
        typed_worker: true,
        body: JSON.stringify(lifecycleBody),
      };
      const outcome = recordTypedEnvelopeOutcome(tracker, envelope.id, attemptId, delivery);
      if (!outcome || outcome.delivery_state !== state) {
        return reply.code(409).send({ error: 'typed lifecycle report was not correlated' });
      }
      let settled = false;
      const retry = tracker.getEnvelopeRetry(envelope.id);
      if (retry) {
        const settlementOwner = crypto.randomUUID();
        if (tracker.claimEnvelopeRetry(envelope.id, { ownerToken: settlementOwner })) {
          settled = settleDurableEnvelope({
            tracker,
            envelope: tracker.getEnvelope(envelope.id),
            retry: tracker.getEnvelopeRetry(envelope.id),
            retryOwnerToken: settlementOwner,
          });
        }
      } else {
        settled = true;
      }
      const ticket = envelope.ticket_id ? tracker.getTicket(envelope.ticket_id) : null;
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      broadcastWS({ type: 'dispatch-queue-updated' });
      broadcastWS({ type: 'communication-health-updated' });
      return { ok: true, lifecycle: outcome.delivery_state, settled };
    } catch (err) {
      return reply.code(409).send({ error: String(err?.message ?? err) });
    }
  });
  // TKT-0245: GET /api/dispatch-queue — list pending queued dispatches,
  // optionally filtered by ?session_id=. Used by the UI (and the smoke) to
  // discover + cancel pending rows for a session.
  // TKT-0286: queue-wide view. Optional session / project / status filters
  // (default status=pending; status=all → every status for history). Accepts
  // `session` (new) AND `session_id` (0245 backcompat). Rows are enriched with
  // ticket_title + session_label by listDispatchQueue.
  fastify.get('/api/dispatch-queue', async (req) => {
    const q = req.query ?? {};
    const sessionId = q.session || q.session_id || null;
    const projectId = q.project != null ? resolveProjectId(q.project) : null;
    let status = q.status || 'pending';
    if (status === 'all') status = null;
    return tracker.listDispatchQueue({ session_id: sessionId, project_id: projectId, status });
  });

  // TKT-0245: DELETE /api/dispatch-queue/:qid — cancel a pending queued
  // dispatch. Broadcasts a ticket-updated for the affected ticket so the drawer
  // re-renders back to the dispatch row. 404 if no such pending row.
  fastify.delete('/api/dispatch-queue/:qid', async (req, reply) => {
    const qid = req.params.qid;
    try {
      const row = tracker.cancelQueuedDispatch(qid, { actor: 'human' });
      const ticket = tracker.getTicket(row.ticket_id);
      await pushDispatchRevoked(ticket, row.session_id, 'queued dispatch cancelled');
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      // TKT-0286: signal queue-aware surfaces to refetch (the row is gone).
      broadcastWS({ type: 'dispatch-queue-updated' });
      broadcastWS({ type: 'communication-health-updated' });
      return { ok: true };
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (/not found|not pending/i.test(msg)) return reply.code(404).send({ error: msg });
      return reply.code(400).send({ error: msg });
    }
  });

  fastify.get('/api/bus/stats', async () => tracker.busStats());

  fastify.post('/api/bus/ingest', async (req, reply) => {
    try {
      const result = tracker.ingestBusEvents(req.body ?? {});
      const session_status = updateSessionMaterializedStatusFromIngest(result);
      if (session_status.updated && typeof state.refreshNativeSessions === 'function') await state.refreshNativeSessions();
      broadcastWS({ type: 'bus-ingested', result: { ...result, events: undefined }, session_status });
      if (session_status.updated) {
        broadcastWS({ type: 'native-sessions-update', native_sessions: enrichSessionRows(state.nativeSessions(), state.channels()), channels: state.channels() });
      }
      return reply.code(202).send({ ...result, session_status });
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.post('/api/bus/prune', async (req, reply) => {
    try {
      const result = tracker.pruneBus(req.body ?? {});
      broadcastWS({ type: 'bus-pruned', result });
      return result;
    } catch (err) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  // GOL-151: the /api/streams routes are gone with the streams concept.
  // Grouping is parent_id (a spec and its children), nothing else.

  // GET /api/sessions/dispatchable — live native sessions in a project (alive,
  // matching the requested contract project_id). Channel presence is an
  // ANNOTATION, not a filter (TKT-0369): an alive legacy session whose channel
  // MCP died stays listed with reachable:false so the UI can offer durable
  // when-idle queueing (delivered when the channel re-registers). Fact-backed
  // rows still require an authenticated healthy endpoint, but not immediate
  // delivery readiness: healthy busy/waiting targets are queueable. `project`
  // omitted → all dispatchable sessions (each annotated with its project_id).
  fastify.get('/api/sessions/dispatchable', async (req) => {
    // This endpoint is the just-in-time roster authority used immediately
    // before every new handoff or session notification. Do not make callers
    // wait for the normal three-second background refresh to discover a peer
    // that was created after their session started.
    try {
      await state.refreshNativeSessions();
    } catch (err) {
      console.error('[dispatchable] synchronous session refresh failed:', err);
    }
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
    const teamBySession = new Map(buildTeamRows(wanted, { channels, aliveOnly: true }).map((row) => [row.session_id, row]));

    const out = [];
    for (const s of enrichSessionRows(state.nativeSessions(), channels)) {
      if (!s.alive) continue;
      if (wanted != null && s.project_id !== wanted) continue;
      const ch = channelBySession.get(s.session_id);
      // Once a harness has adopted canonical facts, an authenticated healthy
      // endpoint lease is part of dispatchability. Legacy rows retain the
      // queue-while-unreachable compatibility behavior during migration.
      if (s.fact_observed_at && !hasAuthenticatedHealthyChannel(s)) continue;
      const team = teamBySession.get(s.session_id);
      // TKT-0369: an alive session whose channel MCP died must NOT silently
      // vanish from the picker — it stays listed with reachable:false so the UI
      // can offer durable when-idle queueing (delivered when the channel
      // re-registers, e.g. after /reload-plugins). Channel presence is now an
      // annotation, not a filter.
      out.push({
        ...s,
        session_id: s.session_id,
        name: s.name ?? null,
        label: s.name || `session ${String(s.session_id ?? '').slice(0, 8)}`,
        status: s.status ?? null,
        role: s.role ?? null,
        role_mission: s.role ? roleMission(s.role) : null,
        harness: s.harness ?? 'claudecode',
        project_id: s.project_id ?? null,
        current_in_progress_ticket: tracker.currentInProgressTicketForSession(s.session_id),
        channel_url: ch ? (ch.url ?? (ch.host && ch.port ? `http://${ch.host}:${ch.port}` : null)) : null,
        started_at: s.started_at ?? null,
        updated_at: s.updated_at ?? null,
        // TKT-0245: count of pending queued dispatches for this session, so the
        // picker can show "working · 1 queued".
        pending_count: s.pending_count ?? 0,
        role_meta: team?.role_meta ?? null,
        in_progress_tickets: team?.in_progress_tickets ?? [],
        workload: team?.workload ?? {
          in_progress_tickets: [],
          pending_count: s.pending_count ?? 0,
          last_active: s.updated_at ?? s.started_at ?? null,
        },
      });
    }
    const enriched = enrichDispatchableRows(out, { projectId: wanted });
    const assists = teamAssists(enriched);
    return enriched.map((row) => ({ ...row, suggested: row.session_id === assists.suggested_manager?.session_id ? 'lead' : null }));
  });

  fastify.get('/api/roles', async () => roleCardsWithDefaults());

  fastify.get('/api/model-profiles', async () => modelProfilesPayload());

  fastify.post('/api/model-profiles', async (req, reply) => {
    try {
      const profile = createProfile(req.body ?? {});
      const roles = roleCardsWithDefaults();
      broadcastWS({ type: 'model-profiles-updated', profiles: modelProfilesPayload(), roles, meta: roleMetaMap() });
      broadcastWS({ type: 'roles-updated', roles, meta: roleMetaMap() });
      return reply.code(201).send(profile);
    } catch (error) {
      return profileRouteError(reply, error);
    }
  });

  fastify.route({
    method: ['PATCH', 'PUT'],
    url: '/api/model-profiles/:name',
    handler: async (req, reply) => {
      try {
        const profile = updateProfile(req.params.name, req.body ?? {});
        const roles = roleCardsWithDefaults();
        broadcastWS({ type: 'model-profiles-updated', profiles: modelProfilesPayload(), roles, meta: roleMetaMap() });
        broadcastWS({ type: 'roles-updated', roles, meta: roleMetaMap() });
        return profile;
      } catch (error) {
        return profileRouteError(reply, error);
      }
    },
  });

  fastify.delete('/api/model-profiles/:name', async (req, reply) => {
    try {
      const result = deleteProfile(req.params.name);
      const roles = roleCardsWithDefaults();
      broadcastWS({ type: 'model-profiles-updated', profiles: modelProfilesPayload(), roles, meta: roleMetaMap() });
      broadcastWS({ type: 'roles-updated', roles, meta: roleMetaMap() });
      return result;
    } catch (error) {
      return profileRouteError(reply, error);
    }
  });

  // Pi's catalog is an editor aid only. A missing binary, an offline Pi, or a
  // malformed table returns the last-good cache (or an empty catalog), never a
  // failed dashboard route and never a spawn-path dependency.
  fastify.get('/api/model-catalog', async (req) => (
    req.query?.refresh === '1' || req.query?.refresh === 'true'
      ? refreshCatalogPayload()
      : readCatalogPayload()
  ));
  fastify.post('/api/model-catalog/refresh', async () => refreshCatalogPayload());

  async function pushRoleToLive(name) {
    if (typeof state.refreshNativeSessions === 'function') await state.refreshNativeSessions();
    const targets = state.nativeSessions().filter((s) => s.alive && s.role === name);
    const results = [];
    for (const session of targets) {
      const brief = roleChangeBrief(name, session);
      let result = { ok: false, error: 'no role assign payload' };
      if (brief) {
        try {
          const activated = await deliverControlEnvelope(tracker, {
            project_id: session.project_id ?? null,
            sender_id: 'human:dashboard',
            recipient_session_id: session.session_id,
            kind: 'role_assign',
            content: brief,
            legacy: { path: '/role', body: brief },
          });
          result = { ...activated.delivery, envelope_id: activated.envelope.id };
        } catch (error) {
          result = { ok: false, status: 0, error: String(error?.message ?? error) };
        }
      }
      results.push({
        session_id: session.session_id,
        name: session.name ?? null,
        ok: !!result.ok,
        status: result.status ?? null,
        error: result.error ?? null,
        target: result.target ?? null,
      });
      chat.record(result.ok ? 'system' : 'error', 'session_role_push', `role ${name} push ${result.ok ? 'delivered' : 'failed'} for ${session.name || session.session_id}`, { session_id: session.session_id });
    }
    return { role: name, count: results.length, results };
  }

  fastify.post('/api/roles', async (req, reply) => {
    try {
      const incoming = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : {};
      const hasDefaultProfile = Object.hasOwn(incoming, 'default_profile');
      const defaultProfile = incoming.default_profile;
      delete incoming.default_profile;
      const role = createRole(incoming);
      if (hasDefaultProfile) {
        setRoleDefault(role.name, defaultProfile == null || String(defaultProfile).trim() === '' ? null : defaultProfile);
      }
      const roles = roleCardsWithDefaults();
      broadcastWS({ type: 'roles-updated', roles, meta: roleMetaMap() });
      return reply.code(201).send(roles.find((item) => item.name === role.name) || role);
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /already exists/i.test(msg) ? 409 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  fastify.route({
    method: ['PUT', 'PATCH'],
    url: '/api/roles/:name',
    handler: async (req, reply) => {
    const name = req.params.name;
    const existing = getRole(name);
    if (!existing) return reply.code(404).send({ error: 'role_not_found' });
    try {
      const incoming = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : {};
      const hasBody = typeof incoming.body === 'string';
      const hasDefaultProfile = Object.hasOwn(incoming, 'default_profile');
      const defaultProfile = incoming.default_profile;
      delete incoming.default_profile;
      // Builtin identity is fixed. The model layer owns execution validation;
      // default_profile is stored in profiles.json, never in the role row.
      const patch = existing.builtin
        ? { ...incoming, color: existing.color, glyph: existing.glyph, builtin: existing.builtin }
        : incoming;
      updateRoleMeta(name, patch);
      if (hasDefaultProfile) {
        setRoleDefault(name, defaultProfile == null || String(defaultProfile).trim() === '' ? null : defaultProfile);
      }
      if (hasBody) writeRoleCard(existing.name, incoming.body);
      // Always return the complete card. writeRoleCard() only returns card
      // metadata, which would otherwise drop exec from a body-only round-trip.
      const role = roleCardsWithDefaults().find((r) => r.name === existing.name);
      broadcastWS({ type: 'roles-updated', roles: roleCardsWithDefaults(), meta: roleMetaMap() });
      return role;
    } catch (err) {
      // validateRolePreset() throws a readable model-layer message. Keep it
      // as a client error so the editor can show it inline instead of a 500.
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
    },
  });

  fastify.delete('/api/roles/:name', async (req, reply) => {
    try {
      const result = deleteRole(req.params.name, { force: req.query?.force === 'true' || req.query?.force === '1' });
      clearRoleDefault(req.params.name);
      broadcastWS({ type: 'roles-updated', roles: roleCardsWithDefaults(), meta: roleMetaMap() });
      if (typeof state.refreshNativeSessions === 'function') await state.refreshNativeSessions();
      broadcastWS({ type: 'native-sessions-update', native_sessions: enrichSessionRows(state.nativeSessions(), state.channels()), channels: state.channels() });
      return result;
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : /assigned|builtin/i.test(msg) ? 409 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  fastify.post('/api/roles/:name/push', async (req, reply) => {
    const name = req.params.name;
    if (!getRole(name)) return reply.code(404).send({ error: 'role_not_found' });
    const push = await pushRoleToLive(name);
    broadcastWS({ type: 'roles-updated', roles: listRoleCards(), meta: roleMetaMap(), push });
    return push;
  });

  fastify.post('/api/sessions/:id/role', async (req, reply) => {
    const id = req.params.id;
    const body = req.body ?? {};
    const role = body.role === 'clear' ? null : (body.role ?? null);
    if (role != null && !getRole(role)) {
      return reply.code(400).send({ error: `invalid role: ${role}` });
    }
    try {
      const row = setSessionRole(id, role, { by: 'human:dashboard' });
      const text = `session role ${role ?? 'cleared'} for ${row.name || row.session_id || id}`;
      chat.record('system', 'session_role', text, { session_id: row.session_id || id });
      let activation = { ok: true, skipped: true, reason: 'role cleared; no role card activation required' };
      const brief = roleChangeBrief(role, row);
      if (brief) {
        try {
          const activated = await deliverControlEnvelope(tracker, {
            project_id: row.project_id ?? null,
            sender_id: 'human:dashboard',
            recipient_session_id: row.session_id || id,
            kind: 'role_assign',
            content: brief,
            legacy: { path: '/role', body: brief },
          });
          activation = { ...activated.delivery, envelope_id: activated.envelope.id };
        } catch (error) {
          activation = { ok: false, status: 0, error: String(error?.message ?? error) };
        }
      }
      if (!activation.ok) {
        chat.record('system', 'warning', activation.error, { session_id: row.session_id || id });
      }
      if (typeof state.refreshNativeSessions === 'function') await state.refreshNativeSessions();
      broadcastWS({ type: 'native-sessions-update', native_sessions: enrichSessionRows(state.nativeSessions(), state.channels()), channels: state.channels() });
      return { ok: true, saved: true, session: row, activation };
    } catch (err) {
      const msg = String(err?.message ?? err);
      const code = /not found/i.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  // GET /api/templates — genre scaffolds (spec/feature/bug/decision) shipped
  // as Markdown bodies. Reads the templates dir at
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

  // TKT-0206 / GOL-13: ideas stack now project-scoped — ?project=<contract_id>
  // filters the queue to that project's ideas. Without the param the legacy
  // global view (all ideas) is returned for backward compat.
  fastify.get('/api/ideas', async (req) => {
    const project = req.query?.project ? resolveProjectId(String(req.query.project)) : null;
    return listIdeas(project || null);
  });

  fastify.post('/api/ideas', async (req, reply) => {
    try {
      const b = req.body ?? {};
      const project = b.project_id || b.project || b.projectId || null;
      const resolved = project ? resolveProjectId(String(project)) : null;
      const idea = await createIdea({ body: b.body || '', project_id: resolved || project || null });
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

  fastify.post('/api/ideas/:id/promote', async (req, reply) => {
    try {
      const idea = await readIdea(req.params.id);
      const b = req.body ?? {};
      const projectId = resolveProjectId(b.project_id || b.project || 'golem-1eba80');
      const title = String(b.title || idea.body.split('\n')[0] || 'Promoted idea').trim().slice(0, 120) || 'Promoted idea';
      const ticket = tracker.createTicket({
        project_id: projectId,
        kind: 'spec',
        title,
        body: ideaSpecBody(idea.body),
        state: 'todo',
        source_ref: `ideas/${idea.id}`,
        created_by: b.created_by || 'human:ideas',
      });
      await popIdea(idea.id);
      broadcastWS({ type: 'ticket-created', ticket });
      return reply.code(201).send({ idea_id: idea.id, ticket });
    } catch (err) {
      if (err && err.status) return reply.code(err.status).send({ error: err.message });
      return reply.code(400).send({ error: String(err?.message ?? err) });
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
              payload: {
                ...state.snapshot(),
                native_sessions: enrichSessionRows(state.nativeSessions(), state.channels()),
                ...trackerSnapshot(),
                chat: chat.snapshot(),
              },
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
    if (ev?.type === 'native-sessions-update') {
      ev = {
        ...ev,
        native_sessions: enrichSessionRows(ev.native_sessions || state.nativeSessions(), ev.channels || state.channels()),
      };
    }
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

  // TKT-0245: dispatch drainer — delivers queued dispatches when their target
  // session goes idle. Own 5s tick (reads state.nativeSessions(), which state.js
  // already refreshes every 3s — no new session poll). Closed in shutdown().
  const dispatchDrainer = initDispatchDrainer({
    tracker,
    state,
    chat,
    pushBrief,
    pushControlEnvelope,
    buildDispatchBrief,
    broadcastWS,
    listChannels,
  });

  // Pin to the canonical dashboard URL http://dashboard.golem.localhost:7420.
  // A second start must fail. Never replace a process or walk to a random port;
  // use an explicit --port value when a second isolated dashboard is intended.
  const tryListen = async (port) => {
    try {
      await fastify.listen({ host: CONFIG.host, port });
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      const holder = findListenerPid(port);
      const detail = holder.pid
        ? ` held by pid ${holder.pid} (${getProcessComm(holder.pid)})`
        : ` (${holder.error || 'the listener could not be identified'})`;
      throw new Error(`port ${port} is already in use${detail}; refusing to start another dashboard. Pass --port <other-port> to use an explicit alternate port`);
    }
    fastify.log.info(`dashboard listening on http://${CONFIG.host}:${port}`);
    return port;
  };

  // Canonical URL is http://dashboard.golem.localhost:7420 (RFC 6761 *.localhost
  // resolves to 127.0.0.1 — no /etc/hosts edit needed).
  const boundPort = await tryListen(CONFIG.port);

  // WS2: self-register so WS3's MCP discovery can find the live dashboard.
  // Atomic write (tmp + rename) into ~/.golem/dashboard.json. Best-effort
  // — a write failure logs a warning and must NOT crash the server. We LEAVE the
  // file on shutdown (a stale entry is harmless: consumers health-check the URL).
  try {
    const dir = golemHome();
    fs.mkdirSync(dir, { recursive: true });
    const target = dashboardJsonPath();
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
      dispatchDrainer.close();
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
