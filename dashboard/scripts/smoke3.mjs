import { acquireChrome } from './_chrome.mjs';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const { browser, cleanup } = await acquireChrome();
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find((p) => p.url().includes('127.0.0.1:7420') || p.url().includes('dashboard.golem.localhost:7420')); if (!page) { page = await ctx.newPage(); await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' }); };
  /* bringToFront is a no-op on headless Chrome (TKT-0187) */
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (msg) => console.log('[browser]', msg.type(), msg.text()));
  page.on('pageerror', (err) => console.log('[browser-error]', err.message));

  await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' });
  await wait(1500);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-ticket-drawer', { detail: { id: 'TKT-0001' } })));
  await wait(2000);

  // Open rail
  await page.click('#anno-fab');
  await wait(500);

  // Inspect: does the rail actually have the React children?
  const railStructure = await page.evaluate(() => {
    const rail = document.getElementById('anno-rail');
    return {
      classes: rail?.className,
      childCount: rail?.childElementCount,
      html: rail?.innerHTML.substring(0, 500),
    };
  });
  console.log('rail structure:', JSON.stringify(railStructure, null, 2));

  // Click + New directly via the button selector with text
  const newBtnInfo = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#anno-rail .rail-btn'));
    return btns.map((b, i) => ({ i, text: b.textContent.trim(), rect: b.getBoundingClientRect().toJSON() }));
  });
  console.log('rail buttons before click:', JSON.stringify(newBtnInfo, null, 2));

  // Try clicking via Playwright with `force: true` (skip visibility/actionability checks)
  try {
    await page.locator('#anno-rail .rail-btn:has-text("+ New")').click({ force: true, timeout: 5000 });
    console.log('+ New clicked via locator');
  } catch (e) {
    console.log('+ New click error:', e.message);
  }
  await wait(800);

  const after = await page.evaluate(() => {
    const c = document.querySelector('.anno-composer');
    return c ? { yes: true, ta: !!c.querySelector('textarea') } : { yes: false };
  });
  console.log('after + New click:', JSON.stringify(after));

  // Try via direct DOM event dispatch
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#anno-rail .rail-btn')).find((b) => b.textContent.trim() === '+ New');
    if (btn) {
      btn.click();
      console.log('+ New clicked via native click()');
    } else {
      console.log('+ New button not found');
    }
  });
  await wait(800);

  const after2 = await page.evaluate(() => {
    const c = document.querySelector('.anno-composer');
    const allTextareas = document.querySelectorAll('.anno-composer textarea').length;
    return c ? { yes: true, ta: allTextareas } : { yes: false };
  });
  console.log('after native click:', JSON.stringify(after2));

  // Probe: is the React component still mounted? Check that the rail is reactive
  await page.evaluate(() => {
    // Try invoking setShowResolved
    const rail = document.getElementById('anno-rail');
    const resolvedBtn = Array.from(rail.querySelectorAll('.rail-btn')).find((b) => b.textContent.includes('resolved'));
    if (resolvedBtn) {
      const before = resolvedBtn.textContent.trim();
      resolvedBtn.click();
      const after = resolvedBtn.textContent.trim();
      console.log('resolved button before:', before, 'after:', after);
    }
  });
  await wait(400);
  await cleanup();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });