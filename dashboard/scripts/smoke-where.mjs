// smoke-where.mjs — find where the ceo-composer form is being rendered in DOM tree
import { acquireChrome } from './_chrome.mjs';
const log = (...a) => console.log('[s]', ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { browser, cleanup } = await acquireChrome();
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('127.0.0.1:7420') || p.url().includes('dashboard.golem.localhost:7420')); if (!page) { page = await ctx.newPage(); await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' }); } if (!page) { page = await ctx.newPage(); await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' }); }
/* bringToFront is a no-op on headless Chrome (TKT-0187) */
await page.setViewportSize({ width: 1440, height: 900 });

await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' });
await wait(2000);

await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-ticket-drawer', { detail: { id: 'TKT-0001' } })));
await wait(2500);

// Find ALL forms in DOM and their full ancestor chain
const formsInfo = await page.evaluate(() => {
  const forms = Array.from(document.querySelectorAll('form'));
  return forms.map((f) => {
    const chain = [];
    let n = f;
    while (n && chain.length < 12) {
      chain.push(`${n.tagName}${n.id ? '#' + n.id : ''}${n.className ? '.' + String(n.className).split(/\s+/).slice(0,2).join('.') : ''}`);
      n = n.parentElement;
    }
    return { classes: f.className, chain };
  });
});
log('FORMS:', JSON.stringify(formsInfo, null, 2));

// Count ceo-composer instances
const ceoCount = await page.locator('.ceo-composer').count();
log('ceo-composer count:', ceoCount);

// Are any ceo-composers inside anno-list?
const ceoInAnno = await page.evaluate(() => {
  const anno = document.getElementById('anno-list');
  return Array.from(anno?.querySelectorAll('.ceo-composer') || []).length;
});
log('ceo-composer inside #anno-list:', ceoInAnno);

// Open rail, click + New, then check again
await page.click('#anno-fab');
await wait(500);

log('--- after FAB, before + New ---');
log('anno-list child count:', await page.evaluate(() => document.getElementById('anno-list')?.childElementCount));
log('ceo-composer count:', await page.locator('.ceo-composer').count());

// Click + New
await page.locator('#anno-rail .rail-btn', { hasText: '+ New' }).first().click();
await wait(800);

log('--- after + New ---');
log('anno-list child count:', await page.evaluate(() => document.getElementById('anno-list')?.childElementCount));
log('ceo-composer count:', await page.locator('.ceo-composer').count());
log('anno-composer count:', await page.locator('.anno-composer').count());

// What's the structure of anno-list after?
const list = await page.evaluate(() => Array.from(document.getElementById('anno-list').children).map((c) => ({
  tag: c.tagName, class: c.className, isInside: !!c.closest('.ceo-composer'),
})));
log('list after:', JSON.stringify(list, null, 2));

// What does the full ceo-composer form parent chain look like NOW?
const formChain = await page.evaluate(() => {
  const ceos = Array.from(document.querySelectorAll('.ceo-composer'));
  return ceos.map((c) => {
    const chain = [];
    let n = c;
    while (n && chain.length < 12) {
      chain.push(`${n.tagName}${n.id ? '#' + n.id : ''}${n.className ? '.' + String(n.className).split(/\s+/).slice(0,2).join('.') : ''}`);
      n = n.parentElement;
    }
    return chain;
  });
});
log('ceo-composer chains:', JSON.stringify(formChain, null, 2));

await cleanup();
log('done.');