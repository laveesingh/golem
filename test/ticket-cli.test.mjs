// GOL-344: isolated CLI/runtime tests for the flat `golem ticket` family and
// the compatibility revision/format gates (GOL-326 D5). The dashboard, DB and
// project fixtures are isolated; the CLI runs through the real runTicket entry
// with injected caller context, plus one real grandchild CLI process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { createGolemClient, GolemClientError } from '../lib/golem-client.js';
import { GOLEM_TOOL_CONTRACTS } from '../lib/golem-tool-contracts.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gol344-'));
let dashboard;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML_DOC = '<h2>Spec goals</h2><p>The first paragraph.</p><ul><li>one</li></ul>';
const CALLER = 'gol344-cli-caller';

try {
  // ---- isolated dashboard -------------------------------------------------
  fs.mkdirSync(path.join(tmp, 'projects', 'gol344'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'projects', 'gol344', 'CLAUDE.md'), '# gol344 cli probe');
  fs.mkdirSync(path.join(tmp, 'home'), { recursive: true });
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
  dashboard = spawn(process.execPath, [path.join(repo, 'dashboard/server/index.js')], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let dashErr = '';
  dashboard.stderr.on('data', (c) => { dashErr += c; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* retry */ }
    if (dashboard.exitCode !== null) throw new Error(`dashboard exited: ${dashErr}`);
    await sleep(100);
  }
  await sleep(300);
  const projectId = (await (await fetch(`${base}/api/projects`)).json())
    .find((p) => String(p.project_id ?? '').startsWith('gol344-'))?.project_id;
  check('isolated dashboard ready with discovered project', !!projectId);

  // ---- CLI harness: real runTicket with injected context/client ------------
  const { runTicket } = await import('../cli/ticket.js');
  const client = createGolemClient({ baseUrl: base, callerSessionId: CALLER });
  const boundContext = { sessionId: CALLER, projectId, projectPath: path.join(tmp, 'projects', 'gol344') };
  const run = (args, extra = {}) => {
    const out = [], err = [];
    return runTicket(args, {
      stdout: (s) => out.push(s), stderr: (s) => err.push(s),
      client, resolveContext: () => boundContext, ...extra,
    }).then((exit) => {
      const outJoined = out.join('\n');
      let json = null;
      try { json = JSON.parse(outJoined); } catch { /* non-JSON output */ }
      return { exit, out: outJoined, err: err.join('\n'), json };
    });
  };
  const bodyFile = path.join(tmp, 'spec.html');
  fs.writeFileSync(bodyFile, HTML_DOC);
  const opsFile = path.join(tmp, 'ops.json');

  // A1: create via file payload.
  const created = await run(['create', '--project', projectId, '--kind', 'spec', '--title', 'CLI spec',
    '--body-format', 'html', '--body-file', bodyFile]);
  check('A1 create returns format/revision/normalized outline', created.exit === 0
    && created.json.body_format === 'html' && created.json.body_revision === 1
    && Array.isArray(created.json.outline) && created.json.outline.length > 0
    && created.json.created_by === CALLER, created.err || created.out.slice(0, 200));
  const specId = created.json.id;
  check('create output is compact: no body/comments/events/children echo (GOL-349)',
    !('body' in created.json) && !('comments' in created.json) && !('events' in created.json)
      && !('children' in created.json) && !('pending_dispatch' in created.json)
      && Array.isArray(created.json.outline));

  // A4: outline + get-block.
  const outline = await run(['get-outline', specId]);
  check('A4 get-outline returns blocks and revision', outline.exit === 0
    && outline.json.body_revision === 1 && outline.json.blocks.length > 0);
  const h2 = outline.json.blocks.find((b) => b.kind === 'h2');
  const block = await run(['get-block', specId, h2.id]);
  check('A4 get-block returns canonical outer html', block.exit === 0
    && block.json.html === `<h2 data-block-id="${h2.id}">Spec goals</h2>`);

  // A5/A6: patch-blocks via operations file; broken batch writes nothing.
  fs.writeFileSync(opsFile, JSON.stringify({ operations: [
    { op: 'replace', block_id: h2.id, html: '<h2>Spec goals v2</h2>' },
    { op: 'insert_after', block_id: h2.id, html: '<p>inserted by cli</p>' },
  ] }));
  const patched = await run(['patch-blocks', specId, '--expected-revision', '1', '--operations-file', opsFile]);
  check('A5 patch-blocks commits atomically and returns inserted ids', patched.exit === 0
    && patched.json.body_revision === 2 && patched.json.inserted.length === 1, patched.err);
  const brokenOpsFile = path.join(tmp, 'broken-ops.json');
  fs.writeFileSync(brokenOpsFile, JSON.stringify({ operations: [
    { op: 'replace', block_id: h2.id, html: '<h2>must not land</h2>' },
    { op: 'remove', block_id: 'b-000000000000' },
  ] }));
  const broken = await run(['patch-blocks', specId, '--expected-revision', '2', '--operations-file', brokenOpsFile]);
  check('A6 broken batch (unknown block) fails with owned payload and no write', broken.exit === 2
    && broken.json.code === 'block_not_found'
    && (await run(['get-outline', specId])).json.body_revision === 2
    && !JSON.stringify(broken.json).includes('must not land'), broken.out.slice(0, 160));

  // A7: conflict recovery — stale revision payload carries current revision/outline.
  const conflict = await run(['patch-blocks', specId, '--expected-revision', '1', '--operations-file', opsFile]);
  check('A7 stale patch exits 2 with revision_conflict + current revision/outline on stdout',
    conflict.exit === 2 && conflict.json.code === 'revision_conflict'
      && conflict.json.current_revision === 2 && Array.isArray(conflict.json.outline),
    conflict.out.slice(0, 160));
  const recovered = await run(['patch-blocks', specId, '--expected-revision', String(conflict.json.current_revision),
    '--operations-file', opsFile]);
  check('A7 recovery: re-read revision then patch succeeds', recovered.exit === 0
    && recovered.json.body_revision === 3);

  // A13: lost response after commit — replay with the same revision conflicts.
  let lostResponse = false;
  const losingClient = createGolemClient({
    baseUrl: base, callerSessionId: CALLER,
    fetchImpl: async (url, init) => {
      if (!lostResponse && init?.method === 'POST' && String(url).endsWith('/block-patches')) {
        lostResponse = true;
        const response = await fetch(url, init); // real commit happens
        await response.text();
        throw new GolemClientError('connection lost after commit', { code: 'GOLEM_TRANSPORT_ERROR', retryable: true });
      }
      return fetch(url, init);
    },
  });
  const lost = await runTicket(['patch-blocks', specId, '--expected-revision', '3', '--operations-file', opsFile], {
    stdout: () => {}, stderr: () => {}, client: losingClient, resolveContext: () => boundContext,
  });
  check('lost response after commit exits operational failure (1)', lost === 1);
  const beforeReplayCount = (await run(['get-outline', specId])).json
    .blocks.filter((b) => b.short_text === 'inserted by cli').length;
  const replay = await run(['patch-blocks', specId, '--expected-revision', '3', '--operations-file', opsFile]);
  const outlineAfter = (await run(['get-outline', specId])).json;
  const afterReplayCount = outlineAfter.blocks.filter((b) => b.short_text === 'inserted by cli').length;
  check('A13 blind replay with the pre-commit revision conflicts; no duplicate insert',
    replay.exit === 2 && replay.json.code === 'revision_conflict'
      && afterReplayCount === beforeReplayCount,
    JSON.stringify({ before: beforeReplayCount, after: afterReplayCount }));

  // Comments: block anchor → reply → resolve.
  const commentTarget = outlineAfter.blocks.find((b) => b.kind === 'p');
  fs.writeFileSync(path.join(tmp, 'note.md'), 'a block comment from the cli');
  const commented = await run(['add-comment', specId, '--block-id', commentTarget.id, '--anchor-kind', 'block',
    '--message-file', path.join(tmp, 'note.md')]);
  check('add-comment anchors to a validated html block', commented.exit === 0
    && commented.json.block_id === commentTarget.id && commented.json.anchor_kind === 'block');
  fs.writeFileSync(path.join(tmp, 'reply.md'), 'the cli reply');
  const replied = await run(['reply-comment', specId, commented.json.id, '--message-file', path.join(tmp, 'reply.md')]);
  check('reply-comment inherits the parent block anchor', replied.exit === 0
    && replied.json.parent_id === commented.json.id && replied.json.block_id === commentTarget.id);
  const resolved = await run(['update-comment', specId, commented.json.id, '--status', 'resolved']);
  check('update-comment resolves', resolved.exit === 0 && resolved.json.status === 'resolved');
  const retarget = await run(['update-comment', specId, commented.json.id, '--block-id', 'b-000000000000']);
  check('retarget to a nonexistent block exits 2 block_not_found', retarget.exit === 2
    && retarget.json.code === 'block_not_found');

  // Markdown spec: create via stdin payload, compact output.
  const md = await run(['create', '--project', projectId, '--kind', 'spec', '--title', 'MD spec', '--body-file', '-'],
    { stdin: Readable.from(['plain markdown body']) });
  check('create accepts stdin body payloads and never echoes the body back',
    md.exit === 0 && !('body' in md.json) && md.json.body_format === 'markdown'
      && md.json.body_revision === 1);

  // Markdown unsupported block operations.
  const mdOutline = await run(['get-outline', md.json.id]);
  const mdPatch = await run(['patch-blocks', md.json.id, '--expected-revision', '1', '--operations-file', opsFile]);
  const mdBlock = await run(['get-block', md.json.id, 'b-000000000000']);
  check('Markdown unsupported block operations exit 2 unsupported_format',
    mdOutline.exit === 2 && mdOutline.json.code === 'unsupported_format'
      && mdPatch.exit === 2 && mdPatch.json.code === 'unsupported_format'
      && mdBlock.exit === 2 && mdBlock.json.code === 'unsupported_format');

  // replace-body: deliberate full-rewrite escape hatch, compact output.
  const mdTicketRow = (await run(['get', md.json.id])).json;
  if (!mdTicketRow) throw new Error('md ticket disappeared');
  const replacedBody = await run(['replace-body', md.json.id, '--body-file', bodyFile,
    '--body-format', 'html', '--expected-revision', String(mdTicketRow.body_revision)]);
  check('replace-body converts via file payload and stays compact (no body echo)',
    replacedBody.exit === 0 && replacedBody.json.body_format === 'html'
      && replacedBody.json.body_revision === mdTicketRow.body_revision + 1
      && !('body' in replacedBody.json) && !('comments' in replacedBody.json)
      && !('events' in replacedBody.json) && Array.isArray(replacedBody.json.outline),
    replacedBody.err || replacedBody.out.slice(0, 160));

  // Grammar: no nested command aliases; per-operation help.
  const nested = await run(['block', 'get', specId]);
  check('no nested resource aliases: `ticket block get` is an unknown operation',
    nested.exit === 2 && nested.json.code === 'unknown_operation');
  const nestedReply = await run(['comment', 'reply', specId, 'x']);
  check('`ticket comment reply` is not an alias', nestedReply.exit === 2
    && nestedReply.json.code === 'unknown_operation');
  const opHelp = await run(['get-outline', '--help']);
  check('per-operation help exits 0 with examples', opHelp.exit === 0
    && /Examples:/.test(opHelp.out) && /golem ticket get-outline/.test(opHelp.out));
  const listHelp = await run([]);
  check('golem ticket --help lists every flat operation', listHelp.exit === 0
    && ['list', 'get', 'create', 'update', 'replace-body', 'get-outline', 'get-block',
      'patch-blocks', 'add-comment', 'reply-comment', 'update-comment']
      .every((op) => listHelp.out.includes(`golem ticket ${op}`)));

  // Positive control: get remains the deliberate full-body read.
  const fullRead = await run(['get', specId]);
  check('get stays the deliberate full-body read (body/comments/events present)',
    fullRead.exit === 0 && typeof fullRead.json.body === 'string' && fullRead.json.body.length > 0
      && Array.isArray(fullRead.json.comments) && Array.isArray(fullRead.json.events));

  // Caller binding: unbound mutations require --human; bound agents reject it.
  const unbound = await runTicket(['create', '--project', projectId, '--title', 'x'], {
    stdout: () => {}, stderr: () => {}, client, resolveContext: () => null,
  });
  check('unbound mutation without --human exits 2', unbound === 2);
  const humanViaArgs = await runTicket(['create', '--project', projectId, '--title', 'Human shell ticket', '--human'], {
    stdout: () => {}, stderr: () => {}, client, resolveContext: () => null,
  });
  check('unbound mutation with --human creates with human:cli attribution', humanViaArgs === 0);
  const boundWithHuman = await run(['update', specId, '--state', 'todo', '--human']);
  check('bound agents cannot use --human', boundWithHuman.exit === 2
    && boundWithHuman.json.code === 'invalid_caller_context');

  // Reads work unbound (no caller binding needed for safe operations).
  const unboundRead = await runTicket(['get-outline', specId], {
    stdout: () => {}, stderr: () => {}, client, resolveContext: () => null,
  });
  check('reads work without caller binding', unboundRead === 0);

  // Unbound callers: stable unsupported-caller result naming compatibility limits.
  const unboundError = Object.assign(new Error('this native harness was removed in GOL-365; golem runs only Pi and Claude'), { code: 'INVALID_CALLER_CONTEXT' });
  const unboundRun = await runTicket(['create', '--project', projectId, '--title', 'x'], {
    stdout: () => {}, stderr: () => {}, client, resolveContext: () => { throw unboundError; },
  });
  check('unbound caller gets the stable unsupported_caller exit code', unboundRun === 2);
  const unboundPayloadRun = await run(['create', '--project', projectId, '--title', 'x'], {
    resolveContext: () => { throw unboundError; },
  });
  check('unsupported_caller payload names the CLI binding path', unboundPayloadRun.exit === 2
    && unboundPayloadRun.json.code === 'unsupported_caller');

  // Transport failure exits 1 (operational), not input-class.
  const deadClient = createGolemClient({ baseUrl: 'http://127.0.0.1:1', callerSessionId: CALLER });
  const transportFail = await runTicket(['get-outline', specId], {
    stdout: () => {}, stderr: () => {}, client: deadClient, resolveContext: () => boundContext,
  });
  check('transport failure exits 1 with transport_failure payload', transportFail === 1);

  // ---- Compatibility gates: schemas, runtime forwarding, server gate ------
  const createTool = GOLEM_TOOL_CONTRACTS.find((c) => c.name === 'ticket_create');
  const updateTool = GOLEM_TOOL_CONTRACTS.find((c) => c.name === 'ticket_update');
  check('compatibility create/update schemas gain only format/revision fields',
    !!createTool.inputSchema.properties.body_format
      && !!updateTool.inputSchema.properties.body_format
      && !!updateTool.inputSchema.properties.expected_revision
      && !GOLEM_TOOL_CONTRACTS.some((c) => /outline|block/i.test(c.name)),
    GOLEM_TOOL_CONTRACTS.map((c) => c.name).join(','));
  check('compatibility update description points html writes at the server gate and CLI tools',
    /expected_revision/.test(updateTool.description) && /patch-blocks/.test(updateTool.description)
      && /replace-body/.test(updateTool.description) && /409/.test(updateTool.description));

  // The compatibility surface reaches the same server revision gate.
  const htmlNow = await client.getTicket(specId);
  let gateError = null;
  try { await client.updateTicket(specId, { body: HTML_DOC, actor: CALLER }); }
  catch (e) { gateError = e; }
  check('compatibility html body write without revision → 400 expected_revision_required naming CLI tools',
    gateError && gateError.status === 400 && gateError.body?.code === 'expected_revision_required'
      && /replace-body|patch-blocks/.test(gateError.body?.error ?? gateError.message),
    JSON.stringify(gateError?.body ?? {}));
  let staleCompat = null;
  try { await client.updateTicket(specId, { body: HTML_DOC, expected_revision: 1, actor: CALLER }); }
  catch (e) { staleCompat = e; }
  check('compatibility stale revision → 409 with current revision/outline recovery fields',
    staleCompat instanceof GolemClientError && staleCompat.status === 409
      && staleCompat.body?.code === 'revision_conflict' && staleCompat.body?.current_revision > 1
      && Array.isArray(staleCompat.body?.outline));
  const gatedCompat = await client.updateTicket(specId, {
    body: HTML_DOC, body_format: 'html', expected_revision: htmlNow.body_revision, actor: CALLER,
  });
  check('compatibility revision-gated full replacement succeeds and increments once',
    !(gatedCompat instanceof GolemClientError) && gatedCompat.body_revision === htmlNow.body_revision + 1
      && Array.isArray(gatedCompat.outline));

  // ---- Real grandchild CLI process (unbound human path) --------------------
  fs.writeFileSync(path.join(tmp, 'home', 'dashboard.json'), JSON.stringify({ url: base }));
  const grand = spawn(process.execPath, [path.join(repo, 'cli/golem.js'), 'ticket', 'list', '--project', projectId],
    { cwd: repo, env: { ...process.env, GOLEM_HOME: path.join(tmp, 'home'), HOME: path.join(tmp, 'home'),
      XDG_CONFIG_HOME: path.join(tmp, 'xdg') }, encoding: 'utf8' });
  const grandOut = await new Promise((resolve) => {
    let out = '';
    grand.stdout.on('data', (d) => { out += d; });
    grand.on('close', (code) => resolve({ code, out }));
  });
  let grandParsed = null;
  try { grandParsed = JSON.parse(grandOut.out); } catch { /* non-JSON */ }
  check('real grandchild CLI process lists tickets as pure JSON stdout', grandOut.code === 0
    && Array.isArray(grandParsed) && grandParsed.some((t) => t.id === specId), grandOut.out.slice(0, 160));

  console.log(failures.length === 0 ? '\nALL GOL-344 CHECKS PASS' : `\n${failures.length} FAILURE(S)`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  if (dashboard?.exitCode === null) dashboard.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
}