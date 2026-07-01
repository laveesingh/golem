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

  // ── 1. Ideas link embedded in the sidebar (TKT-0206 revised) ──────
  // Earlier the user complained that a floating bottom-left anchor covered
  // the sidebar's footer (HARNESS · ONLINE, TweaksButton). Fix: the link
  // now lives in the sidebar's normal flow (no position:fixed), pinned
  // via position:sticky + bottom:0 so it's always visible at the bottom
  // of the menu bar.
  const sidebarLink = await page.evaluate(() => {
    const a = document.querySelector('.sidebar-link-ideas');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    const sidebar = document.querySelector('.sidebar');
    const sr = sidebar?.getBoundingClientRect();
    return {
      text: a.textContent.trim(),
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      hasCount: !!a.querySelector('.sidebar-link-count'),
      insideSidebar: sr ? (r.left >= sr.left && r.right <= sr.right) : null,
      sidebarRect: sr ? { left: sr.left, right: sr.right, top: sr.top, bottom: sr.bottom } : null,
    };
  });
  assert.ok(sidebarLink, 'Ideas link is present');
  assert.ok(sidebarLink.insideSidebar, 'Ideas link is INSIDE the sidebar (no floating cover)');
  assert.ok(sidebarLink.hasCount === false, 'no count badge when queue is empty');

  // ── 2. Click the link → drawer opens ────────────────────────────
  await page.evaluate(() => document.querySelector('.sidebar-link-ideas')?.click());
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
    const c = document.querySelector('.sidebar-link-ideas .sidebar-link-count');
    return c ? c.textContent : null;
  });
  assert.equal(anchorWithCount, '1', 'sidebar link count = 1');

  // ── 5. Pop the idea ─────────────────────────────────────────────
  await page.evaluate(() => {
    const btn = document.querySelector('.idea-card button.orch-btn.primary.small');
    btn?.click();
  });
  await wait(800);
  const afterPop = await page.evaluate(() => ({
    cards: document.querySelectorAll('.idea-card').length,
    anchorCount: document.querySelector('.sidebar-link-ideas .sidebar-link-count')?.textContent || null,
  }));
  assert.equal(afterPop.cards, 0, 'no idea cards after pop');
  assert.equal(afterPop.anchorCount, null, 'sidebar link count removed when queue empty');

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
