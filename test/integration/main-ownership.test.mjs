import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { processBirth } from '../../lib/management-lock.js';
import { stopMainGroup } from '../support/main-group.mjs';
import { runScript } from '../support/run-script.mjs';

for (const mode of ['stale', 'indeterminate'])
  test(`main ${mode} incarnation refuses signal and retains exact owned recovery`, async () => {
    let signals = 0,
      failure;
    const started = Date.now();
    try {
      await runScript('test/fixtures/w2-safety-probe.mjs', {
        args: ['main-fence-hold'],
        timeout: 1000,
        drainTimeout: 500,
        mainControls: {
          probe: () => {
            if (mode === 'indeterminate')
              throw Error('controlled main identity probe unavailable');
            return 'controlled-stale-incarnation';
          },
          beforeSignal: () => signals++,
        },
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure?.receipt, String(failure));
    const receipt = failure.receipt,
      root = receipt.sandboxRoot;
    try {
      assert.ok(Date.now() - started < 6000);
      assert.equal(signals, 0);
      assert.equal(receipt.timedOut, true);
      assert.ok(
        receipt.cleanupErrors.some((error) =>
          /main|probe unavailable/.test(error),
        ),
      );
      assert.equal(fs.existsSync(root), true);
      assert.match(receipt.stdout, /main-fence-ready/);
      const trueIdentity = receipt.mainOwnership;
      assert.equal(
        processBirth(trueIdentity.pgid),
        trueIdentity.members.find((row) => row.pid === trueIdentity.pgid).birth,
      );
      // Exact true allocation snapshot, not the controlled stale probe or an
      // unrelated PID/reuse attack, authorizes owned negative-fixture recovery.
      await stopMainGroup(trueIdentity, root);
      assert.equal(processBirth(trueIdentity.pgid), null);
    } finally {
      await stopMainGroup(receipt.mainOwnership, root);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
test('leader exit preserves captured ownership of genuine own residual members', async () => {
  let signaledIdentity,
    leaderGone = false,
    failure;
  try {
    await runScript('test/fixtures/w2-safety-probe.mjs', {
      args: ['main-residual-exit'],
      mainControls: {
        beforeSignal: (identity) => {
          signaledIdentity = identity;
          leaderGone = processBirth(identity.pgid) === null;
        },
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure?.receipt, String(failure));
  assert.equal(leaderGone, true);
  assert.ok(
    signaledIdentity.members.some((row) => row.pid !== signaledIdentity.pgid),
  );
  assert.match(failure.receipt.stdout, /main-residual-ready/);
  assert.equal(failure.receipt.code, 1);
  assert.deepEqual(failure.receipt.cleanupErrors, []);
  assert.equal(fs.existsSync(failure.receipt.sandboxRoot), false);
  for (const row of signaledIdentity.members)
    assert.equal(processBirth(row.pid), null);
});
