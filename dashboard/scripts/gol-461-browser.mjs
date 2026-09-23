import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { projectIdFor } from '../server/project-id.js';
import { acquireChrome } from './_chrome.mjs';

const ok = (condition, message) => { if (!condition) throw new Error(message); console.log(`  ok  ${message}`); };
const scratch = mkdtempSync(path.join(tmpdir(), 'golem-461-'));
const home = path.join(scratch, 'home');
const projects = path.join(scratch, 'projects');
const alpha = path.join(projects, 'alpha');
const beta = path.join(projects, 'beta');
for (const dir of [home, alpha, beta]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(alpha, 'CLAUDE.md'), '# Alpha fixture\n');
writeFileSync(path.join(beta, 'CLAUDE.md'), '# Beta fixture\n');
utimesSync(beta, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
const alphaId = projectIdFor(alpha);
const betaId = projectIdFor(beta);
writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: [
  { id: alphaId, name: 'Alpha fixture', path: alpha, kind: 'auto' },
  { id: betaId, name: 'Beta fixture', path: beta, kind: 'auto' },
] }));

// A real child process supplies honest liveness; the stale row deliberately has
// no process/channel evidence and must never become dispatchable.
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const now = new Date().toISOString();
const waitingRecent = new Date(Date.now() - 15_000).toISOString();
const idleOlder = new Date(Date.now() - 60_000).toISOString();
const idleNewer = new Date(Date.now() - 30_000).toISOString();
const legacyRecent = new Date(Date.now() - 45_000).toISOString();
const sessionRows = [
  { session_id: 'idle-fixture-session', project_id: alphaId, project_path: alpha, pid: worker.pid, hook_ppid: worker.pid, status: 'busy', name: 'Fixture Builder', harness: 'pi', model: 'gpt-5.6-fixture', updated_at: now, last_seen_at: now },
  { session_id: 'waiting-fixture-session', project_id: alphaId, project_path: alpha, pid: worker.pid, hook_ppid: worker.pid, status: 'waiting', name: 'Waiting Reviewer', harness: 'pi', model: 'gpt-5.6-fixture', updated_at: waitingRecent, last_seen_at: waitingRecent },
  { session_id: 'idle-older-session', project_id: alphaId, project_path: alpha, pid: worker.pid, hook_ppid: worker.pid, status: 'idle', name: 'Idle Older', harness: 'pi', model: 'claude-fixture', updated_at: idleOlder, last_seen_at: idleOlder },
  { session_id: 'idle-newer-session', project_id: alphaId, project_path: alpha, pid: worker.pid, hook_ppid: worker.pid, status: 'idle', name: 'Idle Newer', harness: 'pi', model: 'gpt-5.6-fixture', updated_at: idleNewer, last_seen_at: idleNewer },
  { session_id: 'legacy-fixture-session', project_id: alphaId, project_path: alpha, pid: worker.pid, hook_ppid: worker.pid, status: 'legacy', name: 'Legacy Status', harness: 'pi', model: 'claude-fixture', updated_at: legacyRecent, last_seen_at: legacyRecent },
  { session_id: 'cross-project-session', project_id: betaId, project_path: beta, pid: worker.pid, hook_ppid: worker.pid, status: 'busy', name: 'Beta Builder', harness: 'pi', model: 'gpt-5.6-fixture', updated_at: now, last_seen_at: now },
  { session_id: 'stale-fixture-session', project_id: alphaId, project_path: alpha, pid: 2147483647, hook_ppid: 2147483647, status: 'idle', name: 'Stale Ghost', harness: 'claudecode', updated_at: '2020-01-01T00:00:00.000Z' },
] ;
writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ sessions: sessionRows }));
const delivered = [];
let busyHold = true; // the fixture worker starts busy; flipping to idle flips readiness
const channelServer = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, 'http://127.0.0.1');
  if (requestUrl.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      canonical_id: requestUrl.searchParams.get('session_id'),
      owner_token: requestUrl.searchParams.get('owner_token'),
      protocol_version: 1,
      kind: 'typed-worker',
      delivery_ready: !busyHold,
    }));
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    delivered.push({ url: req.url, body });
    if (req.url === '/brief') {
      try {
        const posted = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          accepted: true, envelope_id: posted.envelope_id, attempt_id: 'browser-fixture-attempt',
          accepted_attempt_id: 'browser-fixture-attempt', delivery_state: 'settled',
        }));
        return;
      } catch { /* fall through to the generic ack */ }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
await new Promise((resolve) => channelServer.listen(0, '127.0.0.1', resolve));
const channelPort = channelServer.address().port;
writeFileSync(path.join(home, 'channels.json'), JSON.stringify({ channels: [
  { session_id: 'healthy-working-session', pid: worker.pid, host: '127.0.0.1', port: channelPort, harness: 'pi', kind: 'typed-worker', delivery_ready: true, updated_at: now },
  { session_id: 'idle-fixture-session', pid: worker.pid, host: '127.0.0.1', port: channelPort, harness: 'pi', consumer_ready: true, delivery_ready: true, updated_at: now },
  { session_id: 'waiting-fixture-session', pid: worker.pid, host: '127.0.0.1', port: channelPort, harness: 'pi', updated_at: waitingRecent },
  { session_id: 'idle-older-session', pid: worker.pid, host: '127.0.0.1', port: channelPort, harness: 'pi', updated_at: idleOlder },
  { session_id: 'idle-newer-session', pid: worker.pid, host: '127.0.0.1', port: channelPort, harness: 'pi', updated_at: idleNewer },
  { session_id: 'cross-project-session', pid: worker.pid, host: '127.0.0.1', port: channelPort, harness: 'pi', updated_at: now },
] }));
writeFileSync(path.join(home, 'session-facts.json'), JSON.stringify({ version: 1, facts: [{
  canonical_id: 'healthy-working-session', harness: 'pi', revision: 1,
  observed_at: now, status: 'busy', name: 'Healthy Working Pi', model: 'gpt-5.6-fixture',
  project_path: alpha, locator: { raw_session_id: 'healthy-working-session' },
}] }));
writeFileSync(path.join(home, 'endpoint-leases.json'), JSON.stringify({ version: 1, leases: [{
  canonical_id: 'healthy-working-session', owner_token: 'browser-fixture-owner',
  host: '127.0.0.1', port: channelPort, harness: 'pi', kind: 'typed-worker',
  renewed_at: now, expires_at: new Date(Date.now() + 60_000).toISOString(),
}] }));

const socket = net.createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const server = spawn(process.execPath, ['dashboard/server/index.js'], {
  env: { ...process.env, PORT: String(port), GOLEM_HOME: home, GOLEM_PROJECTS_ROOT: projects, GOLEM_IDEAS_ROOT: path.join(scratch, 'ideas') },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let chrome;
try {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const json = async (url, options = {}) => {
    const response = await fetch(base + url, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${options.method || 'GET'} ${url}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  const projectRows = await json('/api/projects');
  const alphaUiId = projectRows.find((p) => p.project_id === alphaId)?.id;
  const betaUiId = projectRows.find((p) => p.project_id === betaId)?.id;
  ok(alphaUiId && betaUiId, 'isolated projects are discovered with canonical contract ids');
  const create = async (title, body) => {
    const result = await json('/api/tickets', { method: 'POST', body: JSON.stringify({ project_id: alphaId, title, body, kind: 'task', created_by: 'browser-fixture' }) });
    return result.ticket || result;
  };
  const hostile = await create('Hostile markdown fixture', '# Safe heading\n\n<img src=x onerror="window.__xss=1">\n<script>window.__xss=2</script>\n\n```mermaid\ngraph TD; A-->B\n```');
  const stateTicket = await create('State control fixture', '# State control');
  const anchored = await create('Anchored comment fixture', '# Original\n\nAnchor sentence remains.');
  const dispatchable = await json(`/api/sessions/dispatchable?project=${encodeURIComponent(alphaId)}`);
  ok(!dispatchable.some((s) => s.session_id === 'stale-fixture-session'), 'stale session is not dispatchable');
  ok(dispatchable.some((s) => s.session_id === 'idle-fixture-session'), 'live fixture session exposes canonical agent facts');
  const healthyWorking = dispatchable.find((s) => s.session_id === 'healthy-working-session');
  ok(healthyWorking?.channel_present === true && healthyWorking?.endpoint_health === 'healthy' && healthyWorking?.delivery_ready === false && healthyWorking?.delivery_reason === 'busy' && healthyWorking?.reachable === false, 'healthy working typed Pi remains dispatchable with distinct channel and delivery facts');
  const missingChannel = dispatchable.find((s) => s.session_id === 'legacy-fixture-session');
  ok(missingChannel?.channel_present === false && missingChannel?.delivery_reason === 'missing_channel' && missingChannel?.reachable === false, 'genuine missing-channel fixture retains unreachable compatibility facts');
  const queued = await json(`/api/tickets/${hostile.id}/dispatch`, { method: 'POST', body: JSON.stringify({ session_id: 'idle-fixture-session', mode: 'when_idle' }) });
  ok(queued.queued === true || queued.pending === true || queued.mode === 'when_idle', 'busy-session dispatch is durably queued for idle delivery');

  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/project/${encodeURIComponent(alphaUiId)}?ticket=${encodeURIComponent(stateTicket.id)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  if (errors.length) console.log('page errors', errors);
  await page.waitForSelector('[role="dialog"]');
  ok(await page.locator('.drawer-ticket[role="dialog"][aria-modal="true"]:visible').count() === 1, 'shared accessible drawer renders as a modal dialog');
  ok(await page.locator('.app > .main[inert][aria-hidden="true"]').count() === 1, 'open drawer makes background inert');
  const dispatchPicker = page.locator('.td-prop-dispatch').filter({ has: page.locator('.td-prop-label', { hasText: 'Dispatch to' }) }).locator('.ps-trigger');
  await dispatchPicker.click();
  const healthyWorkingOption = page.locator('.ps-option').filter({ hasText: 'Healthy Working Pi' });
  ok((await healthyWorkingOption.innerText()).includes('working · will queue'), 'dispatch picker labels a healthy busy target as working and queueable');
  await healthyWorkingOption.click();
  await page.waitForFunction(() => [...document.querySelectorAll('.td-dispatch-mode-btn.active')].some((button) => button.textContent === 'When idle'));
  ok(await page.locator('.td-dispatch-mode-btn.active').filter({ hasText: 'When idle' }).count() >= 1, 'healthy busy target defaults dispatch to when idle');
  await dispatchPicker.click();
  const missingChannelOption = page.locator('.ps-option').filter({ hasText: 'Legacy Status' });
  ok((await missingChannelOption.innerText()).includes('unreachable · will queue'), 'dispatch picker keeps genuine missing-channel target unreachable');
  await page.keyboard.press('Escape');
  const stateControl = page.locator('.td-prop').filter({ has: page.locator('.td-prop-label', { hasText: 'State' }) }).locator('.ps-trigger');
  await stateControl.click();
  await page.locator('.ps-option').filter({ hasText: 'in_progress' }).click();
  await page.waitForFunction(async (id) => (await (await fetch(`/api/tickets/${id}`)).json()).state === 'in_progress', stateTicket.id);
  ok(true, 'lifecycle update is driven through the exposed ticket state control');
  await page.goto(`${base}/project/${encodeURIComponent(alphaUiId)}?ticket=${encodeURIComponent(hostile.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.drawer-ticket[role="dialog"]');
  ok(await page.locator('script').evaluateAll((nodes) => nodes.every((n) => !/window\.__xss/.test(n.textContent || ''))), 'hostile script is absent from rendered body');
  ok(await page.locator('[onerror]').count() === 0 && await page.evaluate(() => !window.__xss), 'hostile HTML handlers are removed');
  const mermaidRendered = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.innerHTML = window.SubstrateFmt.renderMarkdown('```mermaid\ngraph TD; A-->B\n```');
    document.body.appendChild(host);
    await window.runMermaid(host.querySelectorAll('.mermaid'));
    return host.querySelectorAll('.mermaid svg').length;
  });
  ok(mermaidRendered === 1, 'Mermaid renders sanitized Markdown from the local production bundle');
  const failClosed = await page.evaluate(() => {
    const purifier = window.DOMPurify;
    window.DOMPurify = null;
    const rendered = window.SubstrateFmt.renderMarkdown('<img src=x onerror=alert(1)>');
    window.DOMPurify = purifier;
    return rendered;
  });
  ok(failClosed.includes('&lt;img') && !failClosed.includes('<img'), 'Markdown/legacy HTML fails closed without DOMPurify');
  // Escape closes/unmounts descendants and focus returns to the opener target.
  await page.keyboard.press('Shift+Tab');
  ok(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') != null), 'Shift+Tab remains trapped in the drawer');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  ok(await page.locator('.app > .main[inert]').count() === 0, 'closed drawer unmounts descendants and restores background interactivity');

  // Create an anchored comment and update the body using the exposed UI.
  // GOL-311 D4: single-step — click the block containing the anchor sentence;
  // there is no selection pill anymore.
  await page.goto(`${base}/project/${encodeURIComponent(alphaUiId)}?ticket=${encodeURIComponent(anchored.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.td-md');
  const anchorBlockText = await page.evaluate(() => {
    const root = document.querySelector('.td-md');
    const block = [...root.querySelectorAll('[data-block-id]')].find((el) => el.textContent.includes('Anchor sentence remains.'));
    if (!block) return null;
    block.scrollIntoView({ block: 'center' });
    const r = block.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: block.innerText.trim().replace(/\s+/g, ' ') };
  });
  ok(anchorBlockText != null, 'anchor block rendered');
  await page.mouse.click(anchorBlockText.x, anchorBlockText.y);
  await page.locator('textarea[placeholder^="Comment —"]').fill('Anchored note');
  await page.locator('button.send', { hasText: 'Comment' }).click();
  await page.getByTitle('Edit body').click();
  await page.locator('.td-edit-body').fill('# Updated\n\nPrelude added.\n\nAnchor sentence remains.');
  await page.locator('.td-edit-actions button', { hasText: 'Save' }).click();
  await page.waitForFunction(async (id) => {
    const ticket = await (await fetch(`/api/tickets/${id}`)).json();
    return ticket.body.startsWith('# Updated') && ticket.comments.some((c) => c.body === 'Anchored note' && !!c.block_id);
  }, anchored.id);
  ok(true, 'block-anchored comment survives a body update through UI controls');
  await page.goto(`${base}/project/${encodeURIComponent(betaUiId)}`, { waitUntil: 'networkidle' });
  ok(page.url().includes(encodeURIComponent(betaUiId)) && await page.getByText('Beta fixture', { exact: true }).count() > 0, 'project deep link restores selection');
  await page.evaluate((id) => localStorage.setItem('golem.sidebar.pinnedProjects', JSON.stringify([id])), betaUiId);
  await page.reload({ waitUntil: 'networkidle' });
  ok((await page.locator('.sidebar-bucket.bucket-pinned .sidebar-freshness').innerText()).toLowerCase().includes('archived'), 'pinned archived project shows explicit freshness');
  await page.locator(`.sidebar-project-row a[href^="/project/${alphaUiId}"]`).click();
  await page.waitForFunction((id) => location.pathname.includes(id), alphaUiId);
  ok(true, 'sidebar project switch updates the route');
  const projectSessions = page.locator('.pv-section').filter({ hasText: 'Sessions in this project' }).locator('.native-session-card');
  const projectSessionNames = await projectSessions.locator('.agent-card-name').allTextContents();
  ok(await page.locator('.project-hero-meta').getByText('6 live sessions', { exact: true }).count() === 1 && projectSessionNames.length === 6, 'project hero count matches six alive project-session cards');
  ok(projectSessionNames.join('|') === 'Fixture Builder|Healthy Working Pi|Waiting Reviewer|Idle Newer|Legacy Status|Idle Older', 'project sessions include healthy busy, missing-channel, waiting, idle, and legacy rows in last-seen order');
  const busyCard = projectSessions.filter({ hasText: 'Fixture Builder' });
  const waitingCard = projectSessions.filter({ hasText: 'Waiting Reviewer' });
  ok(await busyCard.locator('.agent-status-badge').count() === 0 && await busyCard.locator('.agent-card-orb').count() === 1 && await busyCard.locator('.agent-card-harness-mark .agent-harness-icon').count() === 1, 'busy project card uses the H1 model orb plus a raw harness mark instead of an obsolete Working badge');
  ok(await waitingCard.locator('.agent-status-badge').count() === 0 && await waitingCard.locator('.agent-card-orb').count() === 1 && await waitingCard.locator('.agent-card-harness-mark .agent-harness-icon').count() === 1, 'waiting project card also keeps lifecycle state in its model orb and raw harness mark');
  ok(await projectSessions.filter({ hasText: 'Healthy Working Pi' }).locator('.native-session-nochannel').count() === 0, 'healthy working card never renders a no-channel warning');
  ok((await projectSessions.filter({ hasText: 'Legacy Status' }).locator('.agent-card-communication').innerText()).includes('Channel offline'), 'genuine missing-channel card retains visible offline communication');
  ok(!projectSessionNames.includes('Stale Ghost') && !projectSessionNames.includes('Beta Builder'), 'project sessions exclude dead and cross-project rows');
  const selectorNames = await page.evaluate((projectId) => {
    const state = window.Store.getState();
    state.nativeSessions.push(
      { session_id: 'selector-dead-session', project_id: projectId, alive: false, status: 'idle', name: 'Selector Dead', last_seen_at: new Date(Date.now() + 60_000).toISOString() },
      { session_id: 'fallback-older-session', project_id: projectId, alive: true, status: 'idle', name: 'Fallback Older', last_seen_at: 'invalid', fact_observed_at: 'invalid', updated_at: Date.now() + 90_000 },
      { session_id: 'fallback-newer-session', project_id: projectId, alive: true, status: 'idle', name: 'Fallback Newer', last_seen_at: 'invalid', fact_observed_at: 'invalid', updated_at: Date.now() + 120_000 },
    );
    const names = window.Store.getProjectSessions(window.Store.getProjectByContractId(projectId)).map((session) => session.name);
    state.nativeSessions = state.nativeSessions.filter((session) => !session.session_id.startsWith('selector-') && !session.session_id.startsWith('fallback-'));
    return names;
  }, alphaId);
  ok(!selectorNames.includes('Selector Dead'), 'project session selector rejects an explicit alive false row');
  ok(selectorNames.indexOf('Fallback Newer') < selectorNames.indexOf('Fallback Older'), 'project session ordering falls back past invalid last-seen values');
  const projectIconImages = projectSessions.locator('.agent-harness-icon img, .agent-model-icon img');
  const projectHarnessImages = projectSessions.locator('.agent-harness-icon img');
  const projectModelImages = projectSessions.locator('.agent-model-icon img');
  ok(await projectHarnessImages.count() === 6 && await projectModelImages.count() === 12 && await projectIconImages.evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0 && (image.src.startsWith('data:image/svg+xml') || new URL(image.src).origin === location.origin))), 'six project cards render bundled harness (one) and model (orb + chip) SVG icons');
  const harnessIcons = projectSessions.locator('.agent-harness-icon[role="img"]');
  ok(await harnessIcons.count() === 6 && await harnessIcons.evaluateAll((icons) => icons.every((icon) => icon.getAttribute('aria-label')?.startsWith('Harness: ') && !icon.querySelector(':scope > span'))), 'six harness SVG icons retain accessible names without text-initial fallbacks');
  await page.goto(`${base}/agents`, { waitUntil: 'networkidle' });
  const agentCard = page.locator('.native-session-card').filter({ hasText: 'Healthy Working Pi' });
  const agentSurface = agentCard.locator('.agent-card-surface');
  await agentSurface.focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role="dialog"]');
  // The H1 drawer tabs: metadata rows live on the Activity & Events tab.
  await page.locator('.nsd-tab-btn', { hasText: 'Activity & Events' }).click();
  await page.waitForSelector('.nsd-meta-row, [role="dialog"] .drawer-body');
  const agentText = await page.locator('[role="dialog"]').innerText();
  for (const fact of ['session_id', 'harness', 'last seen', 'endpoint', 'delivery', 'Healthy Working Pi']) {
    ok(agentText.toLowerCase().includes(fact.toLowerCase()), `agent detail shows canonical ${fact} fact`);
  }
  ok(agentText.toLowerCase().includes('healthy') && !agentText.toLowerCase().includes('no channel'), 'healthy working drawer shows a healthy endpoint without a missing-channel badge');
  await page.evaluate((id) => window.Router.openTicket(id), hostile.id);
  await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 2);
  ok(await page.locator('.app > .main[inert]').count() === 1, 'nested drawers keep the background inert');
  const lowerDrawer = page.locator('[role="dialog"][aria-label^="Agent details"]');
  ok(await lowerDrawer.getAttribute('inert') !== null && await lowerDrawer.getAttribute('aria-hidden') === 'true' && await lowerDrawer.getAttribute('aria-modal') === null, 'non-top drawer is inert, aria-hidden, and not aria-modal');
  const lowerClose = lowerDrawer.locator('.drawer-close');
  const pointerBlocked = await lowerClose.click({ timeout: 500 }).then(() => false, () => true);
  ok(pointerBlocked, 'non-top drawer rejects pointer interaction');
  ok(await page.evaluate(() => { const button = document.querySelector('[aria-label^="Agent details"] .drawer-close'); button.focus(); return document.activeElement !== button; }), 'non-top drawer rejects keyboard focus');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 1);
  ok((await page.locator('[role="dialog"]').getAttribute('aria-label')).startsWith('Agent details'), 'one Escape closes only the top drawer');
  ok(await page.locator('.app > .main[inert]').count() === 1, 'lower drawer remains modal and background stays inert');
  ok(await lowerDrawer.getAttribute('inert') === null && await lowerDrawer.getAttribute('aria-hidden') === 'false' && await lowerDrawer.getAttribute('aria-modal') === 'true', 'promoted lower drawer restores pointer, keyboard, and modal ARIA state');
  await lowerClose.focus();
  ok(await page.evaluate(() => document.activeElement?.classList.contains('drawer-close')), 'promoted lower drawer accepts keyboard focus');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  ok(await page.locator('.app > .main[inert]').count() === 0, 'second Escape releases background inertness');
  ok(await page.evaluate(() => document.activeElement?.classList.contains('agent-card-surface')), 'nested stack restores the original opener after the lower closes');

  // Move the seeded session from busy to idle and require the drainer to POST
  // the queued envelope to its isolated fake channel, then remove the queue row.
  sessionRows[0] = { ...sessionRows[0], status: 'idle', updated_at: new Date().toISOString(), last_seen_at: new Date().toISOString() };
  busyHold = false;
  writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ sessions: sessionRows }));
  for (let i = 0; i < 60 && !delivered.some((entry) => entry.url === '/brief'); i++) await new Promise((resolve) => setTimeout(resolve, 250));
  ok(delivered.some((entry) => entry.url === '/brief'), 'queued envelope is delivered when the agent becomes idle');
  const remainingQueue = await json(`/api/dispatch-queue?session=idle-fixture-session`);
  ok(remainingQueue.length === 0, 'delivered idle envelope is consumed from the durable queue');

  const distFiles = [];
  const walk = (dir) => { for (const name of readdirSync(dir)) { const file = path.join(dir, name); statSync(file).isDirectory() ? walk(file) : distFiles.push(file); } };
  walk(path.resolve('dashboard/dist'));
  // Namespace/specification URLs embedded by React/Mermaid are inert. Reject
  // hosted module/CDN/Babel sources across every emitted file.
  const forbidden = /https?:\/\/(?:unpkg\.com|esm\.sh)|@babel\/standalone|babel\.min\.js/ig;
  const hits = distFiles.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(forbidden)].map((m) => `${path.basename(file)}:${m[0]}`));
  ok(hits.length === 0, `all ${distFiles.length} dist assets are free of runtime CDN/Babel references${hits.length ? ` (${hits.slice(0, 3).join(', ')})` : ''}`);
  ok(errors.length === 0, `browser emitted no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
  const screenshot = path.join(scratch, 'agent-facts.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(`GOL-461 seeded browser journeys passed; isolated port=${port}; screenshot=${screenshot}`);
} finally {
  if (chrome) await chrome.cleanup();
  server.kill('SIGTERM');
  worker.kill('SIGTERM');
  channelServer.close();
  if (server.exitCode != null && server.exitCode !== 0) rmSync(scratch, { recursive: true, force: true });
}
