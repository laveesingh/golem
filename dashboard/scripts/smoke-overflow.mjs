// smoke-overflow.mjs — find the 1459px-wide element inside the wrap
import { acquireChrome } from './_chrome.mjs';
const log = (...a) => console.log('[o]', ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { browser, cleanup } = await acquireChrome();
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('127.0.0.1:7420'));
await page.setViewportSize({ width: 1440, height: 900 });
await page.reload({ waitUntil: 'domcontentloaded' });
await wait(2500);

await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-ticket-drawer', { detail: { id: 'TKT-0001' } })));
await wait(2500);

// Find all elements inside the wrap whose offsetWidth > wrap.clientWidth
const wide = await page.evaluate(() => {
  const wrap = document.querySelector('.td-annotate-wrap');
  if (!wrap) return [];
  const out = [];
  const visit = (n) => {
    const r = n.getBoundingClientRect();
    if (r.width > wrap.clientWidth + 1) {
      out.push({ tag: n.tagName, class: n.className, id: n.id, w: Math.round(r.width), rect: r.toJSON(), text: n.textContent?.substring(0, 60) });
    }
    for (const c of n.children) visit(c);
  };
  visit(wrap);
  return out;
});
log('elements wider than wrap.clientWidth (1099):');
for (const w of wide) log(' -', JSON.stringify(w));

// Walk top-level direct children of .td-md
const topChildren = await page.evaluate(() => {
  const body = document.querySelector('.td-md');
  if (!body) return [];
  return Array.from(body.children).map((c) => {
    const r = c.getBoundingClientRect();
    return {
      tag: c.tagName, class: c.className, w: Math.round(r.width), h: Math.round(r.height),
      text: c.textContent?.substring(0, 50), childCount: c.childElementCount,
    };
  });
});
log('top-level body children:', JSON.stringify(topChildren, null, 2));

// Check overall body structure
const bodyHTML = await page.evaluate(() => document.querySelector('.td-md')?.outerHTML.substring(0, 2000));
log('body html snippet:', bodyHTML);

await cleanup();
log('done.');