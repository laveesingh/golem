import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { runScript } from '../support/run-script.mjs';

for (const mode of ['cli', 'contracts', 'identities', 'faults']) {
  test(`W5 native synthetic scenario ${mode} consumer and failure boundary`, async () => {
    const receipt = await runScript('test/integration/scenario-probe.mjs', {
      args: [mode],
      timeout: 20000,
    });
    assert.equal(receipt.code, 0);
    assert.equal(receipt.signal, null);
    assert.equal(receipt.timedOut, false);
    assert.equal(receipt.pipeDrainTimedOut, false);
    assert.equal(fs.existsSync(receipt.sandboxRoot), false);
    assert.deepEqual(receipt.cleanupErrors, []);
    assert.match(
      receipt.stdout,
      new RegExp(
        `W5 B1 ${mode}: native synthetic consumer/failure assertions PASS`,
      ),
    );
    assert.match(receipt.stdout, /children reaped before root removal PASS/);
  });
}
