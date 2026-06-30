// smoke-overflow3.mjs — find the child that pushes wrap to 1459
import { chromium } from 'playwright-core';
const log = (...a) => console.log('[o]', ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('127.0.0.1:7420'));
await page.setViewportSize({ width: 1440, height: 900 });
await page.reload({ waitUntil: 'domcontentloaded' });
await wait(2500);
await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-ticket-drawer', { detail: { id: 'TKT-0001' } })));
await wait(2500);

// List direct children of .td-annotate-wrap and check each for inline overflow
const allWide = await page.evaluate(() => {
  const wrap = document.querySelector('.td-annotate-wrap');
  const body = wrap.querySelector('.td-md');
  // Check all elements in the document for scrollWidth > body width
  const cw = body?.clientWidth;
  const out = [];
  document.querySelectorAll('*').forEach((n) => {
    if (n.scrollWidth > cw && n !== body && n !== wrap) {
      out.push({
        tag: n.tagName, class: n.className, id: n.id,
        scrollWidth: n.scrollWidth, clientWidth: n.clientWidth,
        parent: n.parentElement?.className || n.parentElement?.tagName,
        text: n.textContent?.substring(0, 50),
      });
    }
  });
  return out;
});
log('all nodes overflowing:');
for (const w of allWide) log(' -', JSON.stringify(w));

// Specifically: the wrap has scrollWidth 1459. Walk in detail using getBoundingClientRect
const rects = await page.evaluate(() => {
  const wrap = document.querySelector('.td-annotate-wrap');
  const out = [];
  const walk = (n) => {
    const r = n.getBoundingClientRect();
    if (r.right > wrap.getBoundingClientRect().right + 1) {
      out.push({
        tag: n.tagName, class: n.className, id: n.id,
        right: Math.round(r.right), width: Math.round(r.width),
        parent: n.parentElement?.className || n.parentElement?.tagName,
        text: n.textContent?.substring(0, 50),
      });
    }
    for (const c of n.children) walk(c);
  };
  walk(wrap);
  return out;
});
log('nodes extending past wrap right edge:');
for (const w of rects) log(' -', JSON.stringify(w));

await browser.close();
log('done.');