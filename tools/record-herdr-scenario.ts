// Bounded herdr capture on the rec profile. Runs real herdr CLI calls,
// builds the candidate through the broker (ordering + scrub validation),
// then closes. No harness model is involved.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProfile } from '../cli/bootstrap.ts';
import { createScenarioRecorder } from '../lib/scenario-recorder.ts';

assert.equal(process.env.GOLEM_RECORD_REAL, '1');
const repo = fileURLToPath(new URL('../', import.meta.url));
const rec = path.join(process.env.HOME ?? '', '.golem-profiles', 'rec');
const env: Record<string, string | undefined> = { ...process.env };
resolveProfile(['--profile', 'rec'], env);
assert.equal(env.GOLEM_PROFILE_ROOT, rec);
env.HOME = path.join(rec, 'home');
const session = `s4-herdr-${Date.now().toString(36)}`;
env.GOLEM_HERDR_SESSION = session;
const version = spawnSync('herdr', ['--version'], {
  env,
  encoding: 'utf8',
  timeout: 10000,
});
assert.equal(version.status, 0);
const pinned = /(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1];
assert.ok(pinned);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 's4-'));
fs.chmodSync(root, 0o700);
const broker = await createScenarioRecorder(
  path.join(root, 'herdr-worker-lifecycle.json'),
  {
    schema: 1,
    scenario: 'herdr-worker-lifecycle',
    seed: 524,
    source: {
      harness: 'herdr',
      harness_version: pinned,
      golem_version: JSON.parse(
        fs.readFileSync(path.join(repo, 'package.json'), 'utf8'),
      ).version,
    },
  },
);
function call(args: string[]): unknown {
  const argv = ['--session', session, ...args];
  broker.record({
    boundary: 'process',
    direction: 'in',
    operation: 'process-spawn',
    fields: { harness: 'herdr', argv },
  });
  const result = spawnSync('herdr', argv, {
    env,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.error, undefined);
  const payload = parsed.result ?? parsed;
  broker.record({
    boundary: 'process',
    direction: 'out',
    operation: 'process-stdout',
    fields: { harness: 'herdr', stdout_recipe: 'json', result: payload },
  });
  broker.record({
    boundary: 'process',
    direction: 'out',
    operation: 'process-exit',
    fields: { harness: 'herdr', exit_code: 0 },
  });
  return payload;
}
try {
  process.env.GOLEM_HERDR_SESSION = session;
  if (env.XDG_CONFIG_HOME)
    process.env.XDG_CONFIG_HOME = String(env.XDG_CONFIG_HOME);
  const started = await (await import('../lib/herdr-driver.js')).ensureSession(
    session,
  );
  assert.ok(started.session === session);
  const created = call(['workspace', 'create', '--label', 's4-recording']) as {
    workspace?: { workspace_id?: string };
  };
  const workspaceId = created.workspace?.workspace_id;
  assert.ok(workspaceId);
  const tab = call([
    'tab',
    'create',
    '--workspace',
    String(workspaceId),
    '--label',
    's4-worker',
  ]);
  const paneId = (tab as { root_pane?: { pane_id?: string } }).root_pane
    ?.pane_id;
  assert.ok(paneId);
  const driver = await import('../lib/herdr-driver.js');
  call(['agent', 'list']);
  const runArgv = [
    '--session',
    session,
    'pane',
    'run',
    String(paneId),
    '--',
    'echo RECORDING_OK',
  ];
  broker.record({
    boundary: 'process',
    direction: 'in',
    operation: 'process-spawn',
    fields: { harness: 'herdr', argv: runArgv },
  });
  assert.equal(
    driver.paneRun({
      session,
      paneId: String(paneId),
      command: ['echo RECORDING_OK'],
    }),
    true,
  );
  broker.record({
    boundary: 'process',
    direction: 'out',
    operation: 'process-exit',
    fields: { harness: 'herdr', exit_code: 0 },
  });
  const roster = call(['agent', 'list']) as { agents?: unknown };
  assert.ok(Array.isArray(roster.agents));
  const closeArgv = ['--session', session, 'pane', 'close', String(paneId)];
  broker.record({
    boundary: 'process',
    direction: 'in',
    operation: 'process-spawn',
    fields: { harness: 'herdr', argv: closeArgv },
  });
  assert.equal(driver.paneClose({ session, paneId: String(paneId) }), true);
  broker.record({
    boundary: 'process',
    direction: 'out',
    operation: 'process-exit',
    fields: { harness: 'herdr', exit_code: 0 },
  });
  const stopArgv = ['--session', session, 'session', 'stop', session];
  broker.record({
    boundary: 'process',
    direction: 'in',
    operation: 'process-spawn',
    fields: { harness: 'herdr', argv: stopArgv },
  });
  assert.equal(driver.sessionStop(session), true);
  broker.record({
    boundary: 'process',
    direction: 'out',
    operation: 'process-exit',
    fields: { harness: 'herdr', exit_code: 0 },
  });
  const scenario = await broker.close();
  console.log(
    `candidate ${path.join(root, 'herdr-worker-lifecycle.json')}; ${scenario.events.length} real herdr CLI transactions; herdr ${pinned}`,
  );
} catch (error) {
  broker.abort('native_run_failed');
  try {
    await broker.close();
  } catch {}
  console.error(`recording failed: ${(error as Error).message}; root ${root}`);
  process.exitCode = 1;
} finally {
  try {
    await (await import('../lib/herdr-driver.js')).sessionStop(session);
  } catch {}
}
