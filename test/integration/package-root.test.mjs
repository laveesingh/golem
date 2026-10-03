import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'vitest';
import {
  packageLocation,
  packageRoot,
  roleAssetsRoot,
  runtimeFile,
} from '../../lib/package-root.ts';

test('module caller owns package/render roots independently of inherited root env', () => {
  const temp = fs.mkdtempSync(
    path.join(process.env.GOLEM_W2_SANDBOX, 'package-root-'),
  );
  const installed = path.join(temp, 'node_modules/@laveesingh/golem'),
    render = path.join(temp, 'private render');
  fs.mkdirSync(path.join(installed, 'dist/lib'), { recursive: true });
  fs.mkdirSync(path.join(render, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(installed, 'package.json'),
    '{"name":"@laveesingh/golem"}',
  );
  fs.writeFileSync(
    path.join(render, '.golem-render.json'),
    '{"name":"@laveesingh/golem","schema_version":1,"target":"cc"}',
  );
  const previous = process.env.GOLEM_ROOT;
  process.env.GOLEM_ROOT = '/forbidden/source-leak';
  try {
    const child = pathToFileURL(path.join(installed, 'dist/lib/child.js')),
      parent = pathToFileURL(path.join(render, 'lib/parent.js'));
    assert.equal(packageRoot(child), installed);
    assert.equal(packageRoot(parent), render);
    assert.equal(packageLocation(child).kind, 'package');
    assert.equal(packageLocation(parent).kind, 'render');
    assert.equal(
      roleAssetsRoot(child),
      path.join(installed, 'substrate/roles'),
    );
    assert.equal(roleAssetsRoot(parent), path.join(render, 'roles'));
    fs.writeFileSync(
      path.join(installed, 'dist/lib/helper.js'),
      'export const value=1;',
    );
    assert.equal(
      runtimeFile(child, 'lib/helper.js'),
      path.join(installed, 'dist/lib/helper.js'),
    );
    assert.throws(
      () => runtimeFile(child, 'lib/missing.js'),
      /runtime file missing/,
    );
    fs.writeFileSync(
      path.join(render, '.golem-render.json'),
      '{"name":"@laveesingh/golem","schema_version":2,"target":"cc"}',
    );
    assert.throws(() => packageRoot(parent), /invalid Golem render marker/);
  } finally {
    if (previous === undefined) delete process.env.GOLEM_ROOT;
    else process.env.GOLEM_ROOT = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
