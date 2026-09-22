// GOL-485 — production appearance journey through the real dashboard server.

import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { projectIdFor } from '../server/project-id.js';
import { acquireChrome } from './_chrome.mjs';

const ok = (condition, message) => { assert.ok(condition, message); console.log(`  ok  ${message}`); };
const packageVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const scratch = mkdtempSync(path.join(tmpdir(), 'golem-485-'));
const home = path.join(scratch, 'home');
const projects = path.join(scratch, 'projects');
const alpha = path.join(projects, 'loam-fixture');
for (const dir of [home, alpha]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(alpha, 'CLAUDE.md'), '# Loam fixture\n');
const projectId = projectIdFor(alpha);
writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: [
  { id: projectId, name: 'Loam fixture', path: alpha, kind: 'auto', color: '#8f6848' },
] }));

// A real process supplies liveness so Agents renders a production card/drawer.
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const now = new Date().toISOString();
writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ sessions: [
  { session_id: 'loam-agent', project_id: projectId, project_path: alpha, pid: worker.pid, hook_ppid: worker.pid, status: 'idle', name: 'Loam Agent', harness: 'pi', model: 'gpt-5.6-fixture', updated_at: now, last_seen_at: now },
] }));

const socket = net.createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const server = spawn(process.execPath, ['dashboard/server/index.js'], {
  env: { ...process.env, PORT: String(port), GOLEM_HOME: home, GOLEM_PROJECTS_ROOT: projects, GOLEM_IDEAS_ROOT: path.join(scratch, 'ideas') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverError = '';
server.stderr.on('data', (chunk) => { serverError += chunk; });

let chrome;
try {
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try { healthy = (await fetch(`${base}/api/health`)).ok; } catch {}
    if (healthy) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  ok(healthy, `isolated dashboard starts on ${base}${serverError ? ` (${serverError.trim()})` : ''}`);

  const projectsResponse = await (await fetch(`${base}/api/projects`)).json();
  const projectUiId = projectsResponse.find((project) => project.project_id === projectId)?.id;
  ok(projectUiId, 'isolated fixture project is discoverable');
  const created = await fetch(`${base}/api/tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, title: 'Theme persistence journey', body: '# Loam & Linen\n\nA production surface.', kind: 'task', created_by: 'browser-fixture' }),
  });
  ok(created.ok, 'tracker fixture is created through the real API');

  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  ok(await page.evaluate(() => !document.documentElement.dataset.theme), 'missing preference keeps the existing dark theme as default');
  ok(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim() === '#0a0b0d'), 'dark production tokens remain intact');
  ok(await page.evaluate(() => {
    const script = document.querySelector('head script');
    const stylesheet = document.querySelector('head link[rel="stylesheet"]');
    return !!(script.compareDocumentPosition(stylesheet) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), 'theme bootstrap executes before stylesheet discovery');
  ok(await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return root.getPropertyValue('--text-2').trim() === '#8a909c'
      && root.getPropertyValue('--text-3').trim() === '#5a606b';
  }), 'dark text-2/text-3 tokens remain byte-for-byte identical to the existing theme');
  ok(await page.locator('.sidebar-footer > .appearance-control > .appearance-trigger').count() === 1
    && await page.locator('.app > .appearance-control').count() === 0,
  'one appearance trigger is owned by the pinned sidebar footer with no App-level floating mount');
  ok(await page.locator('.sidebar-footer-version').textContent() === `v${packageVersion}`,
    `sidebar footer renders root package version v${packageVersion}`);
  const desktopTrigger = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
    const footer = document.querySelector('.sidebar-footer').getBoundingClientRect();
    const trigger = document.querySelector('.appearance-trigger').getBoundingClientRect();
    return {
      position: getComputedStyle(document.querySelector('.appearance-control')).position,
      footerAtBottom: Math.abs(footer.bottom - sidebar.bottom) <= 1,
      triggerInsideFooter: trigger.left >= footer.left && trigger.right <= footer.right
        && trigger.top >= footer.top - 1.1 && trigger.bottom <= footer.bottom,
      footerInsideSidebar: footer.left >= sidebar.left && footer.right <= sidebar.right,
    };
  });
  ok(desktopTrigger.position === 'relative' && desktopTrigger.footerAtBottom
    && desktopTrigger.triggerInsideFooter && desktopTrigger.footerInsideSidebar,
  'desktop appearance trigger is inline in the bottom-left pinned footer, not viewport-floating');
  await page.screenshot({ path: path.join(scratch, 'dark-dashboard.png'), fullPage: true });

  await page.locator('.appearance-trigger').click();
  ok(await page.locator('#appearance-panel[role="dialog"]').count() === 1, 'appearance control exposes one labelled dialog');
  await page.waitForTimeout(200);
  const desktopPanel = await page.evaluate(() => {
    const panel = document.querySelector('#appearance-panel').getBoundingClientRect();
    const footer = document.querySelector('.sidebar-footer').getBoundingClientRect();
    return {
      aboveFooter: panel.bottom <= footer.top,
      insideViewport: panel.left >= 0 && panel.right <= innerWidth && panel.top >= 0,
      panel: { left: panel.left, top: panel.top, right: panel.right, bottom: panel.bottom },
      footer: { left: footer.left, top: footer.top, right: footer.right, bottom: footer.bottom },
    };
  });
  ok(desktopPanel.aboveFooter && desktopPanel.insideViewport,
    `desktop appearance panel opens above the pinned footer without clipping (${JSON.stringify(desktopPanel)})`);
  ok(await page.locator('.theme-choice').count() === 4 && await page.locator('.swatch').count() === 6, 'dialog exposes four themes and the retained six-color palette');
  const darkAppearanceContrast = await page.evaluate(() => {
    const rgb = (value) => {
      const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      if (!channels || channels.length !== 3) throw new Error(`expected rendered rgb color, got ${value}`);
      return channels;
    };
    const lum = (value) => rgb(value).map((channel) => {
      const s = channel / 255;
      return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const ratio = (foreground, background) => {
      const [high, low] = [lum(foreground), lum(background)].sort((a, b) => b - a);
      return (high + .05) / (low + .05);
    };
    const pairs = [
      [document.querySelector('.theme-choice small'), document.querySelector('.theme-choice')],
      [document.querySelector('.tweaks-pop-label'), document.querySelector('.tweaks-pop')],
      [document.querySelector('.tweaks-pop-version'), document.querySelector('.tweaks-pop')],
    ];
    return Math.min(...pairs.map(([text, surface]) => ratio(getComputedStyle(text).color, getComputedStyle(surface).backgroundColor)));
  });
  ok(darkAppearanceContrast >= 4.5, `new dark appearance-panel small text is AA on its actual rendered surfaces (${darkAppearanceContrast.toFixed(2)})`);
  await page.locator('.theme-choice-loam').click();
  ok(await page.evaluate(() => document.documentElement.dataset.theme === 'loam' && localStorage.getItem('golem.tweaks.theme') === 'loam'), 'Loam & Linen applies and persists under its stable theme key');
  await page.getByRole('button', { name: 'Berry' }).click();
  ok(await page.evaluate(() => localStorage.getItem('golem.tweaks.accent') === '#f472b6'), 'accent keeps the legacy hex preference contract');
  ok(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#884f65'), 'saved Berry id maps to its Loam-safe accent');
  await page.locator('.theme-choice-graphite').click();
  ok(await page.evaluate(() => document.documentElement.dataset.theme === 'graphite'
    && localStorage.getItem('golem.tweaks.theme') === 'graphite'
    && getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim() === '#252a2c'
    && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#e1a1b7'),
  'Graphite & Moss applies, persists, and remaps the selected Berry accent');
  await page.locator('.theme-choice-nocturne').click();
  ok(await page.evaluate(() => document.documentElement.dataset.theme === 'nocturne'
    && localStorage.getItem('golem.tweaks.theme') === 'nocturne'
    && getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim() === '#171c22'
    && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#e0a0b8'),
  'Nocturne & Inkstone applies, persists, and remaps the selected Berry accent');
  await page.locator('.theme-choice-dark').click();
  ok(await page.evaluate(() => !document.documentElement.dataset.theme && localStorage.getItem('golem.tweaks.theme') === 'dark' && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#f472b6'), 'switching back to Dark restores the original accent value');
  await page.locator('.theme-choice-loam').click();
  ok(await page.evaluate(() => document.documentElement.dataset.theme === 'loam'), 'theme control completes the Dark ↔ Loam round trip after the new dark themes');

  // Validate contrast with the WCAG G18 sRGB formula against actual theme pairs.
  const contrast = await page.evaluate(() => {
    const rgb = (value) => {
      const match = value.trim().match(/^#([0-9a-f]{6})$/i);
      if (!match) throw new Error(`expected hex color, got ${value}`);
      const number = Number.parseInt(match[1], 16);
      return [number >> 16, (number >> 8) & 255, number & 255];
    };
    const lum = (value) => rgb(value).map((channel) => {
      const s = channel / 255;
      return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const ratio = (a, b) => {
      const [high, low] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (high + .05) / (low + .05);
    };
    const root = getComputedStyle(document.documentElement);
    const bg0 = root.getPropertyValue('--bg-0').trim();
    const bg1 = root.getPropertyValue('--bg-1').trim();
    const sidebar = root.getPropertyValue('--sidebar-bg').trim();
    const text0 = root.getPropertyValue('--text-0').trim();
    const text3 = root.getPropertyValue('--text-3').trim();
    const accents = ['#596b3b', '#3f6680', '#885a1e', '#72517f', '#884f65', '#3d6f6e'];
    return {
      primary: ratio(text0, bg0),
      mutedSidebar: ratio(text3, sidebar),
      minAccentOnRaised: Math.min(...accents.map((accent) => ratio(accent, bg1))),
    };
  });
  ok(contrast.primary >= 4.5 && contrast.mutedSidebar >= 4.5 && contrast.minAccentOnRaised >= 4.5,
    `Loam body/control pairs meet AA (primary ${contrast.primary.toFixed(2)}, muted ${contrast.mutedSidebar.toFixed(2)}, accent ${contrast.minAccentOnRaised.toFixed(2)})`);

  // Escape unmounts every panel control and restores the trigger focus.
  await page.keyboard.press('Escape');
  ok(await page.locator('#appearance-panel').count() === 0, 'Escape unmounts closed appearance controls from keyboard traversal');
  await page.waitForFunction(() => document.activeElement?.classList.contains('appearance-trigger'));
  ok(await page.evaluate(() => document.activeElement?.classList.contains('appearance-trigger')), 'Escape restores focus to the appearance trigger');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  ok(await page.locator('#appearance-panel').count() === 1, 'Cmd/Ctrl+, opens the combined appearance control');
  await page.locator('.page-title').click({ position: { x: 2, y: 2 } });
  ok(await page.locator('#appearance-panel').count() === 0, 'clicking outside dismisses the appearance control');

  // Reload and representative routes retain both preferences.
  await page.reload({ waitUntil: 'networkidle' });
  ok(await page.evaluate(() => document.documentElement.dataset.theme === 'loam'), 'saved Loam theme is present after reload');
  ok(await page.evaluate(() => localStorage.getItem('golem.tweaks.accent') === '#f472b6' && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#884f65'), 'selected accent persists and remaps before representative navigation');
  await page.locator('.appearance-trigger').click();
  await page.getByRole('button', { name: 'Leaf', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.classList.contains('appearance-trigger'));
  const routes = [
    [`/project/${encodeURIComponent(projectUiId)}`, 'Project'],
    ['/agents', 'Agents'],
    ['/tracker', 'Tracker'],
  ];
  for (const [route, label] of routes) {
    await page.goto(base + route, { waitUntil: 'networkidle' });
    ok(await page.evaluate(() => document.documentElement.dataset.theme === 'loam'), `${label} surface retains Loam`);
    await page.screenshot({ path: path.join(scratch, `loam-${label.toLowerCase()}.png`), fullPage: true });
  }

  // A real composer drawer gets visual/keyboard priority over the footer control.
  await page.goto(`${base}/agents`, { waitUntil: 'networkidle' });
  await page.evaluate((id) => window.Router.openComposer(id), projectId);
  await page.waitForSelector('.drawer-compose.open');
  ok(await page.locator('.appearance-control').evaluate((node) => getComputedStyle(node).visibility === 'hidden'), 'open composer drawers suppress the footer appearance control instead of competing with send controls');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.drawer.open'));

  // Mobile keeps the same footer-owned trigger in the horizontal shell bar;
  // the panel opens below the bar instead of occupying either bottom corner.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.appearance-trigger').click();
  await page.waitForTimeout(200);
  const mobile = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
    const footer = document.querySelector('.sidebar-footer').getBoundingClientRect();
    const trigger = document.querySelector('.appearance-trigger').getBoundingClientRect();
    const panel = document.querySelector('#appearance-panel').getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
      footerVisible: getComputedStyle(document.querySelector('.sidebar-footer')).display === 'flex',
      footerInShellBar: footer.top >= sidebar.top && footer.bottom <= sidebar.bottom,
      triggerInsideFooter: trigger.left >= footer.left && trigger.right <= footer.right
        && trigger.top >= footer.top - 1.1 && trigger.bottom <= footer.bottom,
      triggerAwayFromBottomCorners: trigger.bottom < innerHeight / 2,
      triggerInside: trigger.right <= innerWidth && trigger.bottom <= innerHeight,
      panelBelowShell: panel.top >= sidebar.bottom,
      panelInside: panel.left >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight,
      sidebar: { left: sidebar.left, top: sidebar.top, right: sidebar.right, bottom: sidebar.bottom },
      footer: { left: footer.left, top: footer.top, right: footer.right, bottom: footer.bottom },
      trigger: { left: trigger.left, top: trigger.top, right: trigger.right, bottom: trigger.bottom },
      panel: { left: panel.left, top: panel.top, right: panel.right, bottom: panel.bottom },
    };
  });
  ok(mobile.scrollWidth <= mobile.innerWidth && mobile.footerVisible && mobile.footerInShellBar
    && mobile.triggerInsideFooter && mobile.triggerAwayFromBottomCorners && mobile.triggerInside
    && mobile.panelBelowShell && mobile.panelInside,
  `mobile appearance access stays in the shell bar with no overflow, clipping, or bottom-corner collision (${JSON.stringify(mobile)})`);
  await page.screenshot({ path: path.join(scratch, 'loam-mobile-appearance.png'), fullPage: true });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedMotion = await page.locator('.appearance-trigger').evaluate((node) => ({
    transitionDuration: getComputedStyle(node).transitionDuration,
    animationDuration: getComputedStyle(document.querySelector('.sidebar-footer-dot')).animationDuration,
  }));
  ok(parseFloat(reducedMotion.transitionDuration) <= .001 && parseFloat(reducedMotion.animationDuration) <= .001, 'reduced-motion preference collapses appearance and ambient animation durations');

  ok(errors.length === 0, `browser emitted no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
  console.log(JSON.stringify({ ok: true, contrast, mobile, screenshots: scratch }, null, 2));
} finally {
  if (chrome) await chrome.cleanup();
  server.kill('SIGTERM');
  worker.kill('SIGTERM');
}
