// TKT-0198: smoke for the new create-ticket drawer layout + behavior.
// Locks in:
//   1. Top 3 fields (Type / Priority / Template) share a row.
//   2. Standalone "Dispatch to session" field is gone; the Assignee
//      dropdown doubles as the dispatch target.
//   3. Save & Dispatch is enabled exactly when Assignee is a live
//      session; clicking it creates the ticket, dispatches it, and
//      closes the drawer.
//   4. Body textarea has the bottom-right resize handle (TKT-0189
//      removed it; the user wants it back).
//   5. The body auto-fills the available space on first render.
//   6. A user drag is allowed to overflow the .ct-scroll (the body can
//      be grown past the drawer's available space, and the drawer body
//      becomes scrollable).
//
// The smoke uses the real `~/.config/golem/gates/` paths and the real
// /api endpoints, but writes only test tickets which it cleans up in a
// finally.

import { acquireChrome } from './_chrome.mjs';
import { strict as assert } from 'node:assert';

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ── 1. Layout: 3-col top row, no standalone Dispatch field ──────────
  await page.goto('http://dashboard.golem.localhost:7420/tracker', { waitUntil: 'networkidle' });
  await wait(500);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await wait(500);
  await page.locator('button:has-text("New ticket")').first().click();
  await page.waitForSelector('.drawer-compose', { timeout: 5000 });
  await wait(500);

  // Set project (the only required field for stream/assignee to load).
  await page.evaluate(() => {
    const sel = Array.from(document.querySelectorAll('.drawer-compose select.ct-input'))[0];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, 'golem-1eba80');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await wait(500);

  const layout = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.drawer-compose .ct-row'))
      .map((r) => Array.from(r.querySelectorAll('.ct-field label')).map((l) => l.textContent.trim()));
    const standalone = Array.from(document.querySelectorAll('.drawer-compose .ct-field:not(.ct-row .ct-field) > label'))
      .map((l) => l.textContent.trim());
    const hasDispatch = !!document.querySelector('.drawer-compose .ct-dispatch select');
    return { rows, standalone, hasDispatchField: hasDispatch };
  });
  // Top 3 fields share a row.
  assert.deepEqual(layout.rows[0], ['Type', 'Priority', 'Template'], 'Type / Priority / Template on one row');
  // No standalone "Dispatch to session" field anywhere.
  assert.equal(layout.standalone.includes('Dispatch to session'), false, 'no standalone Dispatch field');
  assert.equal(layout.hasDispatchField, false, 'no .ct-dispatch select');

  // ── 2. Resize handle: present, has rows default, adapts on render ──
  const bodyInfo = await page.evaluate(() => {
    const ta = document.querySelector('.drawer-compose textarea');
    return {
      resize: window.getComputedStyle(ta).resize,
      rows: ta.getAttribute('rows'),
      styleHeight: ta.style.height,
    };
  });
  assert.equal(bodyInfo.resize, 'vertical', 'body has resize: vertical');
  assert.ok(parseInt(bodyInfo.styleHeight) > 100, 'body has adaptive inline style.height > 100px');

  // ── 3. Save & Dispatch disabled until a live session is picked ──────
  await page.fill('.drawer-compose input[type="text"]', 'TKT-0198 layout smoke');
  await wait(200);
  const beforeAssignee = await page.evaluate(() => ({
    saveDispatch: Array.from(document.querySelectorAll('.ct-actions button')).find((b) => b.textContent.includes('Save & Dispatch'))?.disabled,
  }));
  assert.equal(beforeAssignee.saveDispatch, true, 'Save & Dispatch disabled when no live session picked');

  // Pick a live session from the Assignee dropdown.
  const liveSession = await page.evaluate(() => {
    const sel = Array.from(document.querySelectorAll('.drawer-compose select.ct-input'))
      .find((s) => s.closest('.ct-field')?.querySelector('label')?.textContent.trim() === 'Assignee');
    const sessions = Array.from(sel.options).filter((o) => o.value && o.value !== '' && o.value !== 'human');
    return sessions[0]?.value;
  });
  assert.ok(liveSession, 'at least one live session in the Assignee dropdown');
  await page.evaluate((v) => {
    const sel = Array.from(document.querySelectorAll('.drawer-compose select.ct-input'))
      .find((s) => s.closest('.ct-field')?.querySelector('label')?.textContent.trim() === 'Assignee');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, v);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, liveSession);
  await wait(400);

  const afterAssignee = await page.evaluate(() => ({
    saveDispatch: Array.from(document.querySelectorAll('.ct-actions button')).find((b) => b.textContent.includes('Save & Dispatch'))?.disabled,
  }));
  assert.equal(afterAssignee.saveDispatch, false, 'Save & Dispatch enabled when Assignee is a live session');

  // ── 4. Resize drag → body grows past the container ─────────────────
  const box = await page.locator('.drawer-compose textarea').boundingBox();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height + 200, { steps: 8 });
  await page.mouse.up();
  await wait(500);

  const afterDrag = await page.evaluate(() => {
    const ta = document.querySelector('.drawer-compose textarea');
    const scroller = document.querySelector('.drawer-compose .ct-scroll');
    return {
      bodyHeight: ta.getBoundingClientRect().height,
      scrollerScrollHeight: scroller.scrollHeight,
      scrollerClientHeight: scroller.clientHeight,
      isScrolling: scroller.scrollHeight > scroller.clientHeight,
    };
  });
  assert.ok(afterDrag.bodyHeight > box.height, 'body height increased after drag');
  assert.equal(afterDrag.isScrolling, true, 'drawer body scrolls when body overflows');

  // ── 5. Save & Dispatch click: ticket created, dispatched, drawer closes ─
  const beforeClickTicketCount = await page.evaluate(() => fetch('/api/tickets?project=golem-1eba80&limit=200').then((r) => r.json()).then((arr) => arr.length));
  await page.click('.ct-actions button:has-text("Save & Dispatch")');
  await wait(2000);
  const afterClick = await page.evaluate(() => ({
    drawerOpen: !!document.querySelector('.drawer-compose'),
    error: document.querySelector('.ct-error')?.textContent,
  }));
  assert.equal(afterClick.drawerOpen, false, 'drawer closes after Save & Dispatch');
  assert.ok(!afterClick.error, 'no error after Save & Dispatch');

  const afterClickTicketCount = await page.evaluate(() => fetch('/api/tickets?project=golem-1eba80&limit=200').then((r) => r.json()).then((arr) => arr.length));
  assert.equal(afterClickTicketCount, beforeClickTicketCount + 1, 'one new ticket created');

  // Find the new ticket by title and check assignee + dispatched_to.
  const newTicket = await page.evaluate(async (title) => {
    const arr = await fetch('/api/tickets?project=golem-1eba80&limit=200').then((r) => r.json());
    return arr.find((t) => t.title === title) || null;
  }, 'TKT-0198 layout smoke');
  assert.ok(newTicket, 'new ticket found by title');
  assert.equal(newTicket.assignee, liveSession, 'new ticket assigned to picked session');
  assert.equal(newTicket.dispatched_to, liveSession, 'new ticket dispatched to picked session');

  console.log(JSON.stringify({ ok: true, layout, bodyInfo, beforeAssignee, afterAssignee, afterDrag, newTicket: { id: newTicket.id, assignee: newTicket.assignee, dispatched_to: newTicket.dispatched_to } }, null, 2));
} finally {
  // Clean up the test ticket.
  try {
    await page.evaluate(async () => {
      const arr = await fetch('/api/tickets?project=golem-1eba80&limit=200').then((r) => r.json());
      const t = arr.find((x) => x.title === 'TKT-0198 layout smoke');
      if (t) await fetch(`/api/tickets/${t.id}`, { method: 'DELETE' }).catch(() => {});
    });
  } catch {}
  await cleanup();
}

console.log('TKT-0198 layout smoke: PASS');
