import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initDispatchDrainer } from '../dashboard/server/dispatch-queue.js';
import { openTrackerDb } from '../dashboard/server/tracker-db.js';
import {
  acceptTypedDelivery,
  claimTypedDelivery,
  closeTypedWorkerEndpoint,
  getTypedDelivery,
  interruptTypedDelivery,
  normalizeTypedWorkerInbox,
  parseTypedDeliveryResponse,
  releaseTypedDeliveryClaim,
  requireTypedDeliveryRecovery,
  settleTypedDelivery,
  startTypedWorkerEndpoint,
  TYPED_WORKER_PROTOCOL_VERSION,
  typedDeliveryResult,
} from '../lib/typed-worker-endpoint.js';
import {
  countTypedDeliveryRejections,
  countTypedDeliveryTombstones,
  pruneTypedDeliveryTombstones,
  readTypedDeliveryTombstone,
  retireTypedDeliveryTombstones,
  upsertTypedDeliveryTombstone,
} from '../lib/typed-delivery-tombstones.js';
import { recordTypedEnvelopeOutcome } from '../dashboard/server/typed-delivery.js';

const canonicalId = 'typed-worker-journey';
const ownerToken = 'typed-worker-owner-token';
let inbox = normalizeTypedWorkerInbox();
const tombstoneTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-typed-tombstones-'));
const tombstoneFile = path.join(tombstoneTemp, 'typed-delivery-tombstones.db');

function envelope(envelope_id, content, overrides = {}) {
  const created_at = overrides.created_at ?? new Date().toISOString();
  return {
    protocol_version: TYPED_WORKER_PROTOCOL_VERSION,
    envelope_id,
    content,
    target_session_id: canonicalId,
    kind: 'ticket_dispatch',
    created_at,
    expires_at: overrides.expires_at ?? new Date(Date.parse(created_at) + 60_000).toISOString(),
    attempt_id: overrides.attempt_id ?? `attempt-${envelope_id}`,
    ...overrides,
  };
}

async function accept(envelope) {
  const claim = claimTypedDelivery(inbox, envelope, {
    lookupTombstone: (envelopeId) => readTypedDeliveryTombstone(canonicalId, envelopeId, { file: tombstoneFile }),
  });
  if (claim.fenced) {
    return {
      ok: false, accepted: false, http_status: 409, legacy_replay_fenced: true,
      error: 'legacy typed replay history is fenced; dashboard must atomically reissue the still-pending envelope',
    };
  }
  if (claim.duplicate) return typedDeliveryResult(claim.delivery, { duplicate: true, attemptId: envelope.attempt_id });
  if (claim.busy) return { ok: false, accepted: false, http_status: 409, error: 'worker is busy' };
  const { delivery } = acceptTypedDelivery(inbox, envelope.envelope_id, { turnId: `turn-${envelope.envelope_id}` });
  upsertTypedDeliveryTombstone(canonicalId, delivery, { file: tombstoneFile });
  return typedDeliveryResult(delivery, { httpStatus: 202, attemptId: envelope.attempt_id });
}

const endpoint = await startTypedWorkerEndpoint({
  canonicalId,
  ownerToken,
  deliveryReady: () => !inbox.in_flight_envelope_id,
  acceptDelivery: accept,
  maxBodyBytes: 512,
});
const base = `http://${endpoint.host}:${endpoint.port}`;

async function post(envelope, { owner = ownerToken, sender = 'dashboard' } = {}) {
  const response = await fetch(`${base}/brief`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sender': sender,
      'x-golem-target-session': canonicalId,
      'x-golem-endpoint-owner': owner,
    },
    body: JSON.stringify(envelope),
  });
  return { response, body: await response.json() };
}

try {
  const health = await fetch(`${base}/healthz?session_id=${canonicalId}&owner_token=${ownerToken}`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).delivery_ready, true);
  assert.equal((await fetch(`${base}/healthz?session_id=${canonicalId}&owner_token=wrong`)).status, 404, 'health does not disclose a stale owner lease');

  const rejected = await post({ envelope_id: 'bad-auth', content: 'x' }, { owner: 'wrong' });
  assert.equal(rejected.response.status, 403, 'stale endpoint owner cannot publish');

  const missingVersion = await post({ ...envelope('missing-version', 'x'), protocol_version: undefined });
  assert.equal(missingVersion.response.status, 400, 'typed envelopes must name the supported protocol version');

  const missingTarget = await post({ ...envelope('missing-target', 'x'), target_session_id: undefined });
  assert.equal(missingTarget.response.status, 400, 'typed envelopes require their canonical target');
  const expired = await post(envelope('expired', 'x', { created_at: new Date(Date.now() - 120_000).toISOString(), expires_at: new Date(Date.now() - 60_000).toISOString() }));
  assert.equal(expired.response.status, 400, 'expired typed envelopes never reach the native adapter');

  const oversized = await post({ envelope_id: 'too-large', content: 'x'.repeat(512) });
  assert.equal(oversized.response.status, 400, 'oversized envelopes are rejected before adapter delivery');

  const firstEnvelope = envelope('first', 'first message');
  const first = await post(firstEnvelope);
  assert.equal(first.response.status, 202);
  assert.equal(first.body.delivery_state, 'accepted');
  assert.equal(inbox.deliveries[0].lifecycle_state, 'accepted');

  // Simulate a lost response: the native turn has accepted attempt A, while
  // the shared queue repeats the immutable envelope under current attempt B.
  const replay = await post({ ...firstEnvelope, content: 'different retry bytes', attempt_id: 'attempt-first-retry' });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.duplicate, true, 'a duplicate envelope never creates a second turn');
  assert.equal(replay.body.attempt_id, 'attempt-first-retry', 'duplicate response correlates to the current retry attempt');
  assert.equal(replay.body.accepted_attempt_id, firstEnvelope.attempt_id, 'first acceptance lineage remains immutable across a lost-response retry');
  assert.ok(parseTypedDeliveryResponse({ typed_worker: true, body: JSON.stringify(replay.body) }, { envelopeId: firstEnvelope.envelope_id, attemptId: 'attempt-first-retry' }), 'the dashboard accepts the retry-correlated duplicate response');
  assert.equal(replay.body.turn_id, first.body.turn_id);

  const secondEnvelope = envelope('second', 'must wait');
  const busy = await post(secondEnvelope);
  assert.equal(busy.response.status, 409, 'a second FIFO delivery is held while the first is active');

  settleTypedDelivery(inbox, 'first', { turnId: first.body.turn_id, completionStatus: 'completed' });
  upsertTypedDeliveryTombstone(canonicalId, getTypedDelivery(inbox, 'first'), { file: tombstoneFile });
  assert.equal(inbox.in_flight_envelope_id, null);
  const second = await post({ ...secondEnvelope, content: 'second message' });
  assert.equal(second.response.status, 202, 'delivery resumes at the next idle boundary');
  interruptTypedDelivery(inbox, 'second', { turnId: second.body.turn_id, completionStatus: 'aborted' });
  upsertTypedDeliveryTombstone(canonicalId, getTypedDelivery(inbox, 'second'), { file: tombstoneFile });
  const interruptedReplay = await post({ ...secondEnvelope, content: 'retry must not run' });
  assert.equal(interruptedReplay.body.duplicate, true);
  assert.equal(interruptedReplay.body.delivery_state, 'interrupted', 'accepted interrupted work is not replayed');

  const recoveryEnvelope = envelope('recovery', 'outcome unknown');
  const recoveryClaim = claimTypedDelivery(inbox, recoveryEnvelope);
  requireTypedDeliveryRecovery(inbox, recoveryClaim.delivery.envelope_id, { error: 'transport outcome unknown' });
  assert.equal(inbox.deliveries.find((row) => row.envelope_id === 'recovery')?.lifecycle_state, 'recovery_required');

  const probeInbox = normalizeTypedWorkerInbox();
  const preaccept = envelope('released-before-accept', 'safe retry', { attempt_id: 'attempt-a' });
  claimTypedDelivery(probeInbox, preaccept);
  assert.equal(releaseTypedDeliveryClaim(probeInbox, preaccept.envelope_id, { attemptId: 'wrong' }).released, false, 'a delayed attempt cannot release another claim');
  assert.equal(releaseTypedDeliveryClaim(probeInbox, preaccept.envelope_id, { attemptId: 'attempt-a', error: 'native validation refused' }).released, true);
  const reclaimed = claimTypedDelivery(probeInbox, { ...preaccept, attempt_id: 'attempt-b' });
  assert.equal(reclaimed.duplicate, false, 'a synchronously refused pre-acceptance claim is replayable');
  acceptTypedDelivery(probeInbox, preaccept.envelope_id);
  settleTypedDelivery(probeInbox, preaccept.envelope_id);
  const claimedOnly = envelope('claimed-only', 'must accept first');
  claimTypedDelivery(probeInbox, claimedOnly);
  assert.throws(() => settleTypedDelivery(probeInbox, claimedOnly.envelope_id), /cannot settle from claimed/, 'the lifecycle graph rejects claimed-to-terminal shortcuts');
  releaseTypedDeliveryClaim(probeInbox, claimedOnly.envelope_id, { attemptId: claimedOnly.attempt_id });
  assert.equal(parseTypedDeliveryResponse({ typed_worker: true, body: JSON.stringify({ accepted: true, envelope_id: 'wrong', attempt_id: 'attempt-a', accepted_attempt_id: 'attempt-a', delivery_state: 'accepted' }) }, { envelopeId: 'expected', attemptId: 'attempt-a' }), null, 'typed acceptance is correlated to the expected envelope and attempt');

  for (let n = 0; n < 258; n += 1) {
    const old = envelope(`tombstone-${n}`, `old ${n}`);
    claimTypedDelivery(probeInbox, old);
    acceptTypedDelivery(probeInbox, old.envelope_id);
    settleTypedDelivery(probeInbox, old.envelope_id);
    upsertTypedDeliveryTombstone(canonicalId, getTypedDelivery(probeInbox, old.envelope_id), { file: tombstoneFile });
  }
  const oldReplay = claimTypedDelivery(probeInbox, envelope('tombstone-0', 'must never run twice'), {
    lookupTombstone: (envelopeId) => readTypedDeliveryTombstone(canonicalId, envelopeId, { file: tombstoneFile }),
  });
  assert.equal(oldReplay.duplicate, true, 'replay protection survives the bounded inspection history');
  assert.equal(oldReplay.delivery.lifecycle_state, 'settled');
  assert.equal(probeInbox.deliveries.length, 256, 'rich supervisor history stays bounded');
  assert.equal(countTypedDeliveryTombstones({ file: tombstoneFile }), 260, 'compact durable tombstones hold replay identity outside the JSON registry');
  assert.equal(pruneTypedDeliveryTombstones({ file: tombstoneFile, now: Date.now() + 120_000 }), 0, 'transport expiry alone never discards replay identity');
  const retainedIds = [
    'first',
    'second',
    ...Array.from({ length: 258 }, (_value, n) => `tombstone-${n}`),
  ];
  assert.equal(retireTypedDeliveryTombstones(canonicalId, retainedIds, { file: tombstoneFile }), 260, 'reclamation requires explicit tracker-authoritative envelope retirement');
  assert.equal(upsertTypedDeliveryTombstone(canonicalId, oldReplay.delivery, { file: tombstoneFile }), null, 'stale adapter JSON cannot reactivate a tracker-retired lineage');
  assert.equal(pruneTypedDeliveryTombstones({ file: tombstoneFile, now: Date.now() + 120_000 }), 260, 'retired compact tombstones are reclaimed without rewriting supervisor JSON');
  assert.equal(countTypedDeliveryTombstones({ file: tombstoneFile }), 0, 'reclaimed tombstone storage remains bounded by explicit terminal retirement');

  // A tracker can renew an unacknowledged lineage after the worker's original
  // HTTP reply was lost. Roll over rich history and simulate a worker restart:
  // retry B must still find immutable acceptance A after A's wire TTL passes.
  const lostResponseInbox = normalizeTypedWorkerInbox();
  const lostResponseEnvelope = envelope('lost-response-renewed-lineage', 'native turn starts once', {
    attempt_id: 'lost-response-attempt-a',
    expires_at: new Date(Date.now() + 1_000).toISOString(),
  });
  claimTypedDelivery(lostResponseInbox, lostResponseEnvelope);
  const { delivery: lostResponseAccepted } = acceptTypedDelivery(lostResponseInbox, lostResponseEnvelope.envelope_id, { turnId: 'native-turn-a' });
  upsertTypedDeliveryTombstone(canonicalId, lostResponseAccepted, { file: tombstoneFile });
  // The native turn can settle while its HTTP response is lost. Its immutable
  // acceptance tombstone remains required for the queue's later retry.
  const { delivery: lostResponseSettled } = settleTypedDelivery(lostResponseInbox, lostResponseEnvelope.envelope_id);
  upsertTypedDeliveryTombstone(canonicalId, lostResponseSettled, { file: tombstoneFile });
  for (let n = 0; n < 257; n += 1) {
    const rollover = envelope(`restart-rollover-${n}`, `rollover ${n}`);
    claimTypedDelivery(lostResponseInbox, rollover);
    acceptTypedDelivery(lostResponseInbox, rollover.envelope_id);
    settleTypedDelivery(lostResponseInbox, rollover.envelope_id);
  }
  assert.equal(getTypedDelivery(lostResponseInbox, lostResponseEnvelope.envelope_id), null, 'restart rollover removes the rich first-attempt inspection row');
  const renewedRetry = claimTypedDelivery(normalizeTypedWorkerInbox(), {
    ...lostResponseEnvelope,
    attempt_id: 'lost-response-attempt-b',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  }, {
    lookupTombstone: (envelopeId) => readTypedDeliveryTombstone(canonicalId, envelopeId, { file: tombstoneFile, now: Date.now() + 120_000 }),
  });
  assert.equal(renewedRetry.duplicate, true, 'lost-response → expiry → restart/rollover → tracker-renewed retry never starts a second native turn');
  assert.equal(renewedRetry.delivery.accepted_attempt_id, 'lost-response-attempt-a');

  // Durable tombstone state is monotonic: a stale JSON recovery row cannot
  // erase a terminal SQLite outcome written immediately before a crash.
  for (const terminalState of ['settled', 'interrupted', 'recovery_required']) {
    const envelopeId = `monotonic-${terminalState}`;
    upsertTypedDeliveryTombstone(canonicalId, {
      envelope_id: envelopeId, target_session_id: canonicalId, attempt_id: 'attempt-a', accepted_attempt_id: 'attempt-a',
      lifecycle_state: terminalState, expires_at: new Date(Date.now() + 60_000).toISOString(),
      accepted_at: new Date().toISOString(), [`${terminalState}_at`]: new Date().toISOString(),
    }, { file: tombstoneFile });
    upsertTypedDeliveryTombstone(canonicalId, {
      envelope_id: envelopeId, target_session_id: canonicalId, attempt_id: 'attempt-a', accepted_attempt_id: 'attempt-a',
      lifecycle_state: 'accepted', expires_at: new Date(Date.now() + 120_000).toISOString(), accepted_at: new Date().toISOString(),
    }, { file: tombstoneFile });
    assert.equal(readTypedDeliveryTombstone(canonicalId, envelopeId, { file: tombstoneFile })?.lifecycle_state, terminalState, `stale accepted JSON cannot regress ${terminalState}`);
  }

  const schemaTwo = normalizeTypedWorkerInbox({
    schema: 2,
    last_accepted_envelope_id: 'accepted-before-retained-history',
    deliveries: [
      { envelope_id: 'recent-only', target_session_id: canonicalId, attempt_id: 'recent-attempt', state: 'completed', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() },
    ],
  });
  const fenced = claimTypedDelivery(schemaTwo, envelope('accepted-before-retained-history', 'must be fenced', {
    created_at: '2000-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
  }));
  assert.equal(fenced.fenced, true, 'schema-2 replay identity older than retained history is fenced before native delivery');
  const { CodexSupervisor, CodexRpcServerRejection, readCodexSupervisor } = await import('../lib/codex-supervisor.js');
  const legacySupervisor = new CodexSupervisor({
    canonicalId: 'legacy-upgrade-worker',
    registryFile: path.join(tombstoneTemp, 'legacy-supervisors.json'),
    tombstoneFile,
  });
  legacySupervisor.migrateTypedDeliveryTombstones({
    schema: 2,
    deliveries: [{
      envelope_id: 'retained-schema-two-acceptance', target_session_id: 'legacy-upgrade-worker',
      attempt_id: 'schema-two-attempt', state: 'completed', created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }],
  });
  assert.equal(
    readTypedDeliveryTombstone('legacy-upgrade-worker', 'retained-schema-two-acceptance', { file: tombstoneFile })?.accepted_attempt_id,
    'schema-two-attempt',
    'supervisor upgrade migrates retained schema-2 acceptance lineage into durable tombstones before readiness',
  );
  upsertTypedDeliveryTombstone('legacy-upgrade-worker', {
    envelope_id: 'stale-json-after-settlement', target_session_id: 'legacy-upgrade-worker',
    attempt_id: 'attempt-a', accepted_attempt_id: 'attempt-a', lifecycle_state: 'settled',
    accepted_at: new Date().toISOString(), settled_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
  }, { file: tombstoneFile });
  legacySupervisor.migrateTypedDeliveryTombstones({
    schema: 5,
    deliveries: [{
      envelope_id: 'stale-json-after-settlement', target_session_id: 'legacy-upgrade-worker',
      attempt_id: 'attempt-a', state: 'started', lifecycle_state: 'accepted', accepted_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 120_000).toISOString(),
    }],
  });
  assert.equal(
    readTypedDeliveryTombstone('legacy-upgrade-worker', 'stale-json-after-settlement', { file: tombstoneFile })?.lifecycle_state,
    'settled',
    'supervisor recovery migration cannot regress a newer terminal tombstone from stale JSON',
  );

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-typed-worker-'));
  const priorGolemHome = process.env.GOLEM_HOME;
  process.env.GOLEM_HOME = path.join(temp, 'home');
  fs.mkdirSync(process.env.GOLEM_HOME, { recursive: true });
  const tracker = openTrackerDb(path.join(temp, 'tracker.db'));
  try {
    const { readEndpointLeases, releaseEndpointLeases, renewEndpointLease, upsertSessionFact } = await import(pathToFileURL(path.resolve('lib/session-facts.js')).href + `?typed=${Date.now()}`);
    const { readChannels } = await import(pathToFileURL(path.resolve('dashboard/server/channels.js')).href + `?typed=${Date.now()}`);
    renewEndpointLease({
      canonical_id: canonicalId,
      owner_token: ownerToken,
      host: endpoint.host,
      port: endpoint.port,
      kind: 'typed-worker',
      harness: 'pi',
    });
    const liveLease = (await readChannels()).find((channel) => channel.session_id === canonicalId);
    assert.equal(liveLease?.typed_worker, true, 'a versioned typed lease is discovered through the generic channel registry');
    assert.equal(liveLease?.delivery_ready, false, 'the live readiness gate reflects the adapter state without recording activity');
    assert.equal(Object.keys(liveLease).includes('owner_token'), false, 'the endpoint owner credential never leaks to a public channel row');
    upsertSessionFact({
      canonical_id: canonicalId,
      continuation_key: 'pi-native:typed-worker-journey',
      harness: 'pi',
      locator: { raw_session_id: canonicalId },
      status: 'idle',
      capabilities: { typed_worker: true, typed_worker_protocol: 1 },
    });
    releaseEndpointLeases(ownerToken, { canonicalId });
    assert.equal(readEndpointLeases({ includeExpired: true }).some((lease) => lease.canonical_id === canonicalId), false, 'a clean endpoint release removes only the live lease');

    const ticket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed lifecycle', created_by: 'test' });
    const envelope = tracker.createDispatchEnvelope(ticket.id, { session_id: canonicalId, actor: 'test' });
    const claimed = tracker.recordTypedEnvelopeLifecycle(envelope.id, { state: 'claimed', attempt_id: 'attempt-1' });
    assert.equal(claimed.delivery_state, 'claimed');
    const accepted = tracker.recordTypedEnvelopeLifecycle(envelope.id, { state: 'accepted', attempt_id: 'attempt-1' });
    assert.equal(accepted.delivery_state, 'accepted');
    const settled = tracker.recordTypedEnvelopeLifecycle(envelope.id, { state: 'settled', attempt_id: 'attempt-1' });
    assert.equal(settled.delivery_state, 'settled');
    assert.throws(
      () => tracker.recordTypedEnvelopeLifecycle(envelope.id, { state: 'claimed', attempt_id: 'attempt-2' }),
      /illegal transition/,
      'settled work cannot be replayed through a second attempt',
    );

    const lostResponse = tracker.createDispatchEnvelope(ticket.id, { session_id: 'typed-lost-response', actor: 'test' });
    tracker.recordTypedEnvelopeLifecycle(lostResponse.id, { state: 'claimed', attempt_id: 'attempt-a' });
    const recoveredAcceptance = tracker.recordTypedEnvelopeLifecycle(lostResponse.id, {
      state: 'accepted', attempt_id: 'attempt-b', accepted_attempt_id: 'attempt-a',
    });
    assert.equal(recoveredAcceptance.delivery_attempt_id, 'attempt-b', 'tracker records the current retry correlation');
    assert.equal(recoveredAcceptance.accepted_attempt_id, 'attempt-a', 'tracker preserves immutable first-accept lineage after a lost response');

    const retryable = tracker.createDispatchEnvelope(ticket.id, { session_id: 'typed-retry', actor: 'test' });
    tracker.recordTypedEnvelopeLifecycle(retryable.id, { state: 'claimed', attempt_id: 'attempt-a' });
    tracker.recordTypedEnvelopeLifecycle(retryable.id, { state: 'pending', attempt_id: 'attempt-a', error: 'pre-acceptance refusal' });
    const reclaimed = tracker.recordTypedEnvelopeLifecycle(retryable.id, { state: 'claimed', attempt_id: 'attempt-b' });
    assert.equal(reclaimed.delivery_attempt_id, 'attempt-b', 'pre-acceptance failures remain replayable');

    // A restart can reclaim an expired publishing lease after the endpoint
    // state persisted but before the old dashboard finalized its queue row.
    // Reconciliation happens under the new owner: claimed is replayable;
    // accepted evidence remains durably owned but unfinished, and only terminal
    // evidence finalizes the queue without a second transport attempt.
    const restartCases = [
      { name: 'claimed', state: 'claimed', shouldPush: true },
      { name: 'accepted', state: 'accepted', shouldPush: false },
      { name: 'settled', state: 'settled', shouldPush: false },
      { name: 'interrupted', state: 'interrupted', shouldPush: false },
      { name: 'recovery-required', state: 'recovery_required', shouldPush: false },
    ];
    const restartSessions = new Map();
    const restartQueueRows = [];
    for (const item of restartCases) {
      const sessionId = `typed-restart-${item.name}`;
      const restartTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: `stale publishing ${item.name}`, created_by: 'test' });
      const queued = tracker.queueDispatch(restartTicket.id, { session_id: sessionId, payload: `recover ${item.name}`, actor: 'test' });
      const queuedEnvelope = tracker.getEnvelope(queued.envelope_id);
      tracker.claimQueuePublishing(queued.id, { ownerToken: `dead-${item.name}` });
      tracker.enqueueEnvelopeRetry(queuedEnvelope.id, {
        session_id: sessionId,
        content: `recover ${item.name}`,
        settlement: { queue: { id: queued.id, owner_token: `dead-${item.name}` } },
        require_typed: true,
      });
      tracker.recordTypedEnvelopeLifecycle(queuedEnvelope.id, { state: 'claimed', attempt_id: `dead-${item.name}` });
      if (item.state === 'accepted') tracker.recordTypedEnvelopeLifecycle(queuedEnvelope.id, { state: 'accepted', attempt_id: `dead-${item.name}` });
      if (['settled', 'interrupted', 'recovery_required'].includes(item.state)) {
        tracker.recordTypedEnvelopeLifecycle(queuedEnvelope.id, { state: 'accepted', attempt_id: `dead-${item.name}` });
        tracker.recordTypedEnvelopeLifecycle(queuedEnvelope.id, { state: item.state, attempt_id: `dead-${item.name}` });
      }
      tracker.raw().prepare("UPDATE dispatch_queue SET publishing_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(queued.id);
      restartSessions.set(sessionId, item);
      restartQueueRows.push(queued);
    }
    let restartNativePublishes = 0;
    const restartDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [...restartSessions.keys()].map((session_id) => ({ session_id, alive: true, status: 'idle' })) },
      chat: { record: () => {} },
      pushBrief: async (_content, sessionId, metadata) => {
        restartNativePublishes += 1;
        return {
          ok: true, status: 202, typed_worker: true,
          body: JSON.stringify({
            accepted: true, envelope_id: metadata.envelope_id, attempt_id: metadata.attempt_id,
            accepted_attempt_id: metadata.attempt_id, delivery_state: 'accepted',
          }),
        };
      },
      buildDispatchBrief: (restartTicket) => restartTicket.title,
      broadcastWS: () => {},
      listChannels: async () => [...restartSessions.keys()].map((session_id) => ({ session_id, kind: 'typed-worker', delivery_ready: true })),
    });
    await restartDrainer.tick();
    assert.equal(restartNativePublishes, 1, 'only the pre-acceptance stale claim is republished after restart');
    for (const queued of restartQueueRows) {
      const state = restartSessions.get(queued.session_id).state;
      const expected = ['settled', 'interrupted', 'recovery_required'].includes(state) ? 'delivered' : 'publishing';
      assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(queued.id).status, expected, `stale ${state} publishing row preserves the acceptance/terminal boundary`);
    }
    assert.equal(tracker.getEnvelope(restartQueueRows[1].envelope_id).delivery_state, 'accepted', 'accepted restart evidence is retained rather than overwritten by a new claim');
    assert.equal(tracker.getEnvelope(restartQueueRows[2].envelope_id).delivery_state, 'settled', 'terminal restart evidence is retained rather than released to pending');
    assert.equal(tracker.getEnvelope(restartQueueRows[3].envelope_id).delivery_state, 'interrupted', 'interrupted restart evidence finalizes without automatic replay');
    assert.equal(tracker.getEnvelope(restartQueueRows[4].envelope_id).delivery_state, 'recovery_required', 'recovery-required restart evidence finalizes without automatic replay');
    restartDrainer.close();

    // Terminal tracker evidence reclaims only its matching rich tombstone. A
    // compact non-evicting rejection identity still protects the endpoint
    // after bounded inbox rollover, while a live accepted sibling remains
    // independently protected.
    const productionTombstoneFile = path.join(process.env.GOLEM_HOME, 'typed-delivery-tombstones.db');
    const mixedSession = 'typed-mixed-retirement';
    const activeMixed = {
      envelope_id: 'mixed-active', target_session_id: mixedSession,
      attempt_id: 'mixed-active-attempt', accepted_attempt_id: 'mixed-active-attempt',
      lifecycle_state: 'accepted', accepted_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    upsertTypedDeliveryTombstone(mixedSession, activeMixed, { file: productionTombstoneFile });
    const terminalMixed = tracker.createDispatchEnvelope(ticket.id, { session_id: mixedSession, actor: 'test' });
    upsertTypedDeliveryTombstone(mixedSession, {
      envelope_id: terminalMixed.id, target_session_id: mixedSession,
      attempt_id: 'mixed-terminal-attempt', accepted_attempt_id: 'mixed-terminal-attempt',
      lifecycle_state: 'settled', accepted_at: new Date().toISOString(), settled_at: new Date().toISOString(),
      expires_at: terminalMixed.expires_at,
    }, { file: productionTombstoneFile });
    const terminalOutcome = recordTypedEnvelopeOutcome(tracker, terminalMixed.id, 'mixed-terminal-attempt', {
      ok: true, status: 202, typed_worker: true,
      body: JSON.stringify({
        accepted: true, envelope_id: terminalMixed.id, attempt_id: 'mixed-terminal-attempt',
        accepted_attempt_id: 'mixed-terminal-attempt', delivery_state: 'settled',
      }),
    });
    assert.equal(terminalOutcome?.delivery_state, 'settled');
    const terminalReplayGuard = readTypedDeliveryTombstone(mixedSession, terminalMixed.id, { file: productionTombstoneFile });
    assert.equal(terminalReplayGuard?.lifecycle_state, 'settled', 'tracker terminal settlement retains a compact endpoint replay refusal');
    assert.equal(countTypedDeliveryTombstones({ file: productionTombstoneFile }), 1, 'the active sibling is the only rich tombstone left after terminal retirement');
    assert.equal(countTypedDeliveryRejections({ file: productionTombstoneFile }), 1, 'the terminal lineage moves to the durable rejection index');
    assert.equal(readTypedDeliveryTombstone(mixedSession, activeMixed.envelope_id, { file: productionTombstoneFile })?.lifecycle_state, 'accepted', 'an active sibling lineage is never retired by another envelope terminal result');
    const staleMixedSupervisor = new CodexSupervisor({
      canonicalId: mixedSession,
      registryFile: path.join(temp, 'mixed-retirement-supervisors.json'),
      tombstoneFile: productionTombstoneFile,
    });
    staleMixedSupervisor.migrateTypedDeliveryTombstones({
      schema: 5,
      deliveries: [{
        envelope_id: terminalMixed.id, target_session_id: mixedSession,
        attempt_id: 'mixed-terminal-attempt', state: 'started', lifecycle_state: 'accepted',
        expires_at: new Date(Date.now() + 120_000).toISOString(),
      }],
    });
    assert.equal(readTypedDeliveryTombstone(mixedSession, terminalMixed.id, { file: productionTombstoneFile })?.lifecycle_state, 'settled', 'stale schema-5 JSON cannot replace the tracker-terminal replay refusal after restart');
    const rolloverProbe = normalizeTypedWorkerInbox();
    for (let n = 0; n < 257; n += 1) {
      const created_at = new Date().toISOString();
      const row = {
        protocol_version: TYPED_WORKER_PROTOCOL_VERSION,
        envelope_id: `terminal-rollover-${n}`,
        content: `terminal rollover ${n}`,
        target_session_id: mixedSession,
        kind: 'ticket_dispatch',
        created_at,
        expires_at: new Date(Date.parse(created_at) + 60_000).toISOString(),
        attempt_id: `terminal-rollover-attempt-${n}`,
      };
      claimTypedDelivery(rolloverProbe, row);
      acceptTypedDelivery(rolloverProbe, row.envelope_id);
      settleTypedDelivery(rolloverProbe, row.envelope_id);
    }
    assert.equal(getTypedDelivery(rolloverProbe, terminalMixed.id), null, 'terminal acceptance falls out of the bounded rich history before replay probe');
    const terminalRolloverReplay = claimTypedDelivery(rolloverProbe, {
      envelope_id: terminalMixed.id,
      target_session_id: mixedSession,
      sender_session_id: 'test', kind: 'ticket_dispatch', content: 'must not execute after tracker terminal retirement',
      created_at: terminalMixed.created_at, expires_at: terminalMixed.expires_at,
      attempt_id: 'mixed-terminal-replay-attempt',
    }, {
      lookupTombstone: (envelopeId) => readTypedDeliveryTombstone(mixedSession, envelopeId, { file: productionTombstoneFile }),
    });
    assert.equal(terminalRolloverReplay.duplicate, true, 'tracker-settled envelope remains a duplicate after rich-history rollover');
    assert.equal(terminalRolloverReplay.delivery.lifecycle_state, 'settled', 'rollover replay returns the terminal outcome instead of claiming a native turn');

    // A terminal notification can win the race with a rejected/lost turn/start
    // response. The supervisor must re-read that durable terminal fact instead
    // of overwriting it with a stale recovery-pending claim.
    const raceSession = 'typed-notification-start-race';
    const raceRegistry = path.join(temp, 'notification-race-supervisors.json');
    const raceTombstones = path.join(temp, 'notification-race-tombstones.db');
    const raceSupervisor = new CodexSupervisor({ canonicalId: raceSession, registryFile: raceRegistry, tombstoneFile: raceTombstones });
    raceSupervisor.threadId = 'race-thread';
    raceSupervisor.projectId = 'typed-test-000000';
    raceSupervisor.mcp = { state: 'active', binding: raceSession };
    raceSupervisor.deliveryReady = () => true;
    raceSupervisor.updateRecord({
      canonical_id: raceSession, thread_id: raceSupervisor.threadId,
      thread_status: { type: 'idle' }, turn: { state: 'idle', turn_id: null },
      inbox: normalizeTypedWorkerInbox(), health: { state: 'healthy', delivery_ready: true },
    });
    raceSupervisor.rpc = {
      request: async (method) => {
        assert.equal(method, 'turn/start');
        raceSupervisor.handleNotification({
          method: 'turn/completed',
          params: { threadId: raceSupervisor.threadId, turn: { id: 'race-native-turn', status: 'completed' } },
        });
        throw new Error('turn/start response lost after terminal notification');
      },
    };
    const raceEnvelope = {
      protocol_version: TYPED_WORKER_PROTOCOL_VERSION,
      envelope_id: 'notification-before-start-response', content: 'one native start',
      target_session_id: raceSession, kind: 'ticket_dispatch', sender_session_id: 'test',
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), attempt_id: 'race-attempt-a',
    };
    const raceResult = await raceSupervisor.acceptDelivery(raceEnvelope);
    assert.equal(raceResult.accepted, true, 'a terminal notification remains an accepted result after the start response is lost');
    assert.equal(raceResult.delivery_state, 'settled');
    assert.equal(readCodexSupervisor(raceSession, { file: raceRegistry })?.inbox?.in_flight_envelope_id, null, 'lost start response never restores an already-settled in-flight claim');
    assert.equal(readCodexSupervisor(raceSession, { file: raceRegistry })?.inbox?.deliveries?.find((row) => row.envelope_id === raceEnvelope.envelope_id)?.lifecycle_state, 'settled');
    const staleRaceRecord = readCodexSupervisor(raceSession, { file: raceRegistry });
    staleRaceRecord.inbox = normalizeTypedWorkerInbox({
      schema: 5,
      in_flight_envelope_id: raceEnvelope.envelope_id,
      deliveries: [{ ...raceEnvelope, state: 'claimed', lifecycle_state: 'claimed', claimed_at: new Date().toISOString() }],
    });
    raceSupervisor.updateRecord({ inbox: staleRaceRecord.inbox, turn: { state: 'starting', envelope_id: raceEnvelope.envelope_id } });
    const restartedRaceSupervisor = new CodexSupervisor({ canonicalId: raceSession, registryFile: raceRegistry, tombstoneFile: raceTombstones });
    const restartedRaceInbox = normalizeTypedWorkerInbox(readCodexSupervisor(raceSession, { file: raceRegistry })?.inbox);
    restartedRaceSupervisor.reconcileTerminalTypedDeliveries(restartedRaceInbox);
    assert.equal(restartedRaceInbox.in_flight_envelope_id, null, 'startup reconciliation clears stale claimed state from the authoritative terminal tombstone');
    assert.equal(getTypedDelivery(restartedRaceInbox, raceEnvelope.envelope_id)?.lifecycle_state, 'settled', 'startup reconciliation preserves the authoritative terminal result');

    // A received JSON-RPC error is a deterministic native refusal, not an
    // ambiguous lost response. The supervisor must release the exact claim so
    // the shared queue can retry it instead of manufacturing recovery_required.
    const rejectionSession = 'typed-server-rejection';
    const rejectionSupervisor = new CodexSupervisor({
      canonicalId: rejectionSession,
      registryFile: path.join(temp, 'server-rejection-supervisors.json'),
      tombstoneFile: path.join(temp, 'server-rejection-tombstones.db'),
    });
    rejectionSupervisor.threadId = 'rejection-thread';
    rejectionSupervisor.projectId = 'typed-test-000000';
    rejectionSupervisor.mcp = { state: 'active', binding: rejectionSession };
    rejectionSupervisor.deliveryReady = () => true;
    rejectionSupervisor.updateRecord({
      canonical_id: rejectionSession, thread_id: rejectionSupervisor.threadId,
      thread_status: { type: 'idle' }, turn: { state: 'idle', turn_id: null },
      inbox: normalizeTypedWorkerInbox(), health: { state: 'healthy', delivery_ready: true },
    });
    rejectionSupervisor.rpc = {
      request: async () => { throw new CodexRpcServerRejection('turn/start', { code: -32000, message: 'synthetic native rejection' }); },
    };
    const rejectedEnvelope = {
      protocol_version: TYPED_WORKER_PROTOCOL_VERSION,
      envelope_id: 'deterministic-server-rejection', content: 'must remain retryable',
      target_session_id: rejectionSession, kind: 'ticket_dispatch', sender_session_id: 'test',
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), attempt_id: 'rejection-attempt-a',
    };
    const rejected = await rejectionSupervisor.acceptDelivery(rejectedEnvelope);
    assert.equal(rejected.accepted, false, 'a received RPC error is not typed acceptance');
    assert.equal(rejected.delivery_state, 'pending', 'deterministic RPC rejection releases the exact pre-accept claim');
    assert.equal(readCodexSupervisor(rejectionSession, { file: rejectionSupervisor.registryFile })?.inbox?.in_flight_envelope_id, null);
    assert.equal(readCodexSupervisor(rejectionSession, { file: rejectionSupervisor.registryFile })?.inbox?.deliveries?.some((row) => row.envelope_id === rejectedEnvelope.envelope_id), false,
      'server rejection leaves no recovery-required or accepted delivery mapping');

    let status = 'idle';
    let pushes = 0;
    const queueTicketOne = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed FIFO one', created_by: 'test' });
    const queueTicketTwo = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed FIFO two', created_by: 'test' });
    const queuedOne = tracker.queueDispatch(queueTicketOne.id, { session_id: canonicalId, payload: 'one', actor: 'test' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const queuedTwo = tracker.queueDispatch(queueTicketTwo.id, { session_id: canonicalId, payload: 'two', actor: 'test' });
    const drainer = initDispatchDrainer({
      tracker,
      // The migration seam is intentional: a Pi harness with a typed lease
      // must use this generic route, never publish a new pi-inbox record.
      state: { nativeSessions: () => [{ session_id: canonicalId, harness: 'pi', alive: true, status }] },
      chat: { record: () => {} },
      pushBrief: async (_content, _sessionId, metadata) => {
        pushes += 1;
        return {
          ok: true,
          status: 202,
          typed_worker: true,
          body: JSON.stringify({ accepted: true, envelope_id: metadata.envelope_id, attempt_id: metadata.attempt_id, accepted_attempt_id: metadata.attempt_id, delivery_state: 'accepted' }),
        };
      },
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: canonicalId, kind: 'typed-worker', delivery_ready: true }],
    });
    await drainer.tick();
    assert.equal(pushes, 1, 'shared drainer publishes only the FIFO head for a typed worker');
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(queuedOne.id).status, 'publishing', 'acceptance retains queue ownership until terminal lifecycle');
    assert.equal(tracker.getEnvelope(queuedOne.envelope_id).delivery_state, 'accepted');
    assert.equal(fs.existsSync(path.join(process.env.GOLEM_HOME, 'pi-inbox', canonicalId)), false, 'a typed Pi lease creates no second pi-inbox publication');
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(queuedTwo.id).status, 'pending');

    const preacceptSession = 'typed-preaccept';
    const preacceptTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed preaccept retry', created_by: 'test' });
    const preacceptQueued = tracker.queueDispatch(preacceptTicket.id, { session_id: preacceptSession, payload: 'retry safely', actor: 'test' });
    const preacceptDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: preacceptSession, harness: 'pi', alive: true, status: 'idle' }] },
      chat: { record: () => {} },
      pushBrief: async (_content, _sessionId, metadata) => ({
        ok: false,
        status: 409,
        typed_worker: true,
        body: JSON.stringify({ accepted: false, envelope_id: metadata.envelope_id, attempt_id: metadata.attempt_id, delivery_state: 'claimed' }),
      }),
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: preacceptSession, kind: 'typed-worker', delivery_ready: true }],
    });
    await preacceptDrainer.tick();
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(preacceptQueued.id).status, 'pending', 'pre-acceptance refusal releases the shared queue row');
    assert.equal(tracker.getEnvelope(preacceptQueued.envelope_id).delivery_state, 'pending');

    // A genuine schema-2 worker fence must not strand an otherwise valid
    // queued row. Publish the legacy identity through a real authenticated
    // endpoint, atomically rotate it in tracker storage, then deliver the
    // post-fence replacement through the same shared queue (no Pi spool).
    const upgradeSession = 'typed-schema-upgrade';
    const upgradeOwner = 'typed-schema-upgrade-owner';
    let upgradeInbox = normalizeTypedWorkerInbox({
      schema: 2,
      deliveries: [{
        envelope_id: 'pre-upgrade-history', target_session_id: upgradeSession,
        attempt_id: 'old-attempt', state: 'completed',
      }],
    });
    let nativeUpgradeStarts = 0;
    const upgradeEndpoint = await startTypedWorkerEndpoint({
      canonicalId: upgradeSession,
      ownerToken: upgradeOwner,
      deliveryReady: () => !upgradeInbox.in_flight_envelope_id,
      acceptDelivery: async (nativeEnvelope) => {
        const claim = claimTypedDelivery(upgradeInbox, nativeEnvelope, {
          lookupTombstone: (envelopeId) => readTypedDeliveryTombstone(upgradeSession, envelopeId, { file: tombstoneFile }),
        });
        if (claim.fenced) {
          return {
            ok: false, accepted: false, http_status: 409, legacy_replay_fenced: true,
            error: 'legacy typed replay history is fenced; dashboard must atomically reissue the still-pending envelope',
          };
        }
        if (claim.duplicate) return typedDeliveryResult(claim.delivery, { duplicate: true, attemptId: nativeEnvelope.attempt_id });
        if (claim.busy) return { ok: false, accepted: false, http_status: 409, error: 'worker is busy' };
        nativeUpgradeStarts += 1;
        const { delivery } = acceptTypedDelivery(upgradeInbox, nativeEnvelope.envelope_id, { turnId: `turn-${nativeEnvelope.envelope_id}` });
        upsertTypedDeliveryTombstone(upgradeSession, delivery, { file: tombstoneFile });
        return typedDeliveryResult(delivery, { httpStatus: 202, attemptId: nativeEnvelope.attempt_id });
      },
    });
    try {
      const upgradeTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'schema-2 queue reissue', created_by: 'test' });
      const upgradeQueued = tracker.queueDispatch(upgradeTicket.id, { session_id: upgradeSession, payload: 'deliver only after reissue', actor: 'test' });
      const originalUpgradeEnvelope = tracker.getEnvelope(upgradeQueued.envelope_id);
      const preFenceCreatedAt = new Date(Date.parse(upgradeInbox.replay_fence_at) - 1_000).toISOString();
      tracker.raw().prepare('UPDATE message_envelopes SET created_at = ?, expires_at = ? WHERE id = ?')
        .run(preFenceCreatedAt, new Date(Date.now() + 60_000).toISOString(), originalUpgradeEnvelope.id);
      const pushUpgrade = async (content, _sessionId, metadata) => {
        const response = await fetch(`http://${upgradeEndpoint.host}:${upgradeEndpoint.port}/brief`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-sender': 'dashboard',
            'x-golem-target-session': upgradeSession,
            'x-golem-endpoint-owner': upgradeOwner,
          },
          body: JSON.stringify({ protocol_version: TYPED_WORKER_PROTOCOL_VERSION, content, ...metadata }),
        });
        return { ok: response.ok, status: response.status, typed_worker: true, body: await response.text() };
      };
      const createUpgradeDrainer = () => initDispatchDrainer({
        tracker,
        state: { nativeSessions: () => [{ session_id: upgradeSession, harness: 'pi', alive: true, status: 'idle' }] },
        chat: { record: () => {} },
        pushBrief: pushUpgrade,
        buildDispatchBrief: (ticket) => ticket.title,
        broadcastWS: () => {},
        listChannels: async () => [{ session_id: upgradeSession, kind: 'typed-worker', delivery_ready: true }],
      });
      await createUpgradeDrainer().tick();
      const rotatedQueue = tracker.raw().prepare('SELECT * FROM dispatch_queue WHERE id = ?').get(upgradeQueued.id);
      const superseded = tracker.getEnvelope(originalUpgradeEnvelope.id);
      const replacement = tracker.getEnvelope(rotatedQueue.envelope_id);
      assert.equal(nativeUpgradeStarts, 0, 'pre-fence identity never creates a native turn');
      assert.equal(rotatedQueue.status, 'pending', 'atomic reissue keeps the original shared queue row pending');
      assert.equal(superseded.status, 'superseded', 'only the unaccepted source envelope is retired');
      assert.equal(replacement.parent_id, originalUpgradeEnvelope.id, 'reissue preserves direct envelope lineage');
      assert.equal(replacement.root_id, originalUpgradeEnvelope.root_id || originalUpgradeEnvelope.id, 'reissue preserves the immutable logical root');
      assert.ok(Date.parse(replacement.created_at) >= Date.parse(upgradeInbox.replay_fence_at), 'replacement is born after the legacy replay fence');
      assert.equal(fs.existsSync(path.join(process.env.GOLEM_HOME, 'pi-inbox', upgradeSession)), false, 'schema upgrade continues on the generic typed channel without a Pi spool');

      // A fresh drainer has no cooldown from the fenced attempt. It receives
      // the replacement in the next queue pass and starts exactly one turn.
      await createUpgradeDrainer().tick();
      assert.equal(nativeUpgradeStarts, 1, 'tracker-authoritative reissue delivers exactly one post-fence native turn');
      assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(upgradeQueued.id).status, 'publishing', 'post-fence acceptance remains owned until terminal lifecycle');
      assert.equal(tracker.getEnvelope(replacement.id).delivery_state, 'accepted');
      settleTypedDelivery(upgradeInbox, replacement.id);
    } finally {
      await closeTypedWorkerEndpoint(upgradeEndpoint.server);
    }

    const mismatchSession = 'typed-mismatch';
    const mismatchTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed response mismatch', created_by: 'test' });
    const mismatchQueued = tracker.queueDispatch(mismatchTicket.id, { session_id: mismatchSession, payload: 'must remain pending', actor: 'test' });
    const mismatchDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: mismatchSession, harness: 'pi', alive: true, status: 'idle' }] },
      chat: { record: () => {} },
      pushBrief: async (_content, _sessionId, metadata) => ({
        ok: true, status: 202, typed_worker: true,
        body: JSON.stringify({ accepted: true, envelope_id: 'wrong-envelope', attempt_id: metadata.attempt_id, accepted_attempt_id: metadata.attempt_id, delivery_state: 'accepted' }),
      }),
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: mismatchSession, kind: 'typed-worker', delivery_ready: true }],
    });
    await mismatchDrainer.tick();
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(mismatchQueued.id).status, 'pending', 'a response for another envelope cannot settle this queue row');
    assert.equal(tracker.getEnvelope(mismatchQueued.envelope_id).delivery_state, 'pending');

    const capabilitySession = 'typed-capable-unready';
    const capabilityTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed lease remains generic while unready', created_by: 'test' });
    const capabilityQueued = tracker.queueDispatch(capabilityTicket.id, { session_id: capabilitySession, payload: 'hold without spool', actor: 'test' });
    renewEndpointLease({ canonical_id: capabilitySession, owner_token: 'reload-owner', host: endpoint.host, port: endpoint.port, kind: 'typed-worker', harness: 'pi' });
    releaseEndpointLeases('reload-owner', { canonicalId: capabilitySession });
    assert.equal(readEndpointLeases({ includeExpired: true }).some((lease) => lease.canonical_id === capabilitySession), false, 'reload has released its old typed lease before rebind');
    const capabilityDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: capabilitySession, harness: 'pi', alive: true, status: 'idle' }] },
      chat: { record: () => {} },
      pushBrief: async () => { throw new Error('an unready typed lease must not receive delivery'); },
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [],
      listEndpointLeases: async () => [],
      listSessionFacts: async () => [{
        canonical_id: capabilitySession,
        harness: 'pi',
        status: 'idle',
        capabilities: { typed_worker: true, typed_worker_protocol: 1 },
      }],
    });
    await capabilityDrainer.tick();
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(capabilityQueued.id).status, 'pending', 'typed capability persists when its live lease is temporarily unready');
    assert.equal(fs.existsSync(path.join(process.env.GOLEM_HOME, 'pi-inbox', capabilitySession)), false, 'typed-capable Pi never falls back to a new legacy spool');

    // A clean terminal fact can precede the replacement lease during restart.
    // Capability is still typed in that gap, so holding the shared queue is
    // safe; publishing a new Pi compatibility inbox file is not.
    const terminalCapabilitySession = 'typed-terminal-restart';
    const terminalCapabilityTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed terminal restart gap', created_by: 'test' });
    const terminalCapabilityQueued = tracker.queueDispatch(terminalCapabilityTicket.id, { session_id: terminalCapabilitySession, payload: 'wait for replacement lease', actor: 'test' });
    const terminalCapabilityDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: terminalCapabilitySession, harness: 'pi', alive: true, status: 'idle' }] },
      chat: { record: () => {} },
      pushBrief: async () => { throw new Error('terminal typed capability must wait for its replacement lease'); },
      buildDispatchBrief: (queuedTicket) => queuedTicket.title,
      broadcastWS: () => {},
      listChannels: async () => [],
      listEndpointLeases: async () => [],
      listSessionFacts: async () => [{
        canonical_id: terminalCapabilitySession, harness: 'pi', status: 'stopped', ended_at: new Date().toISOString(),
        delivery: { mode: 'supervisor-pending', push: false },
        capabilities: { typed_worker: true, typed_worker_protocol: 1 },
      }],
    });
    await terminalCapabilityDrainer.tick();
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(terminalCapabilityQueued.id).status, 'pending', 'terminal typed fact keeps the shared queue pending through restart before lease rebind');
    assert.equal(fs.existsSync(path.join(process.env.GOLEM_HOME, 'pi-inbox', terminalCapabilitySession)), false, 'terminal typed fact never regresses to a Pi spool before the new lease arrives');

    const recoverySession = 'typed-recovery';
    const recoveryTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed recovery hold', created_by: 'test' });
    const recoveryQueued = tracker.queueDispatch(recoveryTicket.id, { session_id: recoverySession, payload: 'do not replay', actor: 'test' });
    const recoveryDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: recoverySession, harness: 'pi', alive: true, status: 'idle' }] },
      chat: { record: () => {} },
      pushBrief: async (_content, _sessionId, metadata) => ({
        ok: false,
        status: 503,
        typed_worker: true,
        body: JSON.stringify({ accepted: true, envelope_id: metadata.envelope_id, attempt_id: metadata.attempt_id, accepted_attempt_id: metadata.attempt_id, delivery_state: 'recovery_required' }),
      }),
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: recoverySession, kind: 'typed-worker', delivery_ready: true }],
    });
    await recoveryDrainer.tick();
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(recoveryQueued.id).status, 'delivered', 'recovery-required work leaves the shared queue instead of replaying');
    assert.equal(tracker.getEnvelope(recoveryQueued.envelope_id).delivery_state, 'recovery_required');

    // Notification retries retain one publication per target per tick, but
    // do not inherit the ticket queue's 60-second cooldown.
    const retryFifoSession = 'typed-retry-fifo';
    const retryFifoOne = tracker.createControlEnvelope({
      project_id: 'typed-test-000000', sender_id: 'test', recipient_session_id: retryFifoSession,
      kind: 'session_notify', payload: { content: 'retry fifo one' },
    });
    const retryFifoTwo = tracker.createControlEnvelope({
      project_id: 'typed-test-000000', sender_id: 'test', recipient_session_id: retryFifoSession,
      kind: 'session_notify', payload: { content: 'retry fifo two' },
    });
    tracker.enqueueEnvelopeRetry(retryFifoOne.id, { session_id: retryFifoSession, content: 'retry fifo one', require_typed: true });
    tracker.enqueueEnvelopeRetry(retryFifoTwo.id, { session_id: retryFifoSession, content: 'retry fifo two', require_typed: true });
    tracker.raw().prepare('UPDATE envelope_delivery_retries SET created_at = ? WHERE envelope_id = ?')
      .run('2026-01-01T00:00:00.000Z', retryFifoOne.id);
    tracker.raw().prepare('UPDATE envelope_delivery_retries SET created_at = ? WHERE envelope_id = ?')
      .run('2026-01-01T00:00:00.001Z', retryFifoTwo.id);
    let retryFifoClock = 10_000;
    const retryFifoPublishes = [];
    const retryFifoDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: retryFifoSession, harness: 'pi', alive: true, status: 'idle' }] },
      chat: { record: () => {} },
      pushBrief: async () => { throw new Error('typed retry FIFO uses the control adapter'); },
      pushControlEnvelope: async ({ envelope: controlEnvelope, metadata }) => {
        retryFifoPublishes.push(controlEnvelope.id);
        return {
          ok: true, status: 202, typed_worker: true, typed_attempt_id: metadata.attempt_id,
          body: JSON.stringify({
            accepted: true, envelope_id: controlEnvelope.id, attempt_id: metadata.attempt_id,
            accepted_attempt_id: metadata.attempt_id, delivery_state: 'settled',
          }),
        };
      },
      buildDispatchBrief: (queuedTicket) => queuedTicket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: retryFifoSession, kind: 'typed-worker', delivery_ready: true }],
      nowMs: () => retryFifoClock,
    });
    await retryFifoDrainer.tick();
    assert.deepEqual(retryFifoPublishes, [retryFifoOne.id], 'one retry opportunity publishes only the FIFO head in a tick');
    assert.equal(tracker.raw().prepare('SELECT status FROM envelope_delivery_retries WHERE envelope_id = ?').get(retryFifoTwo.id).status, 'pending', 'the second retry remains pending behind the FIFO head');
    await retryFifoDrainer.tick();
    assert.deepEqual(retryFifoPublishes, [retryFifoOne.id, retryFifoTwo.id], 'next-tick notification does not inherit ticket cooldown');
    retryFifoClock += 60_001;
    await retryFifoDrainer.tick();
    assert.deepEqual(retryFifoPublishes, [retryFifoOne.id, retryFifoTwo.id], 'later ticks do not repeat settled notifications');
    retryFifoDrainer.close();

    // Queue rows and retry rows are one per-session delivery stream. When
    // timestamps collide at SQLite's millisecond precision, their immutable
    // ids provide the stable total-order tie-break across both tables.
    const crossSourceSession = 'typed-cross-source-fifo';
    const crossSourceTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'older queued ticket', created_by: 'test' });
    const olderQueue = tracker.queueDispatch(crossSourceTicket.id, {
      session_id: crossSourceSession, payload: 'older queued ticket', actor: 'test',
    });
    const newerRetryEnvelope = tracker.createControlEnvelope({
      project_id: 'typed-test-000000', sender_id: 'test', recipient_session_id: crossSourceSession,
      kind: 'session_notify', payload: { content: 'newer retry' },
    });
    tracker.enqueueEnvelopeRetry(newerRetryEnvelope.id, {
      session_id: crossSourceSession, content: 'newer retry', require_typed: true,
    });
    tracker.raw().prepare('UPDATE dispatch_queue SET created_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', olderQueue.id);
    tracker.raw().prepare('UPDATE envelope_delivery_retries SET created_at = ? WHERE envelope_id = ?')
      .run('2026-01-01T00:00:00.000Z', newerRetryEnvelope.id);
    const queueWinsTie = olderQueue.id.localeCompare(newerRetryEnvelope.id) < 0;
    const tieOrder = queueWinsTie
      ? [olderQueue.envelope_id, newerRetryEnvelope.id]
      : [newerRetryEnvelope.id, olderQueue.envelope_id];
    let crossSourceClock = 20_000;
    const crossSourcePublishes = [];
    const terminalResult = (id, metadata) => ({
      ok: true, status: 200, typed_worker: true, typed_attempt_id: metadata.attempt_id,
      body: JSON.stringify({
        accepted: true, envelope_id: id, attempt_id: metadata.attempt_id,
        accepted_attempt_id: metadata.attempt_id, delivery_state: 'settled',
      }),
    });
    const crossSourceDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: crossSourceSession, harness: 'pi', alive: true, status: 'idle' }] },
      chat: { record: () => {} },
      pushBrief: async (_content, _sessionId, metadata) => {
        crossSourcePublishes.push(olderQueue.envelope_id);
        return terminalResult(olderQueue.envelope_id, metadata);
      },
      pushControlEnvelope: async ({ envelope: controlEnvelope, metadata }) => {
        crossSourcePublishes.push(controlEnvelope.id);
        return terminalResult(controlEnvelope.id, metadata);
      },
      buildDispatchBrief: (queuedTicket) => queuedTicket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: crossSourceSession, kind: 'typed-worker', delivery_ready: true }],
      nowMs: () => crossSourceClock,
    });
    await crossSourceDrainer.tick();
    assert.deepEqual(crossSourcePublishes, tieOrder.slice(0, 1), 'equal-timestamp cross-source work uses the immutable-id total-order tie-break');
    if (queueWinsTie) assert.equal(tracker.getEnvelopeRetry(newerRetryEnvelope.id).status, 'pending', 'the retry remains pending behind the tie-winning queue row');
    else assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(olderQueue.id).status, 'pending', 'the queue remains pending behind the tie-winning retry');
    crossSourceClock += 60_001;
    await crossSourceDrainer.tick();
    assert.deepEqual(crossSourcePublishes, tieOrder, 'the second equal-timestamp source publishes only after the total-order head and cooldown');
    crossSourceDrainer.close();

    // A retry can discover only at publication time that the endpoint already
    // settled that envelope. That duplicate response is bookkeeping, not a
    // native opportunity: the next queued ticket must still run in this tick.
    const settlementOnlySession = 'typed-settlement-only-retry';
    const settlementOnlyEnvelope = tracker.createControlEnvelope({
      project_id: 'typed-test-000000', sender_id: 'test', recipient_session_id: settlementOnlySession,
      kind: 'session_notify', payload: { content: 'settle old retry' },
    });
    tracker.enqueueEnvelopeRetry(settlementOnlyEnvelope.id, {
      session_id: settlementOnlySession, content: 'settle old retry', require_typed: true,
    });
    const afterSettlementTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'native work after settlement', created_by: 'test' });
    const afterSettlementQueue = tracker.queueDispatch(afterSettlementTicket.id, {
      session_id: settlementOnlySession, payload: 'native work after settlement', actor: 'test',
    });
    tracker.raw().prepare('UPDATE envelope_delivery_retries SET created_at = ? WHERE envelope_id = ?')
      .run('2026-01-01T00:00:00.000Z', settlementOnlyEnvelope.id);
    tracker.raw().prepare('UPDATE dispatch_queue SET created_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.001Z', afterSettlementQueue.id);
    const settlementOnlyPublishes = [];
    const settlementOnlyDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: settlementOnlySession, harness: 'pi', alive: true, status: 'idle' }] },
      chat: { record: () => {} },
      pushControlEnvelope: async ({ envelope: controlEnvelope, metadata }) => {
        settlementOnlyPublishes.push(`settle:${controlEnvelope.id}`);
        return {
          ok: true, status: 200, typed_worker: true, typed_attempt_id: metadata.attempt_id,
          body: JSON.stringify({
            accepted: true, duplicate: true, envelope_id: controlEnvelope.id,
            attempt_id: metadata.attempt_id, accepted_attempt_id: 'original-attempt', delivery_state: 'settled',
          }),
        };
      },
      pushBrief: async (_content, _sessionId, metadata) => {
        settlementOnlyPublishes.push(`native:${metadata.envelope_id}`);
        return terminalResult(metadata.envelope_id, metadata);
      },
      buildDispatchBrief: (queuedTicket) => queuedTicket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: settlementOnlySession, kind: 'typed-worker', delivery_ready: true }],
    });
    await settlementOnlyDrainer.tick();
    assert.deepEqual(settlementOnlyPublishes, [
      `settle:${settlementOnlyEnvelope.id}`,
      `native:${afterSettlementQueue.envelope_id}`,
    ], 'duplicate terminal settlement leaves the same tick native opportunity available to the next queue row');
    settlementOnlyDrainer.close();

    const settledSession = 'typed-fast-settle';
    const settledTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed fast settle', created_by: 'test' });
    const settledQueued = tracker.queueDispatch(settledTicket.id, { session_id: settledSession, payload: 'already settled', actor: 'test' });
    const settledDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: settledSession, harness: 'pi', alive: true, status: 'idle' }] },
      chat: { record: () => {} },
      pushBrief: async (_content, _sessionId, metadata) => ({
        ok: true,
        status: 202,
        typed_worker: true,
        body: JSON.stringify({ accepted: true, envelope_id: metadata.envelope_id, attempt_id: metadata.attempt_id, accepted_attempt_id: metadata.attempt_id, delivery_state: 'settled' }),
      }),
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: settledSession, kind: 'typed-worker', delivery_ready: true }],
    });
    await settledDrainer.tick();
    const settledEnvelope = tracker.getEnvelope(settledQueued.envelope_id);
    assert.equal(settledEnvelope.delivery_state, 'settled', 'a fast native terminal result retains the preceding acceptance boundary');
    assert.ok(settledEnvelope.accepted_at, 'a fast terminal result still persists correlated acceptance first');

    const busyTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed busy hold', created_by: 'test' });
    const busyQueued = tracker.queueDispatch(busyTicket.id, { session_id: canonicalId, payload: 'busy', actor: 'test' });
    status = 'busy';
    const busyDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: canonicalId, alive: true, status }] },
      chat: { record: () => {} },
      pushBrief: async () => { throw new Error('busy typed target must not receive a push'); },
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: canonicalId, kind: 'typed-worker', delivery_ready: true }],
    });
    await busyDrainer.tick();
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(busyQueued.id).status, 'pending', 'busy target retains the shared queue row');

    // A busy turn can last longer than the endpoint's protocol TTL. The row is
    // held, then the exact durable envelope is renewed before it is rendered
    // into a typed publish request.
    const ttlBusySession = 'typed-ttl-busy';
    let ttlBusyStatus = 'busy';
    let busyRenewedMetadata = null;
    const ttlBusyTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed TTL busy hold', created_by: 'test' });
    const ttlBusyQueued = tracker.queueDispatch(ttlBusyTicket.id, { session_id: ttlBusySession, payload: 'wait longer than TTL', actor: 'test' });
    tracker.raw().prepare("UPDATE message_envelopes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(ttlBusyQueued.envelope_id);
    const ttlBusyDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [{ session_id: ttlBusySession, harness: 'pi', alive: true, status: ttlBusyStatus }] },
      chat: { record: () => {} },
      pushBrief: async (_content, _sessionId, metadata) => {
        busyRenewedMetadata = metadata;
        return { ok: true, status: 202, typed_worker: true, body: JSON.stringify({ accepted: true, envelope_id: metadata.envelope_id, attempt_id: metadata.attempt_id, accepted_attempt_id: metadata.attempt_id, delivery_state: 'accepted' }) };
      },
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [{ session_id: ttlBusySession, kind: 'typed-worker', delivery_ready: true }],
    });
    await ttlBusyDrainer.tick();
    assert.equal(busyRenewedMetadata, null, 'busy hold does not create an expired competing typed turn');
    ttlBusyStatus = 'idle';
    await ttlBusyDrainer.tick();
    assert.ok(Date.parse(busyRenewedMetadata.expires_at) > Date.now(), 'busy-held envelope is durably renewed before typed publish');
    assert.equal(tracker.getEnvelope(ttlBusyQueued.envelope_id).expires_at, busyRenewedMetadata.expires_at, 'endpoint metadata uses the tracker-persisted renewed expiry');

    // Reminder children use the same pre-transport original-envelope retry
    // lifecycle as every other typed producer. Their root linkage appears only
    // when the child settles, so a lost response cannot strand or duplicate a
    // ping/escalation lineage.
    const reminderTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed reminder retry lifecycle', created_by: 'test' });
    const reminderRoot = tracker.createDispatchEnvelope(reminderTicket.id, {
      session_id: 'typed-reminder-target', actor: 'test', sender_id: 'typed-reminder-sender',
    });
    tracker.markEnvelopeDelivery(reminderRoot.id);
    tracker.raw().prepare("UPDATE message_envelopes SET ack_deadline_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(reminderRoot.id);
    const reminderPublishes = [];
    const reminderDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [] },
      chat: { record: () => {} },
      pushBrief: async (_content, _sessionId, metadata) => {
        reminderPublishes.push(metadata.envelope_id);
        return { ok: true, status: 202, typed_worker: true, body: JSON.stringify({
          accepted: true, envelope_id: metadata.envelope_id, attempt_id: metadata.attempt_id,
          accepted_attempt_id: metadata.attempt_id, delivery_state: 'settled',
        }) };
      },
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [
        { session_id: 'typed-reminder-target', kind: 'typed-worker', delivery_ready: true },
        { session_id: 'typed-reminder-sender', kind: 'typed-worker', delivery_ready: true },
      ],
    });
    await reminderDrainer.tick();
    const pingedRoot = tracker.getEnvelope(reminderRoot.id);
    assert.ok(pingedRoot.ping_envelope_id, 'typed settled ping links to its root only after durable child settlement');
    assert.equal(tracker.getEnvelopeRetry(pingedRoot.ping_envelope_id)?.status, 'delivered', 'settled ping resolves its original retry idempotently');
    tracker.raw().prepare("UPDATE message_envelopes SET escalate_after = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(reminderRoot.id);
    await reminderDrainer.tick();
    const escalatedRoot = tracker.getEnvelope(reminderRoot.id);
    assert.ok(escalatedRoot.escalation_envelope_id, 'typed settled escalation links to root only after durable child settlement');
    assert.equal(tracker.getEnvelopeRetry(escalatedRoot.escalation_envelope_id)?.status, 'delivered', 'settled escalation resolves its original retry idempotently');
    assert.equal(reminderPublishes.length, 2, 'one ping and one escalation receive one native opportunity each');
    reminderDrainer.close();

    const offlineTicket = tracker.createTicket({ project_id: 'typed-test-000000', title: 'typed offline hold', created_by: 'test' });
    const offlineQueued = tracker.queueDispatch(offlineTicket.id, { session_id: 'typed-offline', payload: 'offline', actor: 'test' });
    const offlineDrainer = initDispatchDrainer({
      tracker,
      state: { nativeSessions: () => [] },
      chat: { record: () => {} },
      pushBrief: async () => { throw new Error('offline typed target must not receive a push'); },
      buildDispatchBrief: (ticket) => ticket.title,
      broadcastWS: () => {},
      listChannels: async () => [],
    });
    await offlineDrainer.tick();
    assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(offlineQueued.id).status, 'pending', 'offline target retains shared work before expiry');

    // Reuse existing isolated ticket fixtures. Unknown legacy handoff must stop
    // its own replay, not capture a publishing lease forever or block all FIFO.
    const legacySession = 'legacy-uncertain-fifo';
    const legacyFirst = tracker.queueDispatch(offlineTicket.id, { session_id: legacySession, payload: 'first legacy', actor: 'test' });
    const legacySecond = tracker.queueDispatch(reminderTicket.id, { session_id: legacySession, payload: 'second legacy', actor: 'test' });
    tracker.raw().prepare('UPDATE dispatch_queue SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', legacyFirst.id);
    tracker.raw().prepare('UPDATE dispatch_queue SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00.001Z', legacySecond.id);
    let legacyClock = Date.now(), legacyPublishes = [];
    const legacyDrainer = initDispatchDrainer({
      tracker, state: { nativeSessions: () => [{ session_id: legacySession, alive: true, status: 'idle' }] },
      chat: { record() {} }, broadcastWS() {}, buildDispatchBrief: (ticket) => ticket.title,
      listChannels: async () => [{ session_id: legacySession, harness: 'claudecode', consumer_ready: true, delivery_ready: true }],
      nowMs: () => legacyClock,
      pushBrief: async (_content, sessionId, metadata) => {
        if (sessionId !== legacySession) return { ok: true, status: 202 };
        legacyPublishes.push(metadata.envelope_id);
        if (metadata.envelope_id === legacyFirst.envelope_id) throw new Error('legacy response lost');
        return { ok: true, status: 202 };
      },
    });
    try {
      await legacyDrainer.tick();
      const blocked = tracker.raw().prepare('SELECT * FROM dispatch_queue WHERE id = ?').get(legacyFirst.id);
      assert.equal(blocked.status, 'blocked', 'uncertain queue attempt is retained outside active FIFO');
      assert.equal(blocked.publishing_owner, null);
      assert.equal(tracker.getEnvelope(legacyFirst.envelope_id).delivery_state, 'recovery_required');
      legacyClock += 60_001;
      await legacyDrainer.tick();
      assert.deepEqual(legacyPublishes, [legacyFirst.envelope_id, legacySecond.envelope_id]);
      assert.equal(tracker.raw().prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(legacySecond.id).status, 'delivered');
    } finally { legacyDrainer.close(); }
  } finally {
    tracker.close();
    if (priorGolemHome == null) delete process.env.GOLEM_HOME; else process.env.GOLEM_HOME = priorGolemHome;
    fs.rmSync(temp, { recursive: true, force: true });
  }
} finally {
  await closeTypedWorkerEndpoint(endpoint.server);
  fs.rmSync(tombstoneTemp, { recursive: true, force: true });
}

console.log('typed worker endpoint journey: ok');
