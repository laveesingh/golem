import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import {
  archivePrivateScratchFixture,
  createPrivateScratchFixture,
} from '../../dashboard/scripts/_scratch.mjs';
import { repo } from '../support/sandbox.mjs';

const root = process.argv[2] ? fs.realpathSync(process.argv[2]) : repo;
const emitted = Boolean(process.argv[2]);
const runtime = emitted ? path.join(root, 'dist') : root;
const extension = emitted ? '.js' : '.ts';
const home = process.env.GOLEM_HOME;
assert.ok(home && process.env.GOLEM_W2_SANDBOX, 'owned sandbox required');
const file = path.join(home, 'config.json');
const empty = path.join(process.env.GOLEM_W2_SANDBOX, 'config-cwd');
fs.mkdirSync(empty, { recursive: true });
fs.mkdirSync(home, { recursive: true });
const moduleAt = (relative) =>
  import(pathToFileURL(path.join(runtime, relative)).href);
const owner = await moduleAt(`lib/golem-config${extension}`);
assert.equal(typeof owner.loadConfig, 'function');
const roles = await moduleAt(`lib/session-role${extension}`);
const { registerSubstrateRoutes } = await moduleAt(
  'dashboard/server/substrate.js',
);
const { openTrackerDb } = await moduleAt('dashboard/server/tracker-db.js');
const { initDispatchDrainer } = await moduleAt(
  'dashboard/server/dispatch-queue.js',
);
const cc = await moduleAt('lib/compiler/adapters/cc.js');
const pi = await moduleAt('lib/compiler/adapters/pi.js');
const { render } = await moduleAt('lib/compiler/engine.js');
const app = Fastify();
await registerSubstrateRoutes(app);
const dbPath = path.join(home, 'config-tracker.db');
const tracker = openTrackerDb(dbPath);
const ticket = createPrivateScratchFixture(tracker, dbPath, {
  title: 'config refusal',
});
const receipts = [];
const write = (value) => {
  const bytes = JSON.stringify(value);
  fs.writeFileSync(file, bytes);
  return bytes;
};
function shell(hook, env = {}) {
  return spawnSync('bash', [hook], {
    cwd: empty,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10000,
    input: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'synthetic-config-session',
      cwd: empty,
    }),
  });
}
function sourceHook() {
  return path.join(root, 'substrate/hooks/tracker-context.sh');
}
function checkRefused(result) {
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /VERSIONED_VERSION_UNSUPPORTED/);
  assert.equal(result.stdout, '');
}
try {
  const bytes = write({
    schema_version: 9,
    extension: 'synthetic retained future',
  });
  for (const url of ['/api/substrate/config', '/api/substrate/status']) {
    const result = await app.inject({ url });
    assert.equal(result.statusCode, 409, result.body);
    assert.match(
      result.json().message ?? result.json().error,
      /VERSIONED_VERSION_UNSUPPORTED/,
    );
  }
  const rejectedPut = await app.inject({
    method: 'PUT',
    url: '/api/substrate/config',
    payload: { harnesses: { claudecode: { enabled: false } } },
  });
  assert.equal(rejectedPut.statusCode, 409, rejectedPut.body);
  const refusedSync = await app.inject({
    method: 'POST',
    url: '/api/substrate/sync',
    payload: { target: 'claudecode' },
  });
  assert.equal(refusedSync.statusCode, 409, refusedSync.body);
  const envelope = tracker.createDispatchEnvelope(ticket.id, {
    session_id: 'synthetic-config-session',
    actor: 'smoke',
  });
  const beforeEnvelope = tracker.getEnvelope(envelope.id);
  assert.throws(
    () => tracker.markEnvelopeDelivery(envelope.id),
    /VERSIONED_VERSION_UNSUPPORTED/,
  );
  assert.throws(
    () =>
      tracker.recordTypedEnvelopeLifecycle(envelope.id, {
        state: 'claimed',
        attempt_id: 'synthetic-attempt',
      }),
    /VERSIONED_VERSION_UNSUPPORTED/,
  );
  assert.deepEqual(tracker.getEnvelope(envelope.id), beforeEnvelope);
  const drainer = initDispatchDrainer({
    tracker,
    state: {},
    chat: {
      record() {
        assert.fail('no refused-file warning or delivery');
      },
    },
    pushBrief() {
      assert.fail('no delivery');
    },
    broadcastWS() {},
    listChannels: async () => [],
  });
  try {
    await assert.rejects(drainer.tick(), /VERSIONED_VERSION_UNSUPPORTED/);
  } finally {
    drainer.close();
  }
  checkRefused(shell(sourceHook()));
  assert.equal(
    shell(sourceHook(), { GOLEM_ROLE: 'lead' }).status,
    0,
    'assigned role does not read default config',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  receipts.push(
    'source/api/tracker/drainer/shell future refusal + zero config write',
  );

  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.equal(
    (await app.inject({ url: '/api/substrate/config' })).statusCode,
    500,
  );
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/substrate/config',
        payload: { harnesses: {} },
      })
    ).statusCode,
    500,
  );
  const ioShell = shell(sourceHook());
  assert.equal(ioShell.status, 1, ioShell.stderr);
  assert.match(ioShell.stderr, /VERSIONED_FILE_KIND/);
  assert.ok(fs.statSync(file).isDirectory());
  fs.rmdirSync(file);
  fs.mkdirSync(path.join(home, 'roles'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'roles/custom-role.md'),
    'SYNTHETIC-CONFIG-ROLE-CARD',
  );
  for (const [role, included] of [
    ['custom-role', true],
    ['  custom-role  ', false],
    ['Custom-Role', false],
    ['../custom-role', false],
    [null, false],
    ['', false],
  ]) {
    const prior = write({ roles: { default: role } });
    const result = shell(sourceHook());
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.includes('SYNTHETIC-CONFIG-ROLE-CARD'),
      included,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), prior);
  }
  write({
    harnesses: { claudecode: { enabled: true }, pi: { enabled: null } },
    roles: { default: null },
    extension: [null, { kept: true }],
  });
  const malformed = await app.inject({
    method: 'PUT',
    url: '/api/substrate/config',
    payload: { harnesses: { claudecode: { enabled: 'not-boolean' } } },
  });
  assert.equal(malformed.statusCode, 400, malformed.body);
  const valid = await app.inject({
    method: 'PUT',
    url: '/api/substrate/config',
    payload: { harnesses: { claudecode: { enabled: false } } },
  });
  assert.equal(valid.statusCode, 200, valid.body);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.schema_version, 1);
  assert.deepEqual(saved.extension, [null, { kept: true }]);
  assert.equal(saved.roles.default, null);
  assert.equal(saved.harnesses.pi.enabled, null);
  assert.equal(roles.defaultSessionRole(), null);
  const inactiveSync = await app.inject({
    method: 'POST',
    url: '/api/substrate/sync',
    payload: { target: 'claudecode' },
  });
  assert.equal(inactiveSync.statusCode, 200, inactiveSync.body);
  assert.equal(inactiveSync.json().results[0].skipped, true);
  assert.equal(shell(sourceHook()).status, 0);
  receipts.push(
    'real substrate request400/v0 explicit save/v1/default-role/disabled sync',
  );

  for (const [tag, window, expected] of [
    ['zero', 0, 5],
    ['negative', -2, 0],
    ['fraction', 0.25, 0.25],
    ['null', null, 5],
  ]) {
    const prior = write({ dispatch: { unackedWindowMinutes: window } });
    const item = tracker.createDispatchEnvelope(ticket.id, {
      session_id: `synthetic-${tag}`,
      actor: 'smoke',
    });
    const delivered = tracker.markEnvelopeDelivery(item.id);
    assert.equal(
      Date.parse(delivered.ack_deadline_at) -
        Date.parse(delivered.delivered_at),
      expected * 60000,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), prior);
  }
  receipts.push(
    'real tracker preserves established zero/negative/fraction/null window semantics',
  );

  for (const [target, adapter] of [
    ['cc', cc],
    ['pi', pi],
  ]) {
    const out = path.join(
      process.env.GOLEM_W2_SANDBOX,
      `config-private-${target}`,
    );
    const items = adapter.buildPlan({
      substrateRoot: path.join(root, 'substrate'),
      repoRoot: root,
      packageVersion: '5.26.0',
    });
    render({ target, outDir: out, items, packageVersion: '5.26.0' });
    assert.equal(fs.existsSync(path.join(out, 'node_modules')), false);
    const baseline = write({
      roles: { default: 'custom-role' },
      extension: { nested: [null, true] },
    });
    const expression = `import assert from 'node:assert/strict'; import {loadConfig} from './lib/golem-config.js'; import {defaultSessionRole} from './lib/session-role.js'; assert.equal(loadConfig().schema_version,1); assert.equal(defaultSessionRole(),'custom-role');`;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', expression],
      { cwd: out, env: process.env, encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.readFileSync(file, 'utf8'), baseline);
    const future = write({ schema_version: 9 });
    checkRefused(shell(path.join(out, 'hooks/tracker-context.sh')));
    assert.equal(fs.readFileSync(file, 'utf8'), future);
    fs.unlinkSync(file);
    const helper = spawnSync(
      process.execPath,
      [path.join(out, 'lib/config-role-default.js')],
      { cwd: out, env: process.env, encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(helper.status, 0, helper.stderr);
    assert.equal(helper.stdout, 'lead');
    assert.equal(fs.existsSync(file), false);
    receipts.push(
      `actual dependency-free private ${target} emitted read/refusal/missing zero-write`,
    );
  }
  const help = spawnSync(
    process.execPath,
    [path.join(root, 'cli/golem-bin.js'), '--help'],
    { cwd: empty, env: process.env, encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.equal(fs.existsSync(file), false);
  receipts.push(
    `actual ${emitted ? 'installed' : 'source'} CLI import closure without config creation`,
  );
  console.log(JSON.stringify({ emitted, receipts }));
} finally {
  await app.close();
  archivePrivateScratchFixture(tracker, ticket.id);
  tracker.close();
}
