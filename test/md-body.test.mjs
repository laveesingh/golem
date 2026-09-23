// GOL-373 (T1): Markdown block engine, strict text anchors, and shared ops
// for both formats (GOL-369 R1–R4, D1–D5 server side). Isolated: temp DBs and
// an ephemeral dashboard only. `GOLEM_TRACKER_DB_COPY=<copy>` additionally
// round-trips every Markdown body in a copy of the live tracker DB (never the
// live DB itself); run once before return and record the count on GOL-373.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openTrackerDb } from '../dashboard/server/tracker-db.js';
import {
  splitMarkdownBlocks, joinBlocks, outlineFromMarkdown, applyMarkdownOperations,
  getMarkdownBlock, getMarkdownSection,
} from '../dashboard/server/md-body.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gol373-'));
let dashboard;
let ws;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const throwsCode = (fn, code) => {
  try { fn(); } catch (e) { return e.code === code ? e : null; }
  return undefined;
};

const DOC = [
  '# Doc title',
  '',
  'First paragraph.',
  '',
  '## Section one',
  '',
  'Section one body.',
  '',
  '## Section two',
  '',
  'Section two body.',
  '',
  '<details>',
  '<summary>Evidence box</summary>',
  '',
  'Boxed paragraph.',
  '',
  '### Box head',
  '',
  'Box head text.',
  '',
  '</details>',
  '',
  'Tail paragraph.',
].join('\n');

try {
  // ---- Round trip on committed fixtures ------------------------------------
  for (const fixture of ['rich.md', 'nested-details.md', 'no-trailing-newline.md']) {
    const src = fs.readFileSync(path.join(repo, 'test/fixtures/md-blocks', fixture), 'utf8');
    const blocks = splitMarkdownBlocks(src);
    check(`round trip byte-exact: ${fixture}`, joinBlocks(blocks) === src);
  }
  const rich = splitMarkdownBlocks(
    fs.readFileSync(path.join(repo, 'test/fixtures/md-blocks', 'rich.md'), 'utf8'));
  check('rich fixture splits into headed blocks with a details container',
    rich.some((b) => b.kind === 'heading' && b.heading === 'Fixture: rich Markdown')
      && rich.some((b) => b.kind === 'table') && rich.some((b) => b.kind === 'code')
      && rich.some((b) => b.kind === 'details' && b.children.length >= 2));
  const nested = splitMarkdownBlocks(
    fs.readFileSync(path.join(repo, 'test/fixtures/md-blocks', 'nested-details.md'), 'utf8'));
  check('nested details group recursively (container inside container)',
    nested.length === 3 && nested[1].kind === 'details'
      && nested[1].children.some((c) => c.kind === 'details' && c.children.length === 1));

  // ---- Outline (D5: kind/heading/level/section/short_text, no ids) ----------
  const outline = outlineFromMarkdown(DOC);
  check('outline entries carry kind/heading/level/section/short_text and no ids',
    outline.every((b) => 'kind' in b && 'heading' in b && 'level' in b && 'section' in b && 'short_text' in b
      && !('id' in b) && !('hash' in b)));
  check('section path tracks headings',
    outline.find((b) => b.short_text === 'Section one body.').section === 'Doc title > Section one'
      && outline.find((b) => b.short_text === 'Box head text.').section === 'Doc title > Section two > Box head');

  // ---- Every op on Markdown (pure engine) -----------------------------------
  let r = applyMarkdownOperations(DOC, [{ op: 'replace', anchor: { text: 'First paragraph.' }, content: 'First REPLACED.' }]);
  check('replace swaps one block verbatim', r.body.includes('First REPLACED.') && !r.body.includes('First paragraph.')
    && r.body.includes('Tail paragraph.'));
  r = applyMarkdownOperations(DOC, [{ op: 'insert_before', anchor: { text: '## Section one' }, content: 'Inserted before.' }]);
  check('insert_before lands ahead of the target with a blank line',
    /Inserted before\.\n\n## Section one/.test(r.body));
  r = applyMarkdownOperations(DOC, [{ op: 'insert_after', anchor: { text: 'First paragraph.' }, content: 'Inserted after.' }]);
  check('insert_after lands behind the target with a blank line',
    /First paragraph\.\n\nInserted after\./.test(r.body));
  r = applyMarkdownOperations(DOC, [{ op: 'move_after', anchor: { text: 'First paragraph.' }, to_anchor: { text: 'Tail paragraph.' } }]);
  check('move_after relocates the block', r.body.endsWith('Tail paragraph.\n\nFirst paragraph.')
    && r.body.startsWith('# Doc title'));
  r = applyMarkdownOperations(DOC, [{ op: 'move_before', anchor: { text: 'Tail paragraph.' }, to_anchor: { text: 'First paragraph.' } }]);
  check('move_before relocates the block', /Tail paragraph\.\n\nFirst paragraph\./.test(r.body));
  r = applyMarkdownOperations(DOC, [{ op: 'remove', anchor: { text: 'Section one body.' } }]);
  check('remove drops the block', !r.body.includes('Section one body.') && r.body.includes('## Section one')
    && joinBlocks(splitMarkdownBlocks(r.body)) === r.body);
  r = applyMarkdownOperations(DOC, [{ op: 'edit', old: 'First paragraph.', new: 'First edited.' }]);
  check('edit swaps an exact substring', r.body.includes('First edited.') && !r.body.includes('First paragraph.'));
  r = applyMarkdownOperations('a: 1\n\nb: 1\n', [{ op: 'edit', old: '1', prefix: 'b: ', new: '2' }]);
  check('edit disambiguates with prefix', r.body === 'a: 1\n\nb: 2\n');
  r = applyMarkdownOperations(DOC, [{ op: 'replace_section', anchor: { text: '## Section one' }, content: '## Section one\n\nNew one body.' }]);
  check('replace_section swaps heading through the next same-level heading',
    r.body.includes('New one body.') && !r.body.includes('Section one body.') && r.body.includes('Section two body.'));
  r = applyMarkdownOperations(DOC, [{ op: 'append_to_section', anchor: { text: '## Section one' }, content: 'Appended line.' }]);
  check('append_to_section inserts before the next same-level heading',
    /Appended line\.\n\n## Section two/.test(r.body));
  r = applyMarkdownOperations(DOC, [{ op: 'append_to_section', anchor: { text: '### Box head' }, content: 'Deep append.' }]);
  check('inner section append stays inside the details container',
    /Deep append\.\n\n<\/details>/.test(r.body) && !r.body.includes('Deep append.\n\nTail'));

  // ---- Anchor strictness (D2) -----------------------------------------------
  const inner = getMarkdownBlock(DOC, { text: 'Box head text.' });
  check('nested-text anchor resolves to the inner block, not ambiguous',
    inner.kind === 'paragraph' && inner.source === 'Box head text.\n\n');
  const container = getMarkdownBlock(DOC, { text: 'Evidence box' });
  check('summary anchor selects the whole container', container.kind === 'details'
    && container.source.includes('Box head text.'));
  const dup = throwsCode(() => applyMarkdownOperations(DOC, [{ op: 'remove', anchor: { text: 'Section' } }]), 'anchor_ambiguous');
  check('true duplicate returns anchor_ambiguous with context candidates',
    !!dup && Array.isArray(dup.extra?.candidates) && dup.extra.candidates.length > 1
      && dup.extra.candidates.every((c) => typeof c.context === 'string' && c.context.length > 0),
    JSON.stringify(dup?.extra?.candidates?.length));
  check('zero matches return anchor_not_found',
    throwsCode(() => applyMarkdownOperations(DOC, [{ op: 'remove', anchor: { text: 'no such text anywhere' } }]), 'anchor_not_found') !== undefined);
  check('block_id is rejected on Markdown (no stored ids)',
    throwsCode(() => applyMarkdownOperations(DOC, [{ op: 'remove', block_id: 'b-00000000' }]), 'invalid_target') !== undefined);
  check('block_id + anchor together is rejected',
    throwsCode(() => applyMarkdownOperations(DOC, [{ op: 'remove', block_id: 'b-1', anchor: { text: 'x' } }]), 'invalid_target') !== undefined);
  check('section op on a non-heading is rejected',
    throwsCode(() => applyMarkdownOperations(DOC, [{ op: 'replace_section', anchor: { text: 'First paragraph.' }, content: 'x' }]), 'section_target_not_heading') !== undefined);
  check('section read documents the container rule: Section two spans the details box and tail',
    getMarkdownSection(DOC, { text: '## Section two' }).source.includes('Tail paragraph.')
      && getMarkdownSection(DOC, { text: '## Section one' }).source.includes('Section one body.')
      && !getMarkdownSection(DOC, { text: '## Section one' }).source.includes('Section two body.'));

  // ---- Service journeys (temp DB) -------------------------------------------
  const db = openTrackerDb(path.join(tmp, 't1.db'));
  const md = db.createTicket({ project_id: 'proj-md', kind: 'spec', title: 'MD spec', body: DOC, created_by: 'smoke' });
  check('markdown outline via service has no ids', (() => {
    const o = db.getTicketOutline(md.id);
    return o.body_format === 'markdown' && o.body_revision === 1
      && o.blocks.every((b) => !('id' in b) && !('hash' in b));
  })());
  const read = db.getTicketBlock(md.id, null, { anchor: { text: 'Section two body.' } });
  check('markdown get-block returns the verbatim source', read.source === 'Section two body.\n\n'
    && read.section === 'Doc title > Section two');
  const secRead = db.getTicketBlock(md.id, null, { anchor: { text: '## Section one' }, section: true });
  check('markdown get-block --section returns the whole section',
    secRead.source.includes('Section one body.') && !secRead.source.includes('Section two body.'));
  const patched = db.patchTicketBlocks(md.id, {
    expected_revision: 1,
    operations: [{ op: 'replace', anchor: { text: 'First paragraph.' }, content: 'First via service.' }],
  });
  check('markdown patch commits: revision bump, outline, no ids, block_patched event',
    patched.body_format === 'markdown' && patched.body_revision === 2
      && patched.outline.every((b) => !('id' in b))
      && db.getTicket(md.id).body.includes('First via service.')
      && db.listEvents({ ticket_id: md.id }).some((e) => e.type === 'block_patched'),
    JSON.stringify({ rev: patched.body_revision }));
  check('markdown patch without expected_revision is rejected',
    (() => { try { db.patchTicketBlocks(md.id, { operations: [{ op: 'remove', anchor: { text: 'x' } }] }); return false; } catch (e) { return e.code === 'expected_revision_required'; } })());
  check('stale markdown patch conflicts with current revision + outline',
    (() => {
      try { db.patchTicketBlocks(md.id, { expected_revision: 1, operations: [{ op: 'remove', anchor: { text: 'Tail paragraph.' } }] }); return false; }
      catch (e) { return e.code === 'revision_conflict' && e.extra?.current_revision === 2 && Array.isArray(e.extra?.outline); }
    })());
  const revBefore = db.getTicket(md.id).body_revision;
  const bodyBefore = db.getTicket(md.id).body;
  try {
    db.patchTicketBlocks(md.id, {
      expected_revision: revBefore,
      operations: [
        { op: 'replace', anchor: { text: 'Tail paragraph.' }, content: 'Tail v2.' },
        { op: 'remove', anchor: { text: 'no such text anywhere' } },
      ],
    });
    check('mid-batch failure must throw', false);
  } catch (err) {
    check('op failing mid-batch writes nothing',
      err.code === 'anchor_not_found'
        && db.getTicket(md.id).body_revision === revBefore
        && db.getTicket(md.id).body === bodyBefore);
  }
  check('HTML outline still carries ids after the dispatch change', (() => {
    const h = db.createTicket({ project_id: 'proj-md', kind: 'spec', title: 'H', body: '<h2>A</h2><p>text</p>', body_format: 'html', created_by: 'smoke' });
    return db.getTicketOutline(h.id).blocks.every((b) => /^b-/.test(b.id));
  })());
  db.close();

  // ---- Tracker DB copy round trip -------------------------------------------
  const copyPath = process.env.GOLEM_TRACKER_DB_COPY;
  if (copyPath) {
    const copyDb = openTrackerDb(copyPath);
    const rows = copyDb.listTickets({ includeArchived: true });
    let total = 0;
    let pass = 0;
    const mismatches = [];
    for (const t of rows) {
      const full = copyDb.getTicket(t.id);
      if ((full.body_format ?? 'markdown') !== 'markdown') continue;
      total += 1;
      if (joinBlocks(splitMarkdownBlocks(full.body ?? '')) === (full.body ?? '')) pass += 1;
      else if (mismatches.length < 5) mismatches.push(`${t.display_id ?? t.id}`);
    }
    copyDb.close();
    check(`DB-copy Markdown round trip ${pass}/${total}`, pass === total, mismatches.join(','));
    console.log(`  COPY ROUND TRIP: ${pass}/${total} markdown bodies byte-exact`);
  } else {
    console.log('  skip  DB-copy round trip (set GOLEM_TRACKER_DB_COPY=<copy> for the full-corpus check)');
  }

  // ---- REST boundary: anchor reads + markdown patches ------------------------
  {
    fs.mkdirSync(path.join(tmp, 'projects', 'gol373'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'projects', 'gol373', 'CLAUDE.md'), '# gol373 rest probe');
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
      .find((p) => String(p.project_id ?? '').startsWith('gol373-'))?.project_id;
    check('REST: isolated dashboard ready', !!projectId, String(projectId));

    const mdCreated = await api('/api/tickets', { project_id: projectId, kind: 'spec', title: 'REST md', body: DOC, created_by: 'smoke' });
    const mdId = mdCreated.json.id;
    check('REST: markdown spec created', mdCreated.status === 201 && mdCreated.json.body_format === 'markdown');
    const mdOutline = await api(`/api/tickets/${mdId}/outline`);
    check('REST: markdown outline works with no ids',
      mdOutline.status === 200 && mdOutline.json.body_format === 'markdown'
        && mdOutline.json.blocks.every((b) => !('id' in b)));
    const mdBlock = await api(`/api/tickets/${mdId}/block?anchor=${encodeURIComponent('Section two body.')}`);
    check('REST: markdown anchor read returns the source',
      mdBlock.status === 200 && mdBlock.json.source === 'Section two body.\n\n', JSON.stringify(mdBlock.json).slice(0, 120));
    const mdSection = await api(`/api/tickets/${mdId}/block?anchor=${encodeURIComponent('## Section one')}&section=1`);
    check('REST: markdown section read returns the section',
      mdSection.status === 200 && mdSection.json.source.includes('Section one body.')
        && !mdSection.json.source.includes('Section two body.'));
    const mdPatch = await api(`/api/tickets/${mdId}/block-patches`, {
      expected_revision: 1, actor: 'smoke',
      operations: [{ op: 'replace', anchor: { text: 'First paragraph.' }, content: 'First via REST.' }],
    });
    check('REST: markdown anchor patch commits',
      mdPatch.status === 200 && mdPatch.json.body_revision === 2 && mdPatch.json.body_format === 'markdown');
    const mdAmbig = await api(`/api/tickets/${mdId}/block?anchor=${encodeURIComponent('Section')}`);
    check('REST: ambiguous anchor → 400 anchor_ambiguous with candidates',
      mdAmbig.status === 400 && mdAmbig.json?.code === 'anchor_ambiguous'
        && Array.isArray(mdAmbig.json?.candidates) && mdAmbig.json.candidates.length > 1);
    const mdStale = await api(`/api/tickets/${mdId}/block-patches`, {
      expected_revision: 1, actor: 'smoke',
      operations: [{ op: 'remove', anchor: { text: 'Tail paragraph.' } }],
    });
    check('REST: stale markdown patch → 409 with current revision',
      mdStale.status === 409 && mdStale.json?.code === 'revision_conflict' && mdStale.json?.current_revision === 2);

    const htmlCreated = await api('/api/tickets', { project_id: projectId, kind: 'spec', title: 'REST html', body: '<h2>Goals</h2><p>Alpha beta.</p>', body_format: 'html', created_by: 'smoke' });
    const htmlId = htmlCreated.json.id;
    const htmlBlock = await api(`/api/tickets/${htmlId}/block?anchor=${encodeURIComponent('Alpha beta')}`);
    check('REST: html anchor read returns the canonical block',
      htmlBlock.status === 200 && htmlBlock.json.html?.includes('Alpha beta'), JSON.stringify(htmlBlock.json?.html));
    const htmlPatch = await api(`/api/tickets/${htmlId}/block-patches`, {
      expected_revision: 1, actor: 'smoke',
      operations: [{ op: 'append_to_section', anchor: { text: 'Goals' }, content: '<p>Appended via REST.</p>' }],
    });
    check('REST: html anchor section op commits',
      htmlPatch.status === 200 && htmlPatch.json.body_revision === 2);
    const legacy = await api(`/api/tickets/${htmlId}/blocks/${htmlPatch.json.outline[0].id}`);
    check('REST: legacy block-id route unchanged', legacy.status === 200 && legacy.json.html?.startsWith('<h2'));

    dashboard.kill('SIGTERM');
    dashboard = null;
  }
  console.log(failures.length === 0 ? '\nALL GOL-373 CHECKS PASS' : `\n${failures.length} FAILURE(S)`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { dashboard?.kill('SIGKILL'); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
}
