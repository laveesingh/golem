// GOL-383: reply-comment dispatch feedback + button contrast journey.
// Isolated fixture: temp HOME/project/DB, its own dashboard on a random port,
// one live typed-worker endpoint as the dispatch target. Scratch tickets live
// only in the temp DB (SMOKE-titled, created_by smoke, archived in cleanup
// via dashboard/scripts/_scratch.mjs); nothing touches a real project.
//
// Proves, against the real rail:
//  - success: saved reply starts undispatched; Dispatch shows progress,
//    drops duplicate clicks (one delivery), flips the reply chip to
//    dispatched without remounting the card; the parent chip is untouched;
//    a root dispatch flips its own card; refresh preserves both.
//  - failure: a rejected dispatch keeps retry, shows the error at the
//    clicked reply, and never flips the chip (no false success); restoring
//    the transport lets the same retry succeed.
//  - contrast: the Dispatch pill is legible (ratio >= 4.5) in loam and dark.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { acquireChrome } from './_chrome.mjs';
import { archiveTicket } from './_scratch.mjs';
import { projectIdFor } from '../server/project-id.js';
import { upsertSessionFact, renewEndpointLease } from '../../lib/session-facts.js';
import * as typed from '../../lib/typed-worker-endpoint.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gol383-dispatch-'));
const home = path.join(temp, 'home');
const project = path.join(temp, 'project');
const db = path.join(temp, 'tracker.db');
const shots = '/tmp/gol383-shots';
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# GOL-383 reply-dispatch fixture\n');
process.env.GOLEM_HOME = home;
process.env.GOLEM_TRACKER_DB = db;
const base = () => process.env.GOLEM_SMOKE_API;
const projectId = projectIdFor(project);

const LIVE_ID = 'gol383-live-target';
const LIVE_TOKEN = 'gol383-live-owner';
const received = [];
let deliveryDelayMs = 0;

// Live typed-worker endpoint: records deliveries; delay is script-controlled
// so the pending window is observable for the duplicate-click check.
const endpoint = await typed.startTypedWorkerEndpoint({
  canonicalId: LIVE_ID, ownerToken: LIVE_TOKEN, kind: 'typed-worker', deliveryReady: () => true,
  acceptDelivery: async (envelope) => {
    if (deliveryDelayMs > 0) await new Promise((r) => setTimeout(r, deliveryDelayMs));
    received.push(envelope);
    return {
      ok: true, accepted: true, http_status: 200, envelope_id: envelope.envelope_id,
      attempt_id: envelope.attempt_id, accepted_attempt_id: envelope.attempt_id,
      delivery_state: 'settled', turn_id: `turn-${received.length}`,
    };
  },
});
upsertSessionFact({
  canonical_id: LIVE_ID, continuation_key: 'gol383-live-cont', harness: 'pi',
  locator: { raw_session_id: LIVE_ID, session_file: path.join(home, 'pi-sessions', 'live.jsonl') },
  project_path: project, name: 'GOL-383 live target', status: 'idle',
  delivery: { mode: 'typed-worker', push: true, ready: true },
  capabilities: { typed_worker: true, typed_worker_protocol: typed.TYPED_WORKER_PROTOCOL_VERSION },
  observed_at: new Date().toISOString(),
});
renewEndpointLease({
  canonical_id: LIVE_ID, owner_token: LIVE_TOKEN, host: endpoint.host, port: endpoint.port,
  kind: 'typed-worker', harness: 'pi', delivery_ready: true,
});
fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: [
  { id: projectId, name: 'GOL-383 dispatch fixture', path: project, kind: 'auto' },
] }));
fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ sessions: [
  { session_id: LIVE_ID, harness: 'pi', project_path: project, name: 'GOL-383 live target', status: 'idle' },
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
async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const port = await unusedPort();
const dashboard = spawn(process.execPath, ['dashboard/server/index.js'], {
  cwd: repo,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), GOLEM_HOME: home, GOLEM_TRACKER_DB: db,
    GOLEM_PROJECTS_ROOT: path.join(temp, 'projects'), GOLEM_IDEAS_ROOT: path.join(temp, 'ideas'),
    XDG_CONFIG_HOME: path.join(temp, 'xdg'), HOME: path.join(temp, 'home'), LOG_LEVEL: 'error' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
dashboard.stderr.setEncoding('utf8');
dashboard.stderr.on('data', (chunk) => { stderr += chunk; });

let chrome;
let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
let ticketId = null;

try {
  const origin = `http://127.0.0.1:${port}`;
  process.env.GOLEM_SMOKE_API = origin;
  await waitFor(async () => { try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; } }, 'dashboard health');
  await waitFor(async () => {
    const rows = await (await fetch(`${origin}/api/native-sessions`)).json();
    return rows.some((r) => r.session_id === LIVE_ID && r.alive && r.delivery_ready);
  }, 'live target delivery-ready');

  // Fixture ticket (temp project only) assigned to the live target, with one
  // root human comment and one reply — both start undispatched.
  const created = await api('POST', `${origin}/api/tickets`, {
    project_id: projectId, kind: 'spec', title: 'SMOKE-GOL-383 reply dispatch fixture',
    body_format: 'html', body: '<h2>Dispatch fixture</h2><p>Reply from its card.</p>',
    assignee: LIVE_ID, created_by: 'smoke',
  });
  assert.ok([200, 201].includes(created.status), `ticket create: ${JSON.stringify(created.json)}`);
  ticketId = created.json.id;
  const root = await api('POST', `${origin}/api/tickets/${ticketId}/comments`,
    { author: 'human', body: 'root feedback for the GOL-383 journey' });
  assert.equal(root.status, 201, `root comment: ${JSON.stringify(root.json)}`);
  const cidRoot = root.json.id;
  const reply = await api('POST', `${origin}/api/tickets/${ticketId}/comments/${cidRoot}/reply`,
    { author: 'human', body: 'reply feedback dispatched from its card' });
  assert.equal(reply.status, 201, `reply: ${JSON.stringify(reply.json)}`);
  const cidReply = reply.json.id;

  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const openRail = async (id) => {
    await page.evaluate((tid) => { window.Router.openTicket(tid); }, id);
    await page.locator('.drawer-ticket').waitFor();
    await page.locator('#anno-fab').click();
    await page.locator('#anno-rail.open').waitFor();
  };
  const card = (cid) => page.locator(`.anno-card[data-id="${cid}"]`);
  // textContent, not innerText: the chip wears text-transform: uppercase.
  const chipText = (cid) => page.evaluate((id) =>
    document.querySelector(`.anno-card[data-id="${id}"] .anno-dispatch-chip`)?.textContent ?? null, cid);
  const dispatchBtn = (cid) => card(cid).locator('button.act-dispatch');
  const setTheme = async (theme) => {
    await page.evaluate((t) => { localStorage.setItem('golem.tweaks.theme', t); }, theme);
    await page.goto(`${origin}/dashboard`, { waitUntil: 'networkidle' });
    await openRail(ticketId);
    await card(cidReply).waitFor();
    // The Dispatch action renders once the async dispatchable roster marks
    // the assignee live — the card alone is not enough.
    await dispatchBtn(cidReply).waitFor({ timeout: 15000 });
  };
  const contrastOf = (cid) => page.evaluate((id) => {
    const btn = document.querySelector(`.anno-card[data-id="${id}"] button.act-dispatch`);
    const cardEl = document.querySelector(`.anno-card[data-id="${id}"]`);
    if (!btn || !cardEl) return null;
    // Computed color-mix() arrives as oklab() on modern Chrome; flatten
    // everything to sRGB 0-255 before the ratio.
    const oklabToGamma = (l, a, b) => {
      const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
      const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
      const s_ = l - 0.0894841775 * a - 1.2914855480 * b;
      const l3 = l_ * l_ * l_; const m3 = m_ * m_ * m_; const s3 = s_ * s_ * s_;
      const lin = [
        4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
        -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
        -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3,
      ];
      return lin.map((v) => {
        const clamped = Math.min(1, Math.max(0, v));
        const g = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * (clamped ** (1 / 2.4)) - 0.055;
        return Math.round(g * 255);
      });
    };
    const parse = (s) => {
      const text = String(s).trim();
      let m = text.match(/^rgba?\(([^)]+)\)$/);
      if (m) {
        const p = m[1].split(',').map(Number);
        return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
      }
      m = text.match(/^oklab\(([^)]+)\)$/);
      if (m) {
        const parts = m[1].split('/');
        const lab = parts[0].trim().split(/\s+/).map(Number);
        const alpha = parts.length > 1 ? Number(parts[1]) : 1;
        return [...oklabToGamma(lab[0], lab[1], lab[2]), alpha];
      }
      return null;
    };
    const flat = (fg, bg) => {
      const a = fg[3];
      return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
    };
    const lum = (c) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const cs = getComputedStyle(btn);
    const cardBg = parse(getComputedStyle(cardEl).backgroundColor);
    const text = parse(cs.color);
    const btnBg = parse(cs.backgroundColor);
    if (!text || !btnBg) return null;
    const base = (cardBg && cardBg[3] === 1) ? cardBg.slice(0, 3) : [255, 255, 255];
    const flatBg = btnBg[3] < 1 ? flat(btnBg, base) : btnBg.slice(0, 3);
    const L1 = lum(text.slice(0, 3));
    const L2 = lum(flatBg);
    return {
      ratio: Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100,
      color: cs.color, background: cs.backgroundColor,
    };
  }, cid);

  await page.goto(`${origin}/dashboard`, { waitUntil: 'networkidle' });
  await openRail(ticketId);
  await card(cidReply).waitFor();
  check('reply card starts undispatched with a Dispatch action',
    (await chipText(cidReply)) === 'undispatched' && (await dispatchBtn(cidReply).count()) === 1);

  // ── Contrast: loam + dark, measured on the real pill ─────────────────────
  for (const theme of ['loam', 'dark']) {
    await setTheme(theme);
    const c = await contrastOf(cidReply);
    check(`contrast: Dispatch pill legible in ${theme} (ratio ${c?.ratio})`,
      !!c && c.ratio >= 4.5, JSON.stringify(c));
    await card(cidReply).screenshot({ path: path.join(shots, `gol383-dispatch-${theme}.png`) });
  }
  await setTheme('dark');

  // ── Success: reply dispatch ───────────────────────────────────────────────
  deliveryDelayMs = 800; // hold the pending window open for the checks below
  await page.evaluate((cid) => {
    document.querySelector(`.anno-card[data-id="${cid}"]`).__gol383 = 'reply-card';
  }, cidReply);
  const receivedBefore = received.length;
  await dispatchBtn(cidReply).click();
  // Pending label + disabled while in flight (fast poll — 800ms window).
  let sawPending = false;
  const pendingDeadline = Date.now() + 5_000;
  while (Date.now() < pendingDeadline) {
    try {
      const label = await dispatchBtn(cidReply).innerText();
      if ((await dispatchBtn(cidReply).isDisabled()) && /dispatching/i.test(label)) { sawPending = true; break; }
    } catch { break; } // button unmounted = already succeeded
    await pause(10);
  }
  check('reply Dispatch enters a pending, disabled state while in flight', sawPending);
  // Duplicate clicks while pending deliver exactly once.
  await page.evaluate((cid) => {
    const btn = document.querySelector(`.anno-card[data-id="${cid}"] button.act-dispatch`);
    if (btn) { btn.click(); btn.click(); }
  }, cidReply).catch(() => {});
  await waitFor(async () => {
    try { return (await chipText(cidReply)) === 'dispatched'; } catch { return false; }
  }, 'reply chip flips to dispatched');
  await pause(200);
  check('duplicate clicks while pending deliver exactly once', received.length === receivedBefore + 1,
    `received=${received.length - receivedBefore}`);
  check('reply Dispatch action leaves once dispatched', (await dispatchBtn(cidReply).count()) === 0);
  check('reply card is updated in place, not remounted',
    await page.evaluate((cid) =>
      document.querySelector(`.anno-card[data-id="${cid}"]`)?.__gol383 === 'reply-card', cidReply));
  check('parent chip is not confused with the reply status',
    (await chipText(cidRoot)) === 'undispatched' && (await dispatchBtn(cidRoot).count()) === 1);
  deliveryDelayMs = 0;

  // ── Success: root dispatch from its own card ──────────────────────────────
  await dispatchBtn(cidRoot).click();
  await waitFor(async () => {
    try { return (await chipText(cidRoot)) === 'dispatched'; } catch { return false; }
  }, 'root chip flips to dispatched');
  check('root Dispatch flips only the root card',
    (await dispatchBtn(cidRoot).count()) === 0 && (await chipText(cidReply)) === 'dispatched');

  // ── Refresh preserves the result ──────────────────────────────────────────
  await page.goto(`${origin}/dashboard`, { waitUntil: 'networkidle' });
  await openRail(ticketId);
  await card(cidReply).waitFor();
  check('refresh preserves dispatched reply + root',
    (await chipText(cidReply)) === 'dispatched' && (await chipText(cidRoot)) === 'dispatched');

  // ── Ticket switch resets the rail (no cross-ticket retention) ─────────────
  const created2 = await api('POST', `${origin}/api/tickets`, {
    project_id: projectId, kind: 'spec', title: 'SMOKE-GOL-383 second fixture',
    body_format: 'html', body: '<h2>Other</h2><p>Unrelated ticket.</p>',
    assignee: LIVE_ID, created_by: 'smoke',
  });
  assert.ok([200, 201].includes(created2.status), `second ticket: ${JSON.stringify(created2.json)}`);
  const other = await api('POST', `${origin}/api/tickets/${created2.json.id}/comments`,
    { author: 'human', body: 'other ticket marker comment' });
  assert.equal(other.status, 201, `other comment: ${JSON.stringify(other.json)}`);
  await page.goto(`${origin}/dashboard`, { waitUntil: 'networkidle' });
  await openRail(created2.json.id);
  await card(other.json.id).waitFor();
  const railText = await page.evaluate(() => document.querySelector('#anno-rail')?.textContent ?? '');
  check('ticket switch shows only the new ticket comments',
    railText.includes('other ticket marker comment')
      && !railText.includes('reply feedback dispatched from its card'));
  if (created2.json.id && base()) await archiveTicket(created2.json.id).catch(() => {});

  // ── Failure: rejected dispatch keeps retry + shows the error ──────────────
  const reply2 = await api('POST', `${origin}/api/tickets/${ticketId}/comments/${cidRoot}/reply`,
    { author: 'human', body: 'second reply for the failure path' });
  assert.equal(reply2.status, 201, `second reply: ${JSON.stringify(reply2.json)}`);
  const cidReply2 = reply2.json.id;
  await page.goto(`${origin}/dashboard`, { waitUntil: 'networkidle' });
  await openRail(ticketId);
  await card(cidReply2).waitFor();
  await page.evaluate(() => {
    window.__gol383RealDispatch = window.SubstrateAPI.dispatchComment;
    window.SubstrateAPI.dispatchComment = () => Promise.reject(
      Object.assign(new Error('simulated delivery failure'), { payload: { error: 'simulated delivery failure' } }));
  });
  await dispatchBtn(cidReply2).click();
  await card(cidReply2).locator('.anno-dispatch-error').waitFor({ timeout: 8000 }).catch(() => {});
  const errText = await card(cidReply2).locator('.anno-dispatch-error').innerText().catch(() => '');
  check('failure shows the error at the clicked reply',
    /simulated delivery failure/i.test(errText), errText.slice(0, 120));
  check('failure keeps the chip undispatched (no false success)',
    (await chipText(cidReply2)) === 'undispatched');
  check('failure restores retry on the same card', (await dispatchBtn(cidReply2).count()) === 1);
  // The same retry succeeds once the transport is back.
  await page.evaluate(() => { window.SubstrateAPI.dispatchComment = window.__gol383RealDispatch; });
  await dispatchBtn(cidReply2).click();
  await waitFor(async () => {
    try { return (await chipText(cidReply2)) === 'dispatched'; } catch { return false; }
  }, 'retry after failure dispatches');
  check('retry after failure dispatches the reply',
    (await dispatchBtn(cidReply2).count()) === 0
      && (await card(cidReply2).locator('.anno-dispatch-error').count()) === 0);

  check('no uncaught page errors during the journey', pageErrors.length === 0, JSON.stringify(pageErrors));
  console.log(failures === 0
    ? `GOL-383 reply-dispatch journey passed: pending + single delivery + chip flip, root + refresh, failure + retry, loam/dark contrast; port=${port}`
    : `GOL-383 reply-dispatch journey: ${failures} FAILURE(S); port=${port}; stderr tail: ${stderr.slice(-500)}`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  if (ticketId && base()) await archiveTicket(ticketId).catch(() => {});
  if (chrome) await chrome.cleanup();
  await stop(dashboard);
  await typed.closeTypedWorkerEndpoint(endpoint.server).catch(() => {});
  fs.rmSync(temp, { recursive: true, force: true });
}
