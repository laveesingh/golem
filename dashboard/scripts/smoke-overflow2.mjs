// smoke-overflow2.mjs — exhaustive walk
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

// Walk every leaf node and find offsetWidth > wrap.clientWidth
const wide = await page.evaluate(() => {
  const wrap = document.querySelector('.td-annotate-wrap');
  if (!wrap) return [];
  const out = [];
  const walk = (n) => {
    // Use scrollWidth which catches overflowing inline content even on text nodes
    if (n.scrollWidth > wrap.clientWidth) {
      const r = n.getBoundingClientRect();
      out.push({
        tag: n.tagName, class: n.className, id: n.id,
        scrollWidth: n.scrollWidth, clientWidth: n.clientWidth, rectWidth: Math.round(r.width),
        text: (n.textContent || '').substring(0, 80).replace(/\n/g, '\\n'),
      });
    }
    for (const c of n.children) walk(c);
  };
  walk(wrap);
  return out;
});
log('nodes with scrollWidth > 1099:');
for (const w of wide) log(' -', JSON.stringify(w));

// Specifically check code elements
const codes = await page.evaluate(() => Array.from(document.querySelectorAll('.td-md code')).map((c) => ({
  text: c.textContent,
  scrollWidth: c.scrollWidth,
  clientWidth: c.clientWidth,
})));
log('code elements:', JSON.stringify(codes, null, 2));

await browser.close();
log('done.');