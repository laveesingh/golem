import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { projectIdFor } from '../server/project-id.js';
import { acquireChrome } from './_chrome.mjs';

const ok = (condition, message) => {
  if (!condition) throw new Error(message);
  console.log(`  ok  ${message}`);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scratch = mkdtempSync(path.join(tmpdir(), 'golem-495-'));
const artifacts = mkdtempSync(path.join(tmpdir(), 'golem-495-artifacts-'));
const home = path.join(scratch, 'home');
const projects = path.join(scratch, 'projects');
const alpha = path.join(projects, 'alpha');
for (const dir of [home, alpha]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(alpha, 'CLAUDE.md'), '# H1 AgentCard fixture\n');

const alphaId = projectIdFor(alpha);
writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: [
  { id: alphaId, name: 'H1 fixture project', path: alpha, kind: 'auto' },
] }));

const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const now = new Date().toISOString();
const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
const long = 'A deliberately long AgentCard fixture value proving truncation and reflow across narrow passport containers';
const session = (overrides = {}) => ({
  project_id: alphaId,
  project_path: alpha,
  pid: worker.pid,
  hook_ppid: worker.pid,
  boot_time: threeHoursAgo,
  last_seen_at: now,
  harness: 'pi',
  model: 'gpt-5.6-fixture',
  ...overrides,
});
const sessionRows = [
  session({ session_id: 'busy-empty', status: 'busy', name: 'H1 Busy Without Ticket', model: 'deepseek-v4-flash:0731-cloud[1m]' }),
  session({ session_id: 'deepseek-cloud-bare', status: 'idle', name: 'H1 DeepSeek Cloud Bare', model: 'deepseek-v4-flash:0731-cloud' }),
  session({ session_id: 'deepseek-cloud-qualified', status: 'idle', name: 'H1 DeepSeek Cloud Qualified', model: 'ollama/deepseek-v4-flash:0731-cloud[1m]' }),
  session({ session_id: 'ticket-owner', status: 'busy', name: 'H1 Ticket Owner' }),
  session({ session_id: 'waiting-ack', status: 'waiting', name: 'H1 Waiting Acknowledgement' }),
  session({ session_id: 'idle-static', status: 'idle', name: 'H1 Idle Static' }),
  session({ session_id: 'error-static', status: 'error', name: 'H1 Error Static' }),
  session({ session_id: 'initializing-static', status: 'initializing', name: 'H1 Initializing Static' }),
  session({ session_id: 'unknown-static', status: 'not-a-known-state', name: 'H1 Unknown Static', harness: 'mystery-harness', model: 'prototype-unknown-model' }),
  session({ session_id: 'dead-static', status: 'dead', name: 'H1 Dead Static' }),
  session({ session_id: 'offline-queued', status: 'busy', name: 'H1 Offline With Queue' }),
  session({ session_id: 'controls-long', status: 'busy', name: long, model: `${long} model` }),
  ...Array.from({ length: 25 }, (_, index) => session({
    session_id: `dense-busy-${String(index + 1).padStart(2, '0')}`,
    status: 'busy',
    name: `H1 Dense Busy ${String(index + 1).padStart(2, '0')}`,
  })),
];
writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ sessions: sessionRows }));
writeFileSync(path.join(home, 'session-facts.json'), JSON.stringify({ version: 1, facts: [
  {
    canonical_id: 'waiting-ack', harness: 'pi', revision: 1, observed_at: now,
    status: 'waiting', waiting_for: 'await ack', name: 'H1 Waiting Acknowledgement',
    model: 'gpt-5.6-fixture', project_path: alpha, locator: { raw_session_id: 'waiting-ack' },
  },
  {
    canonical_id: 'unknown-static', harness: 'mystery-harness', revision: 1, observed_at: now,
    status: 'not-a-known-state', name: 'H1 Unknown Static', model: 'prototype-unknown-model',
    project_path: alpha, locator: { raw_session_id: 'unknown-static' },
  },
] }));

const channelServer = http.createServer((req, res) => {
  if (new URL(req.url, 'http://127.0.0.1').pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      canonical_id: new URL(req.url, 'http://127.0.0.1').searchParams.get('session_id'),
      owner_token: new URL(req.url, 'http://127.0.0.1').searchParams.get('owner_token'),
      delivery_ready: false,
    }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
});
await new Promise((resolve) => channelServer.listen(0, '127.0.0.1', resolve));
const channelPort = channelServer.address().port;
writeFileSync(path.join(home, 'channels.json'), JSON.stringify({ channels: [
  { session_id: 'busy-empty', pid: worker.pid, host: '127.0.0.1', port: channelPort, harness: 'pi', updated_at: now },
  { session_id: 'controls-long', pid: worker.pid, host: '127.0.0.1', port: channelPort, harness: 'pi', updated_at: now },
] }));

const portSocket = net.createServer();
await new Promise((resolve) => portSocket.listen(0, '127.0.0.1', resolve));
const port = portSocket.address().port;
await new Promise((resolve) => portSocket.close(resolve));
const server = spawn(process.execPath, ['dashboard/server/index.js'], {
  env: {
    ...process.env,
    PORT: String(port),
    GOLEM_HOME: home,
    GOLEM_PROJECTS_ROOT: projects,
    GOLEM_IDEAS_ROOT: path.join(scratch, 'ideas'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  const exited = once(child, 'exit').catch(() => undefined);
  child.kill('SIGTERM');
  await Promise.race([exited, pause(2000)]);
}

let chrome;
try {
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) { healthy = true; break; }
    } catch {}
    await pause(100);
  }
  ok(healthy, 'isolated dashboard health route became ready');
  const json = async (url, options = {}) => {
    const response = await fetch(base + url, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${options.method || 'GET'} ${url}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  const projectsResponse = await json('/api/projects');
  const alphaUiId = projectsResponse.find((project) => project.project_id === alphaId)?.id;
  ok(alphaUiId, 'isolated project is exposed through the production projects route');
  const obsoleteTeamResponse = await fetch(`${base}/api/projects/${encodeURIComponent(alphaId)}/team`);
  ok(obsoleteTeamResponse.status === 404, 'obsolete project Team endpoint is no longer exposed');
  const createTicket = async (title, extra = {}) => json('/api/tickets', {
    method: 'POST',
    body: JSON.stringify({
      project_id: alphaId,
      title,
      body: '# Isolated H1 browser fixture',
      kind: 'task',
      created_by: 'gol-495-browser',
      ...extra,
    }),
  });
  const currentTicket = await createTicket('H1 current ticket', { assignee: 'ticket-owner' });
  await json(`/api/tickets/${encodeURIComponent(currentTicket.id)}`, {
    method: 'PATCH', body: JSON.stringify({ state: 'in_progress', actor: 'gol-495-browser' }),
  });
  const queuedTicket = await createTicket('H1 queued delivery');
  const queueResult = await json(`/api/tickets/${encodeURIComponent(queuedTicket.id)}/dispatch`, {
    method: 'POST', body: JSON.stringify({ session_id: 'offline-queued', mode: 'when_idle', sender_id: 'gol-495-browser' }),
  });
  ok(queueResult.queued === true, 'real tracker dispatch queues an offline busy fixture in isolated storage');

  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${base}/project/${encodeURIComponent(alphaUiId)}`, { waitUntil: 'networkidle' });
  const sessionsSection = page.locator('.pv-section').filter({ hasText: 'Sessions in this project' }).first();
  await sessionsSection.locator('.agent-card.native-session-card').first().waitFor();
  const sectionTitles = await page.locator('.pv-section-title').allTextContents();
  ok(sectionTitles.includes('Sessions in this project') && !sectionTitles.includes('Team'), 'project view exposes one project-scoped session roster and no duplicate Team roster');
  const sessions = sessionsSection.locator('.agent-card.native-session-card');
  const card = (label) => sessions.filter({ has: page.locator('.agent-card-name', { hasText: label }) }).first();
  const busy = card('H1 Busy Without Ticket');
  const ticketOwner = card('H1 Ticket Owner');
  const waiting = card('H1 Waiting Acknowledgement');
  const offline = card('H1 Offline With Queue');
  const unknown = card('H1 Unknown Static');
  const deepseekBare = card('H1 DeepSeek Cloud Bare');
  const deepseekQualified = card('H1 DeepSeek Cloud Qualified');

  const passportGeometry = await sessionsSection.evaluate((section) => {
    const grid = section.querySelector('.native-sessions');
    const cards = [...section.querySelectorAll('.agent-card.native-session-card')];
    const sample = cards[0];
    const portrait = sample?.querySelector('.agent-card-portrait');
    const operations = sample?.querySelector('.agent-card-operations');
    return {
      widths: cards.map((node) => node.getBoundingClientRect().width),
      gridColumns: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length,
      portraitWidth: portrait?.getBoundingClientRect().width ?? 0,
      portraitDivider: getComputedStyle(portrait).borderRightWidth,
      operationsColumns: getComputedStyle(operations).gridTemplateColumns.split(' ').filter(Boolean).length,
      fieldBorders: [...sample.querySelectorAll('.agent-card-field')].map((field) => getComputedStyle(field).borderTopWidth),
    };
  });
  ok(passportGeometry.widths.length > 1 && passportGeometry.widths.every((width) => width > 520.5) && passportGeometry.gridColumns === 2 && passportGeometry.portraitWidth >= 60 && passportGeometry.portraitWidth < 110 && passportGeometry.portraitDivider !== '0px' && passportGeometry.operationsColumns === 1 && passportGeometry.fieldBorders.every((border) => border === '0px'), 'project sessions use freely expanding two-up cards with a compact portrait rail and one-column operations');

  const anatomy = await busy.evaluate((node) => ({
    element: node.tagName,
    surface: node.querySelector('.agent-card-surface')?.tagName,
    fields: [...node.querySelectorAll('.agent-card-operations > .agent-card-field > .agent-card-field-label')].map((label) => label.textContent.trim()),
    noWorkingBadge: !node.querySelector('.agent-status-badge'),
    noPiTruth: !node.querySelector('.agent-card-pi-truth'),
    separateTitleRows: !node.querySelector('.agent-card-title-row'),
    emptyWork: node.querySelector('.agent-card-field-value.is-empty')?.textContent.trim(),
    stableBay: getComputedStyle(node.querySelector('.agent-card-transient-bay')).minBlockSize,
  }));
  ok(anatomy.element === 'ARTICLE' && anatomy.surface === 'BUTTON' && anatomy.fields.join('|') === 'Role|Communication|Current work|Dispatches' && anatomy.noWorkingBadge && anatomy.noPiTruth && anatomy.separateTitleRows && anatomy.emptyWork === 'No current work' && anatomy.stableBay === '0px', 'busy no-ticket card has compact anatomy, field order, empty work, collapsed empty bay, and no metadata row');
  ok((await busy.locator('.agent-card-field').last().innerText()).includes('Queue clear'), 'busy no-ticket card renders the deliberate queue-clear empty state');
  const knownImages = busy.locator('.agent-harness-icon img, .agent-model-icon img');
  ok(await knownImages.count() === 3 && await knownImages.evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0)), 'known harness and provider artwork load across the twin orbs and the model chip');
  ok(await busy.locator('.agent-model-icon.provider-deepseek img').count() === 2 && (await busy.locator('.agent-model-pill').getAttribute('title')) === 'DeepSeek: deepseek-v4-flash:0731-cloud[1m]', 'DeepSeek V4 Flash cloud [1m] resolves to the DeepSeek provider in both orb and chip');
  ok(await deepseekBare.locator('.agent-model-icon.provider-deepseek img').count() === 2 && (await deepseekBare.locator('.agent-model-pill').getAttribute('title')) === 'DeepSeek: deepseek-v4-flash:0731-cloud', 'DeepSeek V4 Flash cloud bare id resolves to the DeepSeek provider');
  ok(await deepseekQualified.locator('.agent-model-icon.provider-deepseek img').count() === 2 && (await deepseekQualified.locator('.agent-model-pill').getAttribute('title')) === 'DeepSeek: ollama/deepseek-v4-flash:0731-cloud[1m]', 'Ollama-qualified DeepSeek V4 Flash cloud [1m] resolves to the DeepSeek provider');
  ok((await busy.locator('.agent-card-time').innerText()).includes('old') && (await busy.locator('.agent-card-time').innerText()).includes('seen'), 'known lifetime and observation freshness share the signed line');
  ok(await unknown.locator('.agent-harness-icon.harness-unknown svg').count() === 1 && await unknown.locator('.agent-model-icon.provider-fallback svg').count() === 2 && await unknown.locator('.agent-harness-icon').getAttribute('aria-label') === 'Harness: mystery-harness', 'explicit unknown harness and provider retain visible generic icon slots (orb + chip) with an accessible raw harness name');

  const ticketLink = ticketOwner.locator('.agent-card-ticket');
  ok(await ticketLink.innerText() === currentTicket.display_id && !(await ticketOwner.innerText()).includes('H1 current ticket'), 'current-work ticket exposes only its identifier, not the title');
  await ticketLink.click();
  await page.waitForFunction((id) => location.search.includes(`ticket=${encodeURIComponent(id)}`), currentTicket.id);
  ok(await page.locator('.drawer-ticket[role="dialog"]:visible').count() === 1 && !page.url().includes('ns='), 'ticket action opens exactly the shared ticket drawer without agent details');
  await page.goBack();
  await page.waitForFunction(() => !document.querySelector('.drawer-ticket[role="dialog"]'));
  ok(await page.evaluate(() => document.activeElement?.classList.contains('agent-card-ticket')), 'Back closes the ticket drawer and restores its ticket opener focus');

  const busySurface = busy.locator('.agent-card-surface');
  for (const activation of ['click', 'Enter', 'Space']) {
    if (activation === 'click') await busySurface.click();
    else { await busySurface.focus(); await page.keyboard.press(activation); }
    await page.waitForFunction((id) => location.search.includes(`ns=${encodeURIComponent(id)}`), 'busy-empty');
    ok(await page.locator('[role="dialog"][aria-label^="Agent details"]:visible').count() === 1 && !page.url().includes('ticket='), `card surface ${activation} opens only the native agent drawer`);
    await page.goBack();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label^="Agent details"]'));
  }

  const role = busy.locator('.agent-card-role-select');
  const roleBox = await role.boundingBox();
  ok(roleBox && roleBox.width > 20, 'role pill exposes a full native-select hit target');
  await role.click({ position: { x: Math.max(1, roleBox.width - 4), y: Math.max(1, roleBox.height / 2) } });
  ok(!page.url().includes('ns=') && await page.locator('[role="dialog"][aria-label^="Agent details"]:visible').count() === 0 && await role.evaluate((node) => document.activeElement === node), 'role pill chevron focuses its native picker without opening agent details');
  await page.keyboard.press('Escape');
  const pointerRoleResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/sessions/busy-empty/role'));
  await role.selectOption('builder');
  ok((await pointerRoleResponse).ok() && !page.url().includes('ns='), 'role pointer mutation reaches the real role endpoint without opening a drawer');
  // The successful pointer mutation broadcasts a native-session update and
  // React replaces the select. Re-resolve the live native control before
  // exercising standard keyboard selection on it.
  const keyboardRole = busy.locator('select');
  await keyboardRole.focus();
  const keyboardRoleResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/sessions/busy-empty/role'));
  await page.keyboard.press('KeyR');
  ok((await keyboardRoleResponse).ok() && JSON.parse(readFileSync(path.join(home, 'sessions.json'), 'utf8')).sessions.some((row) => row.session_id === 'busy-empty' && row.role === 'reviewer'), 'role keyboard mutation also persists through the real endpoint');

  const projectAction = busy.locator('.agent-card-project-action');
  await projectAction.click();
  await page.waitForFunction((id) => location.pathname === `/project/${encodeURIComponent(id)}` && location.search.includes('tab=agents'), alphaUiId);
  ok(!page.url().includes('ns='), 'project glyph pointer action navigates to the project Agents tab without opening agent details');
  await page.goBack();
  await projectAction.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction((id) => location.pathname === `/project/${encodeURIComponent(id)}` && location.search.includes('tab=agents'), alphaUiId);
  ok(!page.url().includes('ns='), 'project glyph keyboard action remains isolated from the card surface');
  await page.goBack();

  const bayGeometry = await page.evaluate(() => {
    const waitingCard = [...document.querySelectorAll('.agent-card')].find((node) => node.textContent.includes('H1 Waiting Acknowledgement'));
    const busyCard = [...document.querySelectorAll('.agent-card')].find((node) => node.textContent.includes('H1 Busy Without Ticket'));
    const waitingOrb = waitingCard.querySelector('.agent-card-orb');
    const busyOrb = busyCard.querySelector('.agent-card-orb');
    return {
      waitingBay: waitingCard.querySelector('.agent-card-transient-bay').getBoundingClientRect().height,
      busyBay: busyCard.querySelector('.agent-card-transient-bay').getBoundingClientRect().height,
      waitingText: waitingCard.querySelector('.agent-card-transient-bay').textContent.trim(),
      waitingAnimation: getComputedStyle(waitingOrb, '::before').animationName,
      busyAnimation: getComputedStyle(busyOrb, '::before').animationName,
    };
  });
  ok(bayGeometry.waitingText === 'await ack' && bayGeometry.waitingBay > 0 && bayGeometry.busyBay === 0 && bayGeometry.waitingAnimation === 'none' && bayGeometry.busyAnimation.includes('agent-card-radiate'), 'waiting await-ack keeps only its populated bay while the empty busy bay collapses and only busy radiates');

  const stateMatrix = await page.evaluate(() => {
    const names = ['H1 Idle Static', 'H1 Error Static', 'H1 Initializing Static', 'H1 Unknown Static', 'H1 Dead Static'];
    return names.map((name) => {
      const node = [...document.querySelectorAll('.agent-card')].find((cardNode) => cardNode.textContent.includes(name));
      return { name, className: node?.className || '', animation: node ? getComputedStyle(node.querySelector('.agent-card-orb'), '::before').animationName : null };
    });
  });
  ok(stateMatrix.length === 5 && stateMatrix.every((state) => state.animation === 'none') && stateMatrix.some((state) => state.className.includes('state-error')) && stateMatrix.some((state) => state.className.includes('state-initializing')) && stateMatrix.some((state) => state.className.includes('state-unknown')) && stateMatrix.some((state) => state.className.includes('state-dead')), 'idle, error, initializing, unknown, and dead states stay distinct and static');
  ok((await offline.innerText()).includes('Channel offline') && (await offline.innerText()).includes('1 queued'), 'offline communication remains independent from busy work state and preserves the accurate queued count');

  const dense = await sessionsSection.evaluate((section) => {
    const cards = [...section.querySelectorAll('.agent-card.state-busy')].filter((node) => node.textContent.includes('H1 Dense Busy'));
    const sample = cards.slice(0, 25).map((node) => {
      const before = getComputedStyle(node.querySelector('.agent-card-orb'), '::before');
      const after = getComputedStyle(node.querySelector('.agent-card-orb'), '::after');
      return { before: before.animationName, after: after.animationName, willChange: before.willChange };
    });
    const keyframes = [...document.styleSheets].flatMap((sheet) => {
      try { return [...sheet.cssRules]; } catch { return []; }
    }).find((rule) => rule.type === CSSRule.KEYFRAMES_RULE && rule.name === 'agent-card-radiate');
    const properties = keyframes ? [...keyframes.cssRules].flatMap((rule) => [...rule.style]).sort() : [];
    return { count: cards.length, sample, properties };
  });
  ok(dense.count === 25 && dense.sample.every((entry) => entry.before.includes('agent-card-radiate') && entry.after.includes('agent-card-radiate') && entry.willChange === 'transform, opacity') && dense.properties.join('|') === 'opacity|opacity|transform|transform', '25 busy cards use only two compositor-oriented transform/opacity radiation rings');
  // Reload through the real project route so the screenshot records the
  // steady H1 state rather than the intentionally transient role-delivery UI.
  await page.reload({ waitUntil: 'networkidle' });
  await sessionsSection.locator('.agent-card.native-session-card').first().waitFor();
  await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });

  for (const [width, expectedColumns] of [[1499, 2], [1500, 3], [1900, 3], [1901, 4]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const columns = await sessionsSection.locator('.native-sessions').evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').filter(Boolean).length);
    ok(columns === expectedColumns, `${width}px viewport uses ${expectedColumns} agent-card columns`);
  }

  for (const width of [520, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const reflow = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.agent-card')];
      const fields = [...document.querySelectorAll('.agent-card-operations')];
      return {
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        cardOverflow: cards.some((cardNode) => cardNode.scrollWidth > cardNode.clientWidth),
        oneColumn: fields.every((field) => getComputedStyle(field).gridTemplateColumns.split(' ').length === 1),
        durableFields: [...document.querySelectorAll('.agent-card-field-label')].filter((label) => ['Role', 'Communication', 'Current work', 'Dispatches'].includes(label.textContent.trim())).length >= 4,
      };
    });
    ok(!reflow.documentOverflow && !reflow.cardOverflow && reflow.oneColumn && reflow.durableFields, `${width}px viewport has no document/card overflow and preserves the compact one-column field reflow`);
  }
  await page.screenshot({ path: path.join(artifacts, 'mobile-320.png'), fullPage: true });

  await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' });
  const controls = page.locator('.agent-card.native-session-card').filter({ has: page.locator('.agent-card-name', { hasText: long }) }).first();
  const modelTextMetrics = await controls.locator('.agent-model-pill span:last-child').evaluate((node) => {
    const style = getComputedStyle(node);
    return { clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, maxWidth: Number.parseFloat(style.maxWidth), overflow: style.overflow, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace };
  });
  ok(modelTextMetrics.maxWidth <= 100 && modelTextMetrics.scrollWidth > modelTextMetrics.clientWidth && modelTextMetrics.overflow === 'hidden' && modelTextMetrics.textOverflow === 'ellipsis' && modelTextMetrics.whiteSpace === 'nowrap', 'long model names keep a 15-character ellipsis budget');
  ok(await controls.locator('.agent-card-controls-footer .cc-session-controls').count() === 1 && await controls.evaluate((node) => node.scrollWidth <= node.clientWidth), 'showControls long-content card retains controls without horizontal overflow');
  await page.goto(`${base}/project/${encodeURIComponent(alphaUiId)}`, { waitUntil: 'networkidle' });
  await sessionsSection.locator('.agent-card.native-session-card').first().waitFor();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const reducedMotion = await busy.evaluate((node) => {
    const before = getComputedStyle(node.querySelector('.agent-card-orb'), '::before');
    return { animation: before.animationName, transform: before.transform, opacity: Number(before.opacity) };
  });
  ok(reducedMotion.animation === 'none' && reducedMotion.transform !== 'none' && reducedMotion.opacity > 0, 'reduced motion disables radiation while retaining the static active cue');
  await page.screenshot({ path: path.join(artifacts, 'reduced-motion.png'), fullPage: true });
  await page.goto(`${base}/agents`, { waitUntil: 'networkidle' });
  const agentsPassport = page.locator('.native-sessions .agent-card.native-session-card').first();
  await agentsPassport.waitFor();
  const agentsGeometry = await agentsPassport.evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    portraitDivider: getComputedStyle(node.querySelector('.agent-card-portrait')).borderRightWidth,
    operationsColumns: getComputedStyle(node.querySelector('.agent-card-operations')).gridTemplateColumns.split(' ').filter(Boolean).length,
  }));
  ok(agentsGeometry.width > 520.5 && agentsGeometry.portraitDivider !== '0px' && agentsGeometry.operationsColumns === 1, 'Agents page shares the freely expanding compact passport card');
  await agentsPassport.screenshot({ path: path.join(artifacts, 'agents-passport.png') });
  await page.screenshot({ path: path.join(artifacts, 'agents.png'), fullPage: true });
  ok(pageErrors.length === 0, `browser emitted no page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`);
  console.log(`GOL-495 H1 browser journey passed; isolated port=${port}; screenshots=${artifacts}`);
} finally {
  if (chrome) await chrome.cleanup();
  await stopChild(server);
  await stopChild(worker);
  await new Promise((resolve) => channelServer.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
}
