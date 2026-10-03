import Ajv from 'ajv';
import { expect, test } from 'vitest';
import { emitJson, envelope, fail, ok } from '../../lib/cli-envelope.ts';
import { cliSchemas } from '../../lib/contracts/cli.ts';
import { JsonValue } from '../../lib/contracts/pilot.ts';

const ajv = new Ajv().addSchema(JsonValue);
for (const schema of Object.values(cliSchemas)) {
  const validate = ajv.compile(schema);
  test(`${schema.$id}: success and failure contracts`, () => {
    const success =
      schema.$id === 'CliStatusResult'
        ? ok({ dashboard_url: null, dashboard_healthy: false, dashboard: null })
        : ok({ help: 'usage' });
    expect(validate(success), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate(fail('INVALID_INPUT', 'bad flag', { flag: '--unknown' })),
    ).toBe(true);
    expect(validate({ ...success, ok: undefined })).toBe(false);
    expect(validate({ ...success, schema_version: undefined })).toBe(false);
    expect(validate({ schema_version: 1, ok: false, error: 'legacy' })).toBe(
      false,
    );
    expect(validate([])).toBe(false);
  });
}
test('flat fields, versions, immutable discriminant and newline-free output', () => {
  const fields = {
    schema_version: 77,
    ok: false,
    items: [],
    resolution: { scope: 'global' },
  };
  const receipt = ok(fields, 2);
  expect(receipt).toEqual({ ...fields, schema_version: 2, ok: true });
  expect(fields.ok).toBe(false);
  const output = [];
  emitJson((text) => output.push(text), receipt);
  expect(output).toEqual([JSON.stringify(receipt)]);
  expect(envelope([])).toEqual({ schema_version: 1, ok: true, items: [] });
  expect(
    envelope({
      ok: false,
      code: 'PARTIAL',
      error: 'stop failed',
      stopped: ['a'],
      resolution: {},
    }),
  ).toEqual({
    schema_version: 1,
    ok: false,
    code: 'PARTIAL',
    error: { code: 'PARTIAL', message: 'stop failed' },
    stopped: ['a'],
    resolution: {},
  });
});
