// GOL-374 (T2): server-side Mermaid check that commits and reports
// (GOL-369 R6, D7). Isolated: temp DB only, no dashboard spawn — the check
// runs synchronously inside the tracker write calls.
//
// Report mode (corpus scan, read-only apart from opening the copy):
//   node test/mermaid-check.test.mjs --corpus <copy of ~/.golem/tracker.db>
// lists broken diagrams already stored. Record the count on GOL-374; the
// scan never fixes anything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTrackerDb } from '../dashboard/server/tracker-db.js';
import {
  extractDiagrams, checkChangedDiagrams, checkSources, __testSetWorkerPath,
} from '../dashboard/server/mermaid-check.js';
import { resolveAnchor } from '../dashboard/server/body-anchor.js';
import { splitMarkdownBlocks, spansFromBlocks } from '../dashboard/server/md-body.js';
import { parseAndNormalizeDoc, resolveHtmlAnchor } from '../dashboard/server/html-body.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gol374-'));
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
void repo;

const VALID = {
  flowchart: 'flowchart LR\n  A-->B',
  sequence: 'sequenceDiagram\n  A->>B: hi',
  state: 'stateDiagram-v2\n  A --> B',
  class: 'classDiagram\n  A <|-- B',
  er: 'erDiagram\n  A ||--o{ B : has',
  mindmap: 'mindmap\n  root((R))\n    child',
  architecture: 'architecture-beta\n  group g(icons)[G]\n  service s(server)[S] in g',
  gantt: 'gantt\n  title T\n  dateFormat X\n  section S\n  a :a1, 2024-01-01, 1d',
  pie: 'pie title T\n  "a" : 1',
  journey: 'journey\n  title T\n  section S\n  a: 5: me',
};
const BROKEN_PAREN = 'flowchart LR\n  A[a (b)]';
const BROKEN_EDGE = 'flowchart LR\n  A-->';
const BROKEN_CLASS = 'classDiagram\n  A <|--';
const fence = (src) => `# T\n\n\`\`\`mermaid\n${src}\n\`\`\`\n`;

// ---- Report mode: corpus scan ------------------------------------------------
const argv = process.argv.slice(2);
if (argv[0] === '--corpus') {
  const copyPath = argv[1];
  if (!copyPath) {
    console.log('usage: node test/mermaid-check.test.mjs --corpus <tracker.db copy>');
    process.exit(2);
  }
  const db = openTrackerDb(copyPath);
  let ticketsWithBroken = 0;
  let brokenDiagrams = 0;
  for (const row of db.listTickets({ includeArchived: true })) {
    const full = db.getTicket(row.id);
    const format = full.body_format ?? 'markdown';
    if (format !== 'markdown' && format !== 'html') continue;
    const diagrams = extractDiagrams(full.body ?? '', format);
    if (!diagrams.length) continue;
    const verdicts = checkSources(diagrams.map((d) => d.source), format);
    const broken = diagrams.filter((d) => verdicts.get(d.source));
    if (!broken.length) continue;
    ticketsWithBroken += 1;
    brokenDiagrams += broken.length;
    for (const b of broken) {
      const v = verdicts.get(b.source);
      console.log(`${full.display_id ?? full.id} [${format}] ${b.firstLine.slice(0, 60)} — line ${v.line}: ${v.message}`);
    }
  }
  db.close();
  console.log(`CORPUS REPORT: ${brokenDiagrams} broken diagrams on ${ticketsWithBroken} tickets (report only, nothing fixed)`);
  process.exit(0);
}

try {
  // ---- Module: one fixture per diagram type ---------------------------------
  for (const [name, src] of Object.entries(VALID)) {
    check(`valid ${name} parses clean`, checkChangedDiagrams('', fence(src), 'markdown').length === 0);
  }
  for (const [name, src, line] of [['paren', BROKEN_PAREN, 2], ['dangling edge', BROKEN_EDGE, 3], ['class edge', BROKEN_CLASS, 2]]) {
    const errs = checkChangedDiagrams('', fence(src), 'markdown');
    check(`broken ${name} reports first_line/line/message/anchor`,
      errs.length === 1 && errs[0].first_line === src.split('\n')[0] && errs[0].line === line
        && typeof errs[0].message === 'string' && errs[0].message.length > 0
        && typeof errs[0].anchor?.text === 'string'
        && Object.keys(errs[0]).sort().join(',') === 'anchor,first_line,line,message',
      JSON.stringify(errs[0]));
  }

  // ---- Module: anchors resolve through body-anchor.js ------------------------
  {
    const after = fence(BROKEN_PAREN);
    const errs = checkChangedDiagrams('', after, 'markdown');
    const blocks = splitMarkdownBlocks(after);
    const hit = resolveAnchor(after, spansFromBlocks(blocks), errs[0].anchor).ref;
    check('markdown error anchor resolves to the diagram code block', hit?.kind === 'code');
    const htmlAfter = `<h2>D</h2><div class="mermaid">${BROKEN_PAREN}</div>`;
    const htmlErrs = checkChangedDiagrams('', htmlAfter, 'html');
    check('html broken diagram reports with an anchor', htmlErrs.length === 1 && typeof htmlErrs[0].anchor?.text === 'string');
    const doc = parseAndNormalizeDoc(htmlAfter).doc;
    check('html error anchor resolves to the diagram block',
      resolveHtmlAnchor(doc, htmlErrs[0].anchor) != null);
  }

  // ---- Module: changed-only ---------------------------------------------------
  {
    const before = fence(BROKEN_PAREN);
    check('unchanged broken fence is absent from the write report',
      checkChangedDiagrams(before, before, 'markdown').length === 0);
    const after = `${before}\n\n\`\`\`mermaid\n${BROKEN_EDGE}\n\`\`\`\n`;
    const errs = checkChangedDiagrams(before, after, 'markdown');
    check('only the newly added broken diagram is reported',
      errs.length === 1 && errs[0].first_line === 'flowchart LR' && errs[0].line === 3,
      JSON.stringify(errs.map((e) => e.line)));
    const fixed = before.replace('A[a (b)]', 'A[A]');
    check('fixing the fence clears the report', checkChangedDiagrams(before, fixed, 'markdown').length === 0);
  }

  // ---- Tracker write paths (temp DB): commit + report ------------------------
  const db = openTrackerDb(path.join(tmp, 't2.db'));
  const committedWith = (id, snippet) => db.getTicket(id).body.includes(snippet);

  // Create with a broken fence.
  const created = db.createTicket({ project_id: 'proj-mm', kind: 'spec', title: 'Broken', body: fence(BROKEN_PAREN), created_by: 'smoke' });
  check('create commits the broken fence and returns mermaid_errors',
    committedWith(created.id, 'A[a (b)]') && created.mermaid_errors?.length === 1
      && created.mermaid_errors[0].first_line === 'flowchart LR');
  const clean = db.createTicket({ project_id: 'proj-mm', kind: 'spec', title: 'Clean', body: fence(VALID.flowchart), created_by: 'smoke' });
  check('clean create carries no mermaid_errors key', !('mermaid_errors' in clean));

  // Replace-body (full-body update) with a broken fence.
  const replaced = db.updateTicket(clean.id, { body: fence(BROKEN_EDGE), actor: 'smoke' });
  check('replace-body commits the broken fence and returns mermaid_errors',
    committedWith(clean.id, 'A-->') && replaced.mermaid_errors?.length === 1 && replaced.mermaid_errors[0].line === 3);

  // Patch-blocks inserting a broken fence, then the anchor fix loop.
  const patchTarget = db.createTicket({ project_id: 'proj-mm', kind: 'spec', title: 'Patch me', body: '# P\n\nPara one.\n', created_by: 'smoke' });
  const patched = db.patchTicketBlocks(patchTarget.id, {
    expected_revision: 1,
    operations: [{ op: 'insert_after', anchor: { text: 'Para one.' }, content: `\`\`\`mermaid\n${BROKEN_CLASS}\n\`\`\`` }],
  });
  check('patch-blocks commits the broken fence and returns mermaid_errors',
    committedWith(patchTarget.id, 'A <|--') && patched.mermaid_errors?.length === 1);
  {
    const anchor = patched.mermaid_errors[0].anchor;
    const firstLine = patched.mermaid_errors[0].first_line;
    const rev = db.getTicket(patchTarget.id).body_revision;
    // One edit op using the returned anchor's first line fixes the diagram.
    const fixed = db.patchTicketBlocks(patchTarget.id, {
      expected_revision: rev,
      operations: [{ op: 'edit', old: `${firstLine}\n  A <|--`, new: `${firstLine}\n  A <|-- B` }],
    });
    void anchor;
    check('mermaid_errors[0] anchor line fixes it through one edit op',
      !('mermaid_errors' in fixed) && committedWith(patchTarget.id, 'A <|-- B'));
  }

  // Compatibility PATCH: full-body HTML write with a broken .mermaid div.
  const htmlTicket = db.createTicket({
    project_id: 'proj-mm', kind: 'spec', title: 'HTML', body: '<h2>D</h2><p>Text.</p>',
    body_format: 'html', created_by: 'smoke',
  });
  const htmlPatched = db.updateTicket(htmlTicket.id, {
    body: `<h2>D</h2><p>Text.</p><div class="mermaid">${BROKEN_PAREN}</div>`,
    expected_revision: 1, actor: 'smoke',
  });
  check('compatibility PATCH commits the broken diagram and returns mermaid_errors',
    committedWith(htmlTicket.id, 'A[a (b)]') && htmlPatched.mermaid_errors?.length === 1);

  // Unchanged broken fence: absent from the write response, present on outline.
  const still = db.updateTicket(created.id, { body: `${fence(BROKEN_PAREN)}\n\nAnother paragraph.\n`, actor: 'smoke' });
  check('unchanged broken fence is absent from the write response', !('mermaid_errors' in still));
  const mdOutline = db.getTicketOutline(created.id);
  const flaggedMd = mdOutline.blocks.filter((b) => b.mermaid_error);
  check('unchanged broken fence is present as mermaid_error on get-outline (markdown)',
    flaggedMd.length === 1 && flaggedMd[0].kind === 'code' && flaggedMd[0].mermaid_error.line === 2
      && typeof flaggedMd[0].mermaid_error.message === 'string');
  const htmlOutline = db.getTicketOutline(htmlTicket.id);
  const flaggedHtml = htmlOutline.blocks.filter((b) => b.mermaid_error);
  check('unchanged broken fence is present as mermaid_error on get-outline (html)',
    flaggedHtml.length === 1 && flaggedHtml[0].mermaid_error.line === 2);
  check('outline entries are otherwise unchanged (additive mermaid_error only)',
    mdOutline.blocks.every((b) => b.mermaid_error === undefined || (b.kind === 'code' && typeof b.mermaid_error.line === 'number'))
      && htmlOutline.blocks.every((b) => b.id && b.hash && b.comments));

  // T2 follow-up: a worker that never answers must not freeze the server.
  // Unique diagram source (uncached) forces the worker round trip.
  __testSetWorkerPath(path.join(repo, 'test/fixtures/mermaid-silent-worker.mjs'));
  try {
    const t0 = Date.now();
    const stuck = db.createTicket({
      project_id: 'proj-mm', kind: 'spec', title: 'Stuck worker',
      body: fence('flowchart LR\n  SILENT_HUNG_1 --> B'), created_by: 'smoke',
    });
    const elapsed = Date.now() - t0;
    check('hung worker: write returns in ~2s, commits, reports no mermaid_errors',
      elapsed >= 1500 && elapsed < 10000
        && committedWith(stuck.id, 'SILENT_HUNG_1') && !('mermaid_errors' in stuck),
      `${elapsed}ms`);
  } finally {
    __testSetWorkerPath(null);
  }

  db.close();
  console.log(failures.length === 0 ? '\nALL GOL-374 CHECKS PASS' : `\n${failures.length} FAILURE(S)`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
