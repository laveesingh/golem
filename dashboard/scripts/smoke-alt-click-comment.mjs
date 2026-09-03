// Option/Alt+click-to-comment: holding the modifier over a commentable block
// shows a comment cursor, and alt+click opens the composer anchored to that
// block — a reliable fallback when the "+" button is hard to reach. Normal
// clicks and interactive elements (links, buttons) are untouched.
import { acquireChrome } from './_chrome.mjs';
import assert from 'node:assert/strict';

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto('http://dashboard.golem.localhost:7420/tickets/TKT-0161', { waitUntil: 'networkidle' });
await wait(2500);

// Pick a commentable block (a paragraph with text) and scroll it into view.
const blockPt = await page.evaluate(() => {
  const b = document.querySelector('.td-md [data-block-id]');
  b?.scrollIntoView({ block: 'center' });
  const r = b.getBoundingClientRect();
  return { x: r.left + 40, y: r.top + r.height / 2 };
});
await wait(400);

// 1. Without the modifier, the root has no alt-comment class.
const before = await page.evaluate(() => document.querySelector('.td-md')?.classList.contains('anno-alt-comment'));
assert.equal(before, false, 'no alt-comment class before pressing the modifier');

// 2. Hold Alt → the class appears (drives the comment cursor).
await page.keyboard.down('Alt');
await wait(150);
const during = await page.evaluate(() => document.querySelector('.td-md')?.classList.contains('anno-alt-comment'));
assert.equal(during, true, 'alt-comment class appears while Alt is held');

// 3. Alt+click the block → composer opens anchored to that block.
await page.mouse.click(blockPt.x, blockPt.y, { modifiers: ['Alt'] });
await wait(500);
const composer = await page.evaluate(() => {
  const ta = document.querySelector('#anno-rail .anno-composer textarea');
  const railOpen = document.querySelector('#anno-rail')?.classList.contains('open');
  // GOL-277 replaced the quote preview with the attachment pill; GOL-287 made
  // that pill name the attached BLOCK itself (block text, not section title).
  const pill = document.querySelector('#anno-rail .anno-composer .anno-attachment-pill')?.textContent?.trim() || null;
  return { railOpen, hasComposer: !!ta, pill };
});
assert.equal(composer.railOpen, true, 'rail opens on alt+click');
assert.equal(composer.hasComposer, true, 'composer opens on alt+click');
assert.ok(composer.pill && /Block/.test(composer.pill), 'composer shows the block attachment pill');

// 4. Release Alt → class clears.
await page.keyboard.up('Alt');
await wait(150);
const after = await page.evaluate(() => document.querySelector('.td-md')?.classList.contains('anno-alt-comment'));
assert.equal(after, false, 'alt-comment class clears when the modifier is released');

// 5. A normal click (no modifier) on the block anchors the composer too —
//    GOL-313 made click single-step: plain and alt click share one path and
//    one suppress set, so the observable is the same pill.
await page.evaluate(() => {
  const b = document.querySelector('#anno-rail .anno-composer .cancel');
  b?.click();
});
await wait(300);
await page.mouse.click(blockPt.x, blockPt.y);
await wait(400);
const normalClick = await page.evaluate(() => !!document.querySelector('#anno-rail .anno-composer .anno-attachment-pill'));
assert.equal(normalClick, true, 'plain click anchors the composer (single-step)');

await cleanup();
console.log('alt+click-to-comment: PASS');
