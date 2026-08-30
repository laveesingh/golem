// GOL-287 — section-comment anchoring journey.
//
// Covers the three reported defects end to end through the real UI:
//   1. Commenting on a top-level heading anchored the PREVIOUS section
//      (nearestPrecedingHeading walked past the heading itself).
//   2. Commenting on a nested heading anchored the parent top-level section.
//   3. The messaging-style composer pill only ever said "Section · …", hiding
//      which block a block-anchored comment would attach to.
// Plus the ride-alongs: agent avatars render the session's model mark, and the
// create/edit Assignee pickers use the shared PopSelect with provider icons.
//
// Anchoring runs on a quarantined scratch ticket (archived in finally). Avatar
// and assignee checks are read-only against real pages.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { acquireChrome } from './_chrome.mjs';
import { archiveTicket, createScratchTicket } from './_scratch.mjs';

const ORIGIN = process.env.GOLEM_SMOKE_ORIGIN || 'http://dashboard.golem.localhost:7420';
const API = `${ORIGIN}/api`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync('/tmp/golem-ui-smoke', { recursive: true });

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}

const BODY = [
  '# Anchor fixture',
  '',
  '## Alpha section',
  '',
  'Alpha intro paragraph with enough text to hover reliably here.',
  '',
  '## Beta section',
  '',
  'Beta intro paragraph with enough text to hover reliably here.',
  '',
  '### Beta nested subsection',
  '',
  'Nested paragraph with enough text to hover reliably here too.',
].join('\n');

const ticket = await createScratchTicket({ title: 'gol287 section anchors', body: BODY, kind: 'spec' });
let chrome;
let createdCommentId = null;

try {
  chrome = await acquireChrome();
  const page = chrome.browser.contexts()[0]?.pages()[0] ?? await chrome.browser.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${ORIGIN}/tickets/${encodeURIComponent(ticket.id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.td-md [data-block-id]');
  await wait(700);

  // Hover a block until the "+" affordance attaches, then click it.
  async function openComposerForBlock(blockId) {
    const pt = await page.evaluate((wanted) => {
      const block = [...document.querySelectorAll('.td-md [data-block-id]')]
        .find((el) => el.dataset.blockId === wanted);
      if (!block) return null;
      block.scrollIntoView({ block: 'center' });
      const r = block.getBoundingClientRect();
      return { x: r.left + Math.min(60, r.width / 2), y: r.top + r.height / 2 };
    }, blockId);
    assert.ok(pt, `block ${blockId} rendered`);
    await page.mouse.move(pt.x, pt.y);
    await wait(200);
    await page.mouse.move(pt.x + 4, pt.y + 2);
    await wait(700); // 300ms show delay + margin
    const plusVisible = await page.evaluate(() => {
      const plus = document.getElementById('anno-block-plus');
      return !!plus && plus.style.display === 'flex';
    });
    assert.equal(plusVisible, true, `+ affordance appears for ${blockId}`);
    await page.click('#anno-block-plus');
    await wait(400);
  }
  const pillText = () => page.evaluate(
    () => document.querySelector('#anno-rail .anno-composer .anno-attachment-pill')?.textContent?.trim() || null,
  );
  const closeComposer = async () => {
    await page.evaluate(() => document.querySelector('#anno-rail .anno-composer .cancel')?.click());
    await wait(250);
  };

  // 1. Top-level heading → the pill names the heading itself, never the
  //    previous section (the reported bug attached Alpha when hovering Beta).
  await openComposerForBlock('beta-section#0');
  let pill = await pillText();
  assert.match(pill, /Block/, 'heading hover yields a block attachment pill');
  assert.match(pill, /Beta section/, 'pill names the hovered heading itself');
  assert.doesNotMatch(pill, /Alpha section/, 'bug 1 fixed: no previous-section anchor');
  await closeComposer();

  // 2. Nested heading → names the nested heading, never the parent section.
  await openComposerForBlock('beta-nested-subsection#0');
  pill = await pillText();
  assert.match(pill, /Beta nested subsection/, 'pill names the nested heading itself');
  assert.doesNotMatch(pill, /· Beta section/, 'bug 2 fixed: no parent-section anchor');

  // 3. Persisted anchor: send the comment and read the row back through the API.
  await page.fill('#anno-rail .anno-composer textarea', 'gol287 anchor check on nested heading');
  await page.click('#anno-rail .anno-composer button.send:not(.secondary)');
  await wait(800);
  const fresh = await request(`/tickets/${encodeURIComponent(ticket.id)}`);
  const mine = (fresh.comments || []).find((c) => c.body === 'gol287 anchor check on nested heading');
  assert.ok(mine, 'comment persisted through the composer');
  createdCommentId = mine.id;
  assert.equal(mine.anchor_kind, 'block', 'comment anchors as a block');
  assert.equal(mine.block_id, 'beta-nested-subsection#0', 'comment anchors the nested heading block');
  assert.equal(mine.section_id, 'beta-nested-subsection', 'persisted section_id is the nested heading slug');
  assert.equal(mine.section, 'Beta nested subsection', 'persisted section title is the nested heading text');

  // 4. Paragraph block → the pill names the block text, not just the section.
  await openComposerForBlock('beta-section#1');
  pill = await pillText();
  assert.match(pill, /Block/, 'paragraph hover yields a block attachment pill');
  assert.match(pill, /Beta intro paragraph/, 'bug 3 fixed: pill names the attached block itself');
  await closeComposer();

  // 4b. Replies are written in the MAIN composer with a reply reference —
  //     no inline composer inside the card (GOL-287 comment feedback).
  const seeded = await request(`/tickets/${encodeURIComponent(ticket.id)}/comments`, {
    method: 'POST',
    body: JSON.stringify({ author: 'smoke', body: 'Seeded parent comment for the reply journey.' }),
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.anno-card');
  await wait(800);
  const parentCard = page.locator('.anno-card', { hasText: 'Seeded parent comment' }).first();
  await parentCard.locator('.act-reply').click();
  await wait(400);
  const replyPill = await pillText();
  assert.match(replyPill, /Reply/, 'replying shows a reply reference in the MAIN composer');
  assert.match(replyPill, /smoke/, 'reply reference names the comment author');
  const inlineComposers = await page.evaluate(() => document.querySelectorAll('.anno-card .anno-composer').length);
  assert.equal(inlineComposers, 0, 'no inline composer inside comment cards anymore');
  const focusInMain = await page.evaluate(() => document.activeElement === document.querySelector('#anno-rail .anno-composer textarea'));
  assert.equal(focusInMain, true, 'reply focus lands in the main composer');
  await page.fill('#anno-rail .anno-composer textarea', 'gol287 main-box reply check');
  await page.click('#anno-rail .anno-composer button.send:not(.secondary)');
  await wait(800);
  // The API stores replies flat (parent_id); the drawer nests them client-side.
  const afterReply = await request(`/tickets/${encodeURIComponent(ticket.id)}`);
  const replyRow = (afterReply.comments || []).find((c) => c.body === 'gol287 main-box reply check');
  assert.ok(replyRow, 'reply persisted');
  assert.equal(replyRow.parent_id, seeded.id, 'reply attaches to the referenced comment (unchanged mechanism)');

  // 5. Agent avatars wear the session's model mark; authors whose session has
  //    rotated out of the live registry fall back to initials. Deterministic:
  //    comment as the CURRENT live session (this smoke's driver session id is
  //    in the registry), so the img icon must render.
  const liveSession = await request('/api/native-sessions').then(
    (rows) => rows.find((s) => s.alive && s.session_id && s.model),
  );
  assert.ok(liveSession, 'a live session with model facts exists for the avatar check');
  await request(`/tickets/${encodeURIComponent(ticket.id)}/comments`, {
    method: 'POST',
    body: JSON.stringify({ author: liveSession.session_id, body: 'gol287 live-session avatar check' }),
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.anno-card');
  await wait(1200);
  const avatarStats = await page.evaluate((liveId) => {
    const stats = { liveCard: null, fallbackCards: 0, humanTotal: 0, humanWithInitials: 0 };
    for (const card of document.querySelectorAll('.anno-card')) {
      const avatar = card.querySelector('.anno-avatar');
      if (!avatar) continue;
      if (avatar.classList.contains('anno-avatar-human')) {
        stats.humanTotal += 1;
        if (avatar.textContent.trim()) stats.humanWithInitials += 1;
        continue;
      }
      const cardText = card.textContent || '';
      if (avatar.querySelector('img')) {
        stats.liveCard = stats.liveCard || cardText.includes('gol287 live-session avatar check');
      } else {
        stats.fallbackCards += 1;
      }
    }
    return stats;
  }, liveSession.session_id);
  assert.equal(avatarStats.liveCard, true, 'live-session comment renders the model mark');
  assert.ok(avatarStats.fallbackCards > 0, 'registry-evicted authors fall back to initials (smoke/seed authors)');
  assert.ok(avatarStats.humanTotal === 0 || avatarStats.humanWithInitials > 0, 'human avatar keeps initials');

  // 6. Assignee pickers: shared PopSelect with provider marks + hints.
  //    6a. Read/edit drawer via the board route (the /tickets reader hides the
  //    properties sidebar by design).
  await page.goto(`${ORIGIN}/?ticket=${encodeURIComponent('GOL-287')}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.drawer-ticket .td-side .td-prop .ps-trigger');
  await wait(800);
  const assigneeProp = page.locator('.drawer-ticket .td-prop', { hasText: 'Assignee' }).locator('.ps-trigger');
  await assigneeProp.click();
  await page.waitForSelector('.ps-menu');
  await wait(300);
  const editPicker = await page.evaluate(() => ({
    options: document.querySelectorAll('.ps-menu .ps-option').length,
    icons: document.querySelectorAll('.ps-menu .ps-option .ps-option-icon').length,
    hints: [...document.querySelectorAll('.ps-menu .ps-option .ps-hint')].map((h) => h.textContent.trim()),
  }));
  assert.ok(editPicker.options >= 2, 'edit assignee picker renders options');
  assert.ok(editPicker.icons >= 1, 'edit assignee picker shows provider marks');
  assert.ok(editPicker.hints.some((h) => /lead|builder|explorer|reviewer|idle|busy|waiting/.test(h)), 'edit assignee rows carry role/status hints');
  await page.keyboard.press('Escape');

  //    6b. Create drawer via the compose route on the same project.
  await page.goto(`${ORIGIN}/?compose=1&project=golem-38ab8a`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.drawer-compose .ct-field .ps-trigger');
  await wait(800);
  const createTrigger = page.locator('.drawer-compose .ct-field', { hasText: 'Assignee' }).locator('.ps-trigger');
  const createTriggerLabel = (await createTrigger.textContent() || '').trim();
  assert.ok(createTriggerLabel.length > 0, 'create assignee trigger renders a label');
  await createTrigger.click();
  await page.waitForSelector('.ps-menu');
  await wait(300);
  const createPicker = await page.evaluate(() => ({
    options: document.querySelectorAll('.ps-menu .ps-option').length,
    icons: document.querySelectorAll('.ps-menu .ps-option .ps-option-icon').length,
    labels: [...document.querySelectorAll('.ps-menu .ps-option .ps-option-label')].map((l) => l.textContent.trim()),
  }));
  assert.ok(createPicker.options >= 2, 'create assignee picker renders options');
  assert.ok(createPicker.icons >= 1, 'create assignee picker shows provider marks');
  assert.ok(createPicker.labels.includes('Unassigned') && createPicker.labels.includes('Lavee'), 'create picker keeps Unassigned + Lavee rows');
  await page.keyboard.press('Escape');

  assert.deepEqual(pageErrors, [], 'no page errors during the journey');
  console.log('gol287 section-anchor journey: all assertions passed');
} finally {
  if (chrome) await chrome.cleanup();
  await archiveTicket(ticket.id);
}
