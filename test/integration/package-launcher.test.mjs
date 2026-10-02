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
      'export async function runBootstrap(): Promise<void> { console.log("native-source"); }',
    );
    assert.ok(!fs.existsSync(path.join(checkout, 'dist')));
    const run = (bin) =>
      spawnSync(process.execPath, [bin], {
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
    const absent = run(installedBin);
    assert.equal(absent.status, 2);
    assert.match(absent.stderr, /dist\/cli\/bootstrap.js/);
    assert.doesNotMatch(
      absent.stderr,
      /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/,
    );
    fs.mkdirSync(path.join(installed, 'dist/cli'), { recursive: true });
    fs.writeFileSync(
      path.join(installed, 'dist/cli/bootstrap.js'),
      'export async function runBootstrap() { console.log("emitted-js"); }',
    );
    const emitted = run(installedBin);
    assert.equal(emitted.status, 0, emitted.stderr);
    assert.match(emitted.stdout, /emitted-js/);
    assert.doesNotMatch(emitted.stdout, /native-source/);
  } finally {
    sandbox.cleanup();
  }
});
