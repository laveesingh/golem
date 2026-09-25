#!/usr/bin/env node
// GOL-387 browser journey: Share control on isolated dashboard (no real tunnel;
// PATH hides cloudflared so Share surfaces an actionable error, never a public
// deployment) + public reader isolation via a direct grant + loopback server.
// Avoids port 7420 and the shared dashboard throughout.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

  // Share click surfaces an actionable error (no binary, no silent bypass).
  await page.click('[data-testid="share-control"] .td-share-btn');
  await page.waitForSelector('[data-testid="share-control"] .td-share-pop', { timeout: 15000 });
  await page.waitForSelector('[data-testid="share-control"] .ct-error', { timeout: 20000 });
  const errText = await page.textContent('[data-testid="share-control"] .ct-error');
  ok(/cloudflared|tunnel|paused|retire/i.test(errText || ''), `Share error state actionable (${(errText || '').slice(0, 80)})`);

  // Clipboard failure path: stub shareTicket to a fake link, break clipboard,
  // then Copy must show the manual fallback (no silent swallow). Stub AFTER
  // navigation (a goto clears page JS).
  await page.goto(`${base}/read/${encodeURIComponent(spec.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="share-control"] .td-share-btn', { timeout: 15000 });
  await page.evaluate(() => {
    window.__fakeLink = 'https://stub-trycloudflare.test/s/stubtoken123';
    window.SubstrateAPI.shareTicket = async () => ({ url: window.__fakeLink, shared: true });
    window.SubstrateAPI.unshareTicket = async () => ({ revoked: true, shared: false });
  });
  await page.click('[data-testid="share-control"] .td-share-btn');
  await page.waitForSelector('[data-testid="share-control"] .td-share-link', { timeout: 15000 });
  const linkVal = await page.inputValue('[data-testid="share-control"] .td-share-link');
  ok(linkVal === 'https://stub-trycloudflare.test/s/stubtoken123', 'stubbed link renders in popover');
  await page.evaluate(() => {
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } }, configurable: true });
  });
  await page.click('[data-testid="share-control"] .td-share-pop .orch-btn.small');
  await page.waitForSelector('[data-testid="share-control"] .ct-error', { timeout: 10000 });
  const copyErr = await page.textContent('[data-testid="share-control"] .td-share-pop');
  ok(/Copy failed/.test(copyErr || ''), 'clipboard failure shows manual fallback');
  // Stop sharing clears the link (stubbed revoke).
  const buttons = await page.$$(' [data-testid="share-control"] .td-share-pop .orch-btn');
  // Second button in the row is Stop sharing.
  await buttons[buttons.length - 1].click();
  await pause(800);
  ok((await page.$('[data-testid="share-control"] .td-share-link')) === null, 'Stop sharing clears the link');

  // GOL-388 unsafe UI: network-level unsafe status + 409s (no API stubs —
  // page.route rewrites the real responses, so the real component paths run).
  // No bearer link may render even though the grant exists server-side.
  await page.route('**/api/tickets/*/share', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ shared: true, shareable: true, unsafe: true, url: null }) });
    } else {
      route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Sharing is paused while the old dashboard tunnel runs. Retire it, then try again.', code: 'UNSAFE_ADMIN_TUNNEL' }) });
    }
  });
  await page.goto(`${base}/read/${encodeURIComponent(spec.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="share-control"] .td-share-btn', { timeout: 15000 });
  await page.click('[data-testid="share-control"] .td-share-btn');
  await page.waitForSelector('[data-testid="share-control"] .td-share-pop', { timeout: 15000 });
  await pause(800);
  ok((await page.$('[data-testid="share-control"] .td-share-link')) === null, 'unsafe status renders no bearer link');
  const pausedText = await page.textContent('[data-testid="share-control"] .td-share-pop');
  ok(/paused while the old dashboard tunnel runs/i.test(pausedText || ''), 'unsafe pause message shown, not silent');
  const getBtn = await page.$('[data-testid="share-control"] .td-share-pop .orch-btn.small');
  ok(getBtn && await getBtn.isDisabled(), 'URL generation disabled while unsafe');
  await page.unroute('**/api/tickets/*/share');

  // Public reader isolation: direct grant + loopback public server (no tunnel).
  const { openTrackerDb } = await import('../server/tracker-db.js');
  const { createSharePublicServer } = await import('../server/share-public.js');
  const pubDb = path.join(scratch, 'pub.db');
  const pubTracker = openTrackerDb(pubDb);
  const pubSpec = pubTracker.createTicket({ project_id: proj, kind: 'spec', title: 'Public Isolation', body: '# Pub\n\nBody.', state: 'todo' });
  const pubGrant = pubTracker.createShareGrant(pubSpec.id);
  const pubSrv = createSharePublicServer({
    tracker: pubTracker,
    assetsDir: path.join(scratch, 'assets-nope'),
    mermaidBundlePath: path.join(repo, 'dashboard', 'dist', 'share-mermaid.mjs'),
  });
  const pubPort = await pubSrv.listen(0);
  await page.goto(`http://127.0.0.1:${pubPort}/s/${pubGrant.token}`, { waitUntil: 'networkidle' });
  const pubHtml = await page.content();
  ok(pubHtml.includes('Public Isolation'), 'public reader renders title/body');
  ok((await page.$('.td-edit-btn')) === null, 'public reader has no Edit');
  ok((await page.$('[data-testid="share-control"]')) === null, 'public reader has no Share control');
  ok((await page.$('.td-children')) === null, 'public reader has no children panel');
  ok((await page.$('textarea')) === null, 'public reader has no comment composer');
  ok(!pubHtml.includes('/api/snapshot'), 'public reader has no dashboard bundle refs');
  ok(!pubHtml.includes('share-ref'), 'public reader omits display-id ref (title/body only)');

  // GOL-388 fix 5: fenced diagram renders to SVG via the isolated bundle.
  const mmdSpec = pubTracker.createTicket({ project_id: proj, kind: 'spec', title: 'Public Diagram', body: '# Diagram\n\n```mermaid\nflowchart LR\n  A-->B\n```\n', state: 'todo' });
  const mmdGrant = pubTracker.createShareGrant(mmdSpec.id);
  await page.goto(`http://127.0.0.1:${pubPort}/s/${mmdGrant.token}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('div.mermaid svg', { timeout: 20000 });
  ok(true, 'public reader renders diagram SVG (isolated bundle)');
  const mmdHtml = await page.content();
  ok(!mmdHtml.includes('language-mermaid'), 'no raw code fence left for diagrams');
  await pubSrv.close();
  pubTracker.close();
  ok(true, 'public reader isolation verified without a tunnel');
} finally {
  if (chrome) await chrome.cleanup().catch(() => {});
  await stopChild(server);
  rmSync(scratch, { recursive: true, force: true });
}
console.log('\nspec-sharing browser journey passed');
