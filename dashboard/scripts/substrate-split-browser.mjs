#!/usr/bin/env node
// GOL-291: full-screen substrate Split editor browser journey. The journey only
// edits an in-memory textarea draft; it never calls Save or writes substrate files.

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { acquireChrome } from './_chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(ROOT, 'dashboard', 'server', 'index.js');
const HOST = '127.0.0.1';
const scratch = mkdtempSync(path.join(tmpdir(), 'golem-substrate-split-'));
const home = path.join(scratch, 'home');
const projects = path.join(scratch, 'projects');
mkdirSync(home, { recursive: true });
mkdirSync(projects, { recursive: true });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, HOST, () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const ok = (condition, message) => {
  if (!condition) throw new Error(message);
  console.log(`  ok  ${message}`);
};

const port = await freePort();
const base = `http://${HOST}:${port}`;
const child = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    HOST,
    PORT: String(port),
    GOLEM_HOME: home,
    GOLEM_TRACKER_DB: path.join(scratch, 'tracker.db'),
    GOLEM_PROJECTS_ROOT: projects,
    GOLEM_IDEAS_ROOT: path.join(scratch, 'ideas'),
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childExited = false;
child.once('exit', () => { childExited = true; });
child.stderr.on('data', (data) => {
  const text = data.toString();
  if (/EADDRINUSE|fatal|Error:/i.test(text)) process.stderr.write(`[dashboard] ${text}`);
});

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childExited) throw new Error('dashboard exited before becoming healthy');
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await pause(100);
  }
  throw new Error('dashboard did not become healthy in time');
}

let chrome = null;
let failures = 0;
try {
  await waitForHealth();
  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  const consoleErrors = [];
  const dialogs = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('dialog', async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  });

  await page.goto(`${base}/substrate`, { waitUntil: 'networkidle' });
  await page.locator('.substrate-skills-list .substrate-skill-item').first().waitFor({ timeout: 15000 });
  ok(await page.locator('.substrate-mode-btn', { hasText: 'Split' }).count() === 1, 'skill editor exposes Split mode');

  await page.locator('.substrate-mode-btn', { hasText: 'Split' }).click();
  const modal = page.locator('[data-testid="substrate-split-modal"]');
  await modal.waitFor();
  ok(await modal.locator('[data-testid="substrate-split-raw"]').count() === 1, 'skill Split opens full-screen raw pane');
  ok(await modal.locator('[data-testid="substrate-split-preview"]').count() === 1, 'skill Split opens live preview pane');
  ok((await modal.locator('.substrate-split-title').innerText()).trim().length > 0, 'skill Split header shows file name');
  ok((await modal.locator('.substrate-split-path').innerText()).includes('SKILL.md'), 'skill Split header shows canonical path');

  const skillDraft = [
    '---',
    'name: split-browser-fixture',
    'description: Metadata stays above the rendered skill prose',
    '---',
    '',
    '# Live skill preview',
    '',
    'The body updates without rendering frontmatter as prose.',
    '',
    '> [!NOTE]',
    '> This is a sanitized live preview.',
    '',
    '```mermaid',
    'flowchart LR',
    '  Raw[Raw source] --> Preview[Live preview]',
    '```',
  ].join('\n');
  const skillRaw = modal.locator('[data-testid="substrate-split-raw"]');
  await skillRaw.fill(skillDraft);
  const skillPreview = modal.locator('[data-testid="substrate-split-preview"]');
  await skillPreview.getByText('Live skill preview', { exact: false }).waitFor({ timeout: 10000 });
  const skillPreviewText = await skillPreview.innerText();
  const skillMetadataText = await modal.locator('[data-testid="substrate-split-frontmatter"]').innerText();
  ok(skillPreviewText.includes('The body updates without rendering frontmatter as prose.'), 'skill typing updates the live preview');
  ok(!skillPreviewText.includes('name: split-browser-fixture') && !skillPreviewText.includes('description: Metadata stays'), 'skill frontmatter is excluded from rendered prose');
  ok(skillMetadataText.includes('split-browser-fixture') && skillMetadataText.includes('Metadata stays above'), 'skill frontmatter is shown in the metadata strip');
  await skillPreview.locator('.mermaid svg').first().waitFor({ timeout: 15000 });
  ok(await skillPreview.locator('.mermaid svg').count() > 0, 'skill Mermaid preview is rendered through the lazy renderer');
  ok((await modal.locator('[data-testid="substrate-split-save-state"]').innerText()).includes('Unsaved'), 'dirty Split state is announced');

  const dialogsBeforeEsc = dialogs.length;
  await skillRaw.press('Escape');
  await modal.waitFor({ state: 'hidden', timeout: 5000 });
  ok(dialogs.length === dialogsBeforeEsc + 1 && dialogs.at(-1).type === 'confirm', 'Esc on a dirty skill draft requests confirmation');

  await page.locator('.substrate-mode-btn', { hasText: 'Edit Markdown' }).click();
  const editTextarea = page.locator('.substrate-markdown-textarea');
  await editTextarea.fill('mode switch draft');
  const dialogsBeforeModeSwitch = dialogs.length;
  await page.locator('.substrate-mode-btn', { hasText: 'Preview' }).click();
  await page.locator('.substrate-preview-wrap').waitFor();
  ok(dialogs.length === dialogsBeforeModeSwitch + 1 && dialogs.at(-1).type === 'confirm', 'mode switch on a dirty draft requests confirmation');

  await page.locator('.substrate-mode-btn', { hasText: 'Split' }).click();
  await modal.waitFor();
  await modal.locator('.substrate-split-close').click();
  await modal.waitFor({ state: 'hidden', timeout: 5000 });

  await page.locator('.substrate-tab-btn', { hasText: 'Instructions (AGENTS.md)' }).click();
  await page.locator('.substrate-editor-title', { hasText: 'AGENTS.md' }).waitFor({ timeout: 10000 });
  ok(await page.locator('.substrate-mode-btn', { hasText: 'Split' }).count() === 1, 'instructions editor exposes Split mode');
  await page.locator('.substrate-mode-btn', { hasText: 'Split' }).click();
  await modal.waitFor();
  const instructionsRaw = modal.locator('[data-testid="substrate-split-raw"]');
  await instructionsRaw.fill('# Live instructions preview\n\nThis text updates in the rendered pane.\n\n| key | value |\n| --- | --- |\n| split | ready |');
  const instructionsPreview = modal.locator('[data-testid="substrate-split-preview"]');
  await instructionsPreview.getByText('Live instructions preview', { exact: false }).waitFor({ timeout: 10000 });
  ok((await instructionsPreview.innerText()).includes('This text updates in the rendered pane.'), 'instructions typing updates the live preview');
  ok(await modal.locator('[data-testid="substrate-split-frontmatter"]').innerText().then((text) => text.includes('No frontmatter detected')), 'instructions show the no-frontmatter metadata state');
  await modal.locator('.substrate-split-close').click();
  await modal.waitFor({ state: 'hidden', timeout: 5000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.substrate-mode-btn', { hasText: 'Split' }).click();
  await modal.waitFor();
  const narrowLayout = await page.evaluate(() => {
    const panes = document.querySelector('.substrate-split-panes');
    return {
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      modalWidth: document.querySelector('.substrate-split-modal')?.getBoundingClientRect().width || 0,
      paneColumns: panes ? getComputedStyle(panes).gridTemplateColumns.split(' ').length : 0,
    };
  });
  ok(narrowLayout.documentWidth <= narrowLayout.viewport && narrowLayout.bodyWidth <= narrowLayout.viewport, `390px Split has no page-level horizontal overflow (${narrowLayout.documentWidth}/${narrowLayout.viewport})`);
  ok(narrowLayout.modalWidth <= narrowLayout.viewport && narrowLayout.paneColumns === 1, '390px Split stacks the editor panes inside the viewport');
  ok(pageErrors.length === 0, `browser journey has zero page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`);
  ok(consoleErrors.length === 0, `browser journey has zero console errors${consoleErrors.length ? `: ${consoleErrors.join('; ')}` : ''}`);
} catch (error) {
  failures += 1;
  console.log(`  fail  ${error?.stack || error}`);
} finally {
  if (chrome) await chrome.cleanup();
  if (child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), pause(2000)]);
  }
  if (child.exitCode == null) child.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
  if (failures === 0) console.log('\nALL CHECKS PASSED');
  else console.log(`\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
