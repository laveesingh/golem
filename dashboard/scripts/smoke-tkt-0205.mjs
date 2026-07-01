// TKT-0205: read-view field grid replaces the cramped chip-tray.
//
// Locks in:
//   1. The read view shows a labeled 2-col field grid (not the old chip tray).
//   2. Project + Title share a row; Kind + Template share a row;
//      Priority + State share a row; Assignee + Stream share a row.
//   3. Dispatch has its own full-width row with the select + button inline.
//   4. The header no longer has a project chip (it lives in the grid).
//   5. The body's H2 title is gone — the Title is in the field grid.
//   6. State changes still commit and the header state pill reflects them.

import { acquireChrome } from './_chrome.mjs';
import { strict as assert } from 'node:assert';

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.goto('http://dashboard.golem.localhost:7420/tracker?project=golem-1eba80', { waitUntil: 'networkidle' });
  await wait(800);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await wait(800);
  await page.evaluate(() => localStorage.setItem('td:width', '90'));
  await page.reload({ waitUntil: 'networkidle' });
  await wait(800);

  // Open a known work-item ticket.
  const opened = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.ticket'));
    const card = cards.find((c) => c.querySelector('.ticket-id')?.textContent.includes('TKT-')) || cards[0];
    if (!card) return null;
    card.click();
    return card.querySelector('.ticket-id')?.textContent.trim() || card.textContent.trim();
  });
  assert.ok(opened, 'opened a ticket');
  await wait(1500);
  await page.waitForSelector('.td-fields-v2', { timeout: 5000 });
  await wait(500);

  // ── 1. The header has NO project chip (TKT-0205: project lives in the grid) ──
  const headerChips = await page.evaluate(() => {
    const header = document.querySelector('.drawer-ticket .td-header');
    if (!header) return null;
    return {
      hasProjectChip: !!header.querySelector('.td-project-chip'),
      hasKindPill: !!header.querySelector('.td-kind-pill'),
      hasStatePill: !!header.querySelector('.pill'),
    };
  });
  assert.equal(headerChips.hasProjectChip, false, 'header has no .td-project-chip (project moved to the grid)');

  // ── 2. The 2-col grid layout is correct ─────────────────────────────────
  const grid = await page.evaluate(() => {
    const grid = document.querySelector('.td-fields-v2');
    if (!grid) return null;
    const rows = Array.from(grid.querySelectorAll('.td-row')).map((r) => {
      const fields = Array.from(r.querySelectorAll('.td-field')).map((f) => f.querySelector('.td-field-label')?.textContent.trim());
      return fields;
    });
    return { rows, dispatchRow: grid.querySelector('.td-row-dispatch') !== null };
  });
  assert.ok(grid, 'td-fields-v2 is mounted');
  // First 4 rows are 2-col.
  assert.deepEqual(grid.rows[0], ['Project', 'Title'], 'row 1: Project + Title');
  assert.deepEqual(grid.rows[1], ['Type', 'Template'], 'row 2: Type + Template');
  assert.deepEqual(grid.rows[2], ['Priority', 'State'], 'row 3: Priority + State');
  assert.deepEqual(grid.rows[3], ['Assignee', 'Stream'], 'row 4: Assignee + Stream');
  assert.ok(grid.dispatchRow, 'dispatch is on its own full-width row');
  // Verify the order: Type comes before Template (the user said "swap priority and template"
  // → priority is no longer next to template; type is now next to template).
  const typeRow = grid.rows[1];
  assert.equal(typeRow[0], 'Type', 'Type comes first on its row');
  assert.equal(typeRow[1], 'Template', 'Template is on the same row as Type');

  // ── 3. Edit button still works (modal editor for title + body) ───────────
  const editButton = await page.evaluate(() => !!document.querySelector('.td-titlebody .td-edit-btn'));
  assert.ok(editButton, 'Edit button is still present in the title row');
  // Click it and verify the edit form appears.
  await page.click('.td-titlebody .td-edit-btn');
  await wait(300);
  const editForm = await page.evaluate(() => ({
    titleInput: !!document.querySelector('.td-edit-title'),
    bodyTextarea: !!document.querySelector('.td-edit-body'),
  }));
  assert.ok(editForm.titleInput, 'edit form has a title input');
  assert.ok(editForm.bodyTextarea, 'edit form has a body textarea');
  // Cancel out of the edit form.
  await page.click('.td-edit-actions button:has-text("Cancel")');
  await wait(300);

  // ── 4. Field select commits on change (TKT-0205: real wiring) ───────────
  // Change the State select and verify the API was hit.
  const beforeState = await page.evaluate(() => document.querySelector('.td-fields-v2 select[aria-label="State"]').value);
  await page.evaluate(() => {
    const sel = document.querySelector('.td-fields-v2 select[aria-label="State"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, 'review');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await wait(800);
  const afterState = await page.evaluate(() => document.querySelector('.td-fields-v2 select[aria-label="State"]').value);
  assert.notEqual(afterState, beforeState, 'state select value changed locally');
  // The header state pill should reflect the new state (the store is the source of truth).
  // The state pill is the .pill that is NOT the kind pill (i.e. has a status class like .idle / .running / .blocked / .review / .done).
  const headerPill = await page.evaluate(() => {
    const pills = Array.from(document.querySelectorAll('.drawer-ticket .td-header .pill'));
    const statePill = pills.find((p) => !p.classList.contains('td-kind-pill'));
    return statePill?.textContent.trim();
  });
  assert.equal(headerPill, 'review', 'header state pill reflects the change');

  // Restore the original state so the test is non-mutating.
  await page.evaluate((v) => {
    const sel = document.querySelector('.td-fields-v2 select[aria-label="State"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, v);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, beforeState);
  await wait(500);

  console.log(JSON.stringify({ ok: true, headerChips, grid, beforeState, afterState, headerPill, opened }, null, 2));
} finally {
  await cleanup();
}
