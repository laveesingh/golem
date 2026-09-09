// S1: real isolated tracker/retry transactions and production publisher/drainer.
// Transport is controlled here; typed-immediate-retry covers actual HTTP/API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-notification-delivery-'));
process.env.GOLEM_HOME = home;
const { openTrackerDb } = await import('../dashboard/server/tracker-db.js');
const { publishDurableEnvelope } = await import('../dashboard/server/envelope-delivery.js');
const { initDispatchDrainer } = await import('../dashboard/server/dispatch-queue.js');
const { closeTypedDeliveryStores } = await import('../lib/typed-delivery-tombstones.js');
const dbPath = path.join(home, 'tracker.db');
const tracker = openTrackerDb(dbPath);
let drainer;
const target = 'isolated-recipient';
const create = (text = 'context 日本語') => tracker.createControlEnvelope({
  sender_id: 'isolated-owner', recipient_session_id: target, payload: { content: text },
});
const enqueue = (e, typed = false) => tracker.enqueueEnvelopeRetry(e.id, {
  session_id: target, content: 'context', require_typed: typed,
});
const publish = (e, send, extra = {}) => publishDurableEnvelope({
  tracker, envelope: e, sessionId: target, content: 'context', publish: send, ...extra,
});

try {
  let sends = 0;
  const send = async () => { sends++; return { ok: true, status: 202 }; };
  const cancelled = create(); enqueue(cancelled);
  tracker.resolveEnvelope(cancelled.id, { status: 'cancelled' });
  assert.equal(tracker.listPendingEnvelopeRetries().length, 0);
  assert.equal(tracker.claimEnvelopeRetry(cancelled.id, { ownerToken: 'nope' }), false);
  await publish(cancelled, send);
  assert.equal(sends, 0);
  assert.equal(tracker.getEnvelopeRetry(cancelled.id).status, 'cancelled');
  const owned = create(); enqueue(owned);
  assert.equal(tracker.claimEnvelopeRetry(owned.id, { ownerToken: 'owner' }), true);
  tracker.resolveEnvelope(owned.id, { status: 'cancelled' });
  await publish(owned, send, { retryAlreadyOwned: true, retryOwnerToken: 'owner' });
  assert.equal(sends, 0, 'final publication fence catches cancellation after reservation');
  assert.equal(tracker.getEnvelopeRetry(owned.id).status, 'cancelled');
  console.log('cancel fences selection, claims, and reserved publication: passed');

  const uncertain = create();
  await publish(uncertain, async () => { sends++; throw new Error('response lost after channel submission'); });
  assert.equal(tracker.getEnvelopeReceipt(uncertain.id).state, 'uncertain');
  assert.equal(tracker.getEnvelopeReceipt(uncertain.id).accepted, null);
  assert.equal(tracker.getEnvelopeRetry(uncertain.id).status, 'blocked');
  await publish(uncertain, send);
  assert.equal(sends, 1, 'legacy uncertainty is never replayed automatically');
  const crashed = create(); enqueue(crashed);
  assert.equal(tracker.claimEnvelopeRetry(crashed.id, { ownerToken: 'crashed', nowMs: 0, leaseMs: 1 }), true);
  assert.equal(tracker.claimEnvelopeRetry(crashed.id, { ownerToken: 'restart' }), false);
  assert.equal(tracker.getEnvelopeReceipt(crashed.id).state, 'uncertain');
  assert.equal(tracker.getEnvelopeRetry(crashed.id).status, 'blocked');
  console.log('legacy lost response and expired publisher lease remain uncertain: passed');

  const refused = create();
  const result = await publish(refused, async () => ({ ok: false, status: 503,
    error: 'consumer not ready', failure_stage: 'before_native', retryable: true }));
  assert.equal(result.retry_queued, true);
  await publish(refused, send);
  assert.equal(tracker.getEnvelopeReceipt(refused.id).acceptance_basis, 'channel_submission');
  assert.equal(tracker.getEnvelopeRetry(refused.id).status, 'delivered');
  assert.equal(sends, 2);
  const view = tracker.getEnvelopeView(refused.id);
  assert.equal(view.envelope_id, refused.id);
  assert.equal(Object.hasOwn(view, 'content'), false);
  assert.equal(Object.hasOwn(view, 'payload'), false);
  assert.equal(tracker.getEnvelopeReceipt(refused.id, { includeContent: true }).content, 'context 日本語');
  console.log('definite pre-publication refusal retries original operation; compact receipt keeps content opt-in: passed');

  const queued = create(); enqueue(queued, true);
  tracker.recordTypedEnvelopeLifecycle(queued.id, { state: 'claimed', attempt_id: 'first', accepted_attempt_id: 'first' });
  assert.equal(tracker.claimEnvelopeRetry(queued.id, { ownerToken: 'never' }), false);
  assert.throws(() => tracker.recordTypedEnvelopeLifecycle(queued.id, { state: 'pending', attempt_id: 'second' }), /cannot return to pending/);
  // Ensure the accepted row is first without waiting on wall-clock resolution.
  const fixture = new Database(dbPath);
  fixture.prepare("UPDATE envelope_delivery_retries SET created_at = '2000-01-01T00:00:00.000Z' WHERE envelope_id = ?").run(queued.id);
  fixture.close();
  const next = create(); enqueue(next, true);
  const retriedIds = [];
  drainer = initDispatchDrainer({
    tracker, state: { nativeSessions: () => [{ session_id: target, alive: true, status: 'busy' }] },
    chat: { record() {} }, broadcastWS() {}, buildDispatchBrief() { throw new Error('no ticket work expected'); },
    listChannels: async () => [{ session_id: target, kind: 'typed-worker', delivery_ready: true }],
    pushControlEnvelope: async ({ envelope, metadata }) => {
      retriedIds.push(envelope.id);
      return { ok: true, status: 200, typed_worker: true, body: JSON.stringify({
        ok: true, accepted: true, envelope_id: envelope.id, attempt_id: metadata.attempt_id,
        accepted_attempt_id: metadata.attempt_id, delivery_state: 'settled',
      }) };
    },
  });
  await drainer.tick();
  assert.deepEqual(retriedIds, [next.id], 'ordinary notify is not held behind another queued acceptance or busy status');
  assert.equal(tracker.getEnvelope(queued.id).accepted_attempt_id, 'first');
  assert.equal(tracker.getEnvelope(queued.id).delivery_state, 'claimed');
  console.log('queued acceptance never becomes a fresh attempt; unrelated busy notification can progress: passed');

  const callback = create();
  let firstAttempt;
  const reconciled = await publish(callback, async ({ metadata }) => {
    firstAttempt = metadata.attempt_id;
    tracker.recordTypedEnvelopeLifecycle(callback.id, { state: 'recovery_required',
      attempt_id: firstAttempt, accepted_attempt_id: firstAttempt, error: 'native startup uncertain' });
    throw new Error('response lost after terminal callback');
  }, { typedTarget: true });
  assert.equal(reconciled.typedOutcome.source, 'durable_callback');
  assert.equal(tracker.getEnvelope(callback.id).delivery_state, 'recovery_required');
  assert.equal(tracker.getEnvelope(callback.id).accepted_attempt_id, firstAttempt);
  assert.equal(tracker.getEnvelopeRetry(callback.id).status, 'delivered', 'bookkeeping completes without resending');
  console.log('terminal callback outranks failed HTTP response and settles without a new attempt: passed');
} finally {
  drainer?.close(); tracker.close(); closeTypedDeliveryStores();
  fs.rmSync(home, { recursive: true, force: true });
}
