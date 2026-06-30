// smoke-composer.mjs — focused diagnostic for "+ New doesn't open composer" bug.
// Captures rail structure, button clicks, and whether the Composer actually renders.
import { acquireChrome } from './_chrome.mjs';
const log = (...a) => console.log('[s]', ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { browser, cleanup } = await acquireChrome();
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('127.0.0.1:7420') || p.url().includes('dashboard.golem.localhost:7420')); if (!page) { page = await ctx.newPage(); await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' }); } if (!page) { page = await ctx.newPage(); await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' }); }
if (!page) { console.error('NO PAGE'); process.exit(1); }
/* bringToFront is a no-op on headless Chrome (TKT-0187) */
await page.setViewportSize({ width: 1440, height: 900 });

page.on('console', (msg) => log('console.' + msg.type() + ':', msg.text()));
page.on('pageerror', (err) => log('PAGEERROR:', err.message, err.stack?.split('\n').slice(0, 4).join(' | ')));

await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' });
await wait(2000);

// 1. Open TKT-0001
await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-ticket-drawer', { detail: { id: 'TKT-0001' } })));
await wait(2500);

// 2. Open the rail via FAB
log('--- opening rail via FAB ---');
await page.click('#anno-fab');
await wait(800);

// 3. Inspect rail structure thoroughly
const railInfo = await page.evaluate(() => {
  const rail = document.getElementById('anno-rail');
  const list = document.getElementById('anno-list');
  return {
    railClass: rail?.className,
    railOpen: rail?.classList.contains('open'),
    railHTML: rail?.outerHTML.substring(0, 2000),
    listChildCount: list?.childElementCount,
    listFirstChild: list?.firstElementChild?.outerHTML.substring(0, 200),
    composer: !!document.querySelector('.anno-composer'),
    empty: !!document.querySelector('.empty'),
    buttons: Array.from(document.querySelectorAll('#anno-rail .rail-btn')).map((b) => ({
      text: b.textContent.trim(),
      rect: b.getBoundingClientRect().toJSON(),
    })),
  };
});
log('rail info:', JSON.stringify(railInfo, null, 2));

// 4. Click + New via Playwright and check immediately
log('--- clicking + New via Playwright ---');
const newBtn = page.locator('#anno-rail .rail-btn', { hasText: '+ New' });
const newBtnCount = await newBtn.count();
log('+ New locator count:', newBtnCount);
if (newBtnCount > 0) {
  await newBtn.first().click();
  await wait(800);
  const after = await page.evaluate(() => ({
    composer: !!document.querySelector('.anno-composer'),
    composerHTML: document.querySelector('.anno-composer')?.outerHTML.substring(0, 200),
    listChildCount: document.getElementById('anno-list')?.childElementCount,
    listFirstChildTag: document.getElementById('anno-list')?.firstElementChild?.tagName,
    listFirstChildClass: document.getElementById('anno-list')?.firstElementChild?.className,
  }));
  log('after + New:', JSON.stringify(after, null, 2));
}

// 5. Try to type into the composer
const taCount = await page.locator('.anno-composer textarea').count();
log('textarea count:', taCount);

// 6. List all renderable children of #anno-rail
const railChildren = await page.evaluate(() => {
  const rail = document.getElementById('anno-rail');
  return Array.from(rail.children).map((c) => ({ tag: c.tagName, id: c.id, class: c.className, kids: c.childElementCount }));
});
log('rail direct children:', JSON.stringify(railChildren, null, 2));

// 7. List all renderable children of #anno-list
const listChildren = await page.evaluate(() => {
  const list = document.getElementById('anno-list');
  return Array.from(list.children).map((c) => ({ tag: c.tagName, id: c.id, class: c.className, html: c.outerHTML.substring(0, 150) }));
});
log('list children:', JSON.stringify(listChildren, null, 2));

await cleanup();
log('done.');
