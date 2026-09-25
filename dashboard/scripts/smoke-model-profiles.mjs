#!/usr/bin/env node
// GOL-253 browser journey. Runs an isolated dashboard, uses one headless Chrome,
// exercises profile CRUD/default assignment/delete guard, and leaves screenshots
// in the OS temp directory for review.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireChrome } from './_chrome.mjs';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const server = path.join(repo, 'dashboard', 'server', 'index.js');
const host = '127.0.0.1';
const port = 7627;
const base = `http://${host}:${port}`;
const tag = crypto.randomBytes(6).toString('hex');
const state = fs.mkdtempSync(path.join(os.tmpdir(), `golem-model-profiles-${tag}-`));
const screenshotModal = path.join(os.tmpdir(), `golem-model-profiles-${tag}-modal.png`);
const screenshotAssigned = path.join(os.tmpdir(), `golem-model-profiles-${tag}-assigned.png`);
const screenshotClaude = path.join(os.tmpdir(), `golem-model-profiles-${tag}-claude.png`);
let child;
let chrome;
let failures = 0;

function check(label, value, detail = '') {
  const ok = !!value;
  if (!ok) failures++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function waitForHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) throw new Error('dashboard exited before health became ready');
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('dashboard did not become healthy');
}

try {
  child = spawn(process.execPath, [server], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: host,
      GOLEM_HOME: path.join(state, 'home'),
      GOLEM_TRACKER_DB: path.join(state, 'tracker.db'),
      GOLEM_PROJECTS_ROOT: path.join(state, 'projects'),
      GOLEM_IDEAS_ROOT: path.join(state, 'ideas'),
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (/fatal|EADDRINUSE/i.test(text)) process.stderr.write(`[dashboard] ${text}`);
  });
  await waitForHealth();

  const catalog = await fetch(`${base}/api/model-catalog`).then((response) => response.json());
  check('real catalog response has providers', Array.isArray(catalog.providers) && catalog.providers.length > 0, JSON.stringify({ providers: catalog.providers?.slice(0, 8), source: catalog.source }));
  check('real catalog response has provider/model map', catalog.modelsByProvider && Object.keys(catalog.modelsByProvider).length > 0);
  console.log(`catalog response: ${JSON.stringify({ providers: catalog.providers, model_counts: Object.fromEntries(Object.entries(catalog.modelsByProvider || {}).map(([key, rows]) => [key, rows.length])) })}`);

  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(`${base}/agents`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="model-profiles-panel"]', { timeout: 15_000 });
  check('model profiles section renders above roles', await page.locator('[data-testid="model-profiles-panel"] + .roles-panel').count() === 1);
  check('seeded profile cards render', await page.locator('[data-testid^="model-profile-card-"]').count() > 0);
  check('role editor uses one default-profile dropdown', await page.locator('#role-reviewer-default-profile').count() === 1 && await page.locator('#role-reviewer-provider').count() === 0);

  await page.locator('[data-testid="model-profile-add"]').click();
  await page.waitForSelector('[data-testid="model-profile-save"]');
  await page.screenshot({ path: screenshotModal, fullPage: true });
  await page.locator('[data-testid="model-profile-name"]').fill('Browser Profile');
  await page.locator('#model-profile-provider').click();
  await page.locator('.model-profile-choice-option', { hasText: 'xai' }).click();
  await page.locator('#model-profile-model').click();
  const modelChoices = await page.locator('.model-profile-choice-option').allTextContents();
  check('model dropdown is filtered by provider', modelChoices.includes('grok-4.6') && !modelChoices.includes('deepseek-v4-flash:0731'));
  await page.locator('.model-profile-choice-option', { hasText: 'grok-4.6' }).click();
  await page.locator('[data-testid="model-profile-thinking"]').selectOption('high');
  await page.locator('[data-testid="model-profile-save"]').click();
  await page.waitForSelector('[data-testid="model-profile-card-Browser Profile"]');
  check('profile create persists and renders card', await page.locator('[data-testid="model-profile-card-Browser Profile"]').count() === 1);

  const card = page.locator('[data-testid="model-profile-card-Browser Profile"]');
  await card.getByRole('button', { name: 'Edit' }).click();
  await page.locator('[data-testid="model-profile-thinking"]').selectOption('max');
  await page.locator('[data-testid="model-profile-save"]').click();
  await page.waitForTimeout(300);
  check('profile edit persists thinking level', (await card.innerText()).includes('thinking · max'));

  const reviewer = page.locator('.role-editor-card', { hasText: 'reviewer' }).first();
  await reviewer.locator('#role-reviewer-default-profile').click();
  await reviewer.locator('.model-profile-choice-option', { hasText: 'Browser Profile' }).click();
  await reviewer.getByRole('button', { name: 'Save default' }).click();
  await page.waitForTimeout(400);
  check('role default assignment persists', (await page.locator('#role-reviewer-default-profile').innerText()).includes('Browser Profile'));
  await page.locator('[data-testid="model-profiles-panel"]').screenshot({ path: screenshotAssigned });

  await card.getByRole('button', { name: 'Delete' }).click();
  await page.waitForSelector('.roles-inline-error', { timeout: 5_000 });
  check('referenced profile delete guard is visible', /default model profile/.test(await page.locator('.roles-inline-error').innerText()));

  await reviewer.locator('#role-reviewer-default-profile').click();
  await reviewer.locator('.model-profile-choice-option', { hasText: 'No default' }).click();
  await reviewer.getByRole('button', { name: 'Save default' }).click();
  await page.waitForTimeout(300);
  await card.getByRole('button', { name: 'Delete' }).click();
  await page.waitForTimeout(400);
  check('unreferenced profile delete succeeds', await page.locator('[data-testid="model-profile-card-Browser Profile"]').count() === 0);

  // GOL-382 R11: a Claude profile — no provider, a free model id, effort levels.
  await page.locator('[data-testid="model-profile-add"]').click();
  await page.waitForSelector('[data-testid="model-profile-save"]');
  await page.locator('[data-testid="model-profile-name"]').fill('Claude Profile');
  await page.locator('[data-testid="model-profile-harness"]').selectOption('claude');
  check('claude hides the provider field', await page.locator('#model-profile-provider').count() === 0 && await page.locator('[data-testid="model-profile-provider-input"]').count() === 0);
  const effortOptions = await page.locator('[data-testid="model-profile-thinking"] option').allTextContents();
  check('claude offers default plus effort levels', JSON.stringify(effortOptions) === JSON.stringify(['default', 'low', 'medium', 'high', 'xhigh', 'max']), JSON.stringify(effortOptions));
  await page.locator('[data-testid="model-profile-model-input"]').fill('claude-opus-5-5');
  await page.locator('[data-testid="model-profile-thinking"]').selectOption('high');
  await page.screenshot({ path: screenshotClaude, fullPage: true });
  await page.locator('[data-testid="model-profile-save"]').click();
  await page.waitForSelector('[data-testid="model-profile-card-Claude Profile"]');
  const claudeCard = page.locator('[data-testid="model-profile-card-Claude Profile"]');
  const claudeText = await claudeCard.innerText();
  check('claude profile card shows harness, model and effort', /claude/.test(claudeText) && claudeText.includes('claude-opus-5-5') && claudeText.includes('effort · high'), claudeText);
  const stored = await fetch(`${base}/api/model-profiles`).then((response) => response.json());
  const storedClaude = (stored.profiles ?? stored).find?.((row) => row.name === 'Claude Profile');
  check('claude profile persists with harness claude and no provider', storedClaude?.harness === 'claude' && storedClaude?.provider == null, JSON.stringify(storedClaude));
} catch (error) {
  failures++;
  console.log(`[FAIL] unexpected browser journey error — ${error?.stack || error}`);
} finally {
  if (chrome) await chrome.cleanup();
  if (child?.exitCode == null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  fs.rmSync(state, { recursive: true, force: true });
  console.log(`screenshots: ${screenshotModal} ${screenshotAssigned} ${screenshotClaude}`);
  process.exit(failures === 0 ? 0 : 1);
}
