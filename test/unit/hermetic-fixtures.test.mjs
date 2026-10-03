import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';

// Slice rule: tests never read git history or run git against the repo (CI
// sandboxes HOME, which hides the workflow's safe.directory). Old-source
// controls use committed copies under test/fixtures/<name>/ instead.
const S1_SOURCES = [
  'test/fixtures/w3-config-regression.mjs',
  'test/fixtures/w3-config-repair.mjs',
  'test/fixtures/w3-config-consumers.mjs',
  'test/fixtures/w3-config-concurrency.mjs',
  'test/fixtures/w3-versioned-stores.mjs',
  'test/fixtures/w3-jsonl-seams.mjs',
  'test/unit/versioned-config.test.mjs',
  'test/unit/versioned-stores.test.mjs',
  'test/integration/versioned-config.test.mjs',
  'test/integration/versioned-stores.test.mjs',
  'test/integration/jsonl-seams.test.mjs',
];

test('S1 tests and fixtures never execute git', () => {
  const root = new URL('../../', import.meta.url).pathname;
  const offenders = [];
  for (const relative of S1_SOURCES) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    const pattern =
      /(execFileSync|spawnSync|spawn)\(\s*['"`]git['"`]|`git\s|\$\(git\s/g;
    const hits = [...source.matchAll(pattern)].map((match) => match[0]);
    if (hits.length) offenders.push({ relative, hits });
  }
  assert.deepEqual(offenders, []);
});
