// TKT-0208: ticket body padding / max-width / spacing sweep.
//
// The .td-md body in the read view (drawer + page) was full-bleed to the
// drawer/page edges, making long lines hard to follow on wide screens. This
// smoke locks in the readability sweep:
//   1. .td-md is capped at 760px max-width (readable line length).
//   2. .td-md has 32px horizontal padding (visual gutter).
//   3. .td-md has 22px top padding and 64px bottom padding.
//   4. .td-md line-height is 1.6 × 13.5px = 21.6px.
//   5. .td-md paragraph margin is 8px (was 6px).
//   6. .td-md heading margin is 20px/8px (was 16px/6px).
//   7. The .td-md body remains at max-width when the rail is closed, and
//      drops back to full-width when the rail is open (rail has 360px + 30px
//      gutter footprint).

import { acquireChrome } from './_chrome.mjs';
import { strict as assert } from 'node:assert';

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.goto('http://dashboard.golem.localhost:7420/tracker?project=golem-1eba80', { waitUntil: 'networkidle' });
  await wait(800);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await wait(800);
  await page.evaluate(() => localStorage.setItem('td:width', '90'));
  await page.reload({ waitUntil: 'networkidle' });
  await wait(800);

  const opened = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.ticket'));
    const card = cards.find((c) => c.querySelector('.ticket-id')?.textContent.includes('TKT-')) || cards[0];
    if (!card) return null;
    card.click();
    return card.querySelector('.ticket-id')?.textContent.trim() || card.textContent.trim();
  });
  assert.ok(opened, 'opened a ticket');
  await wait(1500);
  await page.waitForSelector('.td-md', { timeout: 5000 });
  await wait(300);

  // ── 1-4. Body padding / max-width / line-height ──────────────────────────
  const md = await page.evaluate(() => {
    const el = document.querySelector('.td-md');
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const p = el.querySelector('p');
    const h = el.querySelector('h1, h2, h3, h4, h5, h6');
    return {
      maxWidth: cs.maxWidth,
      paddingTop: cs.paddingTop,
      paddingRight: cs.paddingRight,
      paddingBottom: cs.paddingBottom,
      paddingLeft: cs.paddingLeft,
      lineHeight: cs.lineHeight,
      width: rect.width,
      paragraphMargin: p ? window.getComputedStyle(p).margin : null,
      headingMargin: h ? window.getComputedStyle(h).margin : null,
    };
  });
  assert.ok(md, '.td-md is mounted');
  assert.equal(md.maxWidth, '760px', '.td-md max-width is 760px');
  assert.equal(md.paddingTop, '22px', '.td-md has 22px top padding');
  assert.equal(md.paddingBottom, '64px', '.td-md has 64px bottom padding');
  assert.equal(md.paddingLeft, '32px', '.td-md has 32px left padding');
  assert.equal(md.paddingRight, '32px', '.td-md has 32px right padding');
  assert.equal(md.lineHeight, '21.6px', '.td-md line-height is 1.6 × 13.5px = 21.6px');
  assert.equal(md.width, 760, '.td-md rendered width is capped at 760px');

  // ── 5-6. Paragraph + heading margins ───────────────────────────────────
  // The browser serializes `margin: 8px 0` as `0px 0px 8px 0px` (top right
  // bottom left). Match the *bottom* margin (3rd token) for paragraphs and
  // the *top* margin (1st token) for headings, which is what
  // `margin: 8px 0` / `margin: 20px 0 8px` actually set.
  if (md.paragraphMargin) {
    const tokens = md.paragraphMargin.split(/\s+/);
    const bottom = tokens.length === 1 ? tokens[0] : (tokens.length === 2 ? tokens[0] : tokens[2]);
    assert.equal(bottom, '8px', `paragraph bottom margin is 8px (got ${bottom})`);
  }
  if (md.headingMargin) {
    const tokens = md.headingMargin.split(/\s+/);
    const top = tokens[0];
    assert.equal(top, '20px', `heading top margin is 20px (got ${top})`);
  }

  // ── 7. When the rail is open, max-width drops (rail takes 390px) ───────
  // Force the rail open via DOM (the rail UI requires a hover / click on
  // a block which is fragile to test programmatically; we test the CSS
  // contract directly).
  await page.evaluate(() => {
    const wrap = document.querySelector('.td-annotate-wrap');
    if (wrap) wrap.classList.add('rail-open');
  });
  await wait(200);
  const railOpen = await page.evaluate(() => {
    const el = document.querySelector('.td-md');
    const cs = window.getComputedStyle(el);
    return { maxWidth: cs.maxWidth, paddingRight: cs.paddingRight };
  });
  assert.equal(railOpen.maxWidth, 'none', '.td-md max-width is none when rail is open');
  assert.equal(railOpen.paddingRight, '390px', '.td-md padding-right is 390px when rail is open (360 rail + 30 gutter)');

  console.log(JSON.stringify({ ok: true, md, railOpen, opened }, null, 2));
} finally {
  await cleanup();
}
