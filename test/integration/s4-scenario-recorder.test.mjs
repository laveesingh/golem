import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  createScenarioRecorder,
  recordScenarioProjection,
  tryRecordScenarioProjection,
} from '../../lib/scenario-recorder.ts';

const header = {
  schema: 1,
  scenario: 'typed-brief-accepted-settled',
  seed: 7,
  source: { harness: 'pi', harness_version: '0.99.1', golem_version: '5.26.1' },
};
const dir = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-s4-recorder-'));
  fs.chmodSync(root, 0o700);
  return root;
};

test('recorder orders projections and writes a scrubbed candidate', async () => {
  const root = dir();
  const broker = await createScenarioRecorder(
    path.join(root, 'candidate.json'),
    header,
  );
  assert.ok(broker.env.GOLEM_RECORD_SCENARIO);
  assert.ok(broker.env.GOLEM_RECORD_SOCKET);
  assert.ok(broker.env.GOLEM_RECORD_CAPABILITY);
  broker.record({
    boundary: 'typed-http',
    direction: 'in',
    operation: 'typed-submit',
    fields: {
      envelope_id: 'e1',
      session_id: 's1',
      attempt_id: 'a1',
      kind: 'brief',
    },
  });
  const scenario = await broker.close();
  assert.equal(scenario.events.length, 1);
  assert.equal(scenario.events[0].seq, 1);
  assert.equal(scenario.events[0].fields.envelope_id, '$envelope:1');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, 'candidate.json'), 'utf8'))
      .scenario,
    'typed-brief-accepted-settled',
  );
});

test('recorder rejects unsafe projections, empty runs, and bad paths', async () => {
  const root = dir();
  const broker = await createScenarioRecorder(
    path.join(root, 'candidate.json'),
    header,
  );
  assert.throws(() =>
    broker.record({
      boundary: 'typed-http',
      direction: 'in',
      operation: 'nope',
      fields: {},
    }),
  );
  await assert.rejects(() => broker.close(), /rejected|empty/);
  fs.writeFileSync(path.join(root, 'candidate.json'), '{}');
  await assert.rejects(
    () => createScenarioRecorder(path.join(root, 'candidate.json'), header),
    /already exists/,
  );
  await assert.rejects(
    () => createScenarioRecorder('relative.json', header),
    /absolute/,
  );
});

test('production seam helper never throws without a broker', async () => {
  const previous = { ...process.env };
  delete process.env.GOLEM_RECORD_SCENARIO;
  delete process.env.GOLEM_RECORD_SOCKET;
  delete process.env.GOLEM_RECORD_CAPABILITY;
  try {
    // Recorder off is a silent no-op: delivery continues.
    tryRecordScenarioProjection({
      boundary: 'typed-http',
      direction: 'out',
      operation: 'typed-accepted',
      fields: {
        envelope_id: 'e1',
        session_id: 's1',
        attempt_id: 'a1',
        state: 'accepted',
      },
    });
    assert.equal(
      await recordScenarioProjection({
        boundary: 'typed-http',
        direction: 'out',
        operation: 'typed-accepted',
        fields: {
          envelope_id: 'e1',
          session_id: 's1',
          attempt_id: 'a1',
          state: 'accepted',
        },
      }),
      undefined,
    );
    // Half-configured broker fails closed on the candidate, never delivery.
    process.env.GOLEM_RECORD_SCENARIO = path.join(dir(), 'candidate.json');
    process.env.GOLEM_RECORD_SOCKET = path.join(dir(), 'rec.sock');
    await assert.rejects(
      () =>
        recordScenarioProjection({
          boundary: 'typed-http',
          direction: 'out',
          operation: 'typed-accepted',
          fields: {
            envelope_id: 'e1',
            session_id: 's1',
            attempt_id: 'a1',
            state: 'accepted',
          },
        }),
      /incomplete/,
    );
  } finally {
    process.env = previous;
  }
});
