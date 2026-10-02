import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { captureProcessGroup } from '../../lib/process-group.js';
import { stopMainGroup } from '../support/main-group.mjs';
import { createSandbox, repo } from '../support/sandbox.mjs';

test('launcher selects native clean checkout and refuses TS fallback in node_modules even with stray source', () => {
  const sandbox = createSandbox();
  try {
    const create = (root) => {
      fs.mkdirSync(path.join(root, 'cli'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
      fs.copyFileSync(
        path.join(repo, 'cli/golem-bin.js'),
        path.join(root, 'cli/golem-bin.js'),
      );
      return path.join(root, 'cli/golem-bin.js');
    };
    const checkout = path.join(sandbox.root, 'checkout');
    const sourceBin = create(checkout);
    fs.writeFileSync(
      path.join(checkout, 'cli/bootstrap.ts'),
      'export async function runBootstrap(): Promise<void> { console.log("native-source"); console.log(JSON.stringify(process.argv.slice(2))); }',
    );
    assert.ok(!fs.existsSync(path.join(checkout, 'dist')));
    const run = (bin, args = []) =>
      spawnSync(process.execPath, [bin, ...args], {
        env: sandbox.env,
        encoding: 'utf8',
        timeout: 10000,
      });
    const source = run(sourceBin);
    assert.equal(source.status, 0, source.stderr);
    assert.match(source.stdout, /native-source/);
    const installed = path.join(
      sandbox.root,
      'prefix/node_modules/@laveesingh/golem',
    );
    const installedBin = create(installed);
    fs.copyFileSync(
      path.join(checkout, 'cli/bootstrap.ts'),
      path.join(installed, 'cli/bootstrap.ts'),
    );
    const dashboardBins = [checkout, installed].map((root) => {
      const dashboard = path.join(root, 'cli/dashboard-bin.js');
      fs.copyFileSync(path.join(repo, 'cli/dashboard-bin.js'), dashboard);
      return dashboard;
    });
    const absent = run(installedBin);
    assert.equal(absent.status, 2);
    assert.match(absent.stderr, /dist\/cli\/bootstrap.js/);
    assert.doesNotMatch(
      absent.stderr,
      /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/,
    );
    const dashboardAbsent = run(dashboardBins[1], ['--profile', 'isolated']);
    assert.equal(dashboardAbsent.status, 2);
    assert.match(dashboardAbsent.stderr, /dist\/cli\/bootstrap.js/);
    assert.doesNotMatch(
      dashboardAbsent.stderr,
      /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/,
    );
    fs.mkdirSync(path.join(installed, 'dist/cli'), { recursive: true });
    fs.writeFileSync(
      path.join(installed, 'dist/cli/bootstrap.js'),
      'export async function runBootstrap() { console.log("emitted-js"); console.log(JSON.stringify(process.argv.slice(2))); }',
    );
    const emitted = run(installedBin);
    assert.equal(emitted.status, 0, emitted.stderr);
    assert.match(emitted.stdout, /emitted-js/);
    assert.doesNotMatch(emitted.stdout, /native-source/);
    for (const dashboard of dashboardBins) {
      for (const [args, expected] of [
        [[], ['dashboard']],
        [
          ['--profile', 'isolated', '--port', '18500', '--public'],
          ['--profile', 'isolated', '--port', '18500', 'dashboard', '--public'],
        ],
        [
          ['--port=18500', '--profile=isolated', '--help'],
          ['--port=18500', '--profile=isolated', 'dashboard', '--help'],
        ],
        [
          ['--', '--profile', 'command-owned'],
          ['dashboard', '--', '--profile', 'command-owned'],
        ],
      ]) {
        const result = run(dashboard, args);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
          JSON.parse(result.stdout.trim().split('\n').at(-1)),
          expected,
        );
      }
      for (const args of [['--profile'], ['--port', '--help']]) {
        const result = run(dashboard, args);
        assert.equal(result.status, 2);
        assert.match(result.stderr, /requires a value/);
        assert.equal(result.stdout, '');
      }
    }
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(repo, 'package.json'))).scripts
        .dashboard,
      'node cli/dashboard-bin.js',
    );
  } finally {
    sandbox.cleanup();
  }
});

test('source dashboard CLI and npm wrapper preserve child exits, signals, spawn errors and forwarded shutdown', async () => {
  const sandbox = createSandbox();
  let child, closed, ownership;
  try {
    const fakeServer = path.join(sandbox.root, 'server.mjs');
    const preloader = path.join(sandbox.root, 'dashboard-spawn.mjs');
    const stopped = path.join(sandbox.root, 'stopped');
    fs.writeFileSync(
      fakeServer,
      `
import fs from 'node:fs';
if (process.env.DASHBOARD_FIXTURE_MODE === 'exit') process.exit(7);
else if (process.env.DASHBOARD_FIXTURE_MODE === 'signal') process.kill(process.pid, 'SIGKILL');
else {
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    fs.writeFileSync(${JSON.stringify(stopped)}, signal);
    // Give repeated wrapper signals a chance to arrive during child cleanup.
    setTimeout(() => process.exit(0), 100);
  });
  setInterval(() => {}, 1000);
  console.log('dashboard-fixture-ready');
}
`,
    );
    fs.writeFileSync(
      preloader,
      `
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const original = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  if (args?.[0]?.endsWith('/dashboard/server/index.js')) {
    if (process.env.DASHBOARD_FIXTURE_MODE === 'error')
      return original(${JSON.stringify(path.join(sandbox.root, 'absent-node'))}, [], options);
    return original(command, [${JSON.stringify(fakeServer)}], options);
  }
  return original(command, args, options);
};
syncBuiltinESMExports();
`,
    );
    for (const [bin, args] of [
      ['cli/golem-bin.js', ['dashboard']],
      ['cli/dashboard-bin.js', []],
    ]) {
      for (const mode of ['exit', 'signal', 'error', 'SIGINT', 'SIGTERM']) {
        fs.rmSync(stopped, { force: true });
        const env = {
          ...sandbox.env,
          DASHBOARD_FIXTURE_MODE: mode,
          NODE_OPTIONS: `${sandbox.env.NODE_OPTIONS} --import=${preloader}`,
        };
        child = spawn(process.execPath, [path.join(repo, bin), ...args], {
          cwd: sandbox.root,
          env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        closed = once(child, 'close');
        await once(child, 'spawn');
        ownership = captureProcessGroup(child.pid);
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk;
        });
        child.stderr.on('data', (chunk) => {
          output += chunk;
        });
        if (mode.startsWith('SIG')) {
          for (
            let i = 0;
            i < 200 && !output.includes('dashboard-fixture-ready');
            i++
          ) {
            assert.equal(child.exitCode, null, output);
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          assert.match(output, /dashboard-fixture-ready/);
          assert.ok(child.kill(mode));
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.ok(child.kill(mode));
        }
        let timer;
        const outcome = await Promise.race([
          closed,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error(`dashboard fixture timed out: ${mode}`)),
              10000,
            );
          }),
        ]).finally(() => clearTimeout(timer));
        if (mode === 'exit') assert.deepEqual(outcome, [7, null], output);
        else if (mode === 'signal')
          assert.deepEqual(outcome, [null, 'SIGKILL'], output);
        else if (mode === 'error') {
          assert.deepEqual(outcome, [1, null], output);
          assert.match(output, /failed to start dashboard:.*ENOENT/);
        } else {
          assert.deepEqual(outcome, [0, null], output);
          assert.equal(fs.readFileSync(stopped, 'utf8'), mode);
        }
        await stopMainGroup(ownership, sandbox.root);
        await closed;
        child = closed = ownership = undefined;
      }
    }
  } finally {
    if (child) {
      await stopMainGroup(ownership, sandbox.root);
      await closed;
    }
    sandbox.cleanup();
  }
}, 30000);
