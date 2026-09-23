// GOL-346: final integration/verification for HTML spec collaboration.
// Covers the cross-surface acceptance journeys that the per-slice suites do
// not already own: quarantined scratch fixtures (GOL-326 A5/A7/A15 on a real
// scratch spec), the CLI authoring loop against those fixtures, unbound-caller
// caller limits (A16), and — when the local native Pi toolchain is reachable —
// a real native Pi caller-binding probe. Everything is isolated; scratch
// tickets are archived in `finally`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createScratchTicket, archiveTicket, SMOKE_PROJECT } from '../dashboard/scripts/_scratch.mjs';
import { runTicket } from '../cli/ticket.js';
import { createGolemClient } from '../lib/golem-client.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gol346-'));
let dashboard;
let previousSmokeApi;
const scratchIds = [];
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML_BODY = '<h2>Scratch goals</h2><p>Alpha paragraph.</p><ul><li>one</li></ul>';

try {
  // ── isolated dashboard ──────────────────────────────────────────────────────
  fs.mkdirSync(path.join(tmp, 'projects', 'gol346'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'projects', 'gol346', 'CLAUDE.md'), '# gol346 acceptance fixture');
  fs.mkdirSync(path.join(tmp, 'home'), { recursive: true });
  const reservation = net.createServer();
  await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const base = `http://127.0.0.1:${port}`;
  // _scratch.mjs reads GOLEM_SMOKE_API from process.env — point it at the
  // isolated dashboard BEFORE any scratch call so fixtures never leak to a
  // shared runtime; restored in finally.
  const previousSmokeApi = process.env.GOLEM_SMOKE_API;
  process.env.GOLEM_SMOKE_API = base;
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1',
    GOLEM_HOME: path.join(tmp, 'home'), GOLEM_TRACKER_DB: path.join(tmp, 'rest.db'),
    XDG_CONFIG_HOME: path.join(tmp, 'xdg'), HOME: path.join(tmp, 'home'),
    GOLEM_PROJECTS_ROOT: path.join(tmp, 'projects'), GOLEM_IDEAS_ROOT: path.join(tmp, 'ideas'),
    GOLEM_ROOT: repo, LOG_LEVEL: 'error', GOLEM_SMOKE_API: base,
  };
  fs.mkdirSync(env.GOLEM_HOME, { recursive: true });
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
    .find((p) => String(p.project_id ?? '').startsWith('gol346-'))?.project_id;
  check('isolated dashboard ready', !!projectId);

  // ── A1/A5/A7/A15 on quarantined scratch fixtures ───────────────────────────
  const scratchSpec = await createScratchTicket({
    kind: 'spec', title: 'SMOKE-gol346 html acceptance', body_format: 'html', body: HTML_BODY,
  });
  scratchIds.push(scratchSpec.id);
  check('A1 scratch html spec created in the quarantined project with format metadata',
    scratchSpec.project_id === SMOKE_PROJECT && scratchSpec.body_format === 'html'
      && scratchSpec.body_revision === 1 && /data-block-id="b-/.test(scratchSpec.body)
      && String(scratchSpec.title).startsWith('SMOKE-'),
    JSON.stringify({ project: scratchSpec.project_id, format: scratchSpec.body_format }));

  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + route, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const outline = await api(`/api/tickets/${scratchSpec.id}/outline`);
  check('A4 outline on a scratch fixture', outline.status === 200 && outline.json.blocks.length >= 3);
  const firstBlock = outline.json.blocks[0];

  const noRev = await api(`/api/tickets/${scratchSpec.id}`, { body: HTML_BODY, actor: 'smoke' }, 'PATCH');
  check('A15 scratch html full-body write without revision → 400 expected_revision_required',
    noRev.status === 400 && noRev.json?.code === 'expected_revision_required');
  const stale = await api(`/api/tickets/${scratchSpec.id}`, { body: HTML_BODY, expected_revision: 99, actor: 'smoke' }, 'PATCH');
  check('A7 stale scratch write → 409 with current revision/outline',
    stale.status === 409 && stale.json?.code === 'revision_conflict' && stale.json?.current_revision === 1
      && Array.isArray(stale.json?.outline));
  const batch = await api(`/api/tickets/${scratchSpec.id}/block-patches`, {
    expected_revision: 1, actor: 'smoke',
    operations: [
      { op: 'replace', block_id: firstBlock.id, html: '<h2>Scratch goals v2</h2>' },
      { op: 'insert_after', block_id: firstBlock.id, html: '<p>inserted during acceptance</p>' },
    ],
  });
  check('A5 scratch batch commits atomically (one increment, inserted id)',
    batch.status === 200 && batch.json.body_revision === 2 && batch.json.inserted.length === 1);

  // ── CLI authoring loop against the scratch fixture ─────────────────────────
  const caller = 'gol346-cli-caller';
  const client = createGolemClient({ baseUrl: base, callerSessionId: caller });
  const context = { sessionId: caller, projectId };
  const run = async (args, extra = {}) => {
    const out = [], err = [];
    const exit = await runTicket(args, {
      stdout: (s) => out.push(s), stderr: (s) => err.push(s),
      client, resolveContext: () => context, ...extra,
    });
    let json = null;
    try { json = JSON.parse(out.join('\n')); } catch { /* non-JSON */ }
    return { exit, out: out.join('\n'), err: err.join('\n'), json };
  };
  const cliOutline = await run(['get-outline', scratchSpec.display_id || scratchSpec.id]);
  check('A4 CLI get-outline resolves the scratch display id', cliOutline.exit === 0
    && cliOutline.json.body_revision === 2);
  const cliBlock = await run(['get-block', scratchSpec.display_id, firstBlock.id]);
  check('A4 CLI get-block returns the canonical block', cliBlock.exit === 0
    && cliBlock.json.block_id === firstBlock.id);
  const opsFile = path.join(tmp, 'ops.json');
  fs.writeFileSync(opsFile, JSON.stringify({ operations: [
    { op: 'replace', block_id: firstBlock.id, html: '<h2>Scratch goals v3 via CLI</h2>' },
  ] }));
  const cliPatch = await run(['patch-blocks', scratchSpec.display_id, '--expected-revision', '2', '--operations-file', opsFile]);
  check('A5 CLI patch-blocks against the scratch fixture', cliPatch.exit === 0
    && cliPatch.json.body_revision === 3);
  const noteFile = path.join(tmp, 'note.md');
  fs.writeFileSync(noteFile, 'acceptance comment on the scratch spec');
  const commented = await run(['add-comment', scratchSpec.display_id, '--block-id', firstBlock.id,
    '--anchor-kind', 'block', '--message-file', noteFile]);
  check('A8 CLI add-comment anchors the persisted block id', commented.exit === 0
    && commented.json.block_id === firstBlock.id);
  const replied = await run(['reply-comment', scratchSpec.display_id, commented.json.id,
    '--message-file', noteFile]);
  check('A8 CLI reply-comment inherits the anchor', replied.exit === 0
    && replied.json.block_id === firstBlock.id);

  // ── A16: unbound-caller CLI mutation limits ───────────────────────────────
  const unboundCallerError = Object.assign(
    new Error('no live Pi/Claude CLI caller binding for a mutation'),
    { code: 'INVALID_CALLER_CONTEXT' });
  const unboundCaller = await run(['patch-blocks', scratchSpec.display_id, '--expected-revision', '3', '--operations-file', opsFile], {
    resolveContext: () => { throw unboundCallerError; },
  });
  check('A16 unbound-caller CLI mutation → stable unsupported_caller naming limits',
    unboundCaller.exit === 2 && unboundCaller.json.code === 'unsupported_caller'
      && /Pi\/Claude/.test(unboundCaller.json.error) && /trusted Pi\/Claude session/.test(unboundCaller.json.message),
    unboundCaller.out.slice(0, 200));
  const unboundCallerRead = await run(['get-outline', scratchSpec.display_id], {
    resolveContext: () => { throw unboundCallerError; },
  });
  check('A16 unbound-caller reads stay available', unboundCallerRead.exit === 0);

  // Compatibility MCP path reaches the same server gate (no html bypass).
  let compatGate = null;
  try { await client.updateTicket(scratchSpec.id, { body: HTML_BODY, actor: caller }); }
  catch (e) { compatGate = e; }
  check('A15 compatibility ticket_update html write without revision hits the server gate',
    compatGate && compatGate.status === 400 && compatGate.body?.code === 'expected_revision_required');

  // ── A16: real native Pi caller binding (bounded attempt) ───────────────────
  let nativePi = 'not-run';
  if (process.env.GOL346_SKIP_NATIVE !== '1') {
    try {
      const piBin = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
      const nativeEnv = { ...env };
      const renderDir = path.join(env.GOLEM_HOME, 'renders', 'pi');
      execFileSync(process.execPath, ['cli/golem.js', 'sync', '--target', 'pi'],
        { cwd: repo, env: nativeEnv, stdio: 'ignore' });
      // Keep a real Pi session busy while a CLI grandchild binds to its lease.
      const busyPrompt = 'Work steadily for about three minutes: use the write tool to create ' +
        '/tmp/gol346-native-work.md with a 300-word summary of your system prompt, then edit it ' +
        'five times, one sentence at a time. Do not finish early.';
      // Credentials: the isolated home has no Pi auth, so copy the local agent
      // credentials (read-only copies; the real profile is never touched) and
      // pin the provider this environment can actually reach.
      const piAgent = path.join(env.HOME, '.pi', 'agent');
      fs.mkdirSync(piAgent, { recursive: true });
      for (const f of ['auth.json', 'models.json', 'settings.json', 'antigravity-model-catalog.json', 'models-store.json']) {
        const src = path.join(process.env.HOME, '.pi', 'agent', f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(piAgent, f));
      }
      // A clean environment (no inherited GOLEM_/PI_ identity hints): the CLI
      // binding must come from the isolated render's leases, exactly as in a
      // fresh native session.
      const piChild = spawn(piBin, ['-e', path.join(renderDir, 'golem.ts'),
        '--session-dir', path.join(tmp, 'pi-sessions'), '--session-id', 'gol346-native-pi',
        '--provider', 'ollama-cloud', '--model', 'glm-5.3-flash:cloud',
        '-p', busyPrompt], {
        cwd: repo,
        env: {
          PATH: process.env.PATH, HOME: env.HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
          GOLEM_HOME: env.GOLEM_HOME, GOLEM_TRACKER_DB: env.GOLEM_TRACKER_DB,
          GOLEM_PROJECTS_ROOT: env.GOLEM_PROJECTS_ROOT, GOLEM_IDEAS_ROOT: env.GOLEM_IDEAS_ROOT,
          GOLEM_ROOT: repo, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'error',
        },
        stdio: ['ignore', process.stdout, process.stderr],
      });
      let piErr = '';
      const nativeDeadline = Date.now() + 120_000;
      piChild.stderr?.on('data', (c) => { piErr += c; });
      piChild.on('exit', (code) => { if (Date.now() < nativeDeadline) nativePi = `not-run: pi exited ${code}: ${piErr.slice(0, 200)}`; });
      try {
        const stateDir = env.GOLEM_HOME;
        const factsPath = path.join(stateDir, 'session-facts.json');
        let lease = null;
        while (Date.now() < nativeDeadline && !lease) {
          await sleep(500);
          try {
            const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
            const live = (facts.facts || []).find((f) => f.canonical_id && f.delivery?.ready);
            if (live) {
              const leases = JSON.parse(fs.readFileSync(path.join(stateDir, 'endpoint-leases.json'), 'utf8')).leases;
              lease = leases.find((l) => l.canonical_id === live.canonical_id && l.delivery_ready) || null;
            }
          } catch { /* not ready yet */ }
        }
        if (!lease) { nativePi = 'not-run: native Pi session never became delivery-ready'; }
        else {
          const grand = spawn(process.execPath, [path.join(repo, 'cli/golem.js'), 'ticket', 'list', '--project', projectId], {
            cwd: repo,
            env: { ...nativeEnv, GOLEM_HOME: stateDir, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, HOME: env.HOME },
            encoding: 'utf8',
          });
          const grandOut = await new Promise((resolve) => {
            let out = ''; grand.stdout.on('data', (d) => { out += d; });
            grand.on('close', (code) => resolve({ code, out }));
          });
          let list = null;
          try { list = JSON.parse(grandOut.out); } catch { /* not JSON */ }
          const bound = grandOut.code === 0 && Array.isArray(list);
          nativePi = bound ? 'pass' : `fail: grandchild exit ${grandOut.code} out=${grandOut.out.slice(0, 160)}`;
        }
      } finally {
        piChild.kill('SIGKILL');
      }
    } catch (err) {
      nativePi = `not-run: ${err?.message ?? err}`;
    }
  }
  check('A16 real native Pi CLI caller binding (isolated render + isolated leases)',
    nativePi === 'pass', nativePi);

  // ── A17: instructions mechanics (GOL-377) ──────────────────────────────────
  // The tracker skill exists, is non-empty, and does not prescribe the retired
  // discovery tool. Wording is the human's to change.
  const trackerSkill = fs.readFileSync(path.join(repo, 'substrate/skills/tracker/SKILL.md'), 'utf8');
  check('A17 tracker skill ships non-empty and never prescribes the retired discovery tool',
    trackerSkill.trim().length > 0 && !trackerSkill.includes('sessions_dispatchable'));

  console.log(failures.length === 0 ? '\nALL GOL-346 ACCEPTANCE CHECKS PASS' : `\n${failures.length} FAILURE(S)`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  for (const id of scratchIds) { try { await archiveTicket(id); } catch { /* best effort */ } }
  if (previousSmokeApi === undefined) delete process.env.GOLEM_SMOKE_API;
  else process.env.GOLEM_SMOKE_API = previousSmokeApi;
  if (dashboard?.exitCode === null) dashboard.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
}