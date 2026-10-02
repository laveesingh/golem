import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
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
