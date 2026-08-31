// Shared durable-envelope publication. A typed endpoint can accept a native
// turn and lose the HTTP response afterwards, so every non-ticket caller must
// retain and retry its *original* envelope rather than minting a lookalike.
import crypto from 'node:crypto';
import { typedEnvelopeMetadata } from '../../lib/typed-worker-endpoint.js';
import { recordTypedEnvelopeOutcome } from './typed-delivery.js';

const TERMINAL_TYPED_DELIVERY_STATES = new Set(['settled', 'interrupted', 'recovery_required']);

// A typed 2xx is not itself proof of acceptance: only the correlated endpoint
// result is. Legacy channel routes retain their established HTTP success rule.
export function acceptedDelivery(delivery) {
  if (delivery?.accepted === true) return true;
  return delivery?.typed_worker === true ? false : delivery?.ok === true;
}

function storedSettlement(retry) {
  try { return JSON.parse(retry?.settlement_json || 'null'); } catch { return null; }
}

// Settlement is deliberately completed while the retry remains owned and
// publishing. Each operation is idempotent (exact pending-only comment state
// and guarded queue/root update), so a process death between operations leaves
// the same original envelope available
// for restart settlement rather than minting another native turn.
export function settleDurableEnvelope({ tracker, envelope, retry, retryOwnerToken } = {}) {
  if (!tracker || !envelope?.id || !retryOwnerToken) throw new Error('settleDurableEnvelope requires tracker, envelope, and retry owner');
  const settlement = storedSettlement(retry);
  try {
    const comments = settlement?.comment_dispatch;
    const commentDispatchIds = Array.isArray(comments?.dispatch_ids)
      ? comments.dispatch_ids.filter((id) => typeof id === 'string' && id)
      : [];
    if (commentDispatchIds.length > 0) {
      // Exact immutable ids only. An older retry must never sweep a newer
      // comment batch merely because both address the same ticket/session.
      tracker.markCommentDispatchesDelivered(commentDispatchIds);
    }
    const queue = settlement?.queue;
    if (queue?.id) {
      let delivered = tracker.markQueueDelivered(queue.id, {
        envelope_id: envelope.id,
        ownerToken: queue.owner_token ?? retryOwnerToken,
      });
      if (delivered?.status !== 'delivered'
        && tracker.claimQueuePublishing(queue.id, { ownerToken: retryOwnerToken })) {
        delivered = tracker.markQueueDelivered(queue.id, {
          envelope_id: envelope.id,
          ownerToken: retryOwnerToken,
        });
      }
      if (delivered?.status !== 'delivered') return false;
    }
    // Ack-ping/escalation linkage becomes visible only after the child itself
    // is durably settled. This is also an idempotent legacy delivery fact.
    tracker.markEnvelopeDelivery(envelope.id, { error: null });
    return tracker.markEnvelopeRetryDelivered(envelope.id, { ownerToken: retryOwnerToken });
  } catch (error) {
    console.error('[envelope-delivery] durable settlement failed:', error);
    return false;
  }
}

// `publish` receives canonical metadata for a typed target and is deliberately
// injected by the caller. This keeps the durable lifecycle independent of the
// HTTP/Unix channel transport while giving every producer the same retry rule.
export async function publishDurableEnvelope({
  tracker,
  envelope,
  sessionId,
  content,
  legacy = null,
  typedTarget = false,
  durableRetry = typedTarget,
  settlement = null,
  retryOwnerToken = crypto.randomUUID(),
  retryAlreadyOwned = false,
  publish,
} = {}) {
  if (!tracker || !envelope?.id || !sessionId || typeof publish !== 'function') {
    throw new Error('publishDurableEnvelope requires tracker, envelope, sessionId, and publish');
  }
  const metadata = typedTarget ? typedEnvelopeMetadata(envelope) : null;
  // Reserve the immutable envelope before transport. If the dashboard dies
  // after native acceptance but before it observes the HTTP response, this
  // owned lease is the durable handoff to a later drainer.
  const usesRetry = typedTarget || durableRetry;
  let retry = null;
  let retryOwned = false;
  if (usesRetry) {
    retry = tracker.enqueueEnvelopeRetry(envelope.id, {
      session_id: sessionId,
      content,
      legacy,
      settlement,
      require_typed: typedTarget,
    });
    retryOwned = retryAlreadyOwned || tracker.claimEnvelopeRetry(envelope.id, { ownerToken: retryOwnerToken });
    if (!retryOwned) {
      return {
        envelope,
        delivery: { ok: false, status: 409, typed_worker: true, error: 'original typed envelope is already publishing' },
        typedOutcome: null,
        delivered: false,
        retry_queued: !!retry?.queued,
        retry,
      };
    }
  }
  // Typed lifecycle state is durable before bytes leave the dashboard. A
  // deterministic refusal returns this exact attempt to pending below; a
  // timeout/crash keeps the retry owner as the recovery handoff.
  if (typedTarget && metadata?.attempt_id) {
    tracker.recordTypedEnvelopeLifecycle(envelope.id, {
      state: 'claimed',
      attempt_id: metadata.attempt_id,
    });
  }
  let delivery;
  try {
    delivery = await publish({ envelope, sessionId, content, legacy, metadata });
  } catch (error) {
    delivery = { ok: false, status: 0, error: String(error?.message ?? error) };
  }
  if (typedTarget && delivery?.typed_attempt_id == null && metadata?.attempt_id) {
    delivery = { ...delivery, typed_attempt_id: metadata.attempt_id, typed_worker: delivery?.typed_worker ?? true };
  }
  const typedOutcome = typedTarget
    ? recordTypedEnvelopeOutcome(tracker, envelope.id, metadata?.attempt_id, delivery)
    : null;
  if (typedOutcome?.accepted && !delivery?.accepted) delivery = { ...delivery, accepted: true };
  const delivered = acceptedDelivery(delivery);
  if (!typedOutcome) {
    tracker.markEnvelopeDelivery(envelope.id, {
      error: delivered ? null : (delivery?.error || `status ${delivery?.status ?? '?'}`),
    });
  }

  // Native acceptance is not completion. Keep the original retry and every
  // stored settlement owner replayable, but do not apply queue/comment
  // settlement until the adapter reports a correlated terminal lifecycle.
  // A terminal response can still arrive synchronously for a duplicate whose
  // native turn completed before the original HTTP response was observed.
  let settled = !usesRetry;
  if (usesRetry && retryOwned) {
    const typedTerminal = typedTarget && TERMINAL_TYPED_DELIVERY_STATES.has(typedOutcome?.delivery_state);
    // Issue #34 (GOL-297): a duplicate of a delivery the session already
    // ACCEPTED carries no new turn — it proves the session holds the message
    // (sendUserMessage fired on the earlier attempt). Settle durable
    // ownership like a terminal replay; the adapter owns pickup from here
    // (10s recovery guard), so the delivery must not loop unreconciled.
    const duplicateAccepted = typedTarget
      && typedOutcome?.duplicate === true
      && typedOutcome?.accepted === true
      && typedOutcome?.delivery_state === 'accepted';
    if (delivered && (!typedTarget || typedTerminal || duplicateAccepted)) {
      settled = settleDurableEnvelope({ tracker, envelope, retry, retryOwnerToken });
    } else if (delivered && typedTarget) {
      settled = false;
      tracker.releaseEnvelopeRetry(envelope.id, { ownerToken: retryOwnerToken, error: null });
    } else if (!delivered) {
      if (typedTarget && metadata?.attempt_id) {
        tracker.recordTypedEnvelopeLifecycle(envelope.id, {
          state: 'pending',
          attempt_id: metadata.attempt_id,
          error: delivery?.error || `status ${delivery?.status ?? '?'}`,
        });
      }
      tracker.releaseEnvelopeRetry(envelope.id, {
        ownerToken: retryOwnerToken,
        error: delivery?.error || `status ${delivery?.status ?? '?'}`,
      });
    }
  }
  return {
    envelope,
    delivery,
    typedOutcome,
    delivered,
    settled,
    retry_queued: !!retry?.queued && (!delivered || !settled),
    retry,
  };
}
