import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPortBlockFree, resolveProfile } from '../cli/bootstrap.ts';
import { createScratchTicket } from '../dashboard/scripts/_scratch.mjs';
import { createScenarioRecorder } from '../lib/scenario-recorder.ts';

assert.equal(process.env.GOLEM_RECORD_REAL, '1');
const repo = fileURLToPath(new URL('../', import.meta.url));
const rec = path.join(process.env.HOME, '.golem-profiles', 'rec');
const env = { ...process.env };
const profile = resolveProfile(['--profile', 'rec'], env);
env.HOME = path.join(rec, 'home');
await assertPortBlockFree(profile.port);
const root = fs.mkdtempSync('/tmp/s4-');
fs.chmodSync(root, 0o700);
const version = spawnSync('claude', ['--version'], {
  env,
  encoding: 'utf8',
  timeout: 10000,
});
assert.equal(version.status, 0);
const pinned = /^(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1];
assert.ok(pinned);
const broker = await createScenarioRecorder(
  path.join(root, 'claude-dispatch-ack-return.json'),
  {
    schema: 1,
    scenario: 'claude-dispatch-ack-return',
    seed: 524,
    source: {
      harness: 'claudecode',
      harness_version: pinned,
      golem_version: JSON.parse(
        fs.readFileSync(path.join(repo, 'package.json')),
      ).version,
    },
  },
);
Object.assign(env, broker.env);
const base = env.GOLEM_DASHBOARD_URL;
const children: Array<ReturnType<typeof spawn> & { closed: Promise<unknown> }> =
  [];
let ticket: { id: string } | undefined;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function actor(binary, args, options = {}) {
  const child = spawn(binary, args, {
    cwd: root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
  child.closed = new Promise((resolve) => child.once('exit', () => resolve()));
  child.stdout.resume();
  child.stderr.resume();
  children.push(child);
  return child;
}
async function wait(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {}
    await sleep(50);
  }
  throw Error('native Claude recording boundary timed out');
}
async function request(route, body, method = 'POST') {
  const response = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error(`private dashboard status ${response.status}`);
  return response.json();
}
try {
  actor(process.execPath, [path.join(repo, 'dashboard/server/index.js')], {
    cwd: repo,
  });
  await wait(() => request('/api/health', null, 'GET'));
  ticket = await createScratchTicket(
    { title: 'S4 Claude channel return' },
    (body) => request('/api/tickets', body),
  );
  const session = randomUUID();
  const config = path.join(root, 'mcp.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        golem: {
          command: process.execPath,
          args: [path.join(repo, 'tools/record-mcp.ts')],
          env: { GOLEM_SESSION_ID: session, GOLEM_CHANNEL_PORT: '0' },
        },
      },
    }),
    { mode: 0o600 },
  );
  const settings = path.join(root, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ model: 'claude-haiku-4-5' }), {
    mode: 0o600,
  });
  const argv = [
    '--model',
    'claude-haiku-4-5',
    '--session-id',
    session,
    '--mcp-config',
    config,
    '--strict-mcp-config',
    '--settings',
    settings,
    '--dangerously-load-development-channels',
    'server:golem',
    '--dangerously-skip-permissions',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '-p',
  ];
  broker.record({
    boundary: 'process',
    direction: 'in',
    operation: 'process-spawn',
    fields: { harness: 'claudecode', argv },
  });
  const claude = actor('claude', argv);
  claude.stdin.write(
    `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content:
          'Reply READY. Then wait for a Golem channel notification. On a brief, call mcp__golem__ack with its envelope_id and kind brief, then call mcp__golem__ticket_comment on ' +
          ticket.id +
          ' with body RECORDING_RETURN. Do not call any other tool.',
      },
    })}\n`,
  );
  const _channel = await wait(async () => {
    const file = path.join(env.GOLEM_HOME, 'channels.json');
    if (!fs.existsSync(file)) return false;
    const rows = JSON.parse(fs.readFileSync(file)).channels;
    return rows.find((row) => row.session_id === session && row.pid);
  });
  const delivery = await request('/api/brief', {
    session_id: session,
    brief:
      'Recording brief. Acknowledge this envelope with kind brief and post RECORDING_RETURN on task ' +
      ticket.id +
      '.',
  });
  assert.ok(delivery.envelope_id);
  await wait(async () => {
    const item = await request(
      `/api/message-envelopes/${delivery.envelope_id}`,
      null,
      'GET',
    );
    const task = await request(`/api/tickets/${ticket.id}`, null, 'GET');
    return (
      item.acknowledged_at &&
      task.comments?.some((c) => c.body === 'RECORDING_RETURN')
    );
  }, 120000);
  claude.stdin.end();
  claude.kill('SIGTERM');
  await claude.closed;
  broker.record({
    boundary: 'process',
    direction: 'out',
    operation: 'process-exit',
    fields: {
      harness: 'claudecode',
      ...(claude.signalCode
        ? { signal: claude.signalCode }
        : { exit_code: claude.exitCode }),
    },
  });
  const scenario = await broker.close();
  assert.ok(
    scenario.events.some(
      (e) => e.fields.state === 'acknowledged' && e.fields.ok,
    ),
  );
  assert.ok(
    scenario.events.some((e) => e.fields.state === 'returned' && e.fields.ok),
  );
  console.log(
    `candidate ${path.join(root, 'claude-dispatch-ack-return.json')}; actual correlated channel ack and durable comment return; model claude-haiku-4-5`,
  );
} catch (error) {
  broker.abort('native_run_failed');
  try {
    await broker.close();
  } catch {}
  console.error(`recording failed: ${error.message}; root ${root}`);
  process.exitCode = 1;
} finally {
  if (ticket)
    await request(
      `/api/tickets/${ticket.id}`,
      { state: 'archived', actor: 'smoke' },
      'PATCH',
    ).catch(() => {});
  for (const child of children.reverse())
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin?.end();
      child.kill('SIGTERM');
      await Promise.race([child.closed, sleep(3000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await child.closed;
      }
    }
  for (const name of ['mcp.json', 'settings.json'])
    fs.rmSync(path.join(root, name), { force: true });
}
