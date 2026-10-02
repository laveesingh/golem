import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { runScript } from '../support/run-script.mjs';

test('GOL501 actual isolated Ladle build and preview artifacts', async () => {
  const receipt = await runScript('test/integration/atoms-workshop-probe.mjs', {
    timeout: 120000,
    args: ['build'],
  });
  assert.equal(receipt.code, 0);
  assert.equal(receipt.timedOut, false);
  assert.equal(receipt.pipeDrainTimedOut, false);
  assert.deepEqual(receipt.cleanupErrors, []);
  assert.equal(fs.existsSync(receipt.sandboxRoot), false);
  assert.match(receipt.stdout, /GOL501 owned Ladle build\+actual preview PASS/);
});
