import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-notify-cli-'));
process.env.GOLEM_HOME = home;
process.env.GOLEM_TRACKER_DB = path.join(home, 'tracker.db');
const { runCollaboration } = await import('../cli/collaboration.js');
const { resolveCliSessionContext } = await import('../lib/cli-session-context.js');
const { createGolemClient } = await import('../lib/golem-client.js');
const { startTypedWorkerEndpoint, closeTypedWorkerEndpoint } = await import('../lib/typed-worker-endpoint.js');
const { renewEndpointLease, upsertSessionFact } = await import('../lib/session-facts.js');
const { closeTypedDeliveryStores } = await import('../lib/typed-delivery-tombstones.js');
const target = 'cli-receiver', caller = 'cli-caller';
let endpoint, dashboard;
const inputs = new Map();
async function port() {
  const s = http.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise((r) => s.close(r)); return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const ancestry = new Map([[30, { command: '/bin/sh', ppid: 20 }], [20, { command: 'pi', ppid: 10 }], [10, { command: 'node /bin/golem pi', ppid: 1 }]]);
  const piEvidence = { pid: 30, env: {}, readProcess: (pid) => ancestry.get(pid),
    leases: [{ pid: 20, harness: 'pi', canonical_id: caller }], facts: [{ canonical_id: caller, harness: 'pi', status: 'idle' }] };
  assert.equal(resolveCliSessionContext(piEvidence).sessionId, caller);
  assert.throws(() => resolveCliSessionContext({ ...piEvidence, env: { GOLEM_SESSION_ID: 'stale' } }), /conflicts/);
  assert.throws(() => resolveCliSessionContext({ ...piEvidence, leases: [] }), /missing or ambiguous/);
  assert.throws(() => resolveCliSessionContext({ ...piEvidence, leases: [...piEvidence.leases, { pid: 20, harness: 'pi', canonical_id: 'other' }] }), /ambiguous/);
  assert.throws(() => resolveCliSessionContext({ ...piEvidence, maxDepth: 1 }), /bounded/);
  assert.throws(() => resolveCliSessionContext({ ...piEvidence, readProcess: (pid) => pid === 20 ? { ...ancestry.get(pid), startedAt: Date.now() } : ancestry.get(pid), leases: [{ ...piEvidence.leases[0], renewed_at: '2000-01-01' }] }), /predates/);
  const ccEvidence = { pid: 30, env: { CLAUDE_CODE_SESSION_ID: 'per-run-id' }, leases: [], facts: [],
    readProcess: (pid) => pid === 30 ? { command: '/bin/sh', ppid: 20 } : { command: 'claude', ppid: 1, startedAt: 100 },
    readClaude: () => ({ sessionId: 'logical-resume', pid: 20, recordMtimeMs: 101 }) };
  assert.equal(resolveCliSessionContext(ccEvidence).sessionId, 'logical-resume');
  assert.throws(() => resolveCliSessionContext({ ...ccEvidence, readClaude: () => ({ sessionId: 'wrong-birth', recordMtimeMs: 101, procStart: '2000-01-01' }) }), /birth identity/);
  assert.throws(() => resolveCliSessionContext({ ...ccEvidence, readClaude: () => ({ sessionId: 'stale', recordMtimeMs: 99 }) }), /predates/);
  const unboundHints = { pid: 30, env: { GOLEM_SESSION_ID: 'leftover', GOLEM_CEO_SESSION_ID: 'leftover', PI_SESSION_ID: 'leftover' },
    leases: [], facts: [], readProcess: () => ({ command: '/bin/zsh', ppid: 1 }) };
  assert.equal(resolveCliSessionContext(unboundHints), null, 'complete non-native ancestry is unbound despite leftover id hints');
  assert.throws(() => resolveCliSessionContext({ ...unboundHints, readProcess: () => ({ command: 'codex', ppid: 1 }) }), /does not yet support CLI caller binding/);
  console.log('caller ancestry, resume identity, stale/ambiguous/truncated context: passed');

  endpoint = await startTypedWorkerEndpoint({ canonicalId: target, ownerToken: 'isolated-owner', deliveryReady: () => true,
    acceptDelivery: async (e) => {
      const duplicate = inputs.has(e.envelope_id);
      if (!duplicate) inputs.set(e.envelope_id, e);
      return { ok: true, accepted: true, duplicate, envelope_id: e.envelope_id, attempt_id: e.attempt_id,
        accepted_attempt_id: inputs.get(e.envelope_id).attempt_id, delivery_state: 'settled' };
    } });
  renewEndpointLease({ canonical_id: target, owner_token: 'isolated-owner', host: endpoint.host, port: endpoint.port,
    pid: process.pid, harness: 'pi', kind: 'typed-worker', delivery_ready: true });
  upsertSessionFact({ canonical_id: target, harness: 'pi', locator: { raw_session_id: target, session_file: path.join(home, 'receiver.jsonl') }, pid: process.pid, status: 'idle', project_path: home,
    capabilities: { typed_worker: true, typed_worker_protocol: 1 } });
  const base = `http://127.0.0.1:${await port()}`;
  fs.writeFileSync(path.join(home, 'dashboard.json'), JSON.stringify({ url: base }));
  dashboard = spawn(process.execPath, ['dashboard/server/index.js'], { cwd: repo,
    env: { ...process.env, PORT: new URL(base).port, HOST: '127.0.0.1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let serverErrors = ''; dashboard.stderr.on('data', (data) => { serverErrors += data; });
  let healthy = false;
  for (let i = 0; i < 100; i++) { try { healthy = (await fetch(`${base}/api/health`)).ok; } catch {} if (healthy) break; await sleep(50); }
  assert.ok(healthy, serverErrors);
  const normalClient = createGolemClient({ baseUrl: base, callerSessionId: caller });
  const humanClient = createGolemClient({ baseUrl: base });
  const run = async (family, args, extra = {}) => {
    const out = [], err = [];
    const exit = await runCollaboration(family, args, { client: normalClient, resolveContext: () => ({ sessionId: caller }),
      stdout: (s) => out.push(s), stderr: (s) => err.push(s), ...extra });
    return { exit, out: out.join('\n'), err: err.join('\n') };
  };
  const id = crypto.randomUUID(), text = 'Unicode 日本語\n"quoted" \\ tail\n';
  const file = path.join(home, 'message.txt'); fs.writeFileSync(file, text);
  let result = await run('session', ['notify', '--to', target, '--message-file', file, '--ticket', 'GOL-331', '--request-id', id, '--json']);
  assert.equal(result.exit, 0, result.out || result.err);
  assert.equal(JSON.parse(result.out).id, id);
  assert.equal(result.err, '');
  assert.ok(inputs.get(id).content.endsWith(`GOL-331: ${text}`));
  const before = inputs.size;
  result = await run('session', ['notify', '--to', target, '--message', text, '--ticket', 'GOL-331', '--request-id', id, '--json']);
  assert.equal(result.exit, 0); assert.equal(inputs.size, before);
  result = await run('session', ['notify', '--to', target, '--message', 'changed', '--request-id', id, '--json']);
  assert.equal(result.exit, 2); assert.equal(JSON.parse(result.out).code, 'OPERATION_CONFLICT'); assert.equal(inputs.size, before);
  result = await run('message', ['inspect', id, '--json']);
  assert.equal(result.exit, 0); assert.equal(Object.hasOwn(JSON.parse(result.out), 'content'), false);
  result = await run('message', ['inspect', id, '--content', '--json']);
  assert.ok(JSON.parse(result.out).content.endsWith(text));
  const raceId = crypto.randomUUID(), raceBefore = inputs.size;
  const racing = await Promise.all(Array.from({ length: 6 }, () => run('session', ['notify', '--to', target, '--message', 'concurrent same key', '--request-id', raceId, '--json'])));
  assert.ok(racing.every((item) => item.exit === 0), JSON.stringify(racing));
  assert.equal(inputs.size, raceBefore + 1, 'concurrent idempotent admissions produce one input');
  console.log('real API/SQLite/endpoint file content, ticket context, idempotent retry/conflict and inspection: passed');

  const lostId = crypto.randomUUID();
  const losingClient = createGolemClient({ baseUrl: base, callerSessionId: caller, fetchImpl: async (url, init) => {
    const response = await fetch(url, init);
    if (init.method === 'POST') { await response.text(); throw new Error('simulated lost response after real admission'); }
    return response;
  } });
  const lostArgs = ['notify', '--to', target, '--message', 'lost response', '--request-id', lostId, '--json'];
  result = await run('session', lostArgs, { client: losingClient });
  assert.equal(result.exit, 3); assert.equal(JSON.parse(result.out).operation_id, lostId);
  const afterLoss = inputs.size;
  result = await run('session', lostArgs);
  assert.equal(result.exit, 0); assert.equal(inputs.size, afterLoss);
  console.log('lost mutation response exits uncertain and same-key retry creates no extra input: passed');

  result = await run('session', ['notify', '--to', target, '--message-file', '-', '--human', '--json'],
    { resolveContext: () => null, client: humanClient, stdin: Readable.from(['human stdin\n']) });
  assert.equal(result.exit, 0, result.out);
  const humanInput = inputs.get(JSON.parse(result.out).id).content;
  assert.match(humanInput, /answer the human in this native chat/);
  assert.doesNotMatch(humanInput, /session_notify\(to: "human:cli"\)/);
  for (const args of [
    ['notify', '--to', target, '--message', 'x', '--human', '--json'],
    ['notify', '--to', target, '--message', 'x', '--message-file', file, '--json'],
    ['notify', '--to', target, '--message', ' ', '--json'],
    ['notify', '--to', target, '--message', 'x', '--request-id', 'bad', '--json'],
    ['notify', '--to', target, '--unknown', '--json'],
  ]) assert.equal((await run('session', args)).exit, 2);
  assert.equal((await run('session', ['notify', '--to', target, '--message', 'x', '--json'], { resolveContext: () => null })).exit, 2);
  assert.equal((await run('session', ['notify', '--to', 'self', '--message', 'x', '--human', '--json'], { resolveContext: () => null })).exit, 2);
  result = await run('session', ['notify', '--message-file', '/missing', '--help'], { resolveContext: () => { throw new Error('help must not resolve identity'); } });
  assert.equal(result.exit, 0);
  const cliHelp = spawnSync(process.execPath, ['cli/golem.js', 'session', 'notify', '--message-file', '/missing', '--help'], { cwd: repo, encoding: 'utf8' });
  assert.equal(cliHelp.status, 0, cliHelp.stderr); assert.match(cliHelp.stdout, /request-id/);
  console.log('human provenance, stdin, validation, help before context/file access and actual CLI entry point: passed');

  const unbound = () => resolveCliSessionContext(unboundHints);
  assert.equal((await run('session', ['list', '--all', '--json'], { resolveContext: unbound, client: humanClient })).exit, 0);
  assert.equal((await run('message', ['inspect', id, '--json'], { resolveContext: unbound, client: humanClient })).exit, 0);
  assert.equal((await run('session', ['notify', '--to', target, '--message', 'explicit operator', '--human', '--json'], { resolveContext: unbound, client: humanClient })).exit, 0);
  const inputCount = inputs.size;
  const noProtocolClient = createGolemClient({ baseUrl: base, callerSessionId: caller, fetchImpl: async (_url, init) => {
    assert.equal(init.method, 'GET', 'incompatible server must never receive a mutation');
    return new Response('{"notification_protocol":0}', { status: 200 });
  } });
  assert.equal((await run('session', ['notify', '--to', target, '--message', 'do not send', '--json'], { client: noProtocolClient })).exit, 1);
  assert.equal((await run('session', ['notify', '--to', target, '--message', '\\'.repeat(600000), '--json'])).exit, 2);
  const oversizeId = crypto.randomUUID();
  result = await run('session', ['notify', '--to', target, '--message', 'x'.repeat(1048576 - 200), '--request-id', oversizeId, '--json']);
  assert.equal(result.exit, 2, 'receiving wrapper size must be checked before admission');
  assert.equal((await fetch(`${base}/api/message-envelopes/${oversizeId}`)).status, 404);
  const invalidUtf8 = path.join(home, 'invalid-utf8'); fs.writeFileSync(invalidUtf8, Buffer.from([0xc0, 0xaf]));
  assert.equal((await run('session', ['notify', '--to', target, '--message-file', invalidUtf8, '--json'])).exit, 2);
  assert.equal((await run('session', ['notify', '--to', target, '--message-file', '/definitely-missing-input', '--json'])).exit, 2);
  assert.equal(inputs.size, inputCount);
  result = await run('session', ['notify', '--to', target, '--message', '--json']);
  assert.equal(result.exit, 0); assert.match(result.out, /^message /, 'a message value is not an output-format flag');
  console.log('protocol preflight, encoded/request wrapper limits, invalid input and value/flag separation: passed');

  // Real OS ancestry and a native-record fixture: CLI -> node bridge -> Claude.
  // This validates process resolution, not a model-generated Claude action.
  const nativeFixture = path.join(home, 'native-caller.mjs');
  fs.writeFileSync(nativeFixture, `import fs from 'node:fs'; import path from 'node:path'; import {spawnSync} from 'node:child_process';
process.title='claude';
fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR,'sessions'),{recursive:true});
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'sessions',process.pid+'.json'),JSON.stringify({sessionId:'resumed-native-caller',pid:process.pid}));
const bridge=\`const {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,JSON.parse(process.env.CLI_ARGS),{encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??1);\`;
const r=spawnSync(process.execPath,['-e',bridge],{encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??1);`);
  const nativeEnv = { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CLAUDE_CODE_SESSION_ID: 'per-run-not-logical',
    CLI_ARGS: JSON.stringify([path.join(repo, 'cli/golem.js'), 'session', 'notify', '--to', target, '--message', 'native grandchild', '--json']) };
  for (const key of ['GOLEM_SESSION_ID', 'GOLEM_CEO_SESSION_ID', 'PI_SESSION_ID', 'GOLEM_MANAGED_CODEX_BOUND']) delete nativeEnv[key];
  // Async spawn keeps the receiving endpoint in this process responsive.
  const child = spawn(process.execPath, [nativeFixture], { env: nativeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let nativeOut = '', nativeErr = ''; child.stdout.on('data', (b) => nativeOut += b); child.stderr.on('data', (b) => nativeErr += b);
  const nativeExit = await new Promise((r) => child.once('exit', r));
  assert.equal(nativeExit, 0, nativeErr || nativeOut);
  assert.match(inputs.get(JSON.parse(nativeOut).id).content, /Authenticated sender session_id: resumed-native-caller/);
  console.log('actual CLI grandchild process uses canonical resumed Claude identity, not per-run environment id: passed');

  const scheduleId = crypto.randomUUID();
  const scheduleArgs = ['notify', '--to', target, '--message', 'scheduled context', '--after', '1h', '--every', '2h', '--request-id', scheduleId, '--json'];
  result = await run('session', scheduleArgs);
  assert.equal(result.exit, 0, result.out); const scheduled = JSON.parse(result.out);
  assert.equal(scheduled.kind, 'schedule'); assert.equal(scheduled.state, 'active');
  assert.equal(scheduled.interval_ms, 7200000); assert.equal(scheduled.current_occurrence, null);
  result = await run('session', scheduleArgs);
  assert.equal(JSON.parse(result.out).next_due_at, scheduled.next_due_at, 'idempotent retry never shifts the due time');
  assert.equal((await run('session', ['notify', '--to', target, '--message', 'scheduled context', '--request-id', scheduleId, '--json'])).exit, 2);
  assert.equal((await run('session', ['notify', '--to', target, '--message', text, '--ticket', 'GOL-331', '--after', '1h', '--request-id', id, '--json'])).exit, 2);
  const stranger = { client: createGolemClient({ baseUrl: base, callerSessionId: 'stranger' }), resolveContext: () => ({ sessionId: 'stranger' }) };
  assert.deepEqual(JSON.parse((await run('schedule', ['list', '--json'], stranger)).out), []);
  assert.ok(JSON.parse((await run('schedule', ['list', '--all', '--json'], stranger)).out).some((s) => s.id === scheduleId));
  assert.equal((await run('schedule', ['cancel', scheduleId, '--json'], stranger)).exit, 2);
  result = await run('schedule', ['inspect', scheduleId, '--json']);
  assert.equal(Object.hasOwn(JSON.parse(result.out), 'content'), false);
  assert.equal(JSON.parse((await run('schedule', ['inspect', scheduleId, '--content', '--json'])).out).content, 'scheduled context');
  const operator = { client: humanClient, resolveContext: () => null };
  result = await run('schedule', ['cancel', scheduleId, '--human', '--json'], operator);
  assert.equal(result.exit, 0); const cancelledAt = JSON.parse(result.out).cancelled_at;
  assert.equal(JSON.parse((await run('schedule', ['cancel', scheduleId, '--human', '--json'], operator)).out).cancelled_at, cancelledAt);
  for (const flags of [['--after', '-1s'], ['--every', '0s'], ['--after', '10'], ['--every', '99999999999999999d']]) {
    assert.equal((await run('session', ['notify', '--to', target, '--message', 'invalid time', ...flags, '--json'])).exit, 2);
  }
  const preTimingClient = createGolemClient({ baseUrl: base, callerSessionId: caller, fetchImpl: async (_url, init) => {
    assert.equal(init.method, 'GET'); return new Response('{"notification_protocol":1,"idempotency":true}');
  } });
  assert.equal((await run('session', ['notify', '--to', target, '--message', 'never send early', '--after', '1m', '--json'], { client: preTimingClient })).exit, 1);
  const nowId = crypto.randomUUID();
  result = await run('session', ['notify', '--to', target, '--message', 'clock delivers this', '--after', '0s', '--request-id', nowId, '--json']);
  assert.equal(result.exit, 0, result.out);
  let arrived;
  for (let i = 0; i < 200; i++) {
    arrived = await (await fetch(`${base}/api/schedules/${nowId}`)).json();
    if (arrived.state === 'completed') break;
    await sleep(50);
  }
  assert.equal(arrived.state, 'completed', serverErrors);
  const occurrence = inputs.get(arrived.current_occurrence.id);
  assert.ok(occurrence.content.includes(`Schedule: ${nowId}`));
  assert.ok(occurrence.content.endsWith('clock delivers this'));
  console.log('real schedule CLI/API management, ownership, cross-mode idempotency, capability and clock-to-endpoint delivery: passed');
} finally {
  if (dashboard && dashboard.exitCode == null) {
    dashboard.kill('SIGTERM'); await Promise.race([new Promise((r) => dashboard.once('exit', r)), sleep(3000)]);
    if (dashboard.exitCode == null) dashboard.kill('SIGKILL');
  }
  if (endpoint) await closeTypedWorkerEndpoint(endpoint.server);
  closeTypedDeliveryStores(); fs.rmSync(home, { recursive: true, force: true });
}
