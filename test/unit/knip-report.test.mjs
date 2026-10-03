import assert from 'node:assert/strict';
import { test } from 'vitest';
import { addedDebt, issueKeys } from '../../tools/knip-report.mjs';

test('knip baseline tracks identities, not counts or unstable line numbers', () => {
  const before = issueKeys({
    issues: [{ file: 'legacy.js', exports: [{ name: 'old', line: 1 }] }],
  });
  const moved = issueKeys({
    issues: [{ file: 'legacy.js', exports: [{ name: 'old', line: 99 }] }],
  });
  assert.deepEqual(addedDebt(moved, before), []);
  const replacement = issueKeys({
    issues: [{ file: 'legacy.js', exports: [{ name: 'new' }] }],
  });
  assert.equal(
    addedDebt(replacement, before).length,
    1,
    'equal count cannot conceal new debt',
  );
  assert.equal(
    addedDebt([...before, ...before], before).length,
    1,
    'duplicated finding cannot conceal new debt',
  );
  assert.deepEqual(
    addedDebt([], before),
    [],
    'removing known debt is permitted',
  );
});
