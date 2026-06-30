// smoke-grouping.mjs — verify reply grouping visually (no focus stealing)
import { acquireChrome } from './_chrome.mjs';
const log = (...a) => console.log('[g]', ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { browser, cleanup } = await acquireChrome();
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('127.0.0.1:7420') || p.url().includes('dashboard.golem.localhost:7420')); if (!page) { page = await ctx.newPage(); await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' }); } if (!page) { page = await ctx.newPage(); await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' }); }
await page.setViewportSize({ width: 1440, height: 900 });
await page.reload({ waitUntil: 'domcontentloaded' });
await wait(2500);

await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-ticket-drawer', { detail: { id: 'TKT-0001' } })));
await wait(2500);
await page.click('#anno-fab');
await wait(800);

const topLevelCount = await page.locator('#anno-list .anno-card').count();
log('top-level cards:', topLevelCount);

const cardsWithReplies = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('#anno-list .anno-card')).map((c) => ({
    id: c.dataset.id?.slice(0, 8),
    replies: c.querySelectorAll(':scope > .reply').length,
    replyTexts: Array.from(c.querySelectorAll(':scope > .reply .body')).map((b) => b.textContent),
  }));
});
log('cards with replies:', JSON.stringify(cardsWithReplies, null, 2));

await page.screenshot({ path: '/tmp/golem-ui-smoke/grouping.png' });
log('screenshot saved');

await cleanup();
log('done.');
