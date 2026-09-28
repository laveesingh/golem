#!/usr/bin/env node
// GOL-394 browser journey: read-link Share control on an isolated dashboard
// (no real tunnel; PATH hides cloudflared so a real Share surfaces an
// actionable error, never a public deployment). Covers: spec shows Share,
// task does not; reader shows Share; real Share errors actionably; stubbed
// read-link renders with Copy + exposure/DNS notes; Stop confirms with the
// tunnel message and clears; Stop shows while active even with no URL.
// Avoids port 7420 and the shared dashboard throughout.

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { acquireChrome } from './_chrome.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ok = (cond, msg) => { if (!cond) throw new Error(msg); console.log(`  ok  ${msg}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = mkdtempSync(path.join(tmpdir(), 'spec-share-browser-'));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close((e) => (e ? reject(e) : resolve(p)));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  const exited = once(child, 'exit').catch(() => undefined);
  child.kill('SIGTERM');
  await Promise.race([exited, pause(2000)]);
}

let chrome = null;
let server = null;
try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const home = path.join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(scratch, 'projects'), { recursive: true });
  mkdirSync(path.join(scratch, 'ideas'), { recursive: true });
  server = spawn(process.execPath, ['dashboard/server/index.js'], {
    cwd: repo,
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1',
      GOLEM_HOME: home, GOLEM_TRACKER_DB: path.join(scratch, 'tracker.db'),
      XDG_CONFIG_HOME: path.join(scratch, 'xdg'), HOME: home,
      GOLEM_PROJECTS_ROOT: path.join(scratch, 'projects'),
      GOLEM_IDEAS_ROOT: path.join(scratch, 'ideas'),
      GOLEM_ROOT: repo, LOG_LEVEL: 'error',
      PATH: '/usr/bin:/bin',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let healthy = false;
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) { healthy = true; break; } } catch {}
    if (server.exitCode !== null) break;
    await pause(150);
  }
  ok(healthy, `isolated dashboard ready on ${port} (never 7420)`);
  const json = async (url, options = {}) => {
    const r = await fetch(base + url, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
    const v = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(`${options.method || 'GET'} ${url}: ${r.status}`); e.payload = v; e.status = r.status; throw e; }
    return v;
  };
  const proj = 'share-browser-abcdef';
  const spec = await json('/api/tickets', { method: 'POST', body: JSON.stringify({ project_id: proj, kind: 'spec', title: 'Browser Share Spec', body: '# Share body', state: 'todo' }) });
  const task = await json('/api/tickets', { method: 'POST', body: JSON.stringify({ project_id: proj, kind: 'task', title: 'Browser Task', body: 't', state: 'todo' }) });
  ok(spec.id && task.id, 'seeded spec + task');

  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1440, height: 900 } });

  // Drawer: spec shows Share, task does not.
  await page.goto(`${base}/tracker?ticket=${encodeURIComponent(spec.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.td-title-row', { timeout: 15000 });
  await page.waitForSelector('[data-testid="share-control"] .td-share-btn', { timeout: 15000 });
  ok(true, 'drawer spec shows Share on .td-title-row');
  await page.goto(`${base}/tracker?ticket=${encodeURIComponent(task.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.td-title-row', { timeout: 15000 });
  await pause(800);
  ok((await page.$('[data-testid="share-control"]')) === null, 'drawer task shows no Share');

  // Reader: spec shows Share in the visible title row.
  await page.goto(`${base}/read/${encodeURIComponent(spec.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.td-title-row [data-testid="share-control"] .td-share-btn', { timeout: 15000 });
  ok(true, 'local reader header shows Share');

  // Real Share click surfaces an actionable error (no binary, no silent bypass).
  await page.click('[data-testid="share-control"] .td-share-btn');
  await page.waitForSelector('[data-testid="share-control"] .td-share-pop', { timeout: 15000 });
  await page.waitForSelector('[data-testid="share-control"] .ct-error', { timeout: 20000 });
  const errText = await page.textContent('[data-testid="share-control"] .ct-error');
  ok(/cloudflared|tunnel/i.test(errText || ''), `Share error state actionable (${(errText || '').slice(0, 80)})`);

  // Stubbed read-link: renders with Copy + exposure + DNS-lag notes.
  const fakeLink = `https://stub-host.trycloudflare.com/read/${spec.display_id}`;
  await page.goto(`${base}/read/${encodeURIComponent(spec.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="share-control"] .td-share-btn', { timeout: 15000 });
  await page.evaluate((link) => {
    window.__fakeLink = link;
    window.SubstrateAPI.shareTicket = async () => ({ url: window.__fakeLink, hostname: 'stub-host.trycloudflare.com', display_id: 'stub' });
    window.SubstrateAPI.unshareTicket = async () => ({ stopped: true, already_stopped: false });
  }, fakeLink);
  await page.click('[data-testid="share-control"] .td-share-btn');
  await page.waitForSelector('[data-testid="share-control"] .td-share-link', { timeout: 15000 });
  const linkVal = await page.inputValue('[data-testid="share-control"] .td-share-link');
  ok(linkVal === fakeLink, 'stubbed read-link renders in popover');
  const popText = await page.textContent('[data-testid="share-control"] .td-share-pop');
  ok(/Anyone with this link can open and edit the whole dashboard while sharing is on/.test(popText || ''), 'exposure warning shown');
  ok(/up to a minute to resolve/.test(popText || ''), 'DNS-lag note shown');

  // Copy success path.
  await page.evaluate(() => {
    window.__copied = null;
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied = t; } }, configurable: true });
  });
  await page.click('[data-testid="share-control"] .td-share-pop .orch-btn.small');
  await page.waitForSelector('[data-testid="share-control"] .td-share-copied', { timeout: 10000 });
  ok((await page.evaluate(() => window.__copied)) === fakeLink, 'Copy writes the read-link to the clipboard');

  // Clipboard failure path: manual fallback, no silent swallow.
  await page.evaluate(() => {
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } }, configurable: true });
  });
  const copyBtns = await page.$$('[data-testid="share-control"] .td-share-pop .orch-btn.small');
  await copyBtns[0].click();
  await page.waitForSelector('[data-testid="share-control"] .td-share-pop .ct-error', { timeout: 10000 });
  const copyErr = await page.textContent('[data-testid="share-control"] .td-share-pop');
  ok(/Copy failed/.test(copyErr || ''), 'clipboard failure shows manual fallback');

  // Stop sharing confirms with the tunnel message, then clears the link.
  let dialogMessage = null;
  page.on('dialog', async (d) => { dialogMessage = d.message(); await d.accept(); });
  const rowBtns = await page.$$('[data-testid="share-control"] .td-share-pop .orch-btn');
  await rowBtns[rowBtns.length - 1].click();
  await pause(1000);
  ok(dialogMessage === 'Stops the tunnel. Every shared link stops working.', `stop confirms the tunnel message (got: ${(dialogMessage || '').slice(0, 60)})`);
  ok((await page.$('[data-testid="share-control"] .td-share-link')) === null, 'Stop sharing clears the link');

  // Active-but-no-URL still offers Stop (R7): stub only the GET status.
  await page.route('**/api/tickets/*/share', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ shareable: true, active: true, url: null, uncertain: false }) });
    } else {
      route.continue();
    }
  });
  await page.goto(`${base}/read/${encodeURIComponent(spec.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="share-control"] .td-share-btn', { timeout: 15000 });
  const activeLabel = await page.textContent('[data-testid="share-control"] .td-share-btn');
  ok(/Shared/.test(activeLabel || ''), 'active tunnel labels the button Shared');
  await page.click('[data-testid="share-control"] .td-share-btn');
  await page.waitForSelector('[data-testid="share-control"] .td-share-pop', { timeout: 15000 });
  await pause(800);
  ok((await page.$('[data-testid="share-control"] .td-share-link')) === null, 'no link renders when url is null');
  const stopBtn = await page.$('[data-testid="share-control"] .td-share-pop .orch-btn');
  const stopLabel = stopBtn ? await stopBtn.textContent() : '';
  ok(/Stop sharing/.test(stopLabel || ''), 'Stop offered while active even with no URL');
  await page.unroute('**/api/tickets/*/share');

  ok(true, 'read-link share journey verified without a tunnel');
} finally {
  if (chrome) await chrome.cleanup().catch(() => {});
  await stopChild(server);
  rmSync(scratch, { recursive: true, force: true });
}
console.log('\nspec-sharing browser journey passed');
