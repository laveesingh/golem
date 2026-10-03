import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { cleanupGroups } from '../support/cleanup-groups.mjs';
import { runScript } from '../support/run-script.mjs';

test('uncertain subgroup identity bounds pipe draining and retains owned roots', async () => {
  const started = Date.now();
  let failure;
  try {
    await runScript('test/fixtures/w2-safety-probe.mjs', {
      args: ['uncertain-pipe-group'],
      timeout: 1000,
      drainTimeout: 500,
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure?.receipt, String(failure));
  const receipt = failure.receipt,
    root = receipt.sandboxRoot;
  try {
    assert.ok(Date.now() - started < 6000);
    assert.equal(receipt.timedOut, true);
    assert.equal(receipt.pipeDrainTimedOut, true);
    assert.ok(
      receipt.cleanupErrors.some((error) =>
        error.includes('identity indeterminate'),
      ),
    );
    assert.equal(fs.existsSync(root), true);
    assert.equal(
      root.startsWith(process.env.GOLEM_W2_SANDBOX + path.sep),
      false,
      'retained root must survive worker afterAll',
    );
    const saved = JSON.parse(
      fs.readFileSync(
        new URL(
          '../../.test-results/test__fixtures__w2-safety-probe.mjs.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    assert.equal(saved.timedOut, true);
    assert.equal(saved.pipeDrainTimedOut, true);
  } finally {
    // Restore only the true incarnation token captured for this test-owned
    // process before deliberate corruption, then fenced teardown. No PID guess.
    fs.copyFileSync(
      path.join(root, 'groups-owned.jsonl'),
      path.join(root, 'groups.jsonl'),
    );
    await cleanupGroups(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(root), false);
});
