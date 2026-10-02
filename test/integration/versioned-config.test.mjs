import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runScript } from '../support/run-script.mjs';

test('same future-file regression fails on actual accepted old owner and passes on current native source', async () => {
  const before = await runScript('test/fixtures/w3-config-regression.mjs', {
    args: ['--before'],
  });
  assert.deepEqual(JSON.parse(before.stdout), {
    old: true,
    regressionPassed: false,
    unchanged: true,
  });
  const after = await runScript('test/fixtures/w3-config-regression.mjs');
  assert.deepEqual(JSON.parse(after.stdout), {
    old: false,
    regressionPassed: true,
    unchanged: true,
  });
});
for (const kind of ['snapshot', 'descriptor'])
  test(`frozen f733 desired ${kind} guard FAILS; current native repair PASSES`, async () => {
    for (const old of [true, false]) {
      const result = await runScript('test/fixtures/w3-config-repair.mjs', {
        args: [`--case=${kind}`, ...(old ? ['--before'] : [])],
      });
      assert.deepEqual(JSON.parse(result.stdout), {
        old,
        kind,
        regressionPassed: !old,
        refused: true,
        originalPreserved: kind === 'snapshot' ? !old : true,
        foreignFdOpen: kind === 'descriptor' ? !old : null,
        foreignFdCode: kind === 'descriptor' && old ? 'EBADF' : null,
      });
    }
  });
test('actual concurrent processes cannot reclaim or overwrite another config writer', async () => {
  const result = await runScript('test/fixtures/w3-config-concurrency.mjs', {
    timeout: 25000,
  });
  assert.match(
    result.stdout,
    /actual concurrent saves: held owner preserved; second409/,
  );
});
test('native actual API/tracker/drainer/shell and both dependency-free emitted private helper closures', async () => {
  const result = await runScript('test/fixtures/w3-config-consumers.mjs');
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.emitted, false);
  assert.equal(proof.receipts.length, 6);
});
