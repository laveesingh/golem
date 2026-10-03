// Explicit native recording entry. Never part of CI or the generic real-harness suite.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProfile } from '../cli/bootstrap.ts';
import { createScenarioRecorder } from '../lib/scenario-recorder.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const realHome = process.env.HOME;
assert.equal(
  process.env.GOLEM_RECORD_REAL,
  '1',
  'native recording requires GOLEM_RECORD_REAL=1',
);
assert.ok(realHome);
const rec = path.join(realHome, '.golem-profiles', 'rec');
const env = { ...process.env };
resolveProfile(['--profile', 'rec'], env);
assert.equal(env.GOLEM_PROFILE_ROOT, rec);
assert.equal(env.CLAUDE_CONFIG_DIR, path.join(rec, 'home', '.claude'));
assert.equal(env.PI_CODING_AGENT_DIR, path.join(rec, 'home', '.pi', 'agent'));
env.HOME = path.join(rec, 'home');
const root = fs.mkdtempSync('/tmp/s4-');
fs.chmodSync(root, 0o700);
const candidate = path.join(root, 'typed-brief-accepted-settled.json');
const versionResult = spawnSync('pi', ['--version'], {
  env,
  encoding: 'utf8',
  timeout: 10000,
});
assert.equal(versionResult.status, 0);
const version = versionResult.stdout.trim();
assert.match(version, /^\d+\.\d+\.\d+$/);
const broker = await createScenarioRecorder(candidate, {
  schema: 1,
  scenario: 'typed-brief-accepted-settled',
  seed: 524,
  source: {
    harness: 'pi',
    harness_version: version,
    golem_version: JSON.parse(fs.readFileSync(path.join(repo, 'package.json')))
      .version,
  },
});
Object.assign(env, broker.env);
const extension = path.join(root, 'pi-recording.ts');
fs.writeFileSync(
  extension,
  `
import fs from 'node:fs';
import { PiNativeAdapter } from ${JSON.stringify(path.join(repo, 'lib/pi-native-adapter.js'))};
import { recordScenarioProjection } from ${JSON.stringify(path.join(repo, 'lib/scenario-recorder.ts'))};
export default function(pi) {
  const adapter = new PiNativeAdapter(pi);
  let pending = Promise.resolve();
  const observe = (operation, fields) => {
    pending = pending.then(() => recordScenarioProjection({boundary:'typed-http', direction:operation==='typed-submit'?'in':'out', operation, fields}));
    pending.catch(() => fs.writeFileSync(${JSON.stringify(path.join(root, 'failed'))}, 'observation_failed'));
  };
  const accept = adapter.acceptEnvelope.bind(adapter);
  adapter.acceptEnvelope = async envelope => {
    observe('typed-submit', {envelope_id:envelope.envelope_id, session_id:envelope.target_session_id, attempt_id:envelope.attempt_id, kind:envelope.kind});
    return accept(envelope);
  };
  const save = adapter.saveDelivery.bind(adapter);
  adapter.saveDelivery = (record, delivery) => {
    const result = save(record, delivery);
    if (['accepted','settled'].includes(delivery.lifecycle_state)) observe('typed-'+delivery.lifecycle_state, {envelope_id:delivery.envelope_id, session_id:delivery.target_session_id, attempt_id:delivery.attempt_id, state:delivery.lifecycle_state});
    return result;
  };
  adapter.bind();
  function check(ctx) {
    if (ctx.model?.id !== 'muse-spark-1.3-contributor' || ctx.model?.provider !== 'opencode-go') {
      fs.writeFileSync(${JSON.stringify(path.join(root, 'failed'))}, 'hard_model_rule'); ctx.shutdown(); throw Error('hard model rule');
    }
  }
  pi.on('session_start', async (_event,ctx) => {
    check(ctx);
    fs.writeFileSync(${JSON.stringify(path.join(root, 'endpoint.json'))}, JSON.stringify({session:adapter.canonicalId,port:adapter.endpoint.port,owner:adapter.ownerToken}), {mode:0o600});
  });
  pi.on('before_agent_start', (_event,ctx) => check(ctx));
  pi.on('provider_stream_event', event => {
    if (event.model !== 'muse-spark-1.3-contributor' || event.provider !== 'opencode-go') fs.writeFileSync(${JSON.stringify(path.join(root, 'failed'))}, 'hard_model_rule');
  });
  pi.on('agent_settled', async () => {
    await pending;
    const deliveries = adapter.readRecord().inbox.deliveries;
    for (const delivery of deliveries.filter(d => d.lifecycle_state === 'settled')) observe('typed-settled', {envelope_id:delivery.envelope_id,session_id:delivery.target_session_id,attempt_id:delivery.attempt_id,state:'settled'});
    await pending;
    fs.writeFileSync(${JSON.stringify(path.join(root, 'settled'))}, 'settled', {mode:0o600});
  });
}
`,
  { mode: 0o600 },
);
let child: ReturnType<typeof spawn>;
let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
let stderr = '';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(file, timeout = 120000) {
  const end = Date.now() + timeout;
  while (!fs.existsSync(file)) {
    if (fs.existsSync(path.join(root, 'failed')))
      throw Error(fs.readFileSync(path.join(root, 'failed'), 'utf8'));
    if (Date.now() > end || child.exitCode !== null)
      throw Error('native recording did not reach required boundary');
    await sleep(50);
  }
}
try {
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
  child = spawn('pi', argv, {
    cwd: root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  exit = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  // Native output is drained, not recorded or printed. No transcript is fixture material.
  child.stdout.resume();
  child.stderr.on('data', (data) => {
    if (stderr.length < 16384) stderr += data;
  });
  await wait(path.join(root, 'endpoint.json'), 30000);
  const endpoint = JSON.parse(
    fs.readFileSync(path.join(root, 'endpoint.json')),
  );
  const now = Date.now();
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/brief`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sender': 'dashboard',
      'x-golem-target-session': endpoint.session,
      'x-golem-endpoint-owner': endpoint.owner,
    },
    body: JSON.stringify({
      protocol_version: 1,
      envelope_id: randomUUID(),
      attempt_id: randomUUID(),
      target_session_id: endpoint.session,
      sender_session_id: randomUUID(),
      kind: 'brief',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 180000).toISOString(),
      content: 'Reply with exactly RECORDING_OK. Do not use tools.',
    }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).accepted, true);
  await wait(path.join(root, 'settled'));
  child.stdin.end();
  child.kill('SIGTERM');
  const result = await exit;
  broker.record({
    boundary: 'process',
    direction: 'out',
    operation: 'process-exit',
    fields: {
      harness: 'pi',
      ...(result.signal
        ? { signal: result.signal }
        : { exit_code: result.code }),
    },
  });
  const scenario = await broker.close();
  assert.ok(scenario.events.some((e) => e.operation === 'typed-accepted'));
  assert.ok(scenario.events.some((e) => e.operation === 'typed-settled'));
  console.log(
    `candidate ${candidate}; ${scenario.events.length} actual native seam events; model opencode-go/muse-spark-1.3-contributor`,
  );
} catch (error) {
  broker.abort('native_run_failed');
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([exit, sleep(2000)]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await exit;
    }
  }
  try {
    await broker.close();
  } catch {}
  // Keep only a bounded code, not native transcript output, on failure.
  console.error(
    `recording failed: ${error.message}; private root retained: ${root}`,
  );
  process.exitCode = 1;
} finally {
  // The run owner retains the successful candidate for explicit scrub/sign-off.
  // Credentials stay in rec; only these owned ephemeral endpoint/extension files are removed.
  for (const name of ['endpoint.json', 'pi-recording.ts', 'settled', 'failed'])
    fs.rmSync(path.join(root, name), { force: true });
}
