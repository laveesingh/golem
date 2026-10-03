// Real dashboard-restart/stranded-envelope E2E on the rec profile.
// Phase A: brief to an offline session strands queue rows; the dashboard is
// killed; the rows survive in SQLite. Phase B: after restart a real Pi typed
// target receives a live brief through the restarted drainer. The broker
// records the stranded submit plus the live accepted/settled lineage.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPortBlockFree, resolveProfile } from '../cli/bootstrap.ts';
import { createScratchTicket } from '../dashboard/scripts/_scratch.mjs';
import { createScenarioRecorder } from '../lib/scenario-recorder.ts';

assert.equal(process.env.GOLEM_RECORD_REAL, '1');
const repo = fileURLToPath(new URL('../', import.meta.url));
const rec = path.join(process.env.HOME ?? '', '.golem-profiles', 'rec');
const env: Record<string, string | undefined> = { ...process.env };
const profile = resolveProfile(['--profile', 'rec'], env);
env.HOME = path.join(rec, 'home');
await assertPortBlockFree(profile.port);
const base = String(env.GOLEM_DASHBOARD_URL);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 's4-'));
fs.chmodSync(root, 0o700);
const piRaw = spawnSync('pi', ['--version'], {
  env,
  encoding: 'utf8',
  timeout: 10000,
});
assert.equal(piRaw.status, 0);
const piVersion = /(\d+\.\d+\.\d+)/.exec(piRaw.stdout)?.[1];
assert.ok(piVersion);
const broker = await createScenarioRecorder(
  path.join(root, 'dashboard-restart-stranded-envelope.json'),
  {
    schema: 1,
    scenario: 'dashboard-restart-stranded-envelope',
    seed: 524,
    source: {
      harness: 'pi',
      harness_version: piVersion,
      golem_version: JSON.parse(
        fs.readFileSync(path.join(repo, 'package.json'), 'utf8'),
      ).version,
    },
  },
);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const children: Array<ReturnType<typeof spawn> & { closed: Promise<unknown> }> =
  [];
function actor(
  binary: string,
  args: string[],
  options: Record<string, unknown> = {},
): ReturnType<typeof spawn> & { closed: Promise<unknown> } {
  const child = spawn(binary, args, {
    cwd: root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  }) as ReturnType<typeof spawn> & { closed: Promise<unknown> };
  child.closed = new Promise((resolve) =>
    child.once('exit', () => resolve(undefined)),
  );
  const log = fs.createWriteStream(
    path.join(root, `actor-${children.length}.log`),
    { mode: 0o600 },
  );
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  children.push(child);
  return child;
}
async function request(
  route: string,
  body: unknown,
  method = 'POST',
): Promise<unknown> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(`private dashboard status ${response.status}`);
  return response.json();
}
async function wait(fn: () => Promise<unknown>, ms = 30000): Promise<unknown> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {}
    if (Date.now() > end)
      throw new Error('native restart recording boundary timed out');
    await sleep(100);
  }
}
async function attemptOf(envelopeId: string): Promise<string> {
  const item = await request(
    `/api/message-envelopes/${envelopeId}`,
    null,
    'GET',
  );
  return item?.delivery_attempt_id ?? item?.attempt_id ?? envelopeId;
}
let ticket: { id: string } | undefined;
try {
  console.error('phase: dashboard-1');
  const dashboard = actor(
    process.execPath,
    [path.join(repo, 'dashboard/server/index.js')],
    { cwd: repo },
  );
  await wait(() => request('/api/health', null, 'GET'));
  ticket = await createScratchTicket({ title: 'S4 restart strand' }, (body) =>
    request('/api/tickets', body),
  );
  const strandedSession = `s4-stranded-${Date.now().toString(36)}`;
  const stranded = await fetch(`${base}/api/brief`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: strandedSession,
      brief: 'Stranded brief. No session will ever read this.',
    }),
    signal: AbortSignal.timeout(10000),
  }).then((response) => response.json());
  assert.ok(stranded.envelope_id);
  const strandedAttempt = await attemptOf(stranded.envelope_id);
  broker.record({
    boundary: 'typed-http',
    direction: 'in',
    operation: 'typed-submit',
    fields: {
      envelope_id: stranded.envelope_id,
      session_id: strandedSession,
      attempt_id: strandedAttempt,
      kind: 'brief',
    },
  });
  console.error('phase: kill dashboard-1');
  dashboard.kill('SIGKILL');
  await dashboard.closed;
  console.error('phase: start pi');
  const extension = path.join(root, 'pi-restart.ts');
  fs.writeFileSync(
    extension,
    `import fs from 'node:fs';\nimport { PiNativeAdapter } from ${JSON.stringify(path.join(repo, 'lib/pi-native-adapter.js'))};\nexport default function(pi) {\n  const adapter = new PiNativeAdapter(pi);\n  adapter.bind();\n  pi.on('session_start', () => {\n    fs.writeFileSync(${JSON.stringify(path.join(root, 'endpoint.json'))}, JSON.stringify({ session: adapter.canonicalId }), { mode: 0o600 });\n  });\n}\n`,
    { mode: 0o600 },
  );
  const argv = [
    '--mode',
    'rpc',
    '--no-session',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--extension',
    extension,
    '--provider',
    'opencode-go',
    '--model',
    'muse-spark-1.3-contributor:xhigh',
  ];
  broker.record({
    boundary: 'process',
    direction: 'in',
    operation: 'process-spawn',
    fields: { harness: 'pi', argv },
  });
  const pi = actor('pi', argv);
  const endpoint = await wait(
    async () =>
      fs.existsSync(path.join(root, 'endpoint.json'))
        ? JSON.parse(fs.readFileSync(path.join(root, 'endpoint.json'), 'utf8'))
        : null,
    30000,
  );
  console.error('phase: dashboard-2');
  actor(process.execPath, [path.join(repo, 'dashboard/server/index.js')], {
    cwd: repo,
  });
  await wait(() => request('/api/health', null, 'GET'));
  const strandedView = await request(
    `/api/message-envelopes/${stranded.envelope_id}`,
    null,
    'GET',
  );
  assert.ok(
    strandedView && strandedView.delivery_state !== 'settled',
    'stranded envelope survives the restart',
  );
  console.error(
    `phase: stranded row survives as ${strandedView.delivery_state}`,
  );
  const live = await request('/api/brief', {
    session_id: endpoint.session,
    brief: 'Reply with exactly RECORDING_OK. Do not use tools.',
  });
  assert.ok(live.envelope_id);
  const liveAttempt = await attemptOf(live.envelope_id);
  broker.record({
    boundary: 'typed-http',
    direction: 'in',
    operation: 'typed-submit',
    fields: {
      envelope_id: live.envelope_id,
      session_id: endpoint.session,
      attempt_id: liveAttempt,
      kind: 'brief',
    },
  });
  const outcome = await wait(async () => {
    const item = await request(
      `/api/message-envelopes/${live.envelope_id}`,
      null,
      'GET',
    );
    return item?.delivery_state === 'accepted' ||
      item?.delivery_state === 'settled'
      ? item
      : null;
  }, 90000);
  const acceptedAttempt =
    outcome.accepted_attempt_id ?? (await attemptOf(live.envelope_id));
  broker.record({
    boundary: 'typed-http',
    direction: 'out',
    operation: 'typed-accepted',
    fields: {
      envelope_id: live.envelope_id,
      session_id: endpoint.session,
      attempt_id: acceptedAttempt,
      state: 'accepted',
    },
  });
  if (outcome.delivery_state === 'settled') {
    broker.record({
      boundary: 'typed-http',
      direction: 'out',
      operation: 'typed-settled',
      fields: {
        envelope_id: live.envelope_id,
        session_id: endpoint.session,
        attempt_id: acceptedAttempt,
        state: 'settled',
      },
    });
  }
  pi.kill('SIGTERM');
  await pi.closed;
  broker.record({
    boundary: 'process',
    direction: 'out',
    operation: 'process-exit',
    fields: {
      harness: 'pi',
      ...(pi.signalCode
        ? { signal: pi.signalCode }
        : { exit_code: pi.exitCode ?? 0 }),
    },
  });
  const scenario = await broker.close();
  console.error(
    `candidate ${path.join(root, 'dashboard-restart-stranded-envelope.json')}; stranded ${strandedView.delivery_state}, live ${outcome.delivery_state}, ${scenario.events.length} events`,
  );
} catch (error) {
  broker.abort('native_run_failed');
  try {
    await broker.close();
  } catch {}
  console.error(`recording failed: ${(error as Error).message}; root ${root}`);
  process.exitCode = 1;
} finally {
  if (ticket)
    await request(
      `/api/tickets/${ticket.id}`,
      { state: 'archived', actor: 'smoke' },
      'PATCH',
    ).catch(() => {});
  for (const child of [...children].reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.stdin?.end();
      } catch {}
      child.kill('SIGTERM');
      await Promise.race([child.closed, sleep(3000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await child.closed;
      }
    }
  }
  for (const name of ['pi-restart.ts', 'endpoint.json'])
    fs.rmSync(path.join(root, name), { force: true });
}
