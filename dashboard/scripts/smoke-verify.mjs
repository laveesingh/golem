// smoke-verify.mjs — verify the Composer-collision fix
import { acquireChrome } from './_chrome.mjs';
const log = (...a) => console.log('[s]', ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { browser, cleanup } = await acquireChrome();
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('127.0.0.1:7420') || p.url().includes('dashboard.golem.localhost:7420')); if (!page) { page = await ctx.newPage(); await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' }); } if (!page) { page = await ctx.newPage(); await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' }); }
/* bringToFront is a no-op on headless Chrome (TKT-0187) */
await page.setViewportSize({ width: 1440, height: 900 });
await page.reload({ waitUntil: 'domcontentloaded' });
await wait(2500);

await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-ticket-drawer', { detail: { id: 'TKT-0001' } })));
await wait(2500);

await page.click('#anno-fab');
await wait(500);

// Test + New
await page.locator('#anno-rail .rail-btn', { hasText: '+ New' }).first().click();
await wait(800);
let composer = await page.evaluate(() => ({
  hasAnnoComposer: !!document.querySelector('.anno-composer'),
  hasCeoComposer: !!document.querySelector('.anno-list .ceo-composer'),
  listChildren: Array.from(document.getElementById('anno-list').children).map((c) => c.tagName + '.' + c.className),
}));
log('after + New:', JSON.stringify(composer, null, 2));

// Type a plain comment and send
const ta = page.locator('.anno-composer textarea').first();
const taCount = await ta.count();
log('textarea count after fix:', taCount);
if (taCount > 0) {
  await ta.fill('Smoke test plain comment from new AnnoComposer');
  await wait(300);
  await page.click('.anno-composer .send');
  await wait(1500);
  const after = await page.evaluate(() => ({
    cards: document.querySelectorAll('#anno-list .anno-card').length,
    composers: document.querySelectorAll('.anno-composer').length,
  }));
  log('after sending plain comment:', JSON.stringify(after));
}

// Test text selection -> pill -> click pill -> quote composer
const selResult = await page.evaluate(() => {
  const root = document.querySelector('.td-md');
  if (!root) return 'no body';
  const target = root.querySelector('p, h2, h3, li');
  if (!target) return 'no target';
  const tn = target.firstChild;
  if (!tn || tn.nodeType !== 3) return 'no text node';
  const range = document.createRange();
  range.setStart(tn, 0);
  range.setEnd(tn, Math.min(20, tn.textContent.length));
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return { text: tn.textContent.slice(0, 20), tag: target.tagName };
});
log('selection:', JSON.stringify(selResult));
await wait(500);

const pillVisible = await page.evaluate(() => {
  const p = document.getElementById('anno-pill');
  return p ? { display: p.style.display, x: p.getBoundingClientRect().left } : null;
});
log('pill after select:', JSON.stringify(pillVisible));

// Click pill
const pillClickable = pillVisible && pillVisible.display === 'flex' && pillVisible.x >= 0 && pillVisible.x < 1440;
if (pillClickable) {
  await page.click('#anno-pill');
  await wait(800);
  const q = await page.evaluate(() => ({
    composers: document.querySelectorAll('.anno-composer').length,
    quote: document.querySelector('.anno-composer .quote')?.textContent,
  }));
  log('after pill click:', JSON.stringify(q));

  if (q.composers > 0) {
    const qta = page.locator('.anno-composer textarea').first();
    await qta.fill('Smoke test quote-attached comment');
    await page.click('.anno-composer .send');
    await wait(1500);
    const r = await page.evaluate(() => ({
      cards: document.querySelectorAll('#anno-list .anno-card').length,
      composers: document.querySelectorAll('.anno-composer').length,
    }));
    log('after sending quote comment:', JSON.stringify(r));
  }
}

await page.screenshot({ path: '/tmp/golem-ui-smoke/post-fix.png' });
log('screenshot saved /tmp/golem-ui-smoke/post-fix.png');

await cleanup();
log('done.');
