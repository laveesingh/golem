import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SCENARIOS } from '../../tools/scenario-format.ts';
import {
  argvSlots,
  scrubScenario,
  validateScenario,
} from '../../tools/scenario-scrub-core.ts';
import {
  processTransaction,
  scenario,
  typedCandidate,
} from '../sim/scenario-fixture.mjs';

test('synthetic scrubbing removes private content and retains stable identity structure', () => {
  const clean = scrubScenario(typedCandidate());
  assert.deepEqual(validateScenario(clean), clean);
  assert.equal(
    clean.events[0].fields.envelope_id,
    clean.events[1].fields.envelope_id,
  );
  assert.equal(clean.events[0].fields.content, '<redacted:content>');
  assert.equal(clean.events[0].fields.body, '<redacted:body>');
  for (const key of ['credentials', 'env', 'username'])
    assert.equal(Object.hasOwn(clean.events[0].fields, key), false);
  const text = JSON.stringify(clean);
  for (const privateValue of [
    'private-fixture',
    '/Users/',
    'synthetic-person',
    'synthetic-token',
    'synthetic-credential',
    'synthetic prompt secret',
    'synthetic file contents',
  ])
    assert.equal(text.includes(privateValue), false);
  assert.throws(() => validateScenario(typedCandidate()), /not canonical/);
});

for (const name of SCENARIOS) {
  test(`closed identity ${name} supports only pinned or explicitly synthetic source metadata`, () => {
    const input = scenario(
      processTransaction('herdr', ['--version'], { recipe: 'version' }),
    );
    input.scenario = name;
    input.source.harness_version = '0.9.1';
    input.source.golem_version = '5.26.0';
    assert.deepEqual(validateScenario(input), input);
    input.source.golem_version = 'synthetic';
    assert.throws(() => validateScenario(input), /source version/);
  });
}

const corruptions = [
  [
    'schema',
    (s) => {
      s.schema = 2;
    },
  ],
  [
    'unknown scenario',
    (s) => {
      s.scenario = 'unknown';
    },
  ],
  [
    'unknown source',
    (s) => {
      s.source.harness = 'unknown';
    },
  ],
  [
    'unpinned version',
    (s) => {
      s.source.harness_version = 'uncertain';
    },
  ],
  [
    'unknown field',
    (s) => {
      s.events[0].fields.unknown_private_payload = 'synthetic secret';
    },
  ],
  [
    'prototype key',
    (s) => {
      s.events[0].fields.constructor = 'synthetic secret';
    },
  ],
  [
    'wrong direction',
    (s) => {
      s.events[0].direction = 'out';
    },
  ],
  [
    'wrong boundary',
    (s) => {
      s.events[0].boundary = 'process';
    },
  ],
  [
    'sequence gap',
    (s) => {
      s.events[1].seq = 10;
    },
  ],
  [
    'negative time',
    (s) => {
      s.events[1].at_ms = -1;
    },
  ],
  [
    'zero PID',
    (s) => {
      s.events[0].fields.pid = 0;
    },
  ],
  [
    'port range',
    (s) => {
      s.events[0].fields.port = 65536;
    },
  ],
  [
    'relative path',
    (s) => {
      s.events[0].fields.path = 'relative';
    },
  ],
  [
    'mixed symbolic class',
    (s) => {
      s.events[1].fields.envelope_id = '$envelope:1';
    },
  ],
  [
    'unknown enum',
    (s) => {
      s.events[1].fields.state = 'unknown-private-state';
    },
  ],
  [
    'oversized fields',
    (s) => {
      s.events[0].fields = Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [`field${i}`, true]),
      );
    },
  ],
];
for (const [label, mutate] of corruptions)
  test(`${label} is rejected without disclosing the sentinel`, () => {
    const input = typedCandidate();
    mutate(input);
    let failure;
    try {
      scrubScenario(input);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.equal(failure.message.includes('synthetic secret'), false);
  });

for (const argv of [
  ['--cwd', '$session:1'],
  ['<redacted:argv>'],
  ['$path:1'],
  ['--cwd'],
  ['--label'],
  ['--provider'],
  ['--session', '<redacted:argv>'],
  ['workspace', 'close', '<redacted:argv>'],
  ['--print', '<redacted:label>'],
  ['--unknown-private-flag'],
  ['workspace', 'rename', '$workspace:1'],
  ['pane', 'run', '$pane:1'],
])
  test(`raw and canonical argv reject malformed slots ${JSON.stringify(argv)}`, () => {
    const input = scenario(processTransaction('herdr', argv));
    assert.throws(() => scrubScenario(input));
    assert.throws(() => validateScenario(input));
  });

test('shared argv grammar keeps typed values, print/stdin and inert explicit payload distinct', () => {
  assert.deepEqual(argvSlots(['--cwd', '$path:1']), [
    { kind: 'literal' },
    { kind: 'symbol', type: 'path' },
  ]);
  validateScenario(
    scenario(
      processTransaction('claudecode', ['--print', '<redacted:prompt>']),
    ),
  );
  validateScenario(scenario(processTransaction('claudecode', ['--print'])));
  const input = scenario(
    processTransaction('herdr', ['--', '<redacted:argv>']),
  );
  validateScenario(input);
  const raw = scenario(processTransaction('herdr', ['--', '$workspace:9999']));
  assert.throws(() => scrubScenario(raw), /value kind/);
});

test('exit has one code or signal, never contradictory metadata', () => {
  const input = scenario(
    processTransaction('pi', ['--version'], {
      recipe: 'version',
      signal: 'SIGTERM',
    }),
  );
  validateScenario(input);
  input.events.at(-1).fields.exit_code = 0;
  assert.throws(() => validateScenario(input), /exactly one/);
});
