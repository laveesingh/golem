#!/usr/bin/env node
// WS2 verification — exercises every new tracker REST + WS endpoint against a
// FRESH dashboard server spawned as a child process, fully isolated from the
// user's live dashboard:
//   • PORT       = a free high port (7611), never 7420
//   • HOST       = 127.0.0.1
//   • GOLEM_TRACKER_DB    = a temp DB file (never the real ~/.config tracker.db)
//   • XDG_CONFIG_HOME     = a temp dir (so dashboard.json self-registration,
//                           channels.json reads, projects.json reads all go to
//                           an empty temp config — the live config is untouched)
//
// Prints PASS/FAIL per check; exits non-zero on any failure. Cleans up the
// child + temp files regardless.
//
//   node dashboard/scripts/api-smoke.mjs

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import url from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'server', 'index.js');

const PORT = 7611;
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TAG = crypto.randomBytes(6).toString('hex');
const TMP_DB = path.join(os.tmpdir(), `golem-api-smoke-${TAG}.db`);
const TMP_XDG = fs.mkdtempSync(path.join(os.tmpdir(), `golem-api-smoke-xdg-${TAG}-`));

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
    // Point project roots at empty temp dirs so discovery finds nothing and the
    // child never touches the real workspace. Dispatchable will be empty — which
    // is exactly the "doesn't 500 when empty" case we assert.
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
async function jsend(method, p, payload) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

async function run() {
  await waitForHealth();
  check('server: /api/health ok', true);

  const PID = 'smoke-proj-abc123'; // a canonical-ish contract id



  // --- create tickets -------------------------------------------------
  const mk1 = await jsend('POST', '/api/tickets', { project_id: PID, kind: 'task', title: 'First item', body: 'do it' });
  check('POST /api/tickets: 201 + TKT id', mk1.status === 201 && /^TKT-\d{4}$/.test(mk1.body?.id ?? ''), `status ${mk1.status} id ${mk1.body?.id}`);
  const t1 = mk1.body?.id;

  const mk2 = await jsend('POST', '/api/tickets', { project_id: PID, kind: 'task', title: 'A bug', priority: 'P1', labels: ['urgent'] });
  check('POST /api/tickets: 201 second ticket', mk2.status === 201 && !!mk2.body?.id);
  check('POST /api/tickets: labels round-trip as array', Array.isArray(mk2.body?.labels) && mk2.body.labels[0] === 'urgent');
  const t2 = mk2.body?.id;

  const badTicket = await jsend('POST', '/api/tickets', { project_id: PID, title: 'bad', kind: 'nonsense' });
  check('POST /api/tickets: 400 on invalid kind', badTicket.status === 400, `status ${badTicket.status}`);

  // --- list (with + without filters) ----------------------------------
  const listAll = await jget('/api/tickets');
  check('GET /api/tickets: returns array of 2', Array.isArray(listAll.body) && listAll.body.length === 2, `got ${listAll.body?.length}`);
  const listProj = await jget(`/api/tickets?project=${PID}`);
  check('GET /api/tickets?project: filtered to 2', Array.isArray(listProj.body) && listProj.body.length === 2, `got ${listProj.body?.length}`);
  const listFix = await jget(`/api/tickets?project=${PID}&kind=fix`);
  check('GET /api/tickets?kind=fix: filtered to 1', listFix.body?.length === 1 && listFix.body[0].id === t2);
  const listOtherProj = await jget('/api/tickets?project=nonexistent-xyz');
  check('GET /api/tickets?project=unknown: empty array (no 500)', Array.isArray(listOtherProj.body) && listOtherProj.body.length === 0);

  // --- get one --------------------------------------------------------
  const getOne = await jget(`/api/tickets/${t1}`);
  check('GET /api/tickets/:id: returns ticket + events', getOne.status === 200 && getOne.body?.id === t1 && Array.isArray(getOne.body?.events));
  const get404 = await jget('/api/tickets/TKT-9999');
  check('GET /api/tickets/:id: 404 unknown', get404.status === 404, `status ${get404.status}`);

  // --- patch state + assignee -----------------------------------------
  const patch = await jsend('PATCH', `/api/tickets/${t1}`, { state: 'in_progress', assignee: 'alice', actor: 'smoke' });
  check('PATCH /api/tickets/:id: state+assignee applied', patch.status === 200 && patch.body?.state === 'in_progress' && patch.body?.assignee === 'alice', `status ${patch.status}`);
  const patch404 = await jsend('PATCH', '/api/tickets/TKT-9999', { state: 'done' });
  check('PATCH /api/tickets/:id: 404 unknown', patch404.status === 404, `status ${patch404.status}`);
  const patchBad = await jsend('PATCH', `/api/tickets/${t1}`, { state: 'not-a-state' });
  check('PATCH /api/tickets/:id: 400 invalid state', patchBad.status === 400, `status ${patchBad.status}`);

  // --- comment --------------------------------------------------------
  const comment = await jsend('POST', `/api/tickets/${t1}/comments`, { author: 'human', body: 'looks good' });
  check('POST /api/tickets/:id/comments: 201 + uuid', comment.status === 201 && !!comment.body?.id, `status ${comment.status}`);

  // --- get one again — comment + events present -----------------------
  const getAgain = await jget(`/api/tickets/${t1}`);
  const hasComment = Array.isArray(getAgain.body?.comments) && getAgain.body.comments.some((c) => c.body === 'looks good');
  const evTypes = (getAgain.body?.events ?? []).map((e) => e.type);
  check('GET /api/tickets/:id again: comment attached', hasComment);
  check('GET /api/tickets/:id again: events include state_change+commented', evTypes.includes('state_change') && evTypes.includes('commented'), evTypes.join(','));

  // --- link t1 → t2 ---------------------------------------------------
  const link = await jsend('POST', `/api/tickets/${t1}/links`, { to_ticket: t2, type: 'blocks' });
  check('POST /api/tickets/:id/links: 201', link.status === 201, `status ${link.status}`);
  const getLinked = await jget(`/api/tickets/${t1}`);
  const hasLink = (getLinked.body?.links ?? []).some((l) => l.from_ticket === t1 && l.to_ticket === t2 && l.type === 'blocks');
  check('GET after link: link present on from-ticket', hasLink);
  const unlink = await jsend('DELETE', `/api/tickets/${t1}/links`, { to_ticket: t2, type: 'blocks' });
  check('DELETE /api/tickets/:id/links: removed', unlink.status === 200 && unlink.body?.removed === 1, `status ${unlink.status}`);

  // GOL-151: streams are gone — the routes must 404.
  const goneStreams = await jget('/api/streams');
  check('GET /api/streams: 404 (retired)', goneStreams.status === 404, `status ${goneStreams.status}`);

  // --- dispatchable sessions (empty but must not 500) -----------------
  const disp = await jget(`/api/sessions/dispatchable?project=${PID}`);
  check('GET /api/sessions/dispatchable?project: array, no 500', disp.status === 200 && Array.isArray(disp.body), `status ${disp.status}`);
  const dispAll = await jget('/api/sessions/dispatchable');
  check('GET /api/sessions/dispatchable (no project): array, no 500', dispAll.status === 200 && Array.isArray(dispAll.body), `status ${dispAll.status}`);

  // --- substrate settings/status/sync ----------------------------------
  const subCfg = await jget('/api/substrate/config');
  check('GET /api/substrate/config: harness config', subCfg.status === 200 && subCfg.body?.harnesses?.claudecode, `status ${subCfg.status}`);

  const subStatus = await jget('/api/substrate/status');
  const statusCells = subStatus.body?.global || [];
  const hasCc = statusCells.some((c) => c.harness === 'claudecode' && ['in_sync', 'drifted'].includes(c.status));
  check('GET /api/substrate/status: cc active cells', subStatus.status === 200 && hasCc, `status ${subStatus.status}`);

  const subStatusEnabled = await jget('/api/substrate/status');
  const enabledCells = subStatusEnabled.body?.global || [];
  const commandCells = enabledCells.filter((c) => c.artifact === 'commands');
  const commandsNeutral = commandCells.length === 2 && commandCells.every((c) => ['empty', 'disabled'].includes(c.status));
  check('GET /api/substrate/status: neutral unsupported/empty cells', subStatusEnabled.status === 200 && commandsNeutral, `status ${subStatusEnabled.status}`);

  const syncCc = await jsend('POST', '/api/substrate/sync', { target: 'claudecode' });
  check('POST /api/substrate/sync: claudecode runs', syncCc.status === 200 && syncCc.body?.results?.[0]?.status === 'ok', `status ${syncCc.status}`);

  // --- snapshot folds tracker tables ----------------------------------
  const snap = await jget('/api/snapshot');
  check('GET /api/snapshot: tickets present', Array.isArray(snap.body?.tickets) && snap.body.tickets.length === 2, `tickets ${snap.body?.tickets?.length}`);
  check('GET /api/snapshot: no streams key (retired)', !('streams' in (snap.body ?? {})));

  // --- WS delta on mutation -------------------------------------------
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/ws`);
    let sawSnapshot = false;
    let sawDelta = false;
    const done = (ok, detail) => {
      check('WS: ticket-updated/created delta arrives on mutation', ok, detail);
      try { ws.close(); } catch { /* ignore */ }
      resolve();
    };
    const timer = setTimeout(() => done(sawDelta, sawDelta ? '' : `snapshot=${sawSnapshot} delta=false`), 6000);
    ws.addEventListener('message', (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'snapshot') {
        sawSnapshot = true;
        // Snapshot received → trigger a mutation we expect to echo back.
        jsend('PATCH', `/api/tickets/${t2}`, { state: 'review', actor: 'ws-smoke' }).catch(() => {});
        return;
      }
      if (msg.type === 'ticket-updated' || msg.type === 'ticket-created') {
        sawDelta = true;
        clearTimeout(timer);
        done(true);
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      done(false, 'ws error');
    });
  });

  // --- dashboard.json self-registration -------------------------------
  const dashFile = path.join(TMP_XDG, 'golem', 'dashboard.json');
  let dashOk = false;
  let dashDetail = 'file missing';
  try {
    const doc = JSON.parse(fs.readFileSync(dashFile, 'utf8'));
    dashOk = doc.port === PORT && doc.url === `${BASE}` && typeof doc.pid === 'number' && !!doc.started_at;
    dashDetail = `port=${doc.port} url=${doc.url}`;
  } catch (e) {
    dashDetail = String(e?.message ?? e);
  }
  check('dashboard.json: written to temp XDG with right port', dashOk, dashDetail);
}

let exitCode = 0;
try {
  await run();
} catch (err) {
  failures++;
  console.log(`[FAIL] unexpected exception — ${err && err.stack ? err.stack : err}`);
} finally {
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  // Give it a moment to die, then SIGKILL if needed.
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
