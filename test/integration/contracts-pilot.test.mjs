import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Type } from '@sinclair/typebox';
import Fastify from 'fastify';
import { test } from 'vitest';
import { installContractPolicy } from '../../dashboard/server/contract-policy.ts';
import {
  HealthResponse,
  PilotError,
  TicketCreated,
} from '../../lib/contracts/pilot.ts';
import { runScript } from '../support/run-script.mjs';

const before = JSON.parse(
  fs.readFileSync(
    new URL('../fixtures/contracts/pilot-before.json', import.meta.url),
    'utf8',
  ),
);
function stable(value, key = '') {
  if (key === 'hash') return '<hash>';
  if (typeof value === 'string')
    return value.replace(/b-[a-f0-9]{12}/g, '<block-id>');
  if (Array.isArray(value)) return value.map((item) => stable(item));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, stable(v, k)]),
    );
  return value;
}
test('actual private route shapes preserve BEFORE snapshots except named body type hardening', async () => {
  const receipt = await runScript('test/fixtures/w3-route-baseline.mjs');
  const actual = JSON.parse(receipt.stdout);
  for (const prior of before.cases) {
    const current = actual.cases.find((row) => row.name === prior.name);
    assert.ok(current, prior.name);
    if (['numeric-title', 'numeric-project'].includes(prior.name)) {
      assert.equal(prior.status, 201);
      assert.equal(current.status, 400);
      assert.equal(current.body.code, 'invalid_input');
      continue;
    }
    assert.deepEqual(stable(current), stable(prior), prior.name);
  }
});
test('typed generated pilot client exercises actual routes and legacy error payload', async () => {
  await runScript('test/fixtures/w3-client-probe.mjs');
});
test('response schemas enumerate every observed pilot field with explicit nullability', () => {
  for (const sample of before.cases.filter(
    (row) => !row.name.startsWith('numeric-'),
  )) {
    const schema =
      sample.name === 'health'
        ? HealthResponse
        : sample.status === 201
          ? TicketCreated
          : PilotError;
    for (const key of Object.keys(sample.body))
      assert.ok(key in schema.properties, `${sample.name}: ${key}`);
  }
  assert.ok(
    TicketCreated.properties.priority.anyOf.some(
      (schema) => schema.type === 'null',
    ),
  );
  assert.equal(TicketCreated.additionalProperties, true);
});
test('real Fastify Ajv policy: body never coerces/defaults/strips; query/params only scalar coercion', async () => {
  const app = Fastify();
  installContractPolicy(app);
  app.post(
    '/probe',
    {
      schema: {
        body: Type.Object(
          { n: Type.Optional(Type.Integer({ default: 3 })) },
          { additionalProperties: true },
        ),
      },
    },
    async (req) => req.body,
  );
  app.get(
    '/probe/:id',
    {
      schema: {
        querystring: Type.Object(
          { n: Type.Integer() },
          { additionalProperties: true },
        ),
        params: Type.Object(
          { id: Type.Integer() },
          { additionalProperties: true },
        ),
      },
    },
    async (req) => ({ query: req.query, params: req.params }),
  );
  try {
    const wrong = await app.inject({
      method: 'POST',
      url: '/probe',
      payload: { n: '3' },
    });
    assert.equal(wrong.statusCode, 400);
    const empty = await app.inject({
      method: 'POST',
      url: '/probe',
      payload: { extension: { kept: true } },
    });
    assert.deepEqual(empty.json(), { extension: { kept: true } });
    const scalars = await app.inject({ url: '/probe/4?n=3&extension=kept' });
    assert.deepEqual(scalars.json(), {
      query: { n: 3, extension: 'kept' },
      params: { id: 4 },
    });
    const array = await app.inject({ url: '/probe/4?n=3&n=4' });
    assert.equal(array.statusCode, 400);
  } finally {
    await app.close();
  }
});
