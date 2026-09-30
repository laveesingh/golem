#!/usr/bin/env node
// Session phase integration: real herdr, no harness launches, disposable state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-session-native-'));
const xdg = `/tmp/golem-sess-${process.pid}`;
const home = path.join(root, 'home'), state = path.join(root, 'state'), project = path.join(root, 'project');
for (const dir of [home, state, project]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# disposable session test\n');
const env = { ...process.env, HOME: home, GOLEM_HOME: state, XDG_CONFIG_HOME: xdg, HERDR_ENV: '0' };
for (const key of ['GOLEM_HERDR_SESSION', 'HERDR_SESSION', 'HERDR_SOCKET_PATH', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID', 'GOLEM_SESSION_ID', 'CLAUDE_SESSION_ID', 'PI_SESSION_ID', 'PI_SESSION_FILE']) delete env[key];
const cli = (args) => {
  const result = spawnSync(process.execPath, [path.join(repo, 'cli/golem.js'), 'session', ...args, '--json'], { cwd: project, env, encoding: 'utf8', timeout: 45000 });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.error?.message ?? result.stderr} ${result.stdout}`);
  return JSON.parse(result.stdout);
};
const native = args => spawnSync('herdr', args, { env, encoding: 'utf8', timeout: 10000 });
let session;
try {
  const dry = cli(['start', '--project', project, '--dry-run']);
  assert.equal(dry.plan.association, 'allocation-required-on-real-mutation');
  assert.equal(fs.existsSync(path.join(state, 'herdr-mappings.json')), false);
  const started = cli(['start', '--project', project]); session = started.session;
  assert.match(session, /^g-[0-9a-f]{28}$/); assert.equal(started.started, true);
  const again = cli(['start', '--project', project]); assert.equal(again.noop, true); assert.equal(again.session, session);
  const inspect = cli(['inspect', session]); assert.equal(inspect.native_running, true);
  const stopped = cli(['stop', session]); assert.equal(stopped.lifecycle, 'stopped'); assert.equal(stopped.native_stopped, true);
  const retained = cli(['inspect', session]); assert.equal(retained.native_registered, true); assert.equal(retained.native_running, false);
  const restarted = cli(['start', '--project', project]); assert.equal(restarted.session, session); assert.equal(restarted.started, true);
  const closed = cli(['close', session]); assert.equal(closed.native_deleted, true); assert.equal(closed.lifecycle, 'closed');
  const retry = cli(['close', session]); assert.equal(retry.noop, true);
  console.log('session native passed: isolated real start/no-op/inspect/stop/registration retention/restart/close/retry');
} finally {
  // Stop/delete before destroying the HOME/socket tree, even on assertion failure.
  if (!session) {
    const file = path.join(state, 'herdr-mappings.json');
    if (fs.existsSync(file)) session = Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).projects ?? {})[0]?.session;
  }
  if (session) { native(['session', 'stop', session]); native(['session', 'delete', session]); }
  const processes = spawnSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' });
  assert.equal(processes.status, 0, processes.stderr);
  const survivors = session ? processes.stdout.split('\n').filter(line => line.includes(`--session ${session}`) && /\bherdr\b/.test(line)) : [];
  assert.deepEqual(survivors, [], 'owned native process survived cleanup; resources retained for diagnosis');
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(xdg, { recursive: true, force: true });
  console.log('session native cleanup passed: owned server absent; HOME/socket trees removed after stop/delete');
}
