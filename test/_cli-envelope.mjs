import assert from 'node:assert/strict';
// Consumers must branch on ok before using either outcome's fields.
export function parseCliEnvelope(text) {
  const value = JSON.parse(text);
  assert.ok(value && !Array.isArray(value), 'CLI JSON must be a flat envelope');
  assert.ok(Number.isInteger(value.schema_version), 'CLI schema_version is required');
  if (value.ok === false) {
    assert.equal(typeof value.error?.code, 'string');
    assert.equal(typeof value.error?.message, 'string');
  } else {
    assert.equal(value.ok, true, 'CLI ok discriminant is required');
  }
  return value;
}
