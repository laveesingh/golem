// GOL-375 (T3) integration: every op kind once through the REAL CLI against
// an isolated dashboard.
//
// Self-contained and re-runnable: `node test/gol369-integration.mjs`.
// Spawns its own dashboard on an ephemeral port (never 7420) with a temp
// tracker DB, creates one Markdown spec and one HTML spec as quarantined
// scratch tickets (SMOKE- titles via dashboard/scripts/_scratch.mjs, archived
// in `finally`), drives each block-op kind through `cli/golem.js` with the
// single-op heredoc form, and fixes one broken-diagram write through the
// returned anchor. Prints every command and its result; exits 0 only when
// every check passes.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gol369-int-'));
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dashboard;
const scratchIds = [];

try {
  // ---- isolated dashboard (own port, temp DB) -------------------------------
  const reservation = net.createServer();
  await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const base = `http://127.0.0.1:${port}`;
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'dashboard.json'), JSON.stringify({ url: base }));
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1',
    GOLEM_HOME: home, GOLEM_TRACKER_DB: path.join(tmp, 'tracker.db'),
    XDG_CONFIG_HOME: path.join(tmp, 'xdg'), HOME: home,
    GOLEM_PROJECTS_ROOT: path.join(tmp, 'projects'), GOLEM_IDEAS_ROOT: path.join(tmp, 'ideas'),
    GOLEM_ROOT: repo, LOG_LEVEL: 'error', GOLEM_SMOKE_API: base,
  };
  dashboard = spawn(process.execPath, [path.join(repo, 'dashboard/server/index.js')],
    { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let dashErr = '';
  dashboard.stderr.on('data', (c) => { dashErr += c; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* retry */ }
    if (dashboard.exitCode !== null) throw new Error(`dashboard exited: ${dashErr}`);
    await sleep(100);
  }
  check('isolated dashboard ready on a non-shared port', true, base);
  console.log(`$ dashboard on ${base} (temp DB)`);
  // Scratch tickets route through _scratch.mjs in THIS process too.
  process.env.GOLEM_SMOKE_API = base;

  // ---- real CLI driver -------------------------------------------------------
  // The grandchild walks process ancestry for caller binding; under an agent
  // session that walk hits harness processes and fails ambiguously instead
  // of resolving unbound. A fake `ps` on PATH simulates a plain human shell
  // (ppid 1, no native ancestors) so the CLI takes the documented unbound
  // --human path. Caller binding itself is covered by test/ticket-cli.test.mjs;
  // this script covers ops, anchors and mermaid reporting through the real
  // cli/golem.js binary.
  const fakeBin = path.join(tmp, 'fakebin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'ps'), '#!/bin/sh\ncase "$4" in\n  ppid=) echo "1" ;;\n  command=) echo "-bash" ;;\n  lstart=) echo "Thu Jan  1 00:00:00 2026" ;;\n  *) echo "" ;;\nesac\n');
  fs.chmodSync(path.join(fakeBin, 'ps'), 0o755);
  const cliEnv = {
    ...process.env, GOLEM_HOME: home, HOME: home, XDG_CONFIG_HOME: path.join(tmp, 'xdg'),
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  // Review fix: inherited session identity must not leak into the grandchild.
  // From a Claude Code session, cli-session-context.js:83 rejects unbound
  // --human mutations when these are present. Test-only scrub; the script
  // already simulates a plain human shell (fake `ps` above).
  for (const name of ['CLAUDE_CODE_SESSION_ID', 'GOLEM_SESSION_ID', 'GOLEM_CEO_SESSION_ID',
    'PI_SESSION_ID', 'GOLEM_MANAGED_CODEX_BOUND']) {
    delete cliEnv[name];
  }
  const cli = (args, stdinText = null) => {
    const cmd = `golem ticket ${args.join(' ')}`;
    const res = spawnSync(process.execPath, [path.join(repo, 'cli/golem.js'), 'ticket', ...args], {
      cwd: repo, env: cliEnv, encoding: 'utf8',
      input: stdinText ?? undefined,
    });
    let json = null;
    try { json = JSON.parse(res.stdout); } catch { /* non-JSON */ }
    console.log(`$ ${cmd}${stdinText != null ? ' <<\'EOF\' ...' : ''} → exit ${res.status}`);
    return { exit: res.status, json, out: res.stdout, err: res.stderr };
  };

  // ---- scratch specs (quarantined SMOKE project, archived in finally) --------
  const { createScratchTicket, archiveTicket } = await import('../dashboard/scripts/_scratch.mjs');
  const mdBody = '# Integration MD\n\nAlpha paragraph.\n\n## Section one\n\nSection body.\n\nTail paragraph.\n';
  const md = await createScratchTicket({ kind: 'spec', title: 'GOL-369 markdown', body: mdBody });
  const html = await createScratchTicket({
    kind: 'spec', title: 'GOL-369 html', body_format: 'html',
    body: '<h2>Goals</h2><p>First html paragraph.</p><h2>Next</h2><p>Second html paragraph.</p>',
  });
  scratchIds.push(md.id, html.id);
  check('scratch specs created in quarantine', md.id && html.id, `${md.display_id} ${html.display_id}`);

  const revOf = (id) => {
    const r = cli(['get-outline', id, '--human']);
    if (r.exit !== 0) throw new Error(`get-outline failed: ${r.err}`);
    return r.json.body_revision;
  };

  // ---- Markdown: each op kind once, single-op heredoc form -------------------
  let rev = revOf(md.id);
  const mdPatch = (opArgs, stdinText = null) => {
    const r = cli(['patch-blocks', md.id, '--expected-revision', String(rev), ...opArgs, '--human'], stdinText);
    if (r.exit === 0) rev = r.json.body_revision;
    return r;
  };
  check('md replace', mdPatch(['--op', 'replace', '--anchor', 'Alpha paragraph.'], 'Alpha REPLACED.\n').exit === 0);
  check('md insert_before', mdPatch(['--op', 'insert_before', '--anchor', '## Section one'], 'Before section.\n').exit === 0);
  check('md insert_after', mdPatch(['--op', 'insert_after', '--anchor', 'Tail paragraph.'], 'After tail.\n').exit === 0);
  check('md move_before', mdPatch(['--op', 'move_before', '--anchor', 'After tail.', '--to-anchor', 'Alpha REPLACED.']).exit === 0);
  check('md move_after', mdPatch(['--op', 'move_after', '--anchor', 'Before section.', '--to-anchor', 'Tail paragraph.']).exit === 0);
  check('md edit', mdPatch(['--op', 'edit', '--old', 'Section body.'], 'Section BODY.\n').exit === 0);
  check('md replace_section', mdPatch(['--op', 'replace_section', '--anchor', '## Section one'], '## Section one\n\nNew section body.\n').exit === 0);
  check('md append_to_section', mdPatch(['--op', 'append_to_section', '--anchor', '## Section one'], 'Appended line.\n').exit === 0);
  check('md remove', mdPatch(['--op', 'remove', '--anchor', 'Appended line.']).exit === 0);

  const mdRead = cli(['get-block', md.id, '--anchor', 'New section body.', '--human']);
  check('md get-block --anchor', mdRead.exit === 0 && mdRead.json.source.includes('New section body.'));
  const mdSec = cli(['get-block', md.id, '--anchor', '## Section one', '--section', '--human']);
  check('md get-block --anchor --section', mdSec.exit === 0 && mdSec.json.source.includes('New section body.'));

  // ---- HTML: anchor ops + legacy block-id form --------------------------------
  let hrev = revOf(html.id);
  const htmlPatch = (opArgs, stdinText = null) => {
    const r = cli(['patch-blocks', html.id, '--expected-revision', String(hrev), ...opArgs, '--human'], stdinText);
    if (r.exit === 0) hrev = r.json.body_revision;
    return r;
  };
  check('html anchor replace', htmlPatch(['--op', 'replace', '--anchor', 'First html paragraph.'], '<p>First html REPLACED.</p>\n').exit === 0);
  const outline = cli(['get-outline', html.id, '--human']).json;
  const secondPara = outline.blocks.find((b) => b.short_text === 'Second html paragraph.');
  check('html legacy {block_id, html} still works',
    htmlPatch(['--op', 'replace', '--block-id', secondPara.id], '<p>Second via legacy.</p>\n').exit === 0);
  check('html anchor insert + move with to_anchor',
    htmlPatch(['--op', 'insert_after', '--anchor', 'Goals'], '<p>Inserted html.</p>\n').exit === 0
    && htmlPatch(['--op', 'move_before', '--anchor', 'Inserted html.', '--to-anchor', 'First html REPLACED.']).exit === 0);
  check('html anchor section op',
    htmlPatch(['--op', 'append_to_section', '--anchor', 'Next'], '<p>Next appended.</p>\n').exit === 0);
  check('html edit op',
    htmlPatch(['--op', 'edit', '--old', 'Second via legacy.'], 'Second via edit.\n').exit === 0);
  check('html remove op',
    htmlPatch(['--op', 'remove', '--anchor', 'Inserted html.']).exit === 0);
  const htmlRead = cli(['get-block', html.id, '--anchor', 'Next appended.', '--human']);
  check('html get-block --anchor', htmlRead.exit === 0 && htmlRead.json.html.includes('Next appended.'));
  const htmlBlockId = cli(['get-block', html.id, secondPara.id, '--human']);
  check('html get-block <id> <block-id> unchanged', htmlBlockId.exit === 0 && htmlBlockId.json.block_id === secondPara.id);

  // ---- Broken-diagram write fixed through the returned anchor -----------------
  const broken = cli(['create', '--project', 'smoketests-000000', '--kind', 'spec', '--title', 'GOL-369 broken', '--body-file', '-', '--human'],
    '# Broken\n\n```mermaid\nflowchart LR\n  A[a (b)]\n```\n');
  scratchIds.push(broken.json?.id);
  check('broken-diagram write commits and reports mermaid_errors',
    broken.exit === 0 && broken.json.mermaid_errors?.length === 1
      && broken.json.mermaid_errors[0].first_line === 'flowchart LR',
    JSON.stringify(broken.json?.mermaid_errors));
  const anchorErr = broken.json.mermaid_errors[0];
  const fixRev = cli(['get-outline', broken.json.id, '--human']).json.body_revision;
  const fix = cli(['patch-blocks', broken.json.id, '--expected-revision', String(fixRev),
    '--op', 'edit', '--old', `${anchorErr.first_line}\n  A[a (b)]`, '--human'], `${anchorErr.first_line}\n  A[A]\n`);
  check('one edit op using the returned anchor fixes the diagram',
    fix.exit === 0 && !('mermaid_errors' in fix.json));

  console.log(failures.length === 0 ? '\nALL GOL-369 INTEGRATION CHECKS PASS' : `\n${failures.length} FAILURE(S)`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  if (scratchIds.length) {
    try {
      const { archiveTicket } = await import('../dashboard/scripts/_scratch.mjs');
      for (const id of scratchIds) {
        if (id) await archiveTicket(id).catch(() => {});
      }
      console.log(`archived scratch tickets: ${scratchIds.filter(Boolean).join(', ')}`);
    } catch { /* best-effort */ }
  }
  try { dashboard?.kill('SIGKILL'); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
}
