import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { render } from '../../lib/compiler/engine.js';

const file = (key, outputRelPath, text) => ({
  key,
  outputRelPath,
  sourceSha256: key,
  build: () => text,
});

// Re-sync over an existing render: a key renamed between syncs (source moved
// from .js to .ts) keeps its output path. The orphan sweep must not delete the
// file the renamed key just wrote. 6.0.0 shipped a Pi render without
// lib/session-role.js because of this.
test('re-sync keeps an output whose key was renamed but whose path stayed', () => {
  const outDir = fs.mkdtempSync(
    path.join(process.env.GOLEM_W2_SANDBOX, 'render-prune-'),
  );
  try {
    const out = (rel) => path.join(outDir, rel);
    render({
      target: 'prune-test',
      outDir,
      packageVersion: '0.0.0',
      items: [
        file('runtime:role.js', 'lib/role.js', 'old\n'),
        file('runtime:gone.js', 'lib/gone.js', 'gone\n'),
      ],
    });
    assert.equal(fs.readFileSync(out('lib/role.js'), 'utf8'), 'old\n');

    const second = render({
      target: 'prune-test',
      outDir,
      packageVersion: '0.0.0',
      items: [file('runtime:role.ts', 'lib/role.js', 'new\n')],
    });
    assert.equal(fs.readFileSync(out('lib/role.js'), 'utf8'), 'new\n');
    assert.ok(
      !fs.existsSync(out('lib/gone.js')),
      'a real orphan is still pruned',
    );
    assert.deepEqual(
      second.pruned.map((entry) => entry.key),
      ['runtime:gone.js'],
    );

    // A third sync with the same items is clean and keeps the file.
    const third = render({
      target: 'prune-test',
      outDir,
      packageVersion: '0.0.0',
      items: [file('runtime:role.ts', 'lib/role.js', 'new\n')],
    });
    assert.deepEqual(third.pruned, []);
    assert.equal(fs.readFileSync(out('lib/role.js'), 'utf8'), 'new\n');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
