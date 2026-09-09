// One recorder for typed-worker responses. A non-2xx transport result may
// still mean the native turn accepted work (for example recovery_required),
// but only when the response proves the exact durable envelope *and* attempt.
import { parseTypedDeliveryResponse } from '../../lib/typed-worker-endpoint.js';
import {
  pruneTypedDeliveryTombstones,
  recordTypedDeliveryRejection,
  retireTypedDeliveryTombstones,
} from '../../lib/typed-delivery-tombstones.js';

const TERMINAL_DELIVERY_STATES = new Set(['settled', 'interrupted', 'recovery_required']);

export function recordTypedEnvelopeOutcome(tracker, envelopeId, attemptId, delivery) {
  if (!envelopeId || !attemptId) return null;
  let outcome = parseTypedDeliveryResponse(delivery, { envelopeId, attemptId });
  if (!outcome?.accepted) return null;
  const existing = tracker.getEnvelope(envelopeId);
  const current = existing?.delivery_state || 'pending';
  if (existing?.accepted_attempt_id && outcome.accepted_attempt_id !== existing.accepted_attempt_id) {
    // Old queued-accept adapters could release a claim on restart and invent
    // another first-acceptance id. Do not silently accept that contradiction.
    outcome = { ...outcome, accepted_attempt_id: existing.accepted_attempt_id,
      delivery_state: TERMINAL_DELIVERY_STATES.has(current) ? current : 'recovery_required',
      correlation_error: true, error: 'accepted delivery lineage changed; inspect before recovery' };
  }
  const error = outcome.correlation_error ? outcome.error : delivery?.ok ? null : (outcome.error || delivery?.error || null);
  // A terminal adapter callback can beat the original HTTP acceptance
  // response. Tracker terminal truth wins; the stale response still counts as
  // accepted but must not attempt an illegal terminal -> accepted regression.
  if (TERMINAL_DELIVERY_STATES.has(current) && outcome.delivery_state === 'accepted') {
    return { ...outcome, delivery_state: current };
  }
  // Direct routes can receive a fast terminal answer before observing their
  // claim. Materialize the required prefix; never allow claimed -> terminal.
  if (['pending', 'published'].includes(current)) {
    tracker.recordTypedEnvelopeLifecycle(envelopeId, { state: 'claimed', attempt_id: attemptId });
  }
  if (tracker.getEnvelope(envelopeId)?.delivery_state === 'claimed'
    && ['settled', 'interrupted'].includes(outcome.delivery_state)) {
    tracker.recordTypedEnvelopeLifecycle(envelopeId, {
      state: 'accepted',
      attempt_id: attemptId,
      accepted_attempt_id: outcome.accepted_attempt_id,
    });
  }
  const persisted = tracker.recordTypedEnvelopeLifecycle(envelopeId, {
    state: outcome.delivery_state,
    attempt_id: attemptId,
    accepted_attempt_id: outcome.accepted_attempt_id,
    error,
  });
  // The tracker is authoritative once a typed lineage becomes terminal: it
  // cannot be renewed or replayed through the shared queue. Reclaim only this
  // explicit local replay record (never every tombstone for a session), then
  // prune it immediately. First persist a compact non-evicting endpoint
  // rejection identity: terminal tracker evidence may reclaim lifecycle
  // detail, but must never remove the final replay guard after inbox rollover.
  // Schema-5 supervisor recovery deliberately does not re-import stale JSON.
  if (TERMINAL_DELIVERY_STATES.has(outcome.delivery_state) && persisted?.target_session_id) {
    recordTypedDeliveryRejection(persisted.target_session_id, {
      envelope_id: persisted.id,
      target_session_id: persisted.target_session_id,
      lifecycle_state: persisted.delivery_state,
      attempt_id: persisted.delivery_attempt_id,
      accepted_attempt_id: persisted.accepted_attempt_id,
      accepted_at: persisted.accepted_at,
      expires_at: persisted.expires_at,
    });
    retireTypedDeliveryTombstones(persisted.target_session_id, envelopeId);
    pruneTypedDeliveryTombstones();
  }
  return outcome;
}

export function acceptedTypedDelivery(tracker, envelopeId, attemptId, delivery) {
  return recordTypedEnvelopeOutcome(tracker, envelopeId, attemptId, delivery)?.accepted === true;
}

// A schema-2/3 worker deliberately refuses pre-fence unknown identities. This
// is not a generic delivery failure: the tracker can atomically reissue its
// still-pending lineage with a new envelope id/created_at and retry safely.
export function isLegacyReplayFence(delivery) {
  if (delivery?.legacy_replay_fenced === true) return true;
  if (typeof delivery?.body !== 'string') return false;
  try { return JSON.parse(delivery.body)?.legacy_replay_fenced === true; } catch { return false; }
}
