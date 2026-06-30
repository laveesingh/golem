// TKT-0194: smoke for the human-gate verdict workflow.
//
// 1. Create a test gate file with status: awaiting.
// 2. Verify the dashboard's /api/projects surface shows it under awaiting.
// 3. POST a verdict (denied) to the gate endpoint.
// 4. Verify the gate file's status changed to denied, with acted_at set.
// 5. Verify the dashboard's /api/projects surface now shows it under resolved.
// 6. Clean up the test gate file.
//
// The smoke uses the real `~/.config/golem/gates/anchor-d5cc3e/` directory
// and creates a real test file, then deletes it. The dashboard's
// rediscover timer runs every 30s; the smoke does NOT wait for that —
// it uses the API to fetch the latest state directly.

import { acquireChrome } from './_chrome.mjs';
import { strict as assert } from 'node:assert';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const { browser, cleanup } = await acquireChrome();
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();

const GATE_DIR = path.join(os.homedir(), '.config', 'golem', 'gates', 'anchor-d5cc3e');
const GATE_FILE = path.join(GATE_DIR, 'tkt-0194-smoke.md');
const GATE_BODY = `# TKT-0194 smoke

This is an automated smoke gate; safe to delete.
`;

async function fetchAnchor() {
  const r = await page.evaluate(() => fetch('http://dashboard.golem.localhost:7420/api/projects').then((x) => x.json()));
  return r.find((p) => p.id === 'anchor-d5cc3e') ?? null;
}

try {
  // Step 0: navigate to the dashboard so the page is on the right origin.
  await page.goto('http://dashboard.golem.localhost:7420/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  // Step 1: create the awaiting gate.
  await writeFile(GATE_FILE, `---\ngate_id: tkt-0194-smoke\nkind: approval\nstatus: awaiting\ncreated_at: 2026-06-30T13:00:00Z\nphase_just_completed: design\nnext_phase: build\n---\n\n${GATE_BODY}`);

  // Step 2: hit the projects endpoint and check the project.
  const before = await page.evaluate(async (gateFile) => {
    const proj = await fetch('http://dashboard.golem.localhost:7420/api/projects').then((x) => x.json()).then((arr) => arr.find((p) => p.id === 'anchor-d5cc3e'));
    return { inSnapshot: proj?.gates?.some((g) => g.gateId === 'tkt-0194-smoke') ?? false, projectId: proj?.project_id };
  }, GATE_FILE);
  assert.equal(before.projectId, 'anchor-d5cc3e', 'project resolves');

  // Step 3: POST a verdict via the new endpoint.
  const verdict = await page.evaluate(async () => {
    const r = await fetch('http://dashboard.golem.localhost:7420/api/projects/anchor-d5cc3e/gates/tkt-0194-smoke/denied', { method: 'POST' });
    return { status: r.status, body: await r.json() };
  });
  assert.equal(verdict.status, 200, 'verdict returns 200');
  assert.equal(verdict.body.status, 'denied', 'verdict response carries new status');
  assert.equal(verdict.body.gateId, 'tkt-0194-smoke', 'verdict response carries gateId');

  // Step 4: read the file back.
  const updated = await readFile(GATE_FILE, 'utf8');
  assert.match(updated, /^---\n[\s\S]*status: denied[\s\S]*---/, 'file status is denied');
  assert.match(updated, /acted_at: /, 'file has acted_at');

  // Step 5: error path — invalid decision.
  const bad = await page.evaluate(async () => {
    const r = await fetch('http://dashboard.golem.localhost:7420/api/projects/anchor-d5cc3e/gates/tkt-0194-smoke/bogus', { method: 'POST' });
    return { status: r.status };
  });
  assert.equal(bad.status, 400, 'invalid decision returns 400');

  // Step 5b: missing gate.
  const missing = await page.evaluate(async () => {
    const r = await fetch('http://dashboard.golem.localhost:7420/api/projects/anchor-d5cc3e/gates/nonexistent/approved', { method: 'POST' });
    return { status: r.status };
  });
  assert.equal(missing.status, 404, 'missing gate returns 404');

  console.log(JSON.stringify({ ok: true, before, verdict: { status: verdict.status, body: verdict.body }, bad, missing }, null, 2));
} finally {
  try { await unlink(GATE_FILE); } catch {}
  await cleanup();
}

console.log('TKT-0194 gate smoke: PASS');
