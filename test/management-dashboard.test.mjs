#!/usr/bin/env node
// Actual isolated dashboard smoke + own Chrome rendering the real terminal UI.
import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http'; import { spawn, spawnSync } from 'node:child_process'; import { once } from 'node:events';
import { fileURLToPath } from 'node:url'; import { chromium } from 'playwright-core'; import { transform } from 'esbuild';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-management-dashboard-'));
for (const dir of ['home', 'state', 'config', 'projects', 'ideas', 'chrome']) fs.mkdirSync(path.join(temp, dir), { recursive: true });
const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const env = { ...process.env, HOME: path.join(temp, 'home'), GOLEM_HOME: path.join(temp, 'state'), XDG_CONFIG_HOME: path.join(temp, 'config'), GOLEM_TRACKER_DB: path.join(temp, 'tracker.db'), GOLEM_PROJECTS_ROOT: path.join(temp, 'projects'), GOLEM_IDEAS_ROOT: path.join(temp, 'ideas'), GOLEM_ROOT: repo, HOST: '127.0.0.1', PORT: String(port), GOLEM_CEO_LIVE_MS: '1000' };
for (const key of ['GOLEM_SESSION_ID','CLAUDE_SESSION_ID','PI_SESSION_ID','PI_SESSION_FILE','GOLEM_HERDR_SESSION','HERDR_ENV','HERDR_SESSION','HERDR_PANE_ID','HERDR_SOCKET_PATH']) delete env[key];
let logs = '', chrome, browser, chromeExit;
const dashboard = spawn(process.execPath, [path.join(repo, 'dashboard/server/index.js')], { cwd: repo, env, stdio: ['ignore','pipe','pipe'] });
const dashExit = once(dashboard, 'exit'); dashboard.stdout.on('data', data => logs += data); dashboard.stderr.on('data', data => logs += data);
try {
  let ready = false;
  for (let i = 0; i < 150; i++) { if (dashboard.exitCode != null) throw new Error(logs); try { ready = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch {} if (ready) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(ready, true, logs);
  // PORT explicitly targets this process's worktree server, never shared7420.
  const checked = spawnSync('npm', ['run', 'check:dashboard'], { cwd: repo, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr); process.stdout.write(checked.stdout);
  const roster = await (await fetch(`http://127.0.0.1:${port}/api/sessions/dispatchable`)).json(); assert.ok(Array.isArray(roster));
  let stderr = '';
  chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--user-data-dir=${path.join(temp,'chrome')}`, '--remote-debugging-port=0', '--no-first-run', 'about:blank'], { stdio: ['ignore','ignore','pipe'] });
  chromeExit = once(chrome, 'exit'); chrome.stderr.on('data', data => stderr += data);
  let ws;
  for (let i = 0; i < 100; i++) { ws = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]; if (ws) break; if (chrome.exitCode != null) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(ws, `own Chrome startup failed: ${stderr}`); browser = await chromium.connectOverCDP(ws);
  const page = await browser.newPage(); await page.setContent('<div id="test-root"></div>');
  await page.addScriptTag({ content: fs.readFileSync(path.join(repo,'node_modules/react/umd/react.development.js'),'utf8') });
  await page.addScriptTag({ content: fs.readFileSync(path.join(repo,'node_modules/react-dom/umd/react-dom.development.js'),'utf8') });
  const source = fs.readFileSync(path.join(repo,'dashboard/web/src/native-session-drawer.jsx'),'utf8');
  const compiled = await transform(source + '\nwindow.ManagementTerminal = NsdTerminalView;', { loader: 'jsx', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', format: 'iife' });
  await page.addScriptTag({ content: compiled.code });
  await page.evaluate(() => {
    window.fixture = { ok: false, attach_hint: 'must-not-copy', capabilities: { attach: { state: 'unsupported', reason: 'Outside integrated native runtime' } } };
    window.SubstrateAPI = { sessionTerminal: async () => window.fixture };
    window.copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied.push(text); } } });
    window.root = ReactDOM.createRoot(document.getElementById('test-root'));
    window.root.render(React.createElement(window.ManagementTerminal, { sessionId: 'exact-session-id', session: { name: 'wrong-name' }, alive: false }));
  });
  await page.waitForFunction(() => document.querySelector('.nsd-copy-btn')?.disabled === true && document.body.textContent.includes('Outside integrated native runtime'));
  assert.equal(await page.locator('button').filter({ hasText: 'Attach Cmd' }).isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.copied), []);
  await page.evaluate(() => { window.fixture = { ok: true, text: 'actual terminal', attach_hint: 'golem agent attach exact-session-id', capabilities: { attach: { state: 'available', reason: 'Exact native mapping' } } }; });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.nsd-copy-btn')?.disabled === false);
  await page.getByRole('button', { name: 'Attach Cmd', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.copied), ['golem agent attach exact-session-id']);
  console.log('management dashboard passed: actual isolated worktree check:dashboard/REST arrays; own Chrome unsupported attach disabled/reason visible, available exact-ID copy');
} finally {
  if (browser) await browser.close();
  if (chrome?.exitCode === null) chrome.kill('SIGTERM'); if (chromeExit) await chromeExit;
  if (dashboard.exitCode === null) dashboard.kill('SIGTERM'); await dashExit;
  fs.rmSync(temp, { recursive: true, force: true });
  console.log('management dashboard cleanup passed: owned Chrome/dashboard ended before private state/profile removal');
}
