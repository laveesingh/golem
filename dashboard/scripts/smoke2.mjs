import { acquireChrome } from './_chrome.mjs';
import fs from 'node:fs';

const OUT = '/tmp/golem-ui-smoke';
const log = (...a) => console.log('[smoke2]', ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { browser, cleanup } = await acquireChrome();
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find((p) => p.url().includes('127.0.0.1:7420')) || await ctx.newPage();
  /* bringToFront is a no-op on headless Chrome (TKT-0187) */
  await page.setViewportSize({ width: 1440, height: 900 });

  page.on('pageerror', (err) => log('PAGE ERROR:', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') log('CONSOLE ERROR:', msg.text());
  });

  await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' });
  await wait(1500);

  // Open TKT-0001 directly via event
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-ticket-drawer', { detail: { id: 'TKT-0001' } })));
  await wait(2000);

  const shot = async (n) => page.screenshot({ path: `${OUT}/s2-${n}.png` });

  await shot('01-drawer');

  // 1. Test that the pill's offset parent is .td-annotate-wrap
  const pillAnatomy = await page.evaluate(() => {
    const pill = document.getElementById('anno-pill');
    if (!pill) return null;
    const cs = getComputedStyle(pill);
    const offsetParent = pill.offsetParent?.className;
    const wrapRect = document.querySelector('.td-annotate-wrap').getBoundingClientRect();
    const pillRect = pill.getBoundingClientRect();
    return {
      pillPos: cs.position, zIndex: cs.zIndex, display: pill.style.display,
      offsetParent, wrapRect: { x: wrapRect.left, w: wrapRect.width },
      pillRect: { x: pillRect.left, y: pillRect.top, w: pillRect.width, h: pillRect.height },
    };
  });
  log('pill anatomy:', JSON.stringify(pillAnatomy, null, 2));

  // 2. Open the rail via FAB (no text selection yet)
  await page.click('#anno-fab');
  await wait(500);
  await shot('02-rail-open');

  // 3. Programmatically select text inside the body, dispatch mouseup, then click pill
  const selectResult = await page.evaluate(() => {
    const root = document.querySelector('.td-md');
    if (!root) return 'no body';
    const target = root.querySelector('p, li, h2, h3');
    if (!target) return 'no target';
    const tn = target.firstChild;
    if (!tn || tn.nodeType !== Node.TEXT_NODE) return 'no text node';
    const range = document.createRange();
    range.setStart(tn, 0);
    range.setEnd(tn, Math.min(15, tn.textContent.length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return { text: tn.textContent.slice(0, 15), targetTag: target.tagName };
  });
  log('select result:', JSON.stringify(selectResult));
  await wait(400);
  await shot('03-after-select');

  const pillAfter = await page.evaluate(() => {
    const p = document.getElementById('anno-pill');
    const r = p?.getBoundingClientRect();
    return { display: p?.style.display, x: r ? Math.round(r.left) : null, y: r ? Math.round(r.top) : null, w: r ? Math.round(r.width) : null };
  });
  log('pill after select:', JSON.stringify(pillAfter));

  // 4. Try clicking the pill via Playwright
  if (pillAfter.display === 'flex') {
    await page.click('#anno-pill');
    await wait(700);
    await shot('04-after-pill-click');
    const comp = await page.evaluate(() => {
      const c = document.querySelector('.anno-composer');
      if (!c) return { composer: 'no' };
      return {
        composer: 'yes',
        hasTextarea: !!c.querySelector('textarea'),
        hasSend: !!c.querySelector('.send'),
        activeId: document.activeElement?.tagName,
      };
    });
    log('after pill click:', JSON.stringify(comp));
  }

  // 5. Try clicking + New button to open plain composer
  await page.evaluate(() => {
    document.getElementById('anno-pill')?.style && (document.getElementById('anno-pill').style.display = 'none');
  });
  await page.click('button.rail-btn:has-text("+ New")');
  await wait(500);
  await shot('05-plain-composer');
  const plainComp = await page.evaluate(() => {
    const c = document.querySelector('.anno-composer');
    return c ? { yes: true, hasTextarea: !!c.querySelector('textarea') } : { yes: false };
  });
  log('plain composer:', JSON.stringify(plainComp));

  // 6. Type and send a plain comment
  if (plainComp.hasTextarea) {
    await page.fill('.anno-composer textarea', 'Smoke test plain comment');
    await page.click('.anno-composer .send');
    await wait(2000);
    await shot('06-after-plain-comment');
    const cards = await page.evaluate(() => document.querySelectorAll('.anno-card').length);
    log('cards after plain comment:', cards);
  }

  // 7. Test text selection WITHIN the body to position pill correctly relative to wrap
  const wrapRect = await page.evaluate(() => {
    const w = document.querySelector('.td-annotate-wrap');
    return { x: Math.round(w.getBoundingClientRect().left), w: Math.round(w.getBoundingClientRect().width), right: Math.round(w.getBoundingClientRect().right) };
  });
  log('wrap rect:', JSON.stringify(wrapRect));

  // 8. Open the comments rail toggle (Resolved/Hidden) button to see behavior
  const toggleInfo = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#anno-rail .rail-btn')).map((b) => ({ text: b.textContent.trim(), classes: b.className }));
    return btns;
  });
  log('rail buttons:', JSON.stringify(toggleInfo));

  // 9. Test the +New button label when showResolved is true
  await page.click('#anno-rail .rail-btn:has-text("Hidden"), #anno-rail .rail-btn:has-text("Resolved")');
  await wait(400);
  const toggleInfo2 = await page.evaluate(() => Array.from(document.querySelectorAll('#anno-rail .rail-btn')).map((b) => ({ text: b.textContent.trim(), classes: b.className })));
  log('rail buttons after toggle:', JSON.stringify(toggleInfo2));
  await shot('07-toggle-resolved');

  log('done.');
  await cleanup();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });