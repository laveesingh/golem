// smoke-cleanup.mjs — clean up test data, then final visual
import { acquireChrome } from './_chrome.mjs';
const log = (...a) => console.log('[c]', ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { browser, cleanup } = await acquireChrome();
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('127.0.0.1:7420'));
await page.setViewportSize({ width: 1440, height: 900 });

// Use direct API to clean up test artifacts
const cleanup = await page.evaluate(async () => {
  const ticket = await fetch('/api/tickets/TKT-0001').then((r) => r.json());
  const empty = (ticket.comments || []).filter((c) => !c.body && !c.quote);
  let removed = 0;
  for (const c of empty) {
    await fetch(`/api/tickets/TKT-0001/comments/${c.id}`, { method: 'DELETE' }).catch(() => {});
    removed++;
  }
  return { removed, totalBefore: ticket.comments.length };
});
log('cleanup:', JSON.stringify(cleanup));

await page.reload({ waitUntil: 'domcontentloaded' });
await wait(2500);
await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-ticket-drawer', { detail: { id: 'TKT-0001' } })));
await wait(2500);
await page.click('#anno-fab');
await wait(800);

const counts = await page.evaluate(() => ({
  cards: document.querySelectorAll('#anno-list .anno-card').length,
  withReplies: Array.from(document.querySelectorAll('#anno-list .anno-card')).filter((c) => c.querySelector(':scope > .reply')).length,
  totalReplies: document.querySelectorAll('#anno-list .reply').length,
}));
log('final counts:', JSON.stringify(counts));

await page.screenshot({ path: '/tmp/golem-ui-smoke/clean.png' });
await cleanup();
log('done.');