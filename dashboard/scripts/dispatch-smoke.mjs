#!/usr/bin/env node
// WS4 verification — exercises POST /api/tickets/:id/dispatch against a FRESH
// dashboard server spawned as a child process, fully isolated from the user's
// live dashboard and the real tracker DB:
//   • PORT             = a free high port (7612), never 7420
//   • HOST             = 127.0.0.1
//   • GOLEM_TRACKER_DB = a temp DB file (never the real ~/.config tracker.db)
//   • XDG_CONFIG_HOME  = a temp dir (so channels.json is empty → no channel is
//                        registered for any session, which is exactly the
//                        "unreachable channel, durable-first still works" case)
//
// Asserts the assignment is written to disk (assignee / dispatched_to /
// dispatched_at + a `dispatched` event) EVEN THOUGH the channel push misses,
// plus the 404 (missing ticket) and 400 (missing session_id) guards.
//
// Prints PASS/FAIL per check; exits non-zero on any failure. Cleans up the
// child + temp files regardless.
//
//   node dashboard/scripts/dispatch-smoke.mjs

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import url from 'node:url';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'server', 'index.js');

const PORT = 7612;
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TAG = crypto.randomBytes(6).toString('hex');
const TMP_DB = path.join(os.tmpdir(), `golem-dispatch-smoke-${TAG}.db`);
const TMP_XDG = fs.mkdtempSync(path.join(os.tmpdir(), `golem-dispatch-smoke-xdg-${TAG}-`));

let failures = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function cleanupFiles() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(TMP_XDG, { recursive: true, force: true }); } catch { /* ignore */ }
}

const child = spawn('node', [SERVER], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST,
    GOLEM_TRACKER_DB: TMP_DB,
    XDG_CONFIG_HOME: TMP_XDG,
    LOG_LEVEL: 'warn',
    GOLEM_PROJECTS_ROOT: path.join(TMP_XDG, 'projects'),
    GOLEM_IDEAS_ROOT: path.join(TMP_XDG, 'ideas'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childExited = false;
child.on('exit', () => { childExited = true; });
child.stderr.on('data', (d) => {
  const s = d.toString();
  if (/EADDRINUSE|fatal|Error:/i.test(s)) process.stderr.write(`[child] ${s}`);
});

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childExited) throw new Error('child exited before becoming healthy');
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error('server did not become healthy in time');
}

async function jget(p) {
  const r = await fetch(`${BASE}${p}`);
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function jsend(method, p, payload, headers = {}) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

async function run() {
  await waitForHealth();
  check('server: /api/health ok', true);

  const PID = 'dispatch-smoke-proj';
  const SESSION = 'bogus-session-not-registered';

  // --- create a ticket to dispatch ------------------------------------
  const mk = await jsend('POST', '/api/tickets', { project_id: PID, kind: 'task', title: 'Wire the widget', body: 'do the thing' });
  check('POST /api/tickets: 201 + TKT id', mk.status === 201 && /^TKT-\d{4}$/.test(mk.body?.id ?? ''), `status ${mk.status} id ${mk.body?.id}`);
  const tid = mk.body?.id;

  // --- dispatch to an unregistered session ----------------------------
  // Durable-first must win: assignment persists, channel push misses (no
  // channel registered in the temp XDG → channels.json absent/empty).
  const disp = await jsend('POST', `/api/tickets/${tid}/dispatch`, { session_id: SESSION, note: 'priority one' });
  check('POST dispatch: HTTP 200', disp.status === 200, `status ${disp.status}`);
  check('POST dispatch: top-level ok:false on channel failure', disp.body?.ok === false);
  check('POST dispatch: durable assignment ok:true', disp.body?.assignment?.ok === true);
  check('POST dispatch: ticket.assignee === session_id', disp.body?.ticket?.assignee === SESSION, `assignee ${disp.body?.ticket?.assignee}`);
  check('POST dispatch: ticket.dispatched_to === session_id', disp.body?.ticket?.dispatched_to === SESSION, `dispatched_to ${disp.body?.ticket?.dispatched_to}`);
  check('POST dispatch: dispatched_at set', !!disp.body?.ticket?.dispatched_at, `dispatched_at ${disp.body?.ticket?.dispatched_at}`);
  check('POST dispatch: channel.ok === false (unreachable, as expected)', disp.body?.channel?.ok === false, `channel ${JSON.stringify(disp.body?.channel)}`);
  check('POST dispatch: truthful queued:false + exact failed delivery', disp.body?.queued === false && disp.body?.delivered === false && disp.body?.delivery?.status === 0 && /no channel registered/.test(disp.body?.delivery?.error || ''), JSON.stringify(disp.body));
  check('POST dispatch: envelope id returned', typeof disp.body?.envelope_id === 'string', disp.body?.envelope_id);

  const sql = new Database(TMP_DB, { readonly: true });
  const immediateEnvelope = sql.prepare('SELECT * FROM message_envelopes WHERE id = ?').get(disp.body?.envelope_id);
  check('immediate envelope is durable and records failed delivery', immediateEnvelope?.target_session_id === SESSION && immediateEnvelope?.status === 'delivery_failed' && !!immediateEnvelope?.delivered_at, JSON.stringify(immediateEnvelope));
  sql.close();

  // --- the durable write is reflected on a fresh GET ------------------
  const got = await jget(`/api/tickets/${tid}`);
  const evTypes = (got.body?.events ?? []).map((e) => e.type);
  check('GET after dispatch: dispatched_to persisted', got.body?.dispatched_to === SESSION, `dispatched_to ${got.body?.dispatched_to}`);
  check('GET after dispatch: `dispatched` event present', evTypes.includes('dispatched'), evTypes.join(','));

  // --- guards ---------------------------------------------------------
  const miss = await jsend('POST', '/api/tickets/TKT-9999/dispatch', { session_id: SESSION });
  check('POST dispatch: 404 on unknown ticket', miss.status === 404, `status ${miss.status}`);
  const noSession = await jsend('POST', `/api/tickets/${tid}/dispatch`, { note: 'no session here' });
  check('POST dispatch: 400 on missing session_id', noSession.status === 400, `status ${noSession.status}`);

  // A target with no live session/channel must remain queued, with a durable
  // envelope linked from the nullable queue column (legacy rows may still be null).
  const queuedTicket = await jsend('POST', '/api/tickets', { project_id: PID, kind: 'task', title: 'Queue the widget' });
  const queued = await jsend('POST', `/api/tickets/${queuedTicket.body?.id}/dispatch`, { session_id: 'offline-queued-session', mode: 'when_idle', sender_id: 'sender-session' });
  check('when_idle: truthful queued:true + delivered:false', queued.status === 200 && queued.body?.queued === true && queued.body?.delivered === false, JSON.stringify(queued.body));
  const queuedRows = await jget('/api/dispatch-queue?status=pending');
  const queueRow = queuedRows.body?.find((row) => row.id === queued.body?.queue_id);
  check('when_idle: queue row links durable envelope', typeof queued.body?.envelope_id === 'string' && queueRow?.envelope_id === queued.body.envelope_id, JSON.stringify(queueRow));
  const sql2 = new Database(TMP_DB, { readonly: true });
  const queuedEnvelope = sql2.prepare('SELECT * FROM message_envelopes WHERE id = ?').get(queued.body?.envelope_id);
  check('when_idle: envelope is undelivered without relying on status', queuedEnvelope?.delivery_attempted_at == null && queuedEnvelope?.delivered_at == null, JSON.stringify(queuedEnvelope));
  const queuedPayload = JSON.parse(queuedEnvelope?.payload || '{}');
  check('target content contains generated message id and ack-first instruction', queuedPayload?.envelope_id === queued.body?.envelope_id && queuedPayload?.content?.includes(`Dispatch message_id: ${queued.body?.envelope_id}`) && queuedPayload?.content?.includes("pass it as envelope_id when you ack"), JSON.stringify(queuedPayload));
  const wrongAck = await jsend('POST', `/api/message-envelopes/${queued.body?.envelope_id}/ack`, { target_session_id: 'offline-queued-session', summary: 'spoof' }, { 'x-golem-caller-session': 'wrong-session' });
  check('envelope ack rejects a non-target', wrongAck.status === 403, `status ${wrongAck.status}`);
  const correctAck = await jsend('POST', `/api/message-envelopes/${queued.body?.envelope_id}/ack`, { target_session_id: 'wrong-session', summary: 'picked up' }, { 'x-golem-caller-session': 'offline-queued-session' });
  check('envelope ack accepts stored target without changing root delivery status', correctAck.status === 200 && !!correctAck.body?.envelope?.acknowledged_at && correctAck.body?.envelope?.status === 'pending', JSON.stringify(correctAck.body));
  const retryAck = await jsend('POST', `/api/message-envelopes/${queued.body?.envelope_id}/ack`, {}, { 'x-golem-caller-session': 'offline-queued-session' });
  check('same target ack is idempotent', retryAck.status === 200 && retryAck.body?.envelope?.acknowledged_at === correctAck.body?.envelope?.acknowledged_at, JSON.stringify(retryAck.body));
  const correlatedReply = await jsend('POST', `/api/message-envelopes/${queued.body?.envelope_id}/reply`, { text: 'completed' }, { 'x-golem-caller-session': 'offline-queued-session' });
  check('correlated envelope reply route is retired; delegated returns use session_notify', correlatedReply.status === 404, JSON.stringify(correlatedReply.body));
  const notification = await jsend('POST', '/api/messages/notify', { session_id: 'notify-recipient', sender_id: 'notify-sender', text: 'durable notification', project_id: PID });
  check('session notify reports failed delivery truthfully', notification.status === 200 && notification.body?.ok === false, JSON.stringify(notification.body));
  const notificationEnvelope = sql2.prepare('SELECT * FROM message_envelopes WHERE id = ?').get(notification.body?.envelope_id);
  check('session notify persists nullable-ticket sender/reply route', notificationEnvelope?.ticket_id == null && notificationEnvelope?.sender_id === 'notify-sender' && notificationEnvelope?.reply_to_session_id === 'notify-sender' && notificationEnvelope?.recipient_session_id === 'notify-recipient', JSON.stringify(notificationEnvelope));
  sql2.close();
}

let exitCode = 0;
try {
  await run();
} catch (err) {
  failures++;
  console.log(`[FAIL] unexpected exception — ${err && err.stack ? err.stack : err}`);
} finally {
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  await new Promise((res) => setTimeout(res, 400));
  if (!childExited) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  cleanupFiles();
  if (failures === 0) {
    console.log('\nALL CHECKS PASSED');
  } else {
    console.log(`\n${failures} CHECK(S) FAILED`);
    exitCode = 1;
  }
  process.exit(exitCode);
}
