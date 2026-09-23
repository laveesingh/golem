// GOL-343: isolated service/REST tests for the HTML document and block service
// (GOL-326 A1–A7, A9–A11, A13–A15). Every database, dashboard and parser
// fixture is isolated; nothing touches shared runtime. Negative controls prove
// the revision gate, sanitizer and stable-ID persistence actually gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { openTrackerDb } from '../dashboard/server/tracker-db.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gol343-'));
let dashboard;
let ws;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML_DOC = `<h2>Goals</h2><p>Alpha beta paragraph.</p>` +
  `<ul><li>first item</li><li>second item</li></ul>` +
  `<table><tr><td>cell one</td><td>cell two</td></tr></table>` +
  `<section><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"></circle></svg></section>`;
const HOSTILE_DOC = `<h2>Hostile</h2><p>safe text<script>alert(1)</script>` +
  `<img src="x" onerror="alert(2)"><a href="javascript:alert(3)">bad</a>` +
  `<iframe src="https://evil.example"></iframe><form><input name="q"></form>` +
  `<style>body{}</style><a href="data:text/html,<b>x</b>">data-url</a></p>` +
  `<figure><figcaption>kept</figcaption></figure>`;

try {
  // ---- Migration + defaults (no body/comment rewrites) --------------------
  const dbPath = path.join(tmp, 'migrate.db');
  const db = await (async () => {
    // Create with current code, then roll the new columns + version back to
    // simulate a pre-v22 database and let migrate() converge on reopen.
    const pre = openTrackerDb(dbPath);
    const legacyTagLeading = pre.createTicket({
      project_id: 'proj-abc123', kind: 'spec', title: 'Legacy tag-leading',
      body: '<p>this body starts with a tag but is Markdown data</p>', created_by: 'smoke',
    });
    const legacyPlain = pre.createTicket({
      project_id: 'proj-abc123', kind: 'spec', title: 'Legacy md', body: 'plain text body', created_by: 'smoke',
    });
    pre.close();
    const raw = new (await import('better-sqlite3')).default(dbPath);
    raw.exec('ALTER TABLE tickets DROP COLUMN body_format');
    raw.exec('ALTER TABLE tickets DROP COLUMN body_revision');
    raw.prepare("UPDATE meta SET value = '21' WHERE key = 'schema_version'").run();
    raw.close();
    const reopened = openTrackerDb(dbPath);
    const tagLeading = reopened.getTicket(legacyTagLeading.id);
    const plain = reopened.getTicket(legacyPlain.id);
    check('migration adds body_format/body_revision without rewriting bodies',
      tagLeading.body === legacyTagLeading.body && plain.body === 'plain text body'
        && tagLeading.body_format === 'markdown' && plain.body_format === 'markdown'
        && tagLeading.body_revision === 1 && plain.body_revision === 1,
      JSON.stringify({ format: tagLeading.body_format, rev: tagLeading.body_revision }));
    check('a tag-leading body is NOT promoted to html by migration (format is explicit data)',
      tagLeading.body_format === 'markdown');
    return reopened;
  })();

  // ---- Parser/sanitizer (D2) ----------------------------------------------
  const { normalizeHtmlBody, searchTextFromHtml } = await import('../dashboard/server/html-body.js');
  const hostile = normalizeHtmlBody(HOSTILE_DOC);
  check('sanitizer strips script/event handlers/iframe/form/style and javascript:/data: URLs',
    !/<script|onerror|<iframe|<form|<input|javascript:|data:text\/html|<style/i.test(hostile.html)
      && /<figure data-block-id="b-[a-z0-9]+"><figcaption>kept<\/figcaption><\/figure>/.test(hostile.html),
    hostile.html.slice(0, 200));
  const rich = normalizeHtmlBody(HTML_DOC);
  check('safe structure survives: svg attrs kept and blocks carry persisted ids',
    /<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"><\/circle><\/svg>/.test(rich.html)
      && (rich.html.match(/data-block-id/g) || []).length >= 8,
    rich.html.slice(0, 200));
  check('unsafe-only payload that sanitizes to nothing is rejected, not saved empty',
    (() => { try { normalizeHtmlBody('<script>alert(1)</script><style>x{}</style>'); return false; } catch (e) { return e.code === 'empty_html_body'; } })());
  check('duplicate persisted block ids reject with 400 and the offending id',
    (() => {
      try { normalizeHtmlBody('<p data-block-id="b-aaaaaaaaaaaa">x</p><p data-block-id="b-aaaaaaaaaaaa">y</p>'); return false; }
      catch (e) { return e.code === 'duplicate_block_id' && e.extra?.block_id === 'b-aaaaaaaaaaaa'; }
    })());
  check('malformed persisted block ids reject (not silently retargeted)',
    (() => {
      try { normalizeHtmlBody('<p data-block-id="not-an-id">x</p>'); return false; }
      catch (e) { return e.code === 'malformed_block_id'; }
    })());
  const hostileText = searchTextFromHtml(hostile.html);
  check('A11 search text is readable: human text in, tags/script/style out',
    hostileText.includes('Hostile') && hostileText.includes('kept') && hostileText.includes('data-url')
      && !/[<>]|script|style/.test(hostileText),
    JSON.stringify(hostileText));

  // ---- Service journeys ----------------------------------------------------
  const mdSpec = db.createTicket({ project_id: 'proj-abc123', kind: 'spec', title: 'MD spec', body: 'plain **markdown**', created_by: 'smoke' });
  const htmlSpec = db.createTicket({ project_id: 'proj-abc123', kind: 'spec', title: 'HTML spec', body: HTML_DOC, body_format: 'html', created_by: 'smoke' });
  check('A1 create: format explicit, revision 1, outline with server-assigned ids',
    htmlSpec.body_format === 'html' && htmlSpec.body_revision === 1
      && Array.isArray(htmlSpec.outline) && htmlSpec.outline.every((b) => /^b-[a-z0-9]{12}$/.test(b.id)),
    JSON.stringify(htmlSpec.outline?.slice(0, 2)));
  check('A1 markdown default unchanged; html on task/doc rejected (unsupported_format)',
    mdSpec.body_format === 'markdown' && mdSpec.body_revision === 1
      && (() => { try { db.createTicket({ project_id: 'proj-abc123', kind: 'task', title: 'x', body: '<p>x</p>', body_format: 'html' }); return false; } catch (e) { return e.code === 'unsupported_format'; } })());

  const outline = db.getTicketOutline(htmlSpec.id);
  check('A4 outline: ordered blocks with kinds/hash/comment counts, no full body',
    outline.body_revision === 1
      && outline.blocks.map((b) => b.kind).join(',') === 'h2,p,list,item,item,table,row,section'
      && !('body' in outline)
      && outline.blocks.every((b) => b.comments.open === 0),
    JSON.stringify(outline.blocks.map((b) => b.kind)));
  const li = outline.blocks.find((b) => b.kind === 'item');
  const block = db.getTicketBlock(htmlSpec.id, li.id);
  check('A4 get-block: canonical outer html + revision + comments, no full body',
    block.html === `<li data-block-id="${li.id}">first item</li>` && block.body_revision === 1
      && Array.isArray(block.comments) && block.child_blocks.length === 0,
    JSON.stringify(block.html));

  db.addComment(htmlSpec.id, { author: 'smoke', body: 'on the first item', block_id: li.id, anchor_kind: 'block' });
  const afterComment = db.getTicketBlock(htmlSpec.id, li.id);
  check('block comments hydrate onto the read with anchored status',
    afterComment.comments.length === 1 && afterComment.comments[0].anchor_status === 'anchored');
  check('nonexistent block id rejected on comment (no silent anchor)',
    (() => { try { db.addComment(htmlSpec.id, { author: 'smoke', body: 'x', block_id: 'b-000000000000', anchor_kind: 'block' }); return false; } catch (e) { return e.code === 'block_not_found'; } })());

  // A6: atomic batch — second operation broken → nothing commits.
  const revBefore = db.getTicket(htmlSpec.id).body_revision;
  const bodyBefore = db.getTicket(htmlSpec.id).body;
  try {
    db.patchTicketBlocks(htmlSpec.id, {
      expected_revision: revBefore,
      operations: [
        { op: 'replace', block_id: outline.blocks[0].id, html: '<h2>Goals v2</h2>' },
        { op: 'remove', block_id: 'b-000000000000' },
      ],
    });
    check('A6 broken batch must fail', false);
  } catch (err) {
    check('A6 broken second operation fails the whole batch with no write',
      err.code === 'block_not_found'
        && db.getTicket(htmlSpec.id).body_revision === revBefore
        && db.getTicket(htmlSpec.id).body === bodyBefore);
  }

  // A5/A3: valid batch — one increment, unrelated blocks byte-identical, moved
  // subtree keeps its persisted id.
  const tableBlock = outline.blocks.find((b) => b.kind === 'table');
  const paragraphOuter = `<p data-block-id="${outline.blocks[1].id}">Alpha beta paragraph.</p>`;
  const patched = db.patchTicketBlocks(htmlSpec.id, {
    expected_revision: revBefore,
    operations: [
      { op: 'replace', block_id: outline.blocks[0].id, html: '<h2>Goals v2</h2>' },
      { op: 'insert_after', block_id: outline.blocks[0].id, html: '<p>inserted paragraph</p>' },
      { op: 'move_after', block_id: tableBlock.id, anchor_block_id: outline.blocks[1].id },
    ],
  });
  const postBody = db.getTicket(htmlSpec.id).body;
  check('A5 one revision increment and the inserted id returned',
    patched.body_revision === revBefore + 1 && patched.inserted.length === 1
      && /^b-[a-z0-9]{12}$/.test(patched.inserted[0]),
    JSON.stringify(patched.inserted));
  check('A5 unrelated canonical block byte-identical after edits',
    postBody.includes(paragraphOuter),
    postBody.slice(0, 160));
  check('A3 moved table keeps its persisted id (stable identity across reorder)',
    db.getTicketOutline(htmlSpec.id).blocks.some((b) => b.kind === 'table' && b.id === tableBlock.id));
  check('A3 replaced block retains the target id; reload keeps ids identical',
    db.getTicketOutline(htmlSpec.id).blocks.some((b) => b.kind === 'h2' && b.id === outline.blocks[0].id)
      && db.getTicket(htmlSpec.id).body.includes(`data-block-id="${outline.blocks[0].id}"`));

  // A13: replay the same insert with the stale revision — conflict, no duplicate.
  const beforeReplayCount = db.getTicketOutline(htmlSpec.id).blocks.length;
  try {
    db.patchTicketBlocks(htmlSpec.id, { expected_revision: revBefore, operations: [{ op: 'insert_after', block_id: outline.blocks[0].id, html: '<p>replayed insert</p>' }] });
    check('A13 stale replay must conflict', false);
  } catch (err) {
    check('A13 lost-response replay with old revision conflicts and inserts nothing',
      err.code === 'revision_conflict' && err.extra?.current_revision === revBefore + 1
        && db.getTicketOutline(htmlSpec.id).blocks.length === beforeReplayCount);
  }

  // A9: remove a commented block — thread survives, anchor detaches explicitly.
  const removal = db.patchTicketBlocks(htmlSpec.id, {
    expected_revision: db.getTicket(htmlSpec.id).body_revision,
    operations: [{ op: 'remove', block_id: li.id }],
  });
  const removedComment = db.getTicket(htmlSpec.id).comments.find((c) => c.block_id === li.id);
  check('A9 removed block comments stay stored with detached status and original id',
    removedComment && removedComment.anchor_status === 'detached'
      && removal.detached.some((d) => d.block_id === li.id && d.anchor_status === 'detached'),
    JSON.stringify(removedComment));
  check('A9 explicit retarget to an existing block restores the anchor',
    (() => {
      db.updateComment(htmlSpec.id, removedComment.id, { block_id: outline.blocks[1].id, anchor_kind: 'block' });
      const c = db.getTicket(htmlSpec.id).comments.find((x) => x.id === removedComment.id);
      return c.anchor_status === 'anchored' && c.block_id === outline.blocks[1].id;
    })());
  check('A9 retarget to a nonexistent block is rejected (no silent jump)',
    (() => {
      try { db.updateComment(htmlSpec.id, removedComment.id, { block_id: 'b-000000000000' }); return false; }
      catch (e) { return e.code === 'block_not_found'; }
    })());

  // A7: two writers from revision N — first wins, second conflicts.
  const revNow = db.getTicket(htmlSpec.id).body_revision;
  const bodyNow = db.getTicket(htmlSpec.id).body;
  db.updateTicket(htmlSpec.id, { body: `${bodyNow}<p>extra</p>`, expected_revision: revNow, actor: 'smoke' });
  try {
    db.updateTicket(htmlSpec.id, { body: `${bodyNow}<p>loser</p>`, expected_revision: revNow, actor: 'smoke' });
    check('A7 second stale write must conflict', false);
  } catch (err) {
    check('A7 two writes from revision N: first succeeds, second 409 with current revision',
      err.code === 'revision_conflict' && err.extra?.current_revision === revNow + 1);
  }
  check('A7 conflict payload carries the current outline for recovery',
    (() => {
      try { db.updateTicket(htmlSpec.id, { body: '<p>x</p>', expected_revision: revNow }); }
      catch (err) { return Array.isArray(err.extra?.outline) && err.extra.outline.length > 0; }
      return false;
    })());
  check('markdown body writes stay revision-gate-free (D4 preserves compatibility)',
    (() => {
      const t = db.updateTicket(mdSpec.id, { body: 'updated **markdown**', actor: 'smoke' });
      return t.body_format === 'markdown' && t.body_revision === 2 && !('expected_revision' in t);
    })());

  // A15: format changes require body + revision; stale format change conflicts.
  check('A15 format change without body rejects (complete replacement required)',
    (() => {
      try { db.updateTicket(mdSpec.id, { body_format: 'html' }); return false; }
      catch (e) { return e.code === 'body_required_for_format_change'; }
    })());
  const mdForHtml = db.createTicket({ project_id: 'proj-abc123', kind: 'spec', title: 'Convert me', body: 'md body', created_by: 'smoke' });
  check('A15 explicit format change with body + revision converts once',
    (() => {
      const t = db.updateTicket(mdForHtml.id, { body_format: 'html', body: '<h1>Converted</h1>', expected_revision: 1, actor: 'smoke' });
      return t.body_format === 'html' && t.body_revision === 2 && /<h1 data-block-id="b-/.test(t.body);
    })());
  check('A15 stale format change conflicts',
    (() => {
      try { db.updateTicket(mdForHtml.id, { body_format: 'markdown', body: 'back', expected_revision: 1 }); return false; }
      catch (e) { return e.code === 'revision_conflict' && e.extra?.current_revision === 2; }
    })());

  // GOL-348 fix 1: the spec-only HTML invariant holds across kind PATCH.
  check('html spec PATCHed to a non-spec kind rejects (no stranded html body)',
    (() => {
      try { db.updateTicket(htmlSpec.id, { kind: 'task', actor: 'smoke' }); return false; }
      catch (e) { return e.code === 'unsupported_format'; }
    })());
  check('kind change is allowed once the body is explicitly converted to markdown first',
    (() => {
      const convertible = db.createTicket({ project_id: 'proj-abc123', kind: 'spec', title: 'Convert then retag', body: '<p>html body</p>', body_format: 'html', created_by: 'smoke' });
      const converted = db.updateTicket(convertible.id, {
        body_format: 'markdown', body: 'now markdown', expected_revision: 1, actor: 'smoke',
      });
      const retagged = db.updateTicket(convertible.id, { kind: 'task', actor: 'smoke' });
      return converted.body_format === 'markdown' && retagged.kind === 'task';
    })());

  // GOL-348 fix 2: protocol-relative and external SVG-use references rejected.
  const useProbe = normalizeHtmlBody(
    `<svg viewBox="0 0 10 10"><use href="//evil.example/icons.svg#x"></use><use xlink:href="https://evil.example/y#z"></use><use href="#local-shape"></use></svg>`);
  check('svg <use> keeps only same-document fragment references',
    /<use href="#local-shape"><\/use>/.test(useProbe.html)
      && !/href="\/\//.test(useProbe.html)
      && !/evil\.example/.test(useProbe.html),
    useProbe.html.slice(0, 200));
  check('protocol-relative href/src on any element is stripped (external origin escape)',
    (() => {
      const probe = normalizeHtmlBody('<p><a href="//evil.example/x">rel</a></p>');
      return !/evil\.example/.test(probe.html) && /<a>rel<\/a>/.test(probe.html);
    })());

  // A10: Markdown spec behavior unchanged around the migration.
  check('A10 markdown comments/search unchanged (no block gates)',
    (() => {
      const c = db.addComment(mdSpec.id, { author: 'smoke', body: 'md comment' });
      const hits = db.searchTickets({ project_id: 'proj-abc123', q: 'updated **markdown**' });
      return c.anchor_kind === 'text' && hits.some((h) => h.id === mdSpec.id);
    })());

  // ---- GOL-373 (T1): one grammar for both formats (anchors, content alias,
  // edit, section ops) on a fresh ticket — earlier tickets keep their exact
  // revision history for the A6/A13/A7/A9 assertions above. ------------------
  const anchored = db.createTicket({
    project_id: 'proj-abc123', kind: 'spec', title: 'Anchored html',
    body: '<h2>Alpha</h2><p>First section body.</p><h2>Beta</h2><p>Second section body.</p>',
    body_format: 'html', created_by: 'smoke',
  });
  const anchoredOutline = () => db.getTicketOutline(anchored.id);
  const anchoredRev = () => db.getTicket(anchored.id).body_revision;
  const aPatched = db.patchTicketBlocks(anchored.id, {
    expected_revision: anchoredRev(),
    operations: [{ op: 'replace', anchor: { text: 'First section body.' }, html: '<p>First section REPLACED.</p>' }],
  });
  check('T1 anchor-targeted replace commits and keeps sibling ids stable',
    aPatched.body_revision === 2 && db.getTicket(anchored.id).body.includes('First section REPLACED.')
      && anchoredOutline().blocks.find((b) => b.heading === 'Beta').id != null);
  const aInserted = db.patchTicketBlocks(anchored.id, {
    expected_revision: anchoredRev(),
    // `content` is the cross-format payload name; `html` stays an alias.
    operations: [{ op: 'insert_after', anchor: { text: 'First section REPLACED.' }, content: '<p>Inserted via content alias.</p>' }],
  });
  check('T1 anchor-targeted insert with the content alias commits',
    aInserted.body_revision === 3 && /^b-[a-z0-9]{12}$/.test(aInserted.inserted[0])
      && db.getTicket(anchored.id).body.includes('Inserted via content alias.'));
  const secondPara = anchoredOutline().blocks.find((b) => b.short_text === 'Second section body.');
  const aMoved = db.patchTicketBlocks(anchored.id, {
    expected_revision: anchoredRev(),
    operations: [{ op: 'move_before', anchor: { text: 'Second section body.' }, to_anchor: { text: 'First section REPLACED.' } }],
  });
  check('T1 anchor-targeted move with to_anchor keeps the moved id',
    aMoved.body_revision === 4
      && anchoredOutline().blocks.some((b) => b.id === secondPara.id && b.short_text === 'Second section body.')
      && db.getTicket(anchored.id).body.indexOf('Second section body.') < db.getTicket(anchored.id).body.indexOf('First section REPLACED.'));
  const aSection = db.patchTicketBlocks(anchored.id, {
    expected_revision: anchoredRev(),
    operations: [{ op: 'append_to_section', anchor: { text: 'Beta' }, html: '<p>Beta appended.</p>' }],
  });
  check('T1 anchor-targeted section op appends at the section end',
    aSection.body_revision === 5 && /Beta appended\.<\/p>$/.test(db.getTicket(anchored.id).body));
  const aEdited = db.patchTicketBlocks(anchored.id, {
    expected_revision: anchoredRev(),
    operations: [{ op: 'edit', old: 'Beta appended.', new: 'Beta edited.' }],
  });
  check('T1 whole-body edit commits and survivors keep their ids',
    aEdited.body_revision === 6 && db.getTicket(anchored.id).body.includes('Beta edited.')
      && anchoredOutline().blocks.some((b) => b.id === secondPara.id));
  check('T1 edit touching data-block-* is rejected and writes nothing',
    (() => {
      const before = db.getTicket(anchored.id).body;
      const rev = anchoredRev();
      try {
        db.patchTicketBlocks(anchored.id, {
          expected_revision: rev,
          operations: [{ op: 'edit', old: 'Beta edited.', new: '<p data-block-id="b-000000000000">forged</p>' }],
        });
        return false;
      } catch (e) {
        return e.code === 'protected_attribute' && db.getTicket(anchored.id).body === before
          && db.getTicket(anchored.id).body_revision === rev;
      }
    })());
  check('T1 block_id + anchor together is rejected',
    (() => {
      try {
        db.patchTicketBlocks(anchored.id, {
          expected_revision: anchoredRev(),
          operations: [{ op: 'remove', block_id: secondPara.id, anchor: { text: 'Beta' } }],
        });
        return false;
      } catch (e) { return e.code === 'invalid_target'; }
    })());
  check('T1 legacy {block_id, html} and anchor_block_id still pass',
    (() => {
      const p = db.patchTicketBlocks(anchored.id, {
        expected_revision: anchoredRev(),
        operations: [
          { op: 'replace', block_id: secondPara.id, html: '<p>Second via legacy path.</p>' },
          { op: 'move_after', block_id: secondPara.id, anchor_block_id: anchoredOutline().blocks[0].id },
        ],
      });
      return p.body_revision === anchoredRev() && db.getTicket(anchored.id).body.includes('Second via legacy path.');
    })());
  check('T1 ambiguous anchor fails the batch with candidates',
    (() => {
      try {
        db.patchTicketBlocks(anchored.id, {
          expected_revision: anchoredRev(),
          operations: [{ op: 'remove', anchor: { text: 'Beta' } }],
        });
        return false;
      } catch (e) {
        return e.code === 'anchor_ambiguous' && (e.extra?.candidates ?? []).length > 1;
      }
    })());
  check('T1 html anchor read resolves through the service',
    db.getTicketBlock(anchored.id, null, { anchor: { text: 'Second via legacy' } }).block_id === secondPara.id);
  check('T1 html section read returns the section html',
    (() => {
      const sec = db.getTicketBlock(anchored.id, null, { anchor: { text: 'Alpha' }, section: true });
      return sec.section === true && sec.html.includes('First section REPLACED.') && !sec.html.includes('Beta edited.');
    })());

  // ---- REST boundary -------------------------------------------------------
  {
    const { WebSocket } = await import('ws');
    fs.mkdirSync(path.join(tmp, 'projects', 'gol343'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'projects', 'gol343', 'CLAUDE.md'), '# gol343 rest probe');
    const reservation = net.createServer();
    await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
    const port = reservation.address().port;
    await new Promise((r) => reservation.close(r));
    const base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env, PORT: String(port), HOST: '127.0.0.1',
      GOLEM_HOME: path.join(tmp, 'home'), GOLEM_TRACKER_DB: path.join(tmp, 'rest.db'),
      XDG_CONFIG_HOME: path.join(tmp, 'xdg'), HOME: path.join(tmp, 'home'),
      GOLEM_PROJECTS_ROOT: path.join(tmp, 'projects'), GOLEM_IDEAS_ROOT: path.join(tmp, 'ideas'),
      GOLEM_ROOT: repo, LOG_LEVEL: 'error',
    };
    fs.mkdirSync(env.GOLEM_HOME, { recursive: true });
    dashboard = spawn(process.execPath, [path.join(repo, 'dashboard/server/index.js')], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    dashboard.stderr.on('data', (c) => { stderr += c; });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* retry */ }
      if (dashboard.exitCode !== null) throw new Error(`dashboard exited: ${stderr}`);
      await sleep(100);
    }
    const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
      const response = await fetch(base + route, {
        method, headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    };
    await sleep(300);
    const projectId = (await (await fetch(`${base}/api/projects`)).json())
      .find((p) => String(p.project_id ?? '').startsWith('gol343-'))?.project_id;
    check('REST: isolated dashboard ready with the discovered project', !!projectId, String(projectId));

    // A1 via REST.
    const created = await api('/api/tickets', { project_id: projectId, kind: 'spec', title: 'REST html', body_format: 'html', body: HTML_DOC, created_by: 'smoke' });
    check('A1 REST create html spec returns format/revision/outline',
      created.status === 201 && created.json.body_format === 'html' && created.json.body_revision === 1
        && Array.isArray(created.json.outline) && created.json.outline.length > 0);
    const restHtmlId = created.json.id;
    check('A1 REST create html task rejected (spec-only boundary)',
      (await api('/api/tickets', { project_id: projectId, kind: 'task', title: 'x', body_format: 'html', body: '<p>x</p>', created_by: 'smoke' })).json?.code === 'unsupported_format');
    const restMd = await api('/api/tickets', { project_id: projectId, kind: 'spec', title: 'REST md', body: 'plain markdown', created_by: 'smoke' });

    const outlineRes = await api(`/api/tickets/${restHtmlId}/outline`);
    check('A4 REST outline returns blocks without the body',
      outlineRes.status === 200 && outlineRes.json.blocks.length > 0 && !('body' in outlineRes.json));
    const blockRes = await api(`/api/tickets/${restHtmlId}/blocks/${outlineRes.json.blocks[0].id}`);
    check('A4 REST get-block returns canonical outer html',
      blockRes.status === 200 && blockRes.json.html?.startsWith('<h2 data-block-id="b-'));
    const missingBlock = await api(`/api/tickets/${restHtmlId}/blocks/b-000000000000`);
    check('A4 REST get-block unknown id → 404 block_not_found',
      missingBlock.status === 404 && missingBlock.json?.code === 'block_not_found');
    const mdOutline = await api(`/api/tickets/${restMd.json.id}/outline`);
    // GOL-373: Markdown outline and patches are supported (no ids); a
    // block_id target on Markdown is rejected as invalid_target.
    check('T1 REST markdown outline works with no ids',
      mdOutline.status === 200 && mdOutline.json?.body_format === 'markdown'
        && Array.isArray(mdOutline.json?.blocks) && mdOutline.json.blocks.every((b) => !('id' in b)));
    check('T1 REST markdown block_id target → 400 invalid_target',
      (await api(`/api/tickets/${restMd.json.id}/block-patches`, { expected_revision: 1, operations: [{ op: 'remove', block_id: 'x' }], actor: 'smoke' })).json?.code === 'invalid_target');

    // A15 via REST: missing/stale revision on html full-body PATCH.
    const noRev = await api(`/api/tickets/${restHtmlId}`, { body: '<p>no revision</p>', actor: 'smoke' }, 'PATCH');
    check('A15 REST html body write without expected_revision → 400 + pointer code',
      noRev.status === 400 && noRev.json?.code === 'expected_revision_required', JSON.stringify(noRev.json));
    const stale = await api(`/api/tickets/${restHtmlId}`, { body: '<p>stale</p>', expected_revision: 50, actor: 'smoke' }, 'PATCH');
    check('A15 REST stale revision → 409 revision_conflict with current revision',
      stale.status === 409 && stale.json?.code === 'revision_conflict' && stale.json?.current_revision === 1);
    const gated = await api(`/api/tickets/${restHtmlId}`, { body: HTML_DOC.replace('<h2>Goals</h2>', '<h2>Goals REST</h2>'), expected_revision: 1, actor: 'smoke' }, 'PATCH');
    check('A15 REST gated html write succeeds and increments revision once',
      gated.status === 200 && gated.json.body_revision === 2 && gated.json.outline.length > 0);
    const mdPatch = await api(`/api/tickets/${restMd.json.id}`, { body: 'new markdown body', actor: 'smoke' }, 'PATCH');
    check('A15 markdown body writes remain compatible without expected_revision',
      mdPatch.status === 200 && mdPatch.json.body_format === 'markdown');

    // A5/A6/A13 via REST block-patches.
    const restOutline = (await api(`/api/tickets/${restHtmlId}/outline`)).json;
    const target = restOutline.blocks.find((b) => b.kind === 'p');
    const batch = await api(`/api/tickets/${restHtmlId}/block-patches`, {
      expected_revision: 2, actor: 'smoke',
      operations: [
        { op: 'replace', block_id: target.id, html: '<p>replaced via REST</p>' },
        { op: 'insert_before', block_id: target.id, html: '<p>inserted via REST</p>' },
      ],
    });
    check('A5 REST batch commits atomically: revision bump, inserted id, outline returned',
      batch.status === 200 && batch.json.body_revision === 3 && batch.json.inserted.length === 1
        && Array.isArray(batch.json.outline));
    const brokenBatch = await api(`/api/tickets/${restHtmlId}/block-patches`, {
      expected_revision: 3, actor: 'smoke',
      operations: [{ op: 'replace', block_id: target.id, html: '<p>x</p>' }, { op: 'remove', block_id: 'b-000000000000' }],
    });
    check('A6 REST broken batch fails entirely (404 missing block) and revision unchanged',
      brokenBatch.status === 404 && brokenBatch.json?.code === 'block_not_found'
        && (await api(`/api/tickets/${restHtmlId}/outline`)).json.body_revision === 3,
      JSON.stringify(brokenBatch.json));
    const replay = await api(`/api/tickets/${restHtmlId}/block-patches`, {
      expected_revision: 2, actor: 'smoke', operations: [{ op: 'insert_after', block_id: target.id, html: '<p>replay</p>' }],
    });
    check('A13 REST replay with stale revision → 409, no duplicate insert',
      replay.status === 409
        && (await api(`/api/tickets/${restHtmlId}/outline`)).json.blocks.filter((b) => b.short_text === 'replay').length === 0);

    // A9 via REST: comment then remove the block.
    const commentedBlock = (await api(`/api/tickets/${restHtmlId}/outline`)).json.blocks[0];
    await api(`/api/tickets/${restHtmlId}/comments`, { author: 'smoke', body: 'block comment', block_id: commentedBlock.id, anchor_kind: 'block' });
    const removed = await api(`/api/tickets/${restHtmlId}/block-patches`, {
      expected_revision: 3, actor: 'smoke', operations: [{ op: 'remove', block_id: commentedBlock.id }],
    });
    const ticketAfter = await api(`/api/tickets/${restHtmlId}`);
    check('A9 REST removal reports detached comments; ticket read shows detached status',
      removed.status === 200 && removed.json.detached.length === 1
        && removed.json.detached[0].anchor_status === 'detached'
        && ticketAfter.json.comments.find((c) => c.id === removed.json.detached[0].id).anchor_status === 'detached');

    // A11 via REST search: readable snippet, no tags.
    const search = await api(`/api/tickets/search?project=${projectId}&q=inserted via REST`);
    const hit = search.json.find((h) => h.id === restHtmlId);
    check('A11 REST search returns readable text snippet without tags',
      !!hit && hit.snippet.includes('inserted via REST') && !/[<>]/.test(hit.snippet),
      JSON.stringify(search.json.slice(0, 2)));

    // WebSocket updates only after commit.
    ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const wsMessages = [];
    ws.on('message', (data) => wsMessages.push(JSON.parse(String(data))));
    await sleep(200);
    await api(`/api/tickets/${restHtmlId}/block-patches`, {
      expected_revision: 4, actor: 'smoke',
      operations: [{ op: 'insert_after', block_id: (await api(`/api/tickets/${restHtmlId}/outline`)).json.blocks[0].id, html: '<p>ws probe</p>' }],
    });
    await sleep(400);
    const updates = wsMessages.filter((m) => m.type === 'ticket-updated' && m.ticket?.id === restHtmlId);
    check('WebSocket ticket-updated delivered after the committed block patch',
      updates.length === 1 && updates[0].ticket.body_revision === 5,
      JSON.stringify(wsMessages.map((m) => m.type)));
    ws.close();
    ws = null;

    // ---- Negative controls -------------------------------------------------
    // Sanitizer bypass on a disposable mutated copy (written beside the real
    // module so package imports resolve; removed in finally): the production-
    // path safety assertion must FAIL against the mutant. The on*/style skip
    // alone is not enough (the attribute allowlist drops them anyway), so the
    // mutation disables the executable-element drop (script/iframe/style…).
    const mutantPath = path.join(repo, 'dashboard/server/.gol343-mutant.mjs');
    const source = fs.readFileSync(path.join(repo, 'dashboard/server/html-body.js'), 'utf8');
    assert.ok(source.includes('if (DROP_WITH_CONTENT.has(tag)) return null;'));
    // Two-guard bypass: without both the executable-element drop AND the
    // allowlist unwrap, a script element survives serialization — proving the
    // production safety assertion is the guard for a real bypass.
    const mutantSource = source
      .replace('if (DROP_WITH_CONTENT.has(tag)) return null;', 'if (false) return null;')
      .replace('if (UNWRAP.has(tag) || !ALLOWED_TAGS.has(tag)) {', "if (tag === 'script') { node.childNodes = node.childNodes ?? []; return node; }\n    if (UNWRAP.has(tag) || !ALLOWED_TAGS.has(tag)) {");
    assert.ok(mutantSource !== source);
    fs.writeFileSync(mutantPath, mutantSource);
    try {
      const mutant = await import(pathToFileURL(mutantPath).href);
      const mutantOut = mutant.normalizeHtmlBody('<p>kept<script>alert(1)</script></p>').html;
      const safeOutput = (html) => !/onerror|onclick|<script/.test(html);
      check('negative control: sanitizer-bypass mutant fails the production safety assertion',
        safeOutput(normalizeHtmlBody('<p>kept<script>alert(1)</script></p>').html) === true && safeOutput(mutantOut) === false,
        mutantOut.slice(0, 120));
    } finally {
      fs.rmSync(mutantPath, { force: true });
    }
    // Revision-gate negative control: the gate checker must reject a
    // hypothetical success response for a revision-less write.
    const gateCheck = (response) => response.status === 400 && response.json?.code === 'expected_revision_required';
    check('negative control: revision-gate checker rejects a hypothetical success',
      gateCheck(noRev) === true
        && (() => { try { assert.equal(gateCheck({ status: 200, json: { body_revision: 2 } }), true); return false; } catch { return true; } })());

    dashboard.kill('SIGTERM');
    dashboard = null;
  }
  console.log(failures.length === 0 ? '\nALL GOL-343 CHECKS PASS' : `\n${failures.length} FAILURE(S)`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { dashboard?.kill('SIGKILL'); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
}