// One parser used by CLI fixtures and native journeys. This is the final
// schema-v2 CLI contract, not an old/new compatibility bridge.
import assert from 'node:assert/strict';
export function parseManagementList(text) {
  const receipt = JSON.parse(text);
  assert.equal(receipt.schema_version, 2);
  assert.ok(Array.isArray(receipt.items));
  assert.equal(typeof receipt.resolution, 'object');
  assert.ok(receipt.resolution && typeof receipt.resolution.scope === 'string');
  assert.ok(receipt.items.every(row => !Object.hasOwn(row, 'resolution')), 'provenance belongs to the query, not each row');
  return receipt.items;
}
