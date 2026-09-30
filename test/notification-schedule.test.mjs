import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-schedules-'));
process.env.GOLEM_HOME = home;
const { openTrackerDb } = await import('../dashboard/server/tracker-db.js');
const { publishDurableEnvelope } = await import('../dashboard/server/envelope-delivery.js');
const { recordTypedEnvelopeOutcome } = await import('../dashboard/server/typed-delivery.js');
const { createNotificationScheduleRuntime } = await import('../dashboard/server/notification-schedule-runtime.js');
const { initDispatchDrainer } = await import('../dashboard/server/dispatch-queue.js');
const { notificationFingerprint, normalizeNotificationTiming, parseNotificationDuration } = await import('../lib/notification-contract.js');
const { closeTypedDeliveryStores } = await import('../lib/typed-delivery-tombstones.js');
const { SUPPORTED_PI_VERSION, piCompatibility } = await import('../lib/pi-compatibility.js');
const file = path.join(home, 'tracker.db');
let tracker = openTrackerDb(file), drainer, releaseSlow, running;
const t0 = Date.UTC(2026, 8, 10);
const create = ({ after = 0, every = null, target = crypto.randomUUID(), sender = 'owner', text = 'Check the original work.', typed = false, id = crypto.randomUUID() } = {}) => {
  const timing = normalizeNotificationTiming({ after_ms: after, every_ms: every }, t0);
  return tracker.schedules.create({ id, sender, target, text, timing, requireTyped: typed, nowMs: t0,
    fingerprint: notificationFingerprint({ sender, target, text, timing }) });
};
const emit = (id, nowMs = t0) => tracker.schedules.emit(tracker.schedules.get(id), { nowMs });
const send = (e, publish = async () => ({ ok: true, status: 202 }), extra = {}) => publishDurableEnvelope({
  tracker, envelope: e, sessionId: e.target_session_id, content: JSON.parse(e.payload).content,
  durableRetry: true, publish, ...extra,
});
try {
  assert.equal(parseNotificationDuration('10ms'), 10);
  assert.equal(parseNotificationDuration('2m'), 120000);
  for (const value of ['10', '-1s', '0.5h', '1e4s', '999999999999999999d']) assert.throws(() => parseNotificationDuration(value));
  assert.throws(() => normalizeNotificationTiming({ every_ms: 0 }, t0));
  assert.throws(() => normalizeNotificationTiming({ after_ms: Number.MAX_SAFE_INTEGER }, t0));
  assert.deepEqual(normalizeNotificationTiming({ every_ms: 1 }, t0), { after_ms: 1, every_ms: 1 }, 'no hardcoded routine-cadence minimum');

  const once = create({ after: 100 });
  assert.equal(tracker.schedules.due(t0 + 99).some((s) => s.id === once.id), false);
  const observed = tracker.schedules.get(once.id);
  const onceEnvelope = tracker.schedules.emit(observed, { nowMs: t0 + 100 });
  assert.equal(onceEnvelope.schedule_id, once.id); assert.equal(onceEnvelope.occurrence_seq, 1);
  const secondConnection = openTrackerDb(file);
  try { assert.equal(secondConnection.schedules.emit(observed, { nowMs: t0 + 100 }), null, 'stale observation loses across connections'); }
  finally { secondConnection.close(); }
  assert.equal(tracker.raw().prepare('SELECT count(*) n FROM message_envelopes WHERE schedule_id=?').get(once.id).n, 1);
  await send(onceEnvelope); tracker.schedules.reconcile(t0 + 101);
  assert.equal(tracker.schedules.receipt(once.id).state, 'completed');
  assert.equal(tracker.schedules.receipt(once.id).work_outcome, 'not_evaluated');
  console.log('one-shot eligibility, stale-row CAS, one occurrence and handoff-only completion: passed');

  const recurring = create({ after: 100, every: 1000 });
  const first = emit(recurring.id, t0 + 10100);
  assert.equal(tracker.schedules.get(recurring.id).next_due_at, new Date(t0 + 11100).toISOString());
  assert.equal(emit(recurring.id, t0 + 50100), null, 'undelivered occurrence prevents accumulation');
  assert.equal(tracker.schedules.get(recurring.id).occurrence_seq, 1);
  await send(first);
  const reply = tracker.createControlEnvelope({ sender_id: first.target_session_id, recipient_session_id: 'owner', payload: { content: `DONE ${recurring.id}` } });
  tracker.markEnvelopeDelivery(reply.id);
  tracker.schedules.reconcile(t0 + 50100);
  assert.equal(tracker.schedules.get(recurring.id).status, 'active', 'a result message does not cancel recurrence');
  const second = emit(recurring.id, t0 + 50100);
  assert.equal(second.occurrence_seq, 2);
  assert.equal(tracker.schedules.get(recurring.id).next_due_at, new Date(t0 + 51100).toISOString());
  console.log('recurrence coalescing, one outstanding occurrence and no result interpretation: passed');

  const atomic = create();
  tracker.raw().exec(`CREATE TEMP TRIGGER reject_schedule_outbox BEFORE INSERT ON envelope_delivery_retries
    WHEN (SELECT schedule_id FROM message_envelopes WHERE id=NEW.envelope_id)='${atomic.id}'
    BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END;`);
  assert.throws(() => emit(atomic.id), /injected outbox failure/);
  assert.equal(tracker.schedules.get(atomic.id).occurrence_seq, 0);
  assert.equal(tracker.schedules.get(atomic.id).current_envelope_id, null);
  assert.equal(tracker.raw().prepare('SELECT count(*) n FROM message_envelopes WHERE schedule_id=?').get(atomic.id).n, 0);
  tracker.raw().exec('DROP TRIGGER reject_schedule_outbox');
  tracker.close(); tracker = openTrackerDb(file); // admission survives runtime restart
  const persisted = emit(atomic.id);
  tracker.close(); tracker = openTrackerDb(file); // emitted original outbox survives restart
  assert.equal(tracker.schedules.get(atomic.id).current_envelope_id, persisted.id);
  assert.equal(tracker.getEnvelopeRetry(persisted.id).status, 'pending');
  assert.equal(emit(atomic.id), null);
  console.log('emission transaction rollback and restart retain original schedule/outbox: passed');

  const never = create(); const staleNever = tracker.schedules.get(never.id);
  assert.throws(() => tracker.schedules.cancel(never.id, { caller: 'other' }), /only the creator/);
  assert.throws(() => tracker.schedules.cancel(never.id, { caller: 'owner', human: true }), /only the creator/);
  assert.equal(tracker.schedules.cancel(never.id, { caller: 'owner' }).state, 'cancelled');
  assert.equal(tracker.schedules.emit(staleNever, { nowMs: t0 }), null);
  assert.equal(tracker.schedules.cancel(never.id, { caller: 'owner' }).state, 'cancelled');
  const unclaimed = create(); const unclaimedEnvelope = emit(unclaimed.id);
  tracker.schedules.cancel(unclaimed.id, { human: true });
  assert.equal(tracker.getEnvelope(unclaimedEnvelope.id).status, 'cancelled');
  assert.equal(tracker.claimEnvelopeRetry(unclaimedEnvelope.id, { ownerToken: 'no' }), false);
  const owned = create(); const ownedEnvelope = emit(owned.id);
  assert.equal(tracker.claimEnvelopeRetry(ownedEnvelope.id, { ownerToken: 'publisher' }), true);
  const cancelledOwned = tracker.schedules.cancel(owned.id, { caller: 'owner' });
  assert.equal(cancelledOwned.current_occurrence.state, 'in_flight');
  assert.equal(cancelledOwned.current_occurrence.may_have_been_delivered, true);
  let calls = 0;
  await send(ownedEnvelope, async () => { calls++; return { ok: true, status: 202 }; }, { retryAlreadyOwned: true, retryOwnerToken: 'publisher' });
  assert.equal(calls, 0); assert.equal(tracker.getEnvelopeRetry(ownedEnvelope.id).status, 'cancelled');
  const self = create({ sender: 'owner', target: 'owner' });
  assert.match(JSON.parse(emit(self.id).payload).content, /Scheduled self-reminder — created by this session/);
  const serialA = create({ target: 'serialized' }), serialB = create({ target: 'serialized' });
  const serialEnvelopeA = emit(serialA.id), serialEnvelopeB = emit(serialB.id);
  const contender = openTrackerDb(file);
  try {
    assert.equal(tracker.claimEnvelopeRetry(serialEnvelopeA.id, { ownerToken: 'first-owner' }), true);
    assert.equal(contender.claimEnvelopeRetry(serialEnvelopeB.id, { ownerToken: 'second-owner' }), false, 'ordinary target publication is exclusive across connections');
    const interrupt = tracker.createControlEnvelope({ sender_id: 'owner', recipient_session_id: 'serialized', kind: 'interrupt', payload: 'stop' });
    tracker.enqueueEnvelopeRetry(interrupt.id, { session_id: 'serialized', content: 'stop', require_typed: false });
    assert.equal(contender.claimEnvelopeRetry(interrupt.id, { ownerToken: 'urgent' }), true, 'urgent control does not wait behind ordinary publication');
    contender.releaseEnvelopeRetry(interrupt.id, { ownerToken: 'urgent' });
    tracker.schedules.cancel(serialA.id, { caller: 'owner' });
    await send(serialEnvelopeA, async () => { throw new Error('cancelled publication must not send'); }, { retryAlreadyOwned: true, retryOwnerToken: 'first-owner' });
    assert.equal(contender.claimEnvelopeRetry(serialEnvelopeB.id, { ownerToken: 'second-owner' }), true);
    contender.releaseEnvelopeRetry(serialEnvelopeB.id, { ownerToken: 'second-owner' });
  } finally { contender.close(); }
  console.log('owner checks, cancel/CAS, unclaimed cancellation and final owned-publication fence: passed');

  const unknown = create({ typed: true }); const unknownEnvelope = emit(unknown.id);
  let actualFirst;
  await send(unknownEnvelope, async ({ metadata }) => {
    actualFirst = metadata.attempt_id;
    return { ok: false, status: 0, typed_worker: true, failure_stage: 'after_native', error: 'response lost' };
  }, { typedTarget: true });
  await send(tracker.getEnvelope(unknownEnvelope.id), async () => ({ ok: false, status: 503, typed_worker: true,
    failure_stage: 'before_native', retryable: true, error: 'later attempt refused' }), { typedTarget: true });
  assert.notEqual(tracker.getEnvelope(unknownEnvelope.id).delivery_attempt_id, actualFirst);
  const unknownCancelled = tracker.schedules.cancel(unknown.id, { caller: 'owner' });
  assert.equal(unknownCancelled.current_occurrence.state, 'uncertain');
  assert.equal(tracker.getEnvelope(unknownEnvelope.id).accepted_attempt_id, null, 'never invent the first native id during cancellation');
  assert.equal(tracker.claimEnvelopeRetry(unknownEnvelope.id, { ownerToken: 'no replay' }), false);
  recordTypedEnvelopeOutcome(tracker, unknownEnvelope.id, actualFirst, { ok: true, status: 200, typed_worker: true,
    body: JSON.stringify({ accepted: true, envelope_id: unknownEnvelope.id, attempt_id: actualFirst, accepted_attempt_id: actualFirst, delivery_state: 'settled' }) });
  assert.equal(tracker.getEnvelope(unknownEnvelope.id).accepted_attempt_id, actualFirst);
  assert.equal(tracker.schedules.receipt(unknown.id).state, 'cancelled');
  assert.equal(tracker.schedules.receipt(unknown.id).current_occurrence.state, 'settled');
  console.log('cancelled unknown attempt never replays or guesses lineage; late receipt remains recordable: passed');

  const dead = create({ target: 'dead' }), temporary = create({ target: 'temporary' }), unsupported = create({ target: 'unsupported' });
  const runtime = createNotificationScheduleRuntime({ tracker, readFacts: () => [] });
  runtime.prepare({ nowMs: t0, sessions: [{ session_id: 'dead', alive: false }, { session_id: 'unsupported', alive: true }],
    channels: [{ session_id: 'unsupported', consumer_reason: 'unsupported_custom_base_url' }] });
  assert.equal(tracker.schedules.get(dead.id).status, 'blocked');
  assert.equal(tracker.schedules.get(unsupported.id).status, 'active');
  assert.equal(tracker.schedules.get(unsupported.id).occurrence_seq, 1, 'legacy provider policy emits through the normal outbox');
  assert.ok(tracker.schedules.receipt(unsupported.id).current_occurrence.compatibility_warnings.some(w => w.legacy_metadata));
  assert.equal(tracker.schedules.get(temporary.id).status, 'active');
  assert.equal(tracker.schedules.get(temporary.id).occurrence_seq, 1);
  runtime.prepare({ nowMs: t0 + 100000, sessions: [], channels: [] });
  assert.equal(tracker.schedules.get(temporary.id).occurrence_seq, 1);
  assert.equal(Object.hasOwn(tracker.schedules.receipt(temporary.id), 'content'), false);
  assert.equal(tracker.schedules.receipt(temporary.id, { includeContent: true }).content, 'Check the original work.');
  const reload = create({ target: 'reloading', typed: true }); let reloadAlive = true;
  const reloadRuntime = createNotificationScheduleRuntime({ tracker, pidAlive: () => reloadAlive,
    readFacts: () => [{ canonical_id: 'reloading', harness: 'pi', status: 'stopped', pid: 123, observations: { reason: 'reload' } }] });
  reloadRuntime.prepare({ nowMs: t0, sessions: [{ session_id: 'reloading', alive: false }] });
  assert.equal(tracker.schedules.get(reload.id).status, 'active', 'live reload gap is not permanent death');
  reloadAlive = false;
  reloadRuntime.prepare({ nowMs: t0, sessions: [{ session_id: 'reloading', alive: false }] });
  reloadRuntime.prepare({ nowMs: t0, sessions: [{ session_id: 'reloading', alive: false }] });
  assert.equal(tracker.schedules.get(reload.id).status, 'blocked');
  console.log('dead targets block; legacy provider policy warns/emits; temporary absence retains one occurrence; content opt-in: passed');

  assert.equal(SUPPORTED_PI_VERSION, '0.99.1');
  const versions = ['0.99.1', '0.85.1', '0.100.0', '1.0.0'];
  const versionFacts = [], versionTargets = [];
  const versionSchedules = versions.map(version => {
    const row = create({ target: `pi-${version}`, typed: true });
    versionFacts.push({ canonical_id: row.target_session_id, harness: 'pi', status: 'idle', compatibility: piCompatibility(version) });
    versionTargets.push({ session_id: row.target_session_id, harness: 'pi', alive: true, compatibility: piCompatibility(version) });
    return row;
  });
  const legacyVersion = create({ target: 'legacy-pi', typed: true });
  versionFacts.push({ canonical_id: legacyVersion.target_session_id, harness: 'pi', status: 'idle', compatibility: { status: 'unsupported', pi_version: '0.100.0' } });
  versionTargets.push({ session_id: legacyVersion.target_session_id, harness: 'pi', alive: true });
  const legacyOther = create({ target: 'legacy-provider-label' });
  const pullOnly = create({ target: 'pull-only' });
  const oldBlocked = create({ target: 'old-policy-block' }); tracker.schedules.block(oldBlocked.id, 'historical policy block', t0);
  const cancelledPolicy = create({ target: 'cancelled-policy' }); tracker.schedules.cancel(cancelledPolicy.id, { caller: 'owner' });
  const versionRuntime = createNotificationScheduleRuntime({ tracker, readFacts: () => versionFacts });
  const policySessions = [...versionTargets, { session_id: 'legacy-provider-label', alive: true }, { session_id: 'pull-only', alive: true, delivery_mode: 'pull-only' }];
  const policyChannels = [{ session_id: 'legacy-provider-label', consumer_reason: 'unsupported_future_provider', consumer_initialized: true, delivery_ready: false }];
  versionRuntime.prepare({ nowMs: t0, sessions: policySessions, channels: policyChannels });
  for (const row of [...versionSchedules, legacyVersion, legacyOther]) {
    const schedule = tracker.schedules.get(row.id);
    assert.equal(schedule.status, 'active'); assert.equal(schedule.occurrence_seq, 1);
    assert.equal(tracker.getEnvelopeRetry(schedule.current_envelope_id).status, 'pending', 'normal durable outbox owns delivery');
  }
  const baselineWarnings = tracker.schedules.receipt(versionSchedules[0].id).current_occurrence.compatibility_warnings;
  assert.deepEqual(baselineWarnings, []);
  for (const row of versionSchedules.slice(1)) assert.ok(tracker.schedules.receipt(row.id).current_occurrence.compatibility_warnings.some(w => w.code === 'PI_VERSION_UNVERIFIED'));
  assert.ok(tracker.schedules.receipt(legacyVersion.id).current_occurrence.compatibility_warnings.some(w => w.legacy_metadata));
  assert.ok(tracker.schedules.receipt(legacyOther.id).current_occurrence.compatibility_warnings.some(w => w.code === 'LEGACY_CHANNEL_COMPATIBILITY_POLICY'));
  assert.equal(tracker.schedules.get(pullOnly.id).status, 'blocked');
  assert.equal(tracker.schedules.get(oldBlocked.id).status, 'blocked'); assert.equal(tracker.schedules.get(oldBlocked.id).occurrence_seq, 0);
  assert.equal(tracker.schedules.get(cancelledPolicy.id).status, 'cancelled'); assert.equal(tracker.schedules.get(cancelledPolicy.id).occurrence_seq, 0);
  const beforePolicyTicks = tracker.listEvents({ limit: 1000 }).filter(e => e.type === 'notification_schedule_emitted').length;
  for (let tick = 0; tick < 3; tick++) versionRuntime.prepare({ nowMs: t0 + tick, sessions: policySessions, channels: policyChannels });
  assert.equal(tracker.listEvents({ limit: 1000 }).filter(e => e.type === 'notification_schedule_emitted').length, beforePolicyTicks, 'pending ticks do not flood advisory events');
  const emittedPolicy = tracker.getEnvelope(tracker.schedules.get(legacyVersion.id).current_envelope_id);
  await send(emittedPolicy, async ({ metadata }) => ({ ok: true, status: 202, typed_worker: true,
    body: JSON.stringify({ accepted: true, envelope_id: emittedPolicy.id, attempt_id: metadata.attempt_id, accepted_attempt_id: metadata.attempt_id, delivery_state: 'accepted' }) }), { typedTarget: true });
  versionRuntime.reconcile(t0 + 5);
  assert.equal(tracker.schedules.receipt(legacyVersion.id).state, 'completed');
  assert.equal(tracker.schedules.receipt(legacyVersion.id).work_outcome, 'not_evaluated');
  const actualFailure = tracker.getEnvelope(tracker.schedules.get(legacyOther.id).current_envelope_id);
  await send(actualFailure, async () => ({ ok: false, status: 503, failure_stage: 'before_native', retryable: true, error: 'MCP initialization unavailable' }));
  assert.equal(tracker.getEnvelope(actualFailure.id).accepted_attempt_id, null);
  assert.notEqual(tracker.schedules.receipt(legacyOther.id).state, 'completed', 'warning is not native receipt/consumption');
  assert.match(tracker.getEnvelopeRetry(actualFailure.id).last_error, /MCP initialization unavailable/);
  console.log('current/future/older/legacy policies emit with observable warnings; real endpoint/lifecycle failures and historical cancellation remain intact: passed');

  const slow = create({ target: 'slow' }), fast = create({ target: 'fast' });
  let slowStarted, fastDelivered;
  const started = new Promise((r) => slowStarted = r), fastDone = new Promise((r) => fastDelivered = r);
  drainer = initDispatchDrainer({ tracker, nowMs: () => t0,
    state: { nativeSessions: () => ['slow', 'fast'].map((session_id) => ({ session_id, alive: true, status: 'idle' })) },
    listChannels: async () => ['slow', 'fast'].map((session_id) => ({ session_id, consumer_ready: true, delivery_ready: true })),
    chat: { record() {} }, broadcastWS() {}, buildDispatchBrief() { throw new Error('no ticket fixture'); },
    pushControlEnvelope: async ({ envelope }) => {
      if (envelope.target_session_id === 'slow') { slowStarted(); await new Promise((r) => releaseSlow = r); }
      else fastDelivered();
      return { ok: true, status: 202 };
    },
  });
  running = drainer.tick(); await started;
  await Promise.race([fastDone, new Promise((_, reject) => setTimeout(() => reject(new Error('healthy target was blocked by slow publication')), 1000))]);
  assert.equal(tracker.schedules.get(slow.id).occurrence_seq, 1);
  const overlap = drainer.tick(); assert.equal(overlap, running, 'overlapping clock ticks share the in-flight run');
  releaseSlow(); await running; running = null;
  assert.equal(tracker.schedules.receipt(fast.id).state, 'completed');
  assert.equal(tracker.schedules.receipt(slow.id).state, 'completed');
  console.log('bounded target concurrency progresses healthy work and fences overlapping ticks: passed');
} finally {
  releaseSlow?.(); if (running) await running.catch(() => {});
  drainer?.close(); tracker.close(); closeTypedDeliveryStores(); fs.rmSync(home, { recursive: true, force: true });
}
