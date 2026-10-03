import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import Ajv from 'ajv';
import { runAgent } from '../../cli/agent.js';
import { runCollaboration } from '../../cli/collaboration.js';
import { runContext } from '../../cli/context.js';
import { runSession } from '../../cli/session.js';
import { runTeam } from '../../cli/team.js';
import { runTicket } from '../../cli/ticket.js';
import { cliSchemas } from '../../lib/contracts/cli.ts';
import { JsonValue } from '../../lib/contracts/pilot.ts';
import { parseCliEnvelope } from '../_cli-envelope.mjs';

const ajv = new Ajv().addSchema(JsonValue);
const validate = Object.fromEntries(
  Object.entries(cliSchemas).map(([key, schema]) => [key, ajv.compile(schema)]),
);
const options = {
  resolveContext: () => null,
  env: {},
  nativeSessions: [],
  herdr: { sessionList: () => [] },
  manager: { listAgentRoster: async () => ({ roster: [], ended: [] }) },
  client: {
    request: async () => [],
    listTickets: async () => [],
    getTicket: async () => ({ id: 'GOL-1', body: 'body' }),
  },
};
async function invoke(run, args) {
  const lines = [],
    errors = [];
  const code = await run(...args, {
    ...options,
    stdout: (text) => lines.push(text),
    stderr: (text) => errors.push(text),
  });
  assert.equal(lines.length, 1, errors.join('\n'));
  return { code, value: parseCliEnvelope(lines[0]) };
}
const families = [
  [
    'CliAgentResult',
    runAgent,
    ['agent', ['list', '--scope', 'all', '--json']],
    ['agent', ['bad', '--json']],
  ],
  [
    'CliTeamResult',
    runTeam,
    ['team', ['list', '--scope', 'all', '--json']],
    ['team', ['bad', '--json']],
  ],
  [
    'CliSessionResult',
    runSession,
    ['session', ['list', '--json']],
    ['session', ['bad', '--json']],
  ],
  ['CliContextResult', runContext, [['--json']], [['--json', '--bad']]],
  [
    'CliScheduleResult',
    runCollaboration,
    ['schedule', ['list', '--json']],
    ['schedule', ['bad', '--json']],
  ],
  [
    'CliMessageResult',
    runCollaboration,
    ['message', ['--help', '--json']],
    ['message', ['bad', '--json']],
  ],
  [
    'CliTicketResult',
    runTicket,
    [['get', 'GOL-1', '--json']],
    [['bad', '--json']],
  ],
];
for (const [schema, run, success, error] of families) {
  for (const [args, expected] of [
    [success, true],
    [error, false],
  ]) {
    const result = await invoke(run, args);
    assert.equal(
      result.value.ok,
      expected,
      `${schema}: ${JSON.stringify(result)}`,
    );
    assert.equal(
      validate[schema](result.value),
      true,
      JSON.stringify(validate[schema].errors),
    );
    assert.equal(result.code, expected ? 0 : 2);
  }
}
// Parse and validation errors emit the C3 error envelope whenever --json
// appears anywhere in argv, in either flag ordering. All cases below throw
// during parsing, before any mutation or transport, and keep their exits.
const parseErrors = [
  [
    'CliAgentResult',
    runAgent,
    'agent',
    2,
    ['list', '--bad', '--json'],
    ['list', '--json', '--bad'],
    ['list', '--scope', '--json'],
    ['list', '--json', '--scope'],
  ],
  [
    'CliTeamResult',
    runTeam,
    'team',
    2,
    ['list', '--bad', '--json'],
    ['list', '--json', '--bad'],
    ['list', '--project', '--json'],
    ['list', '--json', '--project'],
  ],
  [
    'CliSessionResult',
    runSession,
    'session',
    2,
    ['list', '--bad', '--json'],
    ['list', '--json', '--bad'],
    ['list', '--project', '--json'],
    ['list', '--json', '--project'],
  ],
  [
    'CliContextResult',
    runContext,
    null,
    2,
    ['--bad', '--json'],
    ['--json', '--bad'],
    ['--project', '--json'],
    ['--json', '--project'],
  ],
  [
    'CliScheduleResult',
    runCollaboration,
    'schedule',
    2,
    ['list', '--bad', '--json'],
    ['list', '--json', '--bad'],
  ],
  [
    'CliMessageResult',
    runCollaboration,
    'message',
    2,
    ['bad', '--json'],
    ['inspect', '--json'],
  ],
];
for (const [schema, run, family, exit, ...variants] of parseErrors) {
  for (const argv of variants) {
    const args = family === null ? [argv] : [family, argv];
    const result = await invoke(run, args);
    assert.equal(result.value.ok, false, `${schema}: ${JSON.stringify(argv)}`);
    assert.equal(
      validate[schema](result.value),
      true,
      JSON.stringify(validate[schema].errors),
    );
    assert.equal(result.code, exit, `${schema}: ${JSON.stringify(argv)}`);
  }
}
// Notify missing values throw before any mutation, in either ordering.
for (const argv of [
  ['notify', '--to', '--json'],
  ['notify', '--json', '--to'],
]) {
  const result = await invoke(runCollaboration, ['agent', argv]);
  assert.equal(result.value.ok, false);
  assert.equal(
    validate.CliAgentResult(result.value),
    true,
    JSON.stringify(validate.CliAgentResult.errors),
  );
  assert.equal(result.code, 2);
}
// Ticket errors always emit the envelope: unknown flag (exit 1, both
// orders), missing value (exit 1), missing positional (exit 2).
for (const [argv, exit] of [
  [['get', '--bad', '--json'], 1],
  [['get', '--json', '--bad'], 1],
  [['get', 'GOL-1', '--project'], 1],
  [['get', '--json'], 2],
]) {
  const result = await invoke(runTicket, [argv]);
  assert.equal(result.value.ok, false, JSON.stringify(argv));
  assert.equal(
    validate.CliTicketResult(result.value),
    true,
    JSON.stringify(validate.CliTicketResult.errors),
  );
  assert.equal(result.code, exit, JSON.stringify(argv));
}
// An actual message receipt, not only the help variant.
const message = {
  kind: 'message',
  id: 'message-id',
  state: 'accepted',
  protocol_version: 1,
};
options.client.request = async () => message;
const inspected = await invoke(runCollaboration, [
  'message',
  ['inspect', message.id, '--json'],
]);
assert.equal(inspected.value.ok, true);
assert.equal(
  validate.CliMessageResult(inspected.value),
  true,
  JSON.stringify(validate.CliMessageResult.errors),
);
const roles = await invoke(runAgent, ['agent', ['role', 'list', '--json']]);
assert.equal(roles.value.ok, true);
assert.ok(roles.value.items.length);
const tickets = await invoke(runTicket, [
  ['list', '--project', 'fixture-abcdef', '--json'],
]);
assert.deepEqual(tickets.value.items, []);
// Help remains JSON for every command family even before parsing selectors.
for (const [, run, success] of families) {
  const args =
    run === runContext || run === runTicket
      ? [['--help', '--json']]
      : [success[0], ['--help', '--json']];
  const result = await invoke(run, args);
  assert.equal(result.value.ok, true);
  assert.equal(typeof result.value.help, 'string');
}
async function status(url, argv = ['--json']) {
  let stdout = '',
    stderr = '';
  const child = spawn(process.execPath, ['cli/golem.js', 'status', ...argv], {
    env: { ...process.env, GOLEM_DASHBOARD_URL: url },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (bytes) => {
    stdout += bytes;
  });
  child.stderr.on('data', (bytes) => {
    stderr += bytes;
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, stderr); // status exit semantics are unchanged.
  const value = parseCliEnvelope(stdout);
  assert.equal(
    validate.CliStatusResult(value),
    true,
    JSON.stringify(validate.CliStatusResult.errors),
  );
  return value;
}
const server = http.createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, project_count: 0 }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
  assert.equal((await status(url)).ok, true);
  // status ignores unknown flags; the envelope holds in either ordering.
  for (const argv of [
    ['--bad', '--json'],
    ['--json', '--bad'],
  ]) {
    const value = await status(url, argv);
    assert.equal(value.ok, true);
    assert.equal(value.dashboard_healthy, true);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
assert.equal((await status(url)).dashboard_healthy, false);
console.log(
  'CLI envelope: eight families success + error, arrays, help and status passed',
);
