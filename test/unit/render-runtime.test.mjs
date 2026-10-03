import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  emittedRuntimeSource,
  runtimeSource,
} from '../../lib/compiler/runtime-source.ts';

test('render copy lists prefer converted source, emit JS imports, and resolve installed output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gol523-unit-'));
  try {
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(
      path.join(root, 'lib/helper.ts'),
      "import type { Value } from './types.ts';\nimport { value } from './value.ts';\nexport const result: number = value;\n",
    );
    fs.writeFileSync(path.join(root, 'lib/helper.js'), 'stale');
    const source = runtimeSource(root, 'lib/helper.js');
    assert.equal(source, path.join(root, 'lib/helper.ts'));
    const code = emittedRuntimeSource(source);
    assert.match(code, /from ['"]\.\/value\.js['"]/);
    assert.doesNotMatch(code, /types\.ts|: number/);
    fs.rmSync(path.join(root, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist/lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/lib/helper.js'), code);
    const installed = runtimeSource(root, 'lib/helper.ts');
    assert.equal(emittedRuntimeSource(installed), code);
    assert.throws(
      () => runtimeSource(root, 'missing.js'),
      /runtime source missing/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
