import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { contractRemovals } from '../../tools/contract-diff.mjs';

test('actual BEFORE response fixture field removal is detected, not a fake released baseline', () => {
  const captured = JSON.parse(
    fs.readFileSync(
      new URL('../fixtures/contracts/pilot-before.json', import.meta.url),
      'utf8',
    ),
  );
  const sample = captured.cases.find((row) => row.name === 'health').body;
  const before = {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(sample).map(([key, value]) => [
        key,
        { type: typeof value === 'number' ? 'integer' : typeof value },
      ]),
    ),
  };
  const after = structuredClone(before);
  delete after.properties.project_count;
  assert.deepEqual(contractRemovals(before, after), [
    '$.properties.project_count',
  ]);
  const additive = structuredClone(before);
  additive.properties.extra = { type: 'string' };
  assert.deepEqual(contractRemovals(before, additive), []);
});
