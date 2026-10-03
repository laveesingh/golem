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
  // The fixture holds two lineages: a stranded submit with no consequence
  // and a live submit followed by accepted and settled for one envelope.
  const submits = scenario.events.filter(
    (event) => event.operation === 'typed-submit',
  );
  assert.equal(submits.length, 2);
  assert.notEqual(submits[0].fields.envelope_id, submits[1].fields.envelope_id);
  const liveSymbol = submits[1].fields.envelope_id;
  assert.ok(
    scenario.events.some(
      (event) =>
        event.operation === 'typed-accepted' &&
        event.fields.envelope_id === liveSymbol,
    ),
  );
  assert.ok(
    scenario.events.some(
      (event) =>
        event.operation === 'typed-settled' &&
        event.fields.envelope_id === liveSymbol,
    ),
  );
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
  // Seed mirrors the fixture: E1 stranded with a dead publishing owner and
  // a pre-acceptance claim, E2 a fresh live dispatch. Separate envelopes.
  const offlineSession = 's4-stranded-session';
  const liveSession = 's4-live-session';
  const strandedTicket = tracker.createTicket({
    project_id: 's4-restart-000000',
    title: 'stranded',
    created_by: 'test',
  });
  const strandedQueued = tracker.queueDispatch(strandedTicket.id, {
    session_id: offlineSession,
    payload: 'strand',
    actor: 'test',
  });
  const stranded = tracker.getEnvelope(strandedQueued.envelope_id);
  tracker.claimQueuePublishing(strandedQueued.id, { ownerToken: 'dead-owner' });
  tracker.enqueueEnvelopeRetry(stranded.id, {
    session_id: offlineSession,
    content: 'strand',
    settlement: { queue: { id: strandedQueued.id, owner_token: 'dead-owner' } },
    require_typed: true,
  });
  tracker.recordTypedEnvelopeLifecycle(stranded.id, {
    state: 'claimed',
    attempt_id: 'dead-owner',
  });
  tracker
    .raw()
    .prepare(
      "UPDATE dispatch_queue SET publishing_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    )
    .run(strandedQueued.id);
  const liveTicket = tracker.createTicket({
    project_id: 's4-restart-000000',
    title: 'live',
    created_by: 'test',
  });
  const liveQueued = tracker.queueDispatch(liveTicket.id, {
    session_id: liveSession,
    payload: 'live',
    actor: 'test',
  });
  const liveEnvelope = tracker.getEnvelope(liveQueued.envelope_id);
  tracker.claimQueuePublishing(liveQueued.id, { ownerToken: 'dead-owner' });
  tracker.enqueueEnvelopeRetry(liveEnvelope.id, {
    session_id: liveSession,
    content: 'live',
    settlement: { queue: { id: liveQueued.id, owner_token: 'dead-owner' } },
    require_typed: true,
  });
  tracker.recordTypedEnvelopeLifecycle(liveEnvelope.id, {
    state: 'claimed',
    attempt_id: 'dead-owner',
  });
  tracker
    .raw()
    .prepare(
      "UPDATE dispatch_queue SET publishing_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    )
    .run(liveQueued.id);
  // The live session appears only after the restart, like the run where
  // nothing was delivered before the dashboard came back.
  let liveOnline = false;
  const sessions = () =>
    liveOnline
      ? [{ session_id: liveSession, alive: true, status: 'idle' }]
      : [];
  // The offline session is never advertised, so the stranded row is held,
  // never pushed: any other target is a test bug, not a retry.
  let publishes = 0;
  const startDrainer = () =>
    initDispatchDrainer({
      tracker,
      state: { nativeSessions: sessions },
      chat: { record: () => {} },
      pushBrief: async (_content, sessionId, metadata) => {
        assert.equal(sessionId, liveSession);
        publishes += 1;
        return {
          ok: true,
          status: 202,
          typed_worker: true,
          body: JSON.stringify({
            accepted: true,
            envelope_id: metadata.envelope_id,
            attempt_id: metadata.attempt_id,
            accepted_attempt_id: metadata.attempt_id,
            delivery_state: 'settled',
          }),
        };
      },
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [
        { session_id: liveSession, kind: 'typed-worker', delivery_ready: true },
      ],
      clock,
    });
  const queueState = (id) =>
    tracker
      .raw()
      .prepare('SELECT status FROM dispatch_queue WHERE id = ?')
      .get(id).status;
  const queueOwner = (id) =>
    tracker
      .raw()
      .prepare('SELECT publishing_owner FROM dispatch_queue WHERE id = ?')
      .get(id).publishing_owner;
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        if (await predicate()) return;
      } catch {}
      if (Date.now() > deadline) throw new Error(`${label} timed out`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  // First incarnation: both sessions offline, so clock ticks hold every row
  // and publish nothing. The stranded lineage is preserved, as recorded.
  const first = startDrainer();
  clock.advance(6000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(publishes, 0);
  assert.equal(tracker.getEnvelope(stranded.id).delivery_state, 'claimed');
  assert.equal(tracker.getEnvelope(liveEnvelope.id).delivery_state, 'claimed');
  // Kill: closing the drainer cancels its clock timer, so advancing time
  // fires nothing and changes nothing.
  first.close();
  clock.advance(6000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(publishes, 0);
  // Restart: the live session appears. Its stale dead-owner claim is
  // reconciled back to pending and republished to settled; the stranded
  // row stays held for its still-offline session, never delivered.
  liveOnline = true;
  const second = startDrainer();
  try {
    clock.advance(6000);
    await waitFor(async () => publishes === 1, 'live publish');
    await waitFor(
      async () =>
        tracker.getEnvelope(liveEnvelope.id).delivery_state === 'settled',
      'live settled',
    );
    assert.equal(queueState(liveQueued.id), 'delivered');
    assert.notEqual(queueOwner(liveQueued.id), 'dead-owner');
    assert.equal(tracker.getEnvelope(stranded.id).delivery_state, 'claimed');
    assert.notEqual(queueState(strandedQueued.id), 'delivered');
    assert.equal(publishes, 1);
  } finally {
    second.close();
  }
  assert.ok(
    Date.now() - wallStart < 1000,
    'restart reconciliation stays under one wall second',
  );
  tracker.raw().close();
  if (previousHome === undefined) delete process.env.GOLEM_HOME;
  else process.env.GOLEM_HOME = previousHome;
});
