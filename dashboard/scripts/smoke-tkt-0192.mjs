// TKT-0192: assert that the commenting behavior is identical between
// the ticket-drawer variant (right-side panel) and the standalone
// ticket page (/tickets/<id>). Both modes share the same TdAnnotate
// component and the same `containerSelector`-driven positioning
// primitives, so the rail / pill / FAB / text-select / block-hover
// affordances MUST work the same in both views.
//
// If this test ever fails with a real divergence, the fix is almost
// certainly to thread a piece of state (containerSelector, a CSS
// variable, or an explicit class) through TdAnnotate, not to introduce
// a branch on isPage / drawer-vs-page inside the annotation engine.

import { acquireChrome } from './_chrome.mjs';
import assert from 'node:assert/strict';

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = async (label) => {
  const s = await page.evaluate(() => {
    const fab = document.querySelector('#anno-fab');
    const rail = document.querySelector('#anno-rail');
    const container = document.querySelector('.drawer-ticket, .ticket-page');
    return {
      hasFab: !!fab,
      hasRail: !!rail,
      containerClass: container?.className,
      marks: document.querySelectorAll('.td-md mark.anno').length,
      blockIds: document.querySelectorAll('.td-md [data-block-id]').length,
      hasBlockHover: document.querySelector('.td-md [data-block-id].block-hover') != null,
    };
  });
  console.log(`[${label}] probe:`, JSON.stringify(s));
  return s;
};

const interactions = async (label) => {
  const out = {};

  // 1. Open the rail
  await page.evaluate(() => document.querySelector('#anno-fab')?.click());
  await wait(400);
  out.railOpen = await page.evaluate(() => document.querySelector('#anno-rail')?.classList.contains('open'));
  // 2. Open the + New composer
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#anno-rail button')).find((x) => /\+ New/.test(x.textContent));
    b?.click();
  });
  await wait(400);
  out.railComposerVisible = await page.evaluate(() => !!document.querySelector('#anno-rail .anno-composer textarea')?.offsetParent);
  // 3. Send a comment
  await page.evaluate((lbl) => {
    const ta = document.querySelector('#anno-rail .anno-composer textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, `TKT-0192 ${lbl} parity test`);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, label);
  await wait(200);
  await page.evaluate(() => document.querySelector('#anno-rail .anno-composer .send')?.click());
  await wait(1500);
  out.commentInRail = await page.evaluate((lbl) => {
    return document.querySelector('#anno-rail')?.textContent?.includes(`TKT-0192 ${lbl} parity test`);
  }, label);
  // 4. Close + reopen
  await page.evaluate(() => document.querySelector('#anno-fab')?.click());
  await wait(400);
  out.railClosedAfterClose = await page.evaluate(() => !document.querySelector('#anno-rail')?.classList.contains('open'));
  await page.evaluate(() => document.querySelector('#anno-fab')?.click());
  await wait(400);
  out.railReopened = await page.evaluate(() => document.querySelector('#anno-rail')?.classList.contains('open'));

  // 5. Block hover
  const block = await page.evaluate(() => {
    const b = document.querySelector('.td-md [data-block-id]');
    const r = b.getBoundingClientRect();
    return { x: r.left + 20, y: r.top + r.height / 2 };
  });
  await page.mouse.move(block.x, block.y);
  await wait(1300);
  out.blockPlusVisible = await page.evaluate(() => {
    const p = document.getElementById('anno-block-plus');
    return p?.style.display === 'flex' && !!p?.offsetParent;
  });
  out.blockHasHoverClass = await page.evaluate(() => {
    return document.querySelector('.td-md [data-block-id].block-hover') != null;
  });
  // 6. Text-select → pill
  await page.evaluate(() => {
    const p = document.querySelector('.td-md p');
    if (!p) return;
    const text = p.firstChild;
    if (!text || text.nodeType !== 3) return;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(20, text.length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new Event('mouseup', { bubbles: true }));
  });
  await wait(800);
  out.pillVisibleAfterSelect = await page.evaluate(() => {
    const p = document.getElementById('anno-pill');
    return p?.style.display === 'flex' && !!p?.offsetParent;
  });

  return out;
};

// Drawer mode
await page.goto('http://dashboard.golem.localhost:7420/tracker', { waitUntil: 'networkidle' });
await wait(500);
await page.evaluate(() => window.Router.openTicket('TKT-0161'));
await page.waitForSelector('.drawer-ticket', { timeout: 5000 });
await wait(2500);
const drawerProbe = await probe('DRAWER');
const drawerInteractions = await interactions('DRAWER');
await page.screenshot({ path: '/tmp/golem-ui-smoke/tkt-0192-drawer.png' });

// Page mode
await page.goto('http://dashboard.golem.localhost:7420/tickets/TKT-0161', { waitUntil: 'networkidle' });
await wait(2500);
const pageProbe = await probe('PAGE');
const pageInteractions = await interactions('PAGE');
await page.screenshot({ path: '/tmp/golem-ui-smoke/tkt-0192-page.png' });

// Compare
console.log('\n=== PROBE DIFF ===');
for (const k of Object.keys(drawerProbe)) {
  const d = drawerProbe[k], p = pageProbe[k];
  if (JSON.stringify(d) !== JSON.stringify(p)) {
    console.log(`  [DIFF] ${k}: drawer=${JSON.stringify(d)} page=${JSON.stringify(p)}`);
  } else {
    console.log(`  [OK]   ${k}: ${JSON.stringify(d)}`);
  }
}

console.log('\n=== INTERACTION DIFF ===');
for (const k of Object.keys(drawerInteractions)) {
  const d = drawerInteractions[k], p = pageInteractions[k];
  if (d !== p) {
    console.log(`  [DIFF] ${k}: drawer=${JSON.stringify(d)} page=${JSON.stringify(p)}`);
  } else {
    console.log(`  [OK]   ${k}: ${JSON.stringify(d)}`);
  }
}

// Hard assertions on the critical behaviors
assert.equal(drawerProbe.containerClass.includes('drawer-ticket'), true, 'drawer mode container is .drawer-ticket');
assert.equal(pageProbe.containerClass.includes('ticket-page'), true, 'page mode container is .ticket-page');
assert.equal(drawerInteractions.railOpen, pageInteractions.railOpen, 'rail opens');
assert.equal(drawerInteractions.railComposerVisible, pageInteractions.railComposerVisible, 'rail + New composer appears');
assert.equal(drawerInteractions.commentInRail, pageInteractions.commentInRail, 'comment sent and rendered in rail');
assert.equal(drawerInteractions.blockPlusVisible, pageInteractions.blockPlusVisible, 'block-hover + appears');
assert.equal(drawerInteractions.pillVisibleAfterSelect, pageInteractions.pillVisibleAfterSelect, 'text-select pill appears');

await cleanup();
console.log('\nTKT-0192 parity: PASS');
