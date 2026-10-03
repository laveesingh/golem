// S4: four recorded scenarios replay through test/sim on the test clock.
// Fixtures are committed scrubbed recordings (test/fixtures/scenarios/);
// no git, no network, no live profile is touched. Each test drives the real
// delivery code the scenario covers, so breaking that code fails the test
// (one mutation per scenario was checked during development and reverted).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { test } from 'vitest';
import { createTestClock } from '../../lib/clock.ts';
import {
  ScenarioEvent,
  ScenarioFixture,
  ScenarioSource,
} from '../../lib/contracts/scenario.ts';
import { readScenarioFile } from '../../lib/scenario-io.ts';
import { validateScenario } from '../../lib/scenario-scrub-core.ts';
import {
  acceptTypedDelivery,
  claimTypedDelivery,
  normalizeTypedWorkerInbox,
  settleTypedDelivery,
} from '../../lib/typed-worker-endpoint.js';

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const fixture = (name) =>
  path.join(repo, 'test', 'fixtures', 'scenarios', name);
const load = (name) => validateScenario(readScenarioFile(fixture(name)));
const ajv = new Ajv();
const matchFixture = ajv.compile(ScenarioFixture);
for (const name of [
  'typed-brief-accepted-settled.json',
  'claude-dispatch-ack-return.json',
  'herdr-worker-lifecycle.json',
  'dashboard-restart-stranded-envelope.json',
]) {
  test(`scenario fixture ${name} validates against the C1 contract`, () => {
    const raw = JSON.parse(fs.readFileSync(fixture(name), 'utf8'));
    assert.equal(matchFixture(raw), true);
    assert.ok(
      [ScenarioEvent, ScenarioSource].every(
        (schema) => typeof schema.$id === 'string',
      ),
    );
  });
}
const simDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-s4-sim-'));
  fs.chmodSync(dir, 0o700);
  return dir;
};
function invokeSim(harness, args, scenario, dir) {
  return spawnSync(
    process.execPath,
    [path.join(repo, 'test', 'sim', harness), ...args],
    {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        GOLEM_SIM_SCENARIO: scenario,
        GOLEM_SIM_STATE_DIR: dir,
      },
    },
  );
}
const operations = (scenario) =>
  scenario.events.map((event) => event.operation);

test('typed brief accepted and settled replays on the test clock', () => {
  const scenario = load('typed-brief-accepted-settled.json');
  assert.equal(scenario.source.harness, 'pi');
  const envelope = scenario.events.find(
    (event) => event.operation === 'typed-submit',
  )?.fields.envelope_id;
  assert.match(envelope, /^\$envelope:1$/);
  assert.ok(operations(scenario).includes('typed-accepted'));
  assert.ok(operations(scenario).includes('typed-settled'));
  // The recorded pi invocation replays through the simulator binary.
  const dir = simDir();
  const ext = path.join(dir, 'ext.ts');
  const done = invokeSim(
    'pi',
    [
      '--mode',
      'rpc',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--extension',
      ext,
      '--provider',
      'opencode-go',
      '--model',
      'muse-spark-test',
    ],
    fixture('typed-brief-accepted-settled.json'),
    dir,
  );
  assert.equal(done.status, 0);
  assert.equal(
    invokeSim(
      'pi',
      ['--version'],
      fixture('typed-brief-accepted-settled.json'),
      dir,
    ).status,
    2,
  );
  // The covered delivery path runs on the injected clock, not wall time.
  const clock = createTestClock(1_700_000_000_000);
  const inbox = normalizeTypedWorkerInbox();
  const body = {
    envelope_id: 's4-typed-1',
    target_session_id: 's4-session',
    sender_session_id: 's4-sender',
    kind: 'brief',
    created_at: new Date(clock.now()).toISOString(),
    expires_at: new Date(clock.now() + 60_000).toISOString(),
    attempt_id: 's4-attempt-1',
  };
  const claimed = claimTypedDelivery(inbox, body, { clock });
  assert.equal(claimed.delivery.lifecycle_state, 'claimed');
  const accepted = acceptTypedDelivery(inbox, body.envelope_id, {
    clock,
    turnId: 's4-turn',
  });
  assert.equal(accepted.delivery.lifecycle_state, 'accepted');
  clock.advance(30_000);
  const settled = settleTypedDelivery(inbox, body.envelope_id, { clock });
  assert.equal(settled.delivery.lifecycle_state, 'settled');
  assert.equal(inbox.in_flight_envelope_id, null);
});

test('claude dispatch acked and returned replays the recorded argv', () => {
  const scenario = load('claude-dispatch-ack-return.json');
  assert.equal(scenario.source.harness, 'claudecode');
  const returned = scenario.events.filter(
    (event) => event.operation === 'mcp-return',
  );
  assert.ok(
    returned.some(
      (event) =>
        event.fields.state === 'acknowledged' && event.fields.ok === true,
    ),
  );
  assert.ok(
    returned.some(
      (event) => event.fields.state === 'returned' && event.fields.ok === true,
    ),
  );
  const dir = simDir();
  const done = invokeSim(
    'claude',
    [
      '--model',
      'claude-haiku-test',
      '--mcp-config',
      path.join(dir, 'mcp.json'),
      '--strict-mcp-config',
      '--settings',
      path.join(dir, 'settings.json'),
      '--dangerously-load-development-channels',
      'server:golem',
      '--allowedTools',
      'mcp__golem__ack mcp__golem__ticket_comment',
    ],
    fixture('claude-dispatch-ack-return.json'),
    dir,
  );
  assert.equal(done.status, 0);
  // The covered ack path correlates the envelope to the calling session.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-s4-ack-'));
  const previousHome = process.env.GOLEM_HOME;
  process.env.GOLEM_HOME = home;
  return import('../../dashboard/server/tracker-db.js').then(
    ({ openTrackerDb }) => {
      const tracker = openTrackerDb(path.join(home, 'tracker.db'));
      try {
        const envelope = tracker.createControlEnvelope({
          sender_id: 's4-human',
          recipient_session_id: 's4-claude',
          kind: 'brief',
          payload: { content: 's4' },
        });
        const acked = tracker.acknowledgeEnvelope(envelope.id, {
          target_session_id: 's4-claude',
          kind: 'brief',
          summary: 's4 ack',
        });
        assert.ok(acked.acknowledged_at);
        assert.throws(
          () =>
            tracker.acknowledgeEnvelope(envelope.id, {
              target_session_id: 's4-other',
              kind: 'brief',
              summary: 'x',
            }),
          /does not match/,
        );
      } finally {
        tracker.raw().close();
      }
      if (previousHome === undefined) delete process.env.GOLEM_HOME;
      else process.env.GOLEM_HOME = previousHome;
    },
  );
});

test('herdr worker lifecycle replays through the driver and simulator', async () => {
  const scenario = load('herdr-worker-lifecycle.json');
  const spawns = scenario.events.filter(
    (event) => event.operation === 'process-spawn',
  );
  assert.equal(spawns.length, 7);
  assert.ok(
    scenario.events.every((event) => event.operation !== 'process-stdin'),
  );
  process.env.GOLEM_SIM_SCENARIO = fixture('herdr-worker-lifecycle.json');
  process.env.GOLEM_SIM_STATE_DIR = simDir();
  process.env.GOLEM_HERDR_BIN = path.join(repo, 'test', 'sim', 'herdr');
  process.env.GOLEM_HERDR_SESSION = 's4-replay-session';
  const driver = await import('../../lib/herdr-driver.js');
  try {
    const created = driver.workspaceCreate({
      session: 's4-replay-session',
      label: 's4-test',
    });
    assert.equal(created.workspace_id, 'sim-524-workspace-1');
    const tab = driver.tabCreate({
      session: 's4-replay-session',
      workspaceId: created.workspace_id,
      label: 's4-worker',
    });
    assert.equal(tab.pane.pane_id, 'sim-524-pane-2');
    const empty = driver.agentList({ session: 's4-replay-session' });
    assert.deepEqual(empty, []);
    assert.equal(
      driver.paneRun({
        session: 's4-replay-session',
        paneId: tab.pane.pane_id,
        command: ['echo', 'hi'],
      }),
      true,
    );
    assert.deepEqual(driver.agentList({ session: 's4-replay-session' }), []);
    assert.equal(
      driver.paneClose({
        session: 's4-replay-session',
        paneId: tab.pane.pane_id,
      }),
      true,
    );
    assert.equal(driver.sessionStop('s4-replay-session'), true);
    assert.throws(() => driver.workspaceList('s4-replay-session'), /simulator/);
  } finally {
    delete process.env.GOLEM_SIM_SCENARIO;
    delete process.env.GOLEM_SIM_STATE_DIR;
    delete process.env.GOLEM_HERDR_BIN;
    delete process.env.GOLEM_HERDR_SESSION;
  }
});

test('restart reconciles the stranded envelope on the test clock in under a wall second', async () => {
  const scenario = load('dashboard-restart-stranded-envelope.json');
  assert.ok(operations(scenario).includes('typed-submit'));
  assert.ok(operations(scenario).includes('typed-accepted'));
  const dir = simDir();
  const ext = path.join(dir, 'ext.ts');
  const replayed = invokeSim(
    'pi',
    [
      '--mode',
      'rpc',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--extension',
      ext,
      '--provider',
      'opencode-go',
      '--model',
      'muse-spark-test',
    ],
    fixture('dashboard-restart-stranded-envelope.json'),
    dir,
  );
  assert.equal(replayed.status, 143);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-s4-restart-'));
  const previousHome = process.env.GOLEM_HOME;
  process.env.GOLEM_HOME = home;
  const { openTrackerDb } = await import(
    '../../dashboard/server/tracker-db.js'
  );
  const { initDispatchDrainer } = await import(
    '../../dashboard/server/dispatch-queue.js'
  );
  const tracker = openTrackerDb(path.join(home, 'tracker.db'));
  const wallStart = Date.now();
  const clock = createTestClock(1_700_000_000_000);
  const ticket = tracker.createTicket({
    project_id: 's4-restart-000000',
    title: 'stranded',
    created_by: 'test',
  });
  const sessionId = 's4-restart-session';
  const queued = tracker.queueDispatch(ticket.id, {
    session_id: sessionId,
    payload: 'strand',
    actor: 'test',
  });
  const envelope = tracker.getEnvelope(queued.envelope_id);
  tracker.claimQueuePublishing(queued.id, { ownerToken: 'dead-owner' });
  tracker.enqueueEnvelopeRetry(envelope.id, {
    session_id: sessionId,
    content: 'strand',
    settlement: { queue: { id: queued.id, owner_token: 'dead-owner' } },
    require_typed: true,
  });
  tracker.recordTypedEnvelopeLifecycle(envelope.id, {
    state: 'claimed',
    attempt_id: 'dead-owner',
  });
  tracker
    .raw()
    .prepare(
      "UPDATE dispatch_queue SET publishing_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    )
    .run(queued.id);
  let publishes = 0;
  const drainer = initDispatchDrainer({
    tracker,
    state: {
      nativeSessions: () => [
        { session_id: sessionId, alive: true, status: 'idle' },
      ],
    },
    chat: { record: () => {} },
    pushBrief: async () => {
      publishes += 1;
      return {
        ok: true,
        status: 202,
        typed_worker: true,
        body: JSON.stringify({
          accepted: true,
          envelope_id: envelope.id,
          attempt_id: 'dead-owner',
          accepted_attempt_id: 'dead-owner',
          delivery_state: 'accepted',
        }),
      };
    },
    buildDispatchBrief: () => 'strand',
    broadcastWS: () => {},
    listChannels: async () => [
      { session_id: sessionId, kind: 'typed-worker', delivery_ready: true },
    ],
    clock,
    nowMs: () => clock.now(),
  });
  try {
    await drainer.tick();
  } finally {
    drainer.close();
  }
  assert.equal(publishes, 1);
  clock.advance(61 * 60_000);
  assert.ok(
    Date.now() - wallStart < 1000,
    'restart reconciliation stays under one wall second',
  );
  tracker.raw().close();
  if (previousHome === undefined) delete process.env.GOLEM_HOME;
  else process.env.GOLEM_HOME = previousHome;
});
