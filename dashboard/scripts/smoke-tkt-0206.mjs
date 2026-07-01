// TKT-0206: smoke for the global ideas-stack feature.
// Verifies:
//   1. The bottom-left anchor button is visible on the dashboard.
//   2. The anchor has a count badge when there are pending ideas.
//   3. Clicking the anchor opens the ideas drawer (URL overlay ?ideas=1).
//   4. The composer posts a new idea to the server.
//   5. The new idea appears as a card in the list.
//   6. Clicking Pop on a card removes it from the list.
//   7. The anchor count badge updates as the list changes.
//   8. The drawer closes on Esc.

import { acquireChrome } from './_chrome.mjs';
import { strict as assert } from 'node:assert';
import { rm } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const IDEAS_DIR = join(homedir(), '.config', 'golem', 'ideas');

// Clean any leftover smoke ideas from prior runs.
for (const f of readdirSync(IDEAS_DIR).filter((f) => f.startsWith('tkt-0206-smoke-'))) {
  await rm(join(IDEAS_DIR, f)).catch(() => {});
}

try {
  // Start clean: clear the queue via the API.
  await page.goto('http://dashboard.golem.localhost:7420/', { waitUntil: 'networkidle' });
  await wait(800);
  const initialIdeas = await page.evaluate(() => fetch('/api/ideas').then((r) => r.json()));
  for (const idea of initialIdeas) {
    await page.evaluate((id) => fetch(`/api/ideas/${encodeURIComponent(id.id)}/pop`, { method: 'POST' }), idea.id);
  }

  // ── 1. Anchor visible on dashboard ─────────────────────────────────
  const anchor = await page.evaluate(() => {
    const a = document.querySelector('.ideas-anchor');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { text: a.textContent.trim(), left: r.left, bottom: r.bottom, hasCount: !!a.querySelector('.ideas-anchor-count') };
  });
  assert.ok(anchor, 'bottom-left ideas anchor is present');
  assert.ok(anchor.left < 50, 'anchor is at the left edge of the viewport');
  assert.ok(anchor.bottom > 800, 'anchor is at the bottom of the viewport');
  assert.equal(anchor.hasCount, false, 'no count badge when queue is empty');

  // ── 2. Click the anchor → drawer opens ────────────────────────────
  await page.evaluate(() => document.querySelector('.ideas-anchor')?.click());
  await wait(600);
  const opened = await page.evaluate(() => {
    return {
      url: location.href,
      drawerOpen: !!document.querySelector('.ideas-drawer.open'),
      hasComposer: !!document.querySelector('.ideas-input'),
      hasList: !!document.querySelector('.ideas-list'),
    };
  });
  assert.match(opened.url, /[?&]ideas=1/, 'URL has ?ideas=1');
  assert.equal(opened.drawerOpen, true, 'drawer is open');
  assert.equal(opened.hasComposer, true, 'composer is visible');
  assert.equal(opened.hasList, true, 'list is visible');

  // ── 3. Post an idea ──────────────────────────────────────────────
  await page.fill('.ideas-input', 'A test idea from the smoke');
  await wait(150);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.ideas-drawer button')).find((b) => b.textContent.trim() === 'Post idea');
    btn?.click();
  });
  await wait(800);
  const afterPost = await page.evaluate(() => ({
    cards: document.querySelectorAll('.idea-card').length,
    firstBody: document.querySelector('.idea-card .idea-body')?.textContent,
    textareaValue: document.querySelector('.ideas-input')?.value,
  }));
  assert.equal(afterPost.cards, 1, 'one idea card');
  assert.match(afterPost.firstBody, /smoke/, 'card body matches what was posted');
  assert.equal(afterPost.textareaValue, '', 'composer cleared after post');

  // ── 4. Anchor count badge updated ─────────────────────────────────
  const anchorWithCount = await page.evaluate(() => {
    const c = document.querySelector('.ideas-anchor-count');
    return c ? c.textContent : null;
  });
  assert.equal(anchorWithCount, '1', 'anchor count = 1');

  // ── 5. Pop the idea ─────────────────────────────────────────────
  await page.evaluate(() => {
    const btn = document.querySelector('.idea-card button.orch-btn.primary.small');
    btn?.click();
  });
  await wait(800);
  const afterPop = await page.evaluate(() => ({
    cards: document.querySelectorAll('.idea-card').length,
    anchorCount: document.querySelector('.ideas-anchor-count')?.textContent || null,
  }));
  assert.equal(afterPop.cards, 0, 'no idea cards after pop');
  assert.equal(afterPop.anchorCount, null, 'anchor count removed when queue empty');

  // ── 6. Press Esc → drawer closes ───────────────────────────────
  await page.keyboard.press('Escape');
  await wait(500);
  const closed = await page.evaluate(() => ({
    url: location.href,
    drawerOpen: !!document.querySelector('.ideas-drawer.open'),
  }));
  assert.equal(closed.drawerOpen, false, 'drawer closes on Esc');
  assert.doesNotMatch(closed.url, /[?&]ideas=1/, 'URL no longer has ?ideas=1');

  // ── 7. API surface sanity ───────────────────────────────────────
  const apiEmpty = await page.evaluate(() => fetch('/api/ideas').then((r) => r.json()));
  assert.equal(apiEmpty.length, 0, 'API returns empty list');

  console.log('TKT-0206 ideas smoke: PASS');
} finally {
  // Final cleanup: remove any smoke ideas.
  for (const f of readdirSync(IDEAS_DIR).filter((f) => f.startsWith('tkt-0206-smoke-'))) {
    await rm(join(IDEAS_DIR, f)).catch(() => {});
  }
  await cleanup();
}
