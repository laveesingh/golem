import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runScript } from '../support/run-script.mjs';

test('concurrent header publication loses zero events across fresh files', async () => {
  const result = await runScript('test/fixtures/w3-jsonl-seams.mjs', {
    args: ['race'],
    timeout: 120000,
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: 'race',
    N: 16,
    R: 200,
    badCount: 0,
    bad: [],
  });
}, 150000);

test('a future spool is refused untouched with nothing submitted', async () => {
  const result = await runScript('test/fixtures/w3-jsonl-seams.mjs', {
    args: ['spool-future'],
    timeout: 60000,
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: 'spool-future',
    exit: 0,
    spoolUnchanged: true,
    submitted: false,
  });
}, 90000);
