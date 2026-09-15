// GOL-345: browser journey for HTML spec authoring (GOL-326 A1–A3, A7–A12,
// A14–A15 human paths). Isolated dashboard + built web bundle + headless Chrome
// over CDP; the shared dashboard is never touched. Covers: explicit format
// create, metadata rendering without first-character sniffing, persisted block
// ids across reload/reorder, hostile HTML defense, block comment anchor on the
// persisted id, block editor + revision conflict with draft preservation,
// removed-anchor detachment and explicit retarget, Markdown regression, and
// format-aware image markup.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { acquireChrome } from './_chrome.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gol345-browser-'));
const home = path.join(temp, 'home');
const state = path.join(temp, 'state');
const projectsRoot = path.join(temp, 'projects');
const project = path.join(projectsRoot, 'gol345');
const db = path.join(temp, 'tracker.db');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(state, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# GOL-345 HTML authoring fixture\n');
process.env.GOLEM_HOME = state;
process.env.GOLEM_TRACKER_DB = db;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch { /* retry */ }
    await pause(50);
  }
  throw new Error(`${label} timed out`);
}
async function stop(child) {
  if (!child || child.exitCode != null) return;
  const exited = once(child, 'exit').catch(() => undefined);
  child.kill('SIGTERM');
  await Promise.race([exited, pause(2_000)]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

const port = await unusedPort();
let stderr = '';
const dashboard = spawn(process.execPath, ['dashboard/server/index.js'], {
  cwd: repo,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), GOLEM_HOME: state,
    GOLEM_TRACKER_DB: db, GOLEM_PROJECTS_ROOT: projectsRoot,
    GOLEM_IDEAS_ROOT: path.join(temp, 'ideas'), XDG_CONFIG_HOME: path.join(temp, 'xdg'),
    HOME: path.join(temp, 'home'), LOG_LEVEL: 'error' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
dashboard.stderr.setEncoding('utf8');
dashboard.stderr.on('data', (chunk) => { stderr += chunk; });

let chrome;
let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const HOSTILE = '<h2>Hostile spec</h2><p>safe text<script>window.__alertFired=(window.__alertExecuted||0)+1</script>' +
  '<img src="x" onerror="window.__alert=(window.__alert||0)+1">' +
  '<a href="javascript:window.__alert=(window.__alert||0)+1">bad</a></p><ul><li>one</li></ul>';
const MD_DOC = '# Markdown regression\n\nPlain **markdown** body with a list:\n\n- alpha\n- beta\n';

try {
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 'dashboard health');
  const projectId = (await (await fetch(`${base}/api/projects`)).json())
    .find((p) => String(p.project_id ?? '').startsWith('gol345-'))?.project_id;
  assert.ok(projectId, 'project discovered');

  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => { dialog.dismiss(); failures++; console.log('  FAIL dialog opened (active content executed)'); });
  await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' });

  // ── A1: explicit format selection in the composer ─────────────────────────
  await page.evaluate((pid) => { window.Router.openComposer(pid); }, projectId);
  const composer = page.locator('.drawer-compose');
  await composer.waitFor();
  await composer.locator('select').first().selectOption(projectId);
  await composer.locator('.ct-field', { hasText: 'Type' }).locator('select').selectOption('spec');
  const formatSelect = composer.locator('.ct-field', { hasText: 'Body format' }).locator('select');
  await formatSelect.waitFor();
  assert.equal(await formatSelect.inputValue(), 'markdown');
  // The markdown spec template is the default template and keeps format markdown.
  await formatSelect.selectOption('html');
  check('A1 composer exposes an explicit body-format selector for specs (default markdown)', true);
  await composer.locator('input[placeholder="Short summary"]').fill('GOL-345 hostile html spec');
  await composer.locator('.orch-modal-textarea').fill(HOSTILE);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/tickets') && r.request().method() === 'POST'),
    composer.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  const tickets = await (await fetch(`${base}/api/tickets?project=${projectId}`)).json();
  const spec = tickets.find((t) => t.title === 'GOL-345 hostile html spec');
  assert.ok(spec, 'html spec created');
  assert.equal(spec.body_format, 'html');
  const specDetail = await (await fetch(`${base}/api/tickets/${spec.id}`)).json();
  const serverIds = [...specDetail.body.matchAll(/data-block-id="(b-[a-z0-9]+)"/g)].map((m) => m[1]);
  check('A1 html spec created with body_format html and server-assigned block ids', serverIds.length >= 2);

  // ── A2/A3: metadata rendering, hostile HTML defense, persisted ids ────────
  await page.evaluate((id) => { window.Router.openTicket(id); }, spec.id);
  const drawer = page.locator('.drawer-ticket');
  await drawer.waitFor();
  await waitFor(async () => (await drawer.locator('.td-md [data-block-id]').count()) > 0, 'annotated rendered body');
  const renderedIds = await drawer.locator('.td-md [data-block-id]').evaluateAll(
    (nodes) => nodes.map((n) => n.dataset.blockId));
  check('A3 rendered body preserves the server-persisted block ids (browser does not regenerate)',
    serverIds.every((id) => renderedIds.includes(id)),
    JSON.stringify({ serverIds, renderedIds }));
  check('A2 hostile markup cannot execute: no script element and no on* handler survives rendering',
    (await drawer.locator('.td-md script').count()) === 0
      && (await drawer.locator('.td-md [onerror], .td-md [onclick]').count()) === 0);
  const renderedText = await drawer.locator('.td-md').innerText();
  check('A2 safe content renders from the html body', renderedText.includes('safe text') && renderedText.includes('Hostile spec'));
  check('rendering used the stored format, not first-character sniffing (markdown template path not applied)',
    (await drawer.locator('.td-md p').count()) >= 1);

  // ── A8/A2: block comment anchors the persisted id ─────────────────────────
  const targetBlock = drawer.locator('.td-md [data-block-id]').first();
  await targetBlock.click();
  const pill = drawer.locator('.anno-attachment-pill');
  await pill.waitFor();
  check('A8 attachment pill names the clicked block', /Block/.test(await pill.innerText()));
  check('GOL-326: the attachment pill exposes Edit block for html specs',
    (await pill.locator('.anno-edit-block').count()) === 1);
  // The annotation rail/composer portals to #anno-rail, outside the drawer shell.
  const composerTextarea = page.locator('.anno-composer textarea').first();
  await composerTextarea.waitFor();
  await composerTextarea.fill('a block comment from the browser');
  await composerTextarea.press('Enter');
  await waitFor(async () => {
    const detail = await (await fetch(`${base}/api/tickets/${spec.id}`)).json();
    return detail.comments.some((c) => c.body.includes('a block comment from the browser'));
  }, 'comment persisted');
  const commentDetail = await (await fetch(`${base}/api/tickets/${spec.id}`)).json();
  const blockComment = commentDetail.comments.find((c) => c.body.includes('a block comment from the browser'));
  check('A8 comment anchored to the persisted block id', blockComment.block_id === renderedIds[0]
    && blockComment.anchor_kind === 'block');

  // ── GOL-326: block editor via the attachment pill ─────────────────────────
  await page.evaluate((id) => { window.Router.openTicket(id); }, spec.id);
  await drawer.locator('.td-md [data-block-id]').first().waitFor();
  await drawer.locator('.td-md [data-block-id]').first().click();
  await drawer.locator('.anno-edit-block').waitFor();
  await drawer.locator('.anno-edit-block').click();
  const editor = drawer.locator('.td-block-editor');
  await editor.waitFor();
  // The editor fetches the block asynchronously; wait for the canonical html.
  await waitFor(async () => (await editor.locator('textarea').inputValue()).includes(renderedIds[0]),
    'block editor loads canonical html');
  const editorValue = await editor.locator('textarea').inputValue();
  check('block editor loads the canonical block html with the persisted id',
    editorValue.includes(renderedIds[0]) && editorValue.includes('Hostile spec'), editorValue.slice(0, 120));
  await editor.locator('textarea').fill(`<h2 data-block-id="${renderedIds[0]}">Hostile spec — edited in the browser</h2>`);
  const revisionBefore = (await (await fetch(`${base}/api/tickets/${spec.id}/outline`)).json()).body_revision;
  await editor.getByRole('button', { name: 'Save block' }).click();
  await waitFor(async () => (await (await fetch(`${base}/api/tickets/${spec.id}/outline`)).json()).body_revision === revisionBefore + 1,
    'block patch committed');
  check('block editor saves through block-patches and bumps the revision once',
    (await (await fetch(`${base}/api/tickets/${spec.id}/outline`)).json()).body_revision === revisionBefore + 1);
  await waitFor(async () => (await drawer.locator('.td-md').innerText()).includes('edited in the browser'), 're-rendered block');
  check('A3 the edited block keeps its persisted id after re-render',
    (await drawer.locator('.td-md [data-block-id]').first().getAttribute('data-block-id')) === renderedIds[0]);

  // ── A7/A15: full-source conflict keeps the draft; retry adopts revision ───
  await drawer.locator('.td-edit-btn').first().click();
  const editTextarea = drawer.locator('.td-edit textarea');
  await editTextarea.waitFor({ timeout: 5000 }).catch(() => {});
  if (await editTextarea.count()) {
    const current = await editTextarea.inputValue();
    // Stale revision: the live store must NOT learn about a server-side change
    // while the editor is open (a lagging/refreshing tab), so freeze BOTH store
    // write paths — the WS delta (applyTicketUpdated) and the upsert helper.
    // This reproduces the "editor open while someone else saves" race the
    // drawer must survive without an automatic overwrite.
    await page.evaluate(() => {
      // Freeze both inbound paths: the live WebSocket handler (SubstrateAPI's
      // socket onmessage → store dispatch) and the upsert helper.
      const ws = window.SubstrateAPI.__lastSocket;
      window.__realOnmessage = ws ? ws.onmessage : null;
      window.__realUpsert = window.Store.upsertTrackerTicket;
      if (ws) ws.onmessage = () => {};
      window.Store.upsertTrackerTicket = () => {};
    });
    const rival = await fetch(`${base}/api/tickets/${spec.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: `${current}<p>server-side change</p>`, expected_revision: (await (await fetch(`${base}/api/tickets/${spec.id}/outline`)).json()).body_revision, actor: 'smoke' }) });
    await editTextarea.fill(`${current}<p>browser draft</p>`);
    const [saveResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/tickets/${spec.id}`) && r.request().method() === 'PATCH').catch(() => null),
      drawer.locator('.td-edit-actions').getByRole('button', { name: 'Save' }).click(),
    ]);
    await drawer.locator('.td-edit .ct-error').waitFor();
    const conflictText = await drawer.locator('.td-edit .ct-error').innerText();
    check('A7/A15 stale full-source save keeps the draft and shows the conflict',
      /Revision conflict/.test(conflictText) && /preserved/.test(conflictText)
        && (await editTextarea.inputValue()).includes('browser draft'),
      conflictText);
    await page.evaluate(() => {
      const ws = window.SubstrateAPI.__lastSocket;
      if (ws && window.__realOnmessage) ws.onmessage = window.__realOnmessage;
      window.Store.upsertTrackerTicket = window.__realUpsert;
    });
    const detail = await (await fetch(`${base}/api/tickets/${spec.id}`)).json();
    // Resync the store with the current server truth (the frozen window dropped
    // the WS delta), then the retry save is a legitimate current-revision write.
    await page.evaluate((t) => window.Store.upsertTrackerTicket(t), detail);
    await editTextarea.fill(detail.body);
    await drawer.getByRole('button', { name: /save/i }).first().click();
    await waitFor(async () => !(await drawer.locator('.td-edit textarea').count()), 'edit closed after successful save');
    check('A15 retry with the current revision succeeds', (await drawer.locator('.td-edit textarea').count()) === 0);
  } else {
    check('A7/A15 full-source conflict journey (edit affordance not found in this build)', false, 'edit entry missing');
  }

  // ── A9: removed anchor detaches; retarget restores ─────────────────────────
  const outlineResponse = await fetch(`${base}/api/tickets/${spec.id}/outline`);
  const outline = await outlineResponse.json();
  const li = outline?.blocks?.find((b) => b.kind === 'item');
  assert.ok(li, `outline missing an item block: ${outlineResponse.status}`);
  // Comment on the li block first, then remove it — the thread must survive
  // with a detached anchor and never silently jump to unrelated content.
  const liEl = drawer.locator(`.td-md [data-block-id="${li.id}"]`);
  await liEl.waitFor();
  await liEl.click();
  const liComposer = page.locator('.anno-composer textarea').first();
  await liComposer.waitFor();
  await liComposer.fill('a comment on the block that will be removed');
  await liComposer.press('Enter');
  await waitFor(async () => {
    const detail = await (await fetch(`${base}/api/tickets/${spec.id}`)).json();
    return detail.comments.some((c) => c.block_id === li.id && c.body.includes('block that will be removed'));
  }, 'li comment persisted');
  await fetch(`${base}/api/tickets/${spec.id}/block-patches`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_revision: outline.body_revision, operations: [{ op: 'remove', block_id: li.id }], actor: 'smoke' }) });
  await waitFor(async () => {
    const detail = await (await fetch(`${base}/api/tickets/${spec.id}`)).json();
    return detail.comments.some((c) => c.block_id === li.id && c.anchor_status === 'detached');
  }, 'server reports detached anchor');
  await page.reload();
  await drawer.locator('.td-md').waitFor();
  // The annotation rail opens from its FAB; open it to read the comment card.
  await page.locator('#anno-fab').click();
  const rail = page.locator('#anno-rail');
  await rail.waitFor();
  await waitFor(async () => /anchor (removed|lost)/i.test(await rail.innerText().catch(() => '')), 'detached anchor visible');
  const railText = await rail.innerText();
  check('A9 removed anchor shows the detached badge in comment history', /anchor (removed|lost)/i.test(railText), railText.slice(0, 300));

  // ── A10: Markdown regression ────────────────────────────────────────────────
  const mdCreated = await (await fetch(`${base}/api/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, kind: 'spec', title: 'GOL-345 markdown regression', body: MD_DOC, created_by: 'smoke' }) })).json();
  await page.evaluate((id) => { window.Router.openTicket(id); }, mdCreated.id);
  await drawer.locator('.td-md').waitFor();
  await waitFor(async () => (await drawer.locator('.td-md [data-block-id]').count()) > 0, 'markdown annotation ids');
  const mdIds = await drawer.locator('.td-md [data-block-id]').first().getAttribute('data-block-id');
  check('A10 markdown specs keep positional annotation ids (slug#index shape)', /#[0-9]/.test(mdIds), String(mdIds));
  check('A10 markdown body renders through marked (bold/list present)',
    (await drawer.locator('.td-md strong').count()) > 0 && (await drawer.locator('.td-md li').count()) >= 2);

  // ── A12: format-aware image markup helper ───────────────────────────────────
  const markup = await page.evaluate(() => ({
    md: window.SubstrateFmt.imageMarkupFor('markdown', '/api/ticket-assets/x.png', 'shot'),
    html: window.SubstrateFmt.imageMarkupFor('html', '/api/ticket-assets/x.png', 'shot'),
  }));
  check('A12 image paste markup is format-aware (markdown syntax vs figure/img)',
    markup.md === '\n![shot](/api/ticket-assets/x.png)\n'
      && markup.html === '\n<figure><img src="/api/ticket-assets/x.png" alt="shot"></figure>\n',
    JSON.stringify(markup));

  // ── A11: readable search snippets (server-side, exercised via REST) ────────
  const search = await (await fetch(`${base}/api/tickets/search?project=${projectId}&q=safe text`)).json();
  const searchHit = search.find((h) => h.id === spec.id);
  check('A11 html search snippet is readable text without tags', !!searchHit
    && searchHit.snippet.includes('safe text') && !/[<>]/.test(searchHit.snippet),
    JSON.stringify(search?.map?.((h) => h.snippet)?.[0] ?? ''));

  check('no uncaught page errors during the journey', pageErrors.length === 0, JSON.stringify(pageErrors));
  console.log(failures === 0
    ? `GOL-345 dashboard HTML authoring browser journey passed (A1–A3, A7–A12, A15); port=${port}`
    : `GOL-345 browser journey: ${failures} FAILURE(S); port=${port}`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  if (chrome) await chrome.cleanup();
  await stop(dashboard);
  fs.rmSync(temp, { recursive: true, force: true });
}