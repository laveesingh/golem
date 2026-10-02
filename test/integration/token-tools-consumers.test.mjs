import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { runScript } from '../support/run-script.mjs';

for (const mode of ['cli', 'lint', 'build-package'])
  test(`GOL485 isolated native token ${mode} consumer`, async () => {
    const receipt = await runScript('test/integration/token-tools-probe.mjs', {
      args: [mode],
      timeout: 60000,
    });
    assert.equal(receipt.code, 0);
    assert.equal(receipt.timedOut, false);
    assert.equal(receipt.pipeDrainTimedOut, false);
    assert.deepEqual(receipt.cleanupErrors, []);
    assert.equal(fs.existsSync(receipt.sandboxRoot), false);
    assert.match(
      receipt.stdout,
      new RegExp(`GOL485 ${mode} isolated native consumer PASS`),
    );
  });
