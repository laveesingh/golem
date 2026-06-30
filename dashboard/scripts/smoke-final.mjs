// smoke-final.mjs — visual + edge case pass
import { chromium } from 'playwright-core';
const log = (...a) => console.log('[f]', ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('127.0.0.1:7420'));
await page.setViewportSize({ width: 1440, height: 900 });
await page.reload({ waitUntil: 'domcontentloaded' });
await wait(2500);

await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-ticket-drawer', { detail: { id: 'TKT-0001' } })));
await wait(2500);

// Check: drawer position, width, scroll
const drawerInfo = await page.evaluate(() => {
  const d = document.querySelector('.drawer-ticket.open');
  const scroll = document.querySelector('.td-scroll');
  const wrap = document.querySelector('.td-annotate-wrap');
  return {
    drawerRect: d ? d.getBoundingClientRect().toJSON() : null,
    scrollOverflowX: scroll ? { sw: scroll.scrollWidth, cw: scroll.clientWidth, overflows: scroll.scrollWidth > scroll.clientWidth } : null,
    wrapOverflowX: wrap ? { sw: wrap.scrollWidth, cw: wrap.clientWidth, overflows: wrap.scrollWidth > wrap.clientWidth } : null,
    bodyViewport: { w: window.innerWidth, h: window.innerHeight },
  };
});
log('drawer info:', JSON.stringify(drawerInfo, null, 2));

// Check the body content - is it rendered as HTML or escaped text?
const bodyInspect = await page.evaluate(() => {
  const body = document.querySelector('.td-md');
  if (!body) return null;
  return {
    tagName: body.tagName,
    childCount: body.childElementCount,
    hasH2: !!body.querySelector('h2'),
    h2Text: body.querySelector('h2')?.textContent?.substring(0, 50),
    hasCode: !!body.querySelector('code'),
    hasSection: !!body.querySelector('section'),
    rawSnippet: body.innerHTML.substring(0, 200),
  };
});
log('body content:', JSON.stringify(bodyInspect, null, 2));

// Test that a long body overflow doesn't break layout
const longTest = await page.evaluate(() => {
  const pre = document.querySelector('.td-md pre');
  const table = document.querySelector('.td-md table');
  return {
    pre: pre ? { sw: pre.scrollWidth, cw: pre.clientWidth, hasScroll: pre.scrollWidth > pre.clientWidth } : null,
    table: table ? { sw: table.scrollWidth, cw: table.clientWidth, hasScroll: table.scrollWidth > table.clientWidth } : null,
  };
});
log('long content overflow:', JSON.stringify(longTest, null, 2));

// Verify the pill position for a selection far down the page
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
await wait(300);
const selDownTest = await page.evaluate(() => {
  const root = document.querySelector('.td-md');
  const allText = Array.from(root.querySelectorAll('h2, h3, p, li')).filter((n) => n.textContent.length > 30);
  const target = allText[Math.floor(allText.length / 2)];
  if (!target) return 'no target';
  const tn = Array.from(target.childNodes).find((n) => n.nodeType === 3);
  if (!tn) return 'no text node';
  const range = document.createRange();
  range.setStart(tn, 0);
  range.setEnd(tn, Math.min(15, tn.textContent.length));
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return { text: tn.textContent.slice(0, 15), tag: target.tagName };
});
log('mid-page selection:', JSON.stringify(selDownTest));
await wait(400);
const pillPos = await page.evaluate(() => {
  const p = document.getElementById('anno-pill');
  if (!p || p.style.display === 'none') return null;
  const r = p.getBoundingClientRect();
  const wrap = document.querySelector('.td-annotate-wrap');
  return {
    pillRect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) },
    wrapRect: { x: Math.round(wrap.getBoundingClientRect().left), w: Math.round(wrap.getBoundingClientRect().width) },
    pillInView: r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight,
  };
});
log('pill pos after mid-page select:', JSON.stringify(pillPos, null, 2));

await page.screenshot({ path: '/tmp/golem-ui-smoke/final.png' });

await browser.close();
log('done.');