// smoke-reply.mjs — verify reply flow works after the Composer fix
import { acquireChrome } from './_chrome.mjs';
const log = (...a) => console.log('[r]', ...a);
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

const firstCard = page.locator('#anno-list .anno-card').first();
const cardId = await firstCard.getAttribute('data-id');
log('first card id:', cardId);

const replyCountBefore = await firstCard.locator('.reply').count();
log('reply count before:', replyCountBefore);

await firstCard.locator('button', { hasText: 'Reply' }).first().click();
await wait(500);

// Inspect the composer that opened
const composerInfo = await page.evaluate((cid) => {
  const card = document.querySelector(`.anno-card[data-id="${cid}"]`);
  const composer = card?.querySelector('.anno-composer');
  if (!composer) return { hasComposer: false };
  return {
    hasComposer: true,
    composerInCard: !!composer.closest(`.anno-card[data-id="${cid}"]`),
    composerHTML: composer.outerHTML.substring(0, 300),
    taCount: composer.querySelectorAll('textarea').length,
    sendBtn: !!composer.querySelector('.send'),
  };
}, cardId);
log('composer info:', JSON.stringify(composerInfo, null, 2));

// Fill and send
const ta = firstCard.locator('.anno-composer textarea');
const taCount = await ta.count();
log('reply textarea count:', taCount);
if (taCount > 0) {
  await ta.first().fill('Smoke reply #1');
  await wait(300);
  await firstCard.locator('.anno-composer .send').first().click();
  await wait(1500);
}

const replyCountAfter = await firstCard.locator('.reply').count();
log('reply count after:', replyCountAfter);
const cardHtml = await firstCard.evaluate((el) => el.outerHTML.substring(0, 1500));
log('card html after reply:', cardHtml);

await page.screenshot({ path: '/tmp/golem-ui-smoke/reply-test.png' });
log('screenshot saved');

await cleanup();
log('done.');
