// smoke-reply2.mjs — tight reply test, single composer
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

// List all composers and their parent contexts
const composersBefore = await page.evaluate(() => Array.from(document.querySelectorAll('.anno-composer')).map((c) => ({
  inCard: c.closest('.anno-card')?.dataset.id,
  taValue: c.querySelector('textarea')?.value,
})));
log('composers before:', JSON.stringify(composersBefore));

// Click Reply on FIRST card
const firstCard = page.locator('#anno-list .anno-card').first();
const cardId = await firstCard.getAttribute('data-id');
log('clicking Reply on card:', cardId);
await firstCard.locator('button', { hasText: 'Reply' }).first().click();
await wait(500);

const composersAfterReply = await page.evaluate((cid) => Array.from(document.querySelectorAll('.anno-composer')).map((c) => ({
  inCard: c.closest('.anno-card')?.dataset.id,
  matchesTarget: c.closest('.anno-card')?.dataset.id === cid,
  taValue: c.querySelector('textarea')?.value,
  taPlaceholder: c.querySelector('textarea')?.placeholder,
})), cardId);
log('composers after reply click:', JSON.stringify(composersAfterReply, null, 2));

// Fill the target composer's textarea
const targetTa = firstCard.locator('.anno-composer textarea');
await targetTa.first().fill('Smoke reply tight #1');
await wait(300);
const filled = await page.evaluate((cid) => {
  const c = document.querySelector(`.anno-card[data-id="${cid}"] .anno-composer textarea`);
  return c?.value;
}, cardId);
log('filled value:', filled);

await firstCard.locator('.anno-composer .send').first().click();
await wait(1500);

const replyCount = await firstCard.locator('.reply').count();
log('reply count after send:', replyCount);

const cardHtml = await firstCard.evaluate((el) => el.outerHTML);
log('card html:', cardHtml.substring(0, 2000));

// Check server side
const serverState = await page.evaluate(async () => {
  const r = await fetch('/api/tickets/TKT-0001');
  const d = await r.json();
  return d.comments.find((c) => c.id === 'aa678213-ce5b-4937-9254-bdcaacefde0e');
});
log('server card aa678213:', JSON.stringify(serverState));

await cleanup();
log('done.');
