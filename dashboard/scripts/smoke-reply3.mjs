// smoke-reply3.mjs — instrument the AnnoComposer to log the onSend payload
import { acquireChrome } from './_chrome.mjs';
const log = (...a) => console.log('[r3]', ...a);
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

// Hook the global fetch to log /comments/.../reply calls
await page.evaluate(() => {
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const url = String(args[0]);
    if (url.includes('/reply') || url.includes('/comments')) {
      const opts = args[1] || {};
      let body = null;
      try { body = opts.body ? JSON.parse(opts.body) : null; } catch {}
      console.log('[FETCH]', opts.method || 'GET', url, JSON.stringify(body));
    }
    return origFetch(...args);
  };
});

page.on('console', (msg) => {
  if (msg.text().startsWith('[FETCH]')) log('console:', msg.text());
});

const firstCard = page.locator('#anno-list .anno-card').first();
const cardId = await firstCard.getAttribute('data-id');
log('replying on card:', cardId);

await firstCard.locator('button', { hasText: 'Reply' }).first().click();
await wait(500);
await firstCard.locator('.anno-composer textarea').first().fill('Smoke reply trace');
await wait(300);
await firstCard.locator('.anno-composer .send').first().click();
await wait(1500);

// Read the network call result
const fetchLog = await page.evaluate(() => {
  // The fetch hook already printed. Now check the latest reply on the server.
  return fetch('/api/tickets/TKT-0001').then((r) => r.json()).then((d) => d.comments.filter((c) => c.parent_id));
});
log('server-side replies (should contain "Smoke reply trace"):');
for (const c of fetchLog) {
  log(' -', c.id.slice(0, 8), 'body:', c.body, 'parent:', c.parent_id?.slice(0, 8));
}

await cleanup();
log('done.');
