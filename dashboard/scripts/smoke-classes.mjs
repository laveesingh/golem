// smoke-classes.mjs — pin down whether the second ceo-composer is a DOM move
// or a class collision. Check the actual textarea inside the form within #anno-list.
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
await page.click('#anno-fab');
await wait(500);

await page.locator('#anno-rail .rail-btn', { hasText: '+ New' }).first().click();
await wait(800);

// Dump EVERYTHING inside #anno-list, including attribute details
const annoList = await page.evaluate(() => {
  const list = document.getElementById('anno-list');
  return Array.from(list.children).map((c) => ({
    tag: c.tagName,
    className: c.className,
    attrs: Array.from(c.attributes).map((a) => `${a.name}="${a.value.substring(0, 80)}"`),
    innerHTML: c.innerHTML.substring(0, 400),
    parentClass: c.parentElement?.className,
    parentId: c.parentElement?.id,
  }));
});
log('anno-list children detail:', JSON.stringify(annoList, null, 2));

// Is the form's textarea actually the ceo-composer-input?
const taDetail = await page.evaluate(() => {
  const list = document.getElementById('anno-list');
  const ta = list?.querySelector('textarea');
  if (!ta) return null;
  return {
    class: ta.className,
    placeholder: ta.placeholder,
    parentClass: ta.parentElement?.className,
    parentTag: ta.parentElement?.tagName,
    grandParent: ta.parentElement?.parentElement?.className,
  };
});
log('textarea inside #anno-list:', JSON.stringify(taDetail, null, 2));

// Try clicking the form's "Send" button and see if anything happens
const sendBtnInfo = await page.evaluate(() => {
  const list = document.getElementById('anno-list');
  const btn = list?.querySelector('button[type="submit"], button.orch-btn');
  return btn ? { text: btn.textContent.trim(), type: btn.type, class: btn.className } : null;
});
log('send button in list:', JSON.stringify(sendBtnInfo));

// What's the React keys (data-id or any)?
const reactKeys = await page.evaluate(() => {
  const list = document.getElementById('anno-list');
  return Array.from(list.children).map((c) => ({
    tag: c.tagName,
    cls: c.className,
    fiberKey: Object.keys(c).find((k) => k.startsWith('__reactFiber')),
  }));
});
log('react fiber on each:', JSON.stringify(reactKeys));

await cleanup();
log('done.');
