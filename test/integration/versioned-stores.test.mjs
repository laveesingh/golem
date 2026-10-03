import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runScript } from '../support/run-script.mjs';

test('dashboard, share, journal and spool migrate legacy and refuse the future', async () => {
  const result = await runScript('test/fixtures/w3-versioned-stores.mjs', {
    timeout: 60000,
  });
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.stores.dashboard, {
    legacyMigrated: true,
    stamped: true,
    futureRefused: true,
  });
  assert.deepEqual(receipt.stores.share, {
    legacyMigrated: true,
    stamped: true,
    futureRefused: true,
  });
  assert.equal(receipt.stores.journal.legacyRead, true);
  assert.equal(receipt.stores.journal.shellHeadered, true);
  assert.deepEqual(receipt.stores.shellSpool, {
    headered: true,
    filtered: true,
  });
}, 90000);
