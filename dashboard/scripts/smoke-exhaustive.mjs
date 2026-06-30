// smoke-exhaustive.mjs — full browser walkthrough, hunting for bugs
import { acquireChrome } from './_chrome.mjs';
import fs from 'node:fs';
const OUT = '/tmp/golem-ui-smoke';
const log = (...a) => console.log('[x]', ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { browser, cleanup } = await acquireChrome();
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('127.0.0.1:7420') || p.url().includes('dashboard.golem.localhost:7420')); if (!page) { page = await ctx.newPage(); await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' }); } if (!page) { page = await ctx.newPage(); await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' }); }
/* bringToFront is a no-op on headless Chrome (TKT-0187) */
await page.setViewportSize({ width: 1440, height: 900 });
const shot = (n) => page.screenshot({ path: `${OUT}/x-${n}.png`, fullPage: false });

const errors = [];
page.on('pageerror', (err) => { errors.push(err.message); log('PAGEERROR:', err.message); });
page.on('console', (msg) => {
  if (msg.type() === 'error') { errors.push(msg.text()); log('CONSOLE.ERR:', msg.text()); }
});

await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' });
await wait(2000);
await shot('01-home');

// Open TKT-0001
await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-ticket-drawer', { detail: { id: 'TKT-0001' } })));
await wait(2500);
await shot('02-drawer');

// Open rail
await page.click('#anno-fab');
await wait(500);
await shot('03-rail-open');

// Test 1: Click resolve on first open card
const firstCard = page.locator('#anno-list .anno-card').first();
const beforeResolve = await firstCard.evaluate((el) => ({ id: el.dataset.id, hasResolvedClass: el.classList.contains('resolved') }));
log('card before resolve:', JSON.stringify(beforeResolve));
const resolveBtn = firstCard.locator('button', { hasText: 'Resolve' });
const resolveCount = await resolveBtn.count();
log('resolve button count:', resolveCount);
if (resolveCount > 0) {
  await resolveBtn.first().click();
  await wait(500);
  const afterResolve = await firstCard.evaluate((el) => ({ id: el.dataset.id, hasResolvedClass: el.classList.contains('resolved'), html: el.outerHTML.substring(0, 200) }));
  log('card after resolve:', JSON.stringify(afterResolve));
  await shot('04-after-resolve');
  // Reopen
  await firstCard.locator('button', { hasText: 'Reopen' }).first().click();
  await wait(500);
  await shot('05-after-reopen');
}

// Test 2: Tag picker
const tagChip = firstCard.locator('.anno-tag.clickable').first();
const tagCount = await tagChip.count();
log('tag chip count:', tagCount);
if (tagCount > 0) {
  await tagChip.click();
  await wait(300);
  const tagPicker = await page.evaluate(() => {
    const inline = document.querySelector('.anno-tagrow.inline');
    return inline ? { visible: true, chips: Array.from(inline.querySelectorAll('.anno-tagchip')).map((c) => c.textContent.trim()) } : null;
  });
  log('tag picker:', JSON.stringify(tagPicker));
  await shot('06-tag-picker');
  // Pick a different tag (e.g., "Fix")
  const fixBtn = page.locator('.anno-tagrow.inline .anno-tagchip', { hasText: 'Fix' });
  if (await fixBtn.count() > 0) {
    await fixBtn.first().click();
    await wait(500);
    const newTag = await firstCard.locator('.anno-tag.clickable').first().textContent();
    log('new tag text:', newTag.trim());
    await shot('07-after-tag-change');
  }
}

// Test 3: Reply flow
const replyBtn = firstCard.locator('button', { hasText: 'Reply' });
if (await replyBtn.count() > 0) {
  await replyBtn.first().click();
  await wait(400);
  const replyTa = page.locator('.anno-card .anno-composer textarea').first();
  const replyTaCount = await replyTa.count();
  log('reply textarea count:', replyTaCount);
  if (replyTaCount > 0) {
    await replyTa.fill('Smoke test reply');
    await page.locator('.anno-card .anno-composer .send').first().click();
    await wait(800);
    const replyCount = await firstCard.locator('.reply').count();
    log('reply count after send:', replyCount);
    await shot('08-after-reply');
  }
}

// Test 4: Delete a comment (use the last one to not lose the first for the rest)
const lastCard = page.locator('#anno-list .anno-card').last();
const beforeDeleteCount = await page.locator('#anno-list .anno-card').count();
log('cards before delete:', beforeDeleteCount);
await lastCard.locator('button', { hasText: 'Delete' }).first().click();
await wait(800);
const afterDeleteCount = await page.locator('#anno-list .anno-card').count();
log('cards after delete:', afterDeleteCount);
await shot('09-after-delete');

// Test 5: Hide resolved toggle
const hideBtn = page.locator('#anno-rail .rail-btn', { hasText: 'Hide resolved' });
if (await hideBtn.count() > 0) {
  await hideBtn.first().click();
  await wait(400);
  const visAfterHide = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#anno-list .anno-card'));
    return cards.map((c) => ({ id: c.dataset.id, resolved: c.classList.contains('resolved') }));
  });
  log('cards visible after hide-resolved:', JSON.stringify(visAfterHide));
  await shot('10-hide-resolved');
  // Toggle back
  const showBtn = page.locator('#anno-rail .rail-btn', { hasText: 'Show resolved' });
  if (await showBtn.count() > 0) await showBtn.first().click();
  await wait(400);
}

// Test 6: Body edit dialog
const editBtn = page.locator('.td-edit-btn');
const editBtnCount = await editBtn.count();
log('edit button count:', editBtnCount);
if (editBtnCount > 0) {
  await editBtn.first().click();
  await wait(400);
  const editDialog = await page.evaluate(() => {
    const titleInput = document.querySelector('input[placeholder="Title"]');
    const bodyArea = document.querySelector('textarea[placeholder*="Body"]');
    return { hasTitle: !!titleInput, hasBody: !!bodyArea, titleVal: titleInput?.value, bodyLen: bodyArea?.value?.length };
  });
  log('edit dialog:', JSON.stringify(editDialog));
  await shot('11-edit-dialog');
  // Cancel
  await page.locator('button', { hasText: 'Cancel' }).first().click();
  await wait(400);
}

// Test 7: Scroll long body — check for overflow
const overflow = await page.evaluate(() => {
  const wrap = document.querySelector('.td-annotate-wrap');
  const scroll = document.querySelector('.td-scroll');
  if (!wrap) return null;
  return {
    wrapScrollWidth: wrap.scrollWidth,
    wrapClientWidth: wrap.clientWidth,
    hasHorizontalScroll: wrap.scrollWidth > wrap.clientWidth,
    scrollOverflow: scroll ? { sw: scroll.scrollWidth, cw: scroll.clientWidth, hsw: scroll.scrollWidth > scroll.clientWidth } : null,
  };
});
log('overflow check:', JSON.stringify(overflow, null, 2));

// Test 8: Close drawer + reopen
const closeBtn = page.locator('.drawer-close').first();
if (await closeBtn.count() > 0) {
  await closeBtn.first().click();
  await wait(500);
  const drawerOpen = await page.evaluate(() => document.querySelector('.drawer-ticket')?.classList.contains('open'));
  log('drawer open after close:', drawerOpen);
  await shot('12-closed');
  // Reopen
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-ticket-drawer', { detail: { id: 'TKT-0001' } })));
  await wait(2000);
  await shot('13-reopened');
}

// Test 9: Mobile viewport
await page.setViewportSize({ width: 390, height: 844 });
await wait(500);
await shot('14-mobile');
const mobileDrawer = await page.evaluate(() => {
  const d = document.querySelector('.drawer-ticket.open');
  if (!d) return null;
  const r = d.getBoundingClientRect();
  return { left: r.left, width: r.width, viewport: window.innerWidth };
});
log('mobile drawer rect:', JSON.stringify(mobileDrawer));

// Test 10: Page error count
log('TOTAL ERRORS:', errors.length);
if (errors.length > 0) {
  log('errors:');
  for (const e of errors) log(' -', e);
}

await cleanup();
log('done.');
