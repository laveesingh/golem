// TKT-0204: smoke for the question / "needs answer" feature.
// Verifies:
//   1. The header "❓ needs answer" pill is present with an explainer
//      tooltip when the ticket is question-kind assigned to a human.
//   2. The drawer container gets a `td-has-question-return` class.
//   3. The floating #anno-fab is hidden in question-ticket views (so it
//      doesn't cover the "Answer & return" button).
//   4. The QuestionReturn section renders a one-line explainer.
//   5. Posting an answer clears the textarea, shows a "Answer posted ✓"
//      flash, and persists a new comment in the API.
//   6. The "Answer & return" button is no longer covered by the FAB
//      (rects don't overlap).
//   7. Page variant (variant="page" at /tickets/<id>) has the same
//      treatment — the FAB is hidden, the help text shows.
//
// The smoke does NOT exercise the dispatch (Save & return) or the
// post+return flow — those are still tested in other smokes.

import { acquireChrome } from './_chrome.mjs';
import { strict as assert } from 'node:assert';

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function openTicket(url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.td-question-return, .td-md', { timeout: 5000 });
  await wait(1200);
}

async function checkQuestionSurface() {
  return page.evaluate(() => {
    const container = document.querySelector('.drawer-ticket, .ticket-page');
    const fab = document.getElementById('anno-fab');
    const fabRect = fab?.getBoundingClientRect();
    const fabVisible = fab && fab.offsetParent !== null;
    const fabComputed = fab ? window.getComputedStyle(fab).display : 'no-fab';
    const fabEffective = fabVisible && fabComputed !== 'none';
    const badge = document.querySelector('.td-answer-badge');
    const badgeText = badge?.textContent?.trim();
    const badgeTitle = badge?.getAttribute('title') || '';
    const qr = document.querySelector('.td-question-return');
    const help = qr?.querySelector('.td-qr-help');
    const answerBtn = qr
      ? Array.from(qr.querySelectorAll('.td-qr-actions button')).find((b) => b.textContent.includes('Answer & return'))
      : null;
    const abRect = answerBtn?.getBoundingClientRect();
    return {
      containerClass: container?.className,
      hasQuestionClass: container?.classList?.contains('td-has-question-return') || false,
      fabComputed,
      fabEffective,
      fabRect: fabRect ? { left: fabRect.left, right: fabRect.right, top: fabRect.top, bottom: fabRect.bottom } : null,
      fabCoversAnswer: fabRect && abRect
        ? !(fabRect.left > abRect.right || fabRect.right < abRect.left || fabRect.top > abRect.bottom || fabRect.bottom < abRect.top)
        : null,
      badgeText,
      hasBadgeTitle: badgeTitle.length > 30,
      hasHelp: !!help,
      answerBtnRect: abRect ? { left: abRect.left, right: abRect.right, top: abRect.top, bottom: abRect.bottom } : null,
    };
  });
}

async function postAnswer() {
  await page.fill('.td-question-return textarea', 'TKT-0204 smoke answer');
  await wait(150);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.td-qr-actions button'))
      .find((b) => b.textContent.trim() === 'Post answer');
    btn?.click();
  });
  await wait(800);
  return page.evaluate(() => {
    const ta = document.querySelector('.td-question-return textarea');
    return {
      hasPostedFlash: !!document.querySelector('.td-qr-posted'),
      postedText: document.querySelector('.td-qr-posted')?.textContent,
      textareaValue: ta?.value,
    };
  });
}

const results = {};

// ── Drawer variant ────────────────────────────────────────────────
try {
  await openTicket('http://dashboard.golem.localhost:7420/tracker?ticket=TKT-0191');
  const drawerCheck = await checkQuestionSurface();
  results.drawer = drawerCheck;
  assert.equal(drawerCheck.hasQuestionClass, true, 'drawer container has td-has-question-return class');
  assert.equal(drawerCheck.fabEffective, false, 'FAB is hidden in drawer mode (display: none or hidden)');
  assert.equal(drawerCheck.fabCoversAnswer, false, 'FAB no longer covers the Answer & return button');
  assert.equal(drawerCheck.badgeText, '❓ needs answer', 'needs-answer pill is present');
  assert.equal(drawerCheck.hasBadgeTitle, true, 'pill has an explainer title');
  assert.equal(drawerCheck.hasHelp, true, 'question-return has a one-line explainer');

  const drawerPost = await postAnswer();
  results.drawerPost = drawerPost;
  assert.equal(drawerPost.textareaValue, '', 'textarea cleared after post');
  assert.equal(drawerPost.hasPostedFlash, true, '"Answer posted ✓" flash visible after post');
  assert.match(drawerPost.postedText, /posted/i, 'posted text says "posted"');
} catch (err) {
  console.log('DRAWER FAIL:', err.message);
  throw err;
}

// ── Page variant ──────────────────────────────────────────────────
try {
  await openTicket('http://dashboard.golem.localhost:7420/tickets/TKT-0191');
  const pageCheck = await checkQuestionSurface();
  results.page = pageCheck;
  assert.equal(pageCheck.hasQuestionClass, true, 'page container has td-has-question-return class');
  assert.equal(pageCheck.fabEffective, false, 'FAB is hidden in page mode');
  assert.equal(pageCheck.fabCoversAnswer, false, 'FAB no longer covers the Answer & return button in page mode');
  assert.equal(pageCheck.hasHelp, true, 'page mode shows the explainer');
} catch (err) {
  console.log('PAGE FAIL:', err.message);
  throw err;
}

// ── Final API check: the smoke answer was actually persisted ──────
try {
  const api = await page.evaluate(() => fetch('/api/tickets/TKT-0191').then((r) => r.json()));
  results.api = { id: api.id, commentCount: api.comments?.length, commentBodies: api.comments?.map((c) => c.body?.slice(0, 30)) };
  assert.ok(api.comments?.some((c) => c.body === 'TKT-0204 smoke answer'), 'TKT-0204 smoke answer persisted in API');
} catch (err) {
  console.log('API FAIL:', err.message);
  throw err;
}

await cleanup();
console.log(JSON.stringify(results, null, 2));
console.log('TKT-0204 question smoke: PASS');
