import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { assertContractFreshness } from '../../tools/contracts-build.ts';

test('freshness rejects a generated mutation in an owned mirror, never touches checkout outputs', () => {
  const root = fs.mkdtempSync(
    path.join(process.env.GOLEM_W2_SANDBOX, 'freshness-'),
  );
  const expected = fs.readFileSync(
    new URL('../../contracts/dist/HealthResponse.schema.json', import.meta.url),
    'utf8',
  );
  const file = 'contracts/dist/HealthResponse.schema.json';
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  try {
    fs.writeFileSync(path.join(root, file), expected);
    assertContractFreshness({ [file]: expected }, root);
    const altered = JSON.parse(expected);
    delete altered.properties.project_count;
    fs.writeFileSync(path.join(root, file), JSON.stringify(altered));
    assert.throws(
      () => assertContractFreshness({ [file]: expected }, root),
      /stale contracts/,
    );
    assert.equal(
      fs.readFileSync(
        new URL(
          '../../contracts/dist/HealthResponse.schema.json',
          import.meta.url,
        ),
        'utf8',
      ),
      expected,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
