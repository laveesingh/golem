// Shared loopback endpoint and delivery-lifecycle contract for native Golem
// workers. Harness adapters own primitive translation; this module owns only
// authenticated transport, bounded envelope validation, and durable lifecycle
// helpers. It intentionally does not know about Pi or the tracker.
import crypto from 'node:crypto';
import http from 'node:http';

export const TYPED_WORKER_PROTOCOL_VERSION = 1;
export const DEFAULT_TYPED_WORKER_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_TYPED_DELIVERY_HISTORY_LIMIT = 256;
export const TYPED_WORKER_INBOX_SCHEMA = 5;

export const TypedDeliveryLifecycleState = Object.freeze({
  CLAIMED: 'claimed',
  ACCEPTED: 'accepted',
  SETTLED: 'settled',
  INTERRUPTED: 'interrupted',
  RECOVERY_REQUIRED: 'recovery_required',
});

const TERMINAL_TYPED_DELIVERY_STATES = new Set([
  TypedDeliveryLifecycleState.SETTLED,
  TypedDeliveryLifecycleState.INTERRUPTED,
  TypedDeliveryLifecycleState.RECOVERY_REQUIRED,
]);

function iso(value = Date.now()) { return new Date(value).toISOString(); }

export function sameEndpointSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Harness adapters share one authenticated terminal callback contract. The
// adapter persists its own terminal fact first, then retries this report until
// the tracker confirms it; the dashboard validates the live endpoint lease and
// immutable first-accept lineage before settling any stored durable owners.
export async function reportTypedDeliveryLifecycle({
  baseUrl,
  canonicalId,
  ownerToken,
  delivery,
  timeoutMs = 2_000,
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl || !canonicalId || !ownerToken || !delivery?.envelope_id
    || !TERMINAL_TYPED_DELIVERY_STATES.has(delivery.lifecycle_state)
    || !delivery.attempt_id || !delivery.accepted_attempt_id) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/api/message-envelopes/${encodeURIComponent(delivery.envelope_id)}/lifecycle`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-golem-target-session': canonicalId,
        'x-golem-endpoint-owner': ownerToken,
      },
      body: JSON.stringify({
        state: delivery.lifecycle_state,
        attempt_id: delivery.attempt_id,
        accepted_attempt_id: delivery.accepted_attempt_id,
        turn_id: delivery.turn_id ?? null,
        error: delivery.last_error ?? null,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const acknowledgement = await response.json();
    return acknowledgement?.ok === true && acknowledgement?.lifecycle === delivery.lifecycle_state;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function readBoundedRequestBody(request, { maxBytes = DEFAULT_TYPED_WORKER_MAX_BODY_BYTES } = {}) {
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`payload too large (max ${maxBytes} bytes)`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function sendEndpointJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function legacyLifecycleState(delivery) {
  switch (delivery?.state) {
    case 'claimed': return TypedDeliveryLifecycleState.CLAIMED;
    case 'accepted':
    case 'started': return TypedDeliveryLifecycleState.ACCEPTED;
    case 'completed': return TypedDeliveryLifecycleState.SETTLED;
    case 'failed': return TypedDeliveryLifecycleState.INTERRUPTED;
    case 'recovery_pending': return TypedDeliveryLifecycleState.RECOVERY_REQUIRED;
    default: return null;
  }
}

// `state` is retained as the supervisor compatibility projection. New
// adapters consume `lifecycle_state`, which names the cross-harness contract.
export function normalizeTypedWorkerInbox(inbox = {}, { historyLimit = DEFAULT_TYPED_DELIVERY_HISTORY_LIMIT } = {}) {
  const normalizeDelivery = (delivery) => {
    const lifecycle_state = delivery?.lifecycle_state || legacyLifecycleState(delivery);
    return {
      ...delivery,
      lifecycle_state,
      // `attempt_id` predates first-accept lineage. Legacy terminal rows had
      // no accepted_at, so their terminal lifecycle itself proves the first
      // accepted request that must remain immutable after migration.
      accepted_attempt_id: delivery?.accepted_attempt_id
        ?? ([
          TypedDeliveryLifecycleState.ACCEPTED,
          TypedDeliveryLifecycleState.SETTLED,
          TypedDeliveryLifecycleState.INTERRUPTED,
          TypedDeliveryLifecycleState.RECOVERY_REQUIRED,
        ].includes(lifecycle_state) ? delivery?.attempt_id ?? null : null),
    };
  };
  const deliveries = Array.isArray(inbox.deliveries)
    ? inbox.deliveries.slice(-historyLimit).map(normalizeDelivery)
    : [];
  // Schema 2/3 retained only bounded delivery rows, so older accepted ids are
  // unknowable. Fence pre-upgrade envelopes before this adapter advertises
  // delivery readiness; schema 4's complete replay map is migrated by the
  // adapter into compact tombstones without fencing current pending work.
  const sourceSchema = Number(inbox.schema) || 0;
  const needsLegacyReplayFence = sourceSchema > 0 && sourceSchema <= 3
    && (Array.isArray(inbox.deliveries) && inbox.deliveries.length > 0 || Object.keys(inbox.replay_index || {}).length > 0);
  return {
    schema: TYPED_WORKER_INBOX_SCHEMA,
    delivery_cursor: Number(inbox.delivery_cursor) || 0,
    in_flight_envelope_id: typeof inbox.in_flight_envelope_id === 'string' ? inbox.in_flight_envelope_id : null,
    last_accepted_envelope_id: typeof inbox.last_accepted_envelope_id === 'string' ? inbox.last_accepted_envelope_id : null,
    last_completed_envelope_id: typeof inbox.last_completed_envelope_id === 'string' ? inbox.last_completed_envelope_id : null,
    replay_fence_at: typeof inbox.replay_fence_at === 'string'
      ? inbox.replay_fence_at
      : (needsLegacyReplayFence ? iso() : null),
    deliveries,
  };
}

export function typedDeliveryDigest(content, senderSessionId, targetSessionId) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([content, senderSessionId ?? null, targetSessionId]))
    .digest('hex');
}

function deliveryIndex(inbox, envelopeId) {
  return inbox.deliveries.findIndex((delivery) => delivery.envelope_id === envelopeId);
}

export function getTypedDelivery(inbox, envelopeId) {
  return inbox?.deliveries?.find((delivery) => delivery.envelope_id === envelopeId) ?? null;
}

function replaceTypedDelivery(inbox, envelopeId, patch) {
  const existing = getTypedDelivery(inbox, envelopeId);
  if (!existing) throw new Error(`typed delivery ${envelopeId} is not claimed`);
  const next = { ...existing, ...patch };
  const index = deliveryIndex(inbox, envelopeId);
  if (index >= 0) inbox.deliveries[index] = next;
  return next;
}

function tombstoneDelivery(tombstone) {
  return {
    envelope_id: tombstone.envelope_id,
    target_session_id: tombstone.target_session_id,
    sender_session_id: null,
    kind: null,
    created_at: null,
    expires_at: tombstone.expires_at,
    attempt_id: tombstone.accepted_attempt_id,
    accepted_attempt_id: tombstone.accepted_attempt_id,
    digest: null,
    state: tombstone.lifecycle_state === TypedDeliveryLifecycleState.SETTLED ? 'completed'
      : tombstone.lifecycle_state === TypedDeliveryLifecycleState.INTERRUPTED ? 'failed'
        : tombstone.lifecycle_state === TypedDeliveryLifecycleState.RECOVERY_REQUIRED ? 'recovery_pending' : 'started',
    lifecycle_state: tombstone.lifecycle_state,
    turn_id: tombstone.turn_id ?? null,
    claimed_at: tombstone.claimed_at ?? null,
    accepted_at: tombstone.accepted_at ?? null,
    settled_at: tombstone.settled_at ?? null,
    interrupted_at: tombstone.interrupted_at ?? null,
    recovery_required_at: tombstone.recovery_required_at ?? null,
  };
}

export function claimTypedDelivery(inbox, envelope, {
  at = Date.now(),
  historyLimit = DEFAULT_TYPED_DELIVERY_HISTORY_LIMIT,
  lookupTombstone = null,
  allowInFlight = false,
} = {}) {
  const createdAt = Date.parse(envelope.created_at || '');
  const fenceAt = Date.parse(inbox.replay_fence_at || '');
  if (Number.isFinite(fenceAt) && Number.isFinite(createdAt) && createdAt < fenceAt) {
    return { inbox, delivery: null, duplicate: false, fenced: true, busy: false };
  }
  const existing = getTypedDelivery(inbox, envelope.envelope_id);
  if (existing) return { inbox, delivery: existing, duplicate: true };
  const tombstone = typeof lookupTombstone === 'function' ? lookupTombstone(envelope.envelope_id) : null;
  if (tombstone) return { inbox, delivery: tombstoneDelivery(tombstone), duplicate: true, tombstone: true };
  if (inbox.in_flight_envelope_id && !allowInFlight) return { inbox, delivery: null, busy: true, duplicate: false };
  const claimedAt = iso(at);
  const delivery = {
    envelope_id: envelope.envelope_id,
    target_session_id: envelope.target_session_id,
    sender_session_id: envelope.sender_session_id ?? null,
    kind: envelope.kind,
    created_at: envelope.created_at,
    expires_at: envelope.expires_at,
    attempt_id: envelope.attempt_id,
    accepted_attempt_id: null,
    digest: typedDeliveryDigest(envelope.content, envelope.sender_session_id, envelope.target_session_id),
    // `claimed` records the synchronous slot
    // reservation required before an adapter invokes its native primitive.
    state: 'claimed',
    lifecycle_state: TypedDeliveryLifecycleState.CLAIMED,
    claimed_at: claimedAt,
    turn_id: null,
  };
  inbox.deliveries.push(delivery);
  inbox.deliveries = inbox.deliveries.slice(-historyLimit);
  inbox.delivery_cursor += 1;
  if (!inbox.in_flight_envelope_id) inbox.in_flight_envelope_id = delivery.envelope_id;
  return { inbox, delivery, duplicate: false, busy: false };
}

// A native primitive can reject synchronously before it has accepted a turn.
// Release only the exact, still-claimed attempt so the envelope becomes
// replayable; a delayed failure cannot erase a later acceptance/recovery.
export function releaseTypedDeliveryClaim(inbox, envelopeId, { attemptId = null, error = null } = {}) {
  const delivery = getTypedDelivery(inbox, envelopeId);
  if (!delivery || delivery.lifecycle_state !== TypedDeliveryLifecycleState.CLAIMED
    || (attemptId != null && delivery.attempt_id !== attemptId)) {
    return { inbox, delivery: delivery ?? null, released: false };
  }
  inbox.deliveries = inbox.deliveries.filter((row) => row.envelope_id !== envelopeId);
  if (inbox.in_flight_envelope_id === envelopeId) inbox.in_flight_envelope_id = null;
  return { inbox, delivery: { ...delivery, released_at: iso(), last_error: error ?? null }, released: true };
}

export function acceptTypedDelivery(inbox, envelopeId, { turnId = null, at = Date.now() } = {}) {
  const delivery = getTypedDelivery(inbox, envelopeId);
  if (!delivery) throw new Error(`typed delivery ${envelopeId} is not claimed`);
  if ([
    TypedDeliveryLifecycleState.ACCEPTED,
    TypedDeliveryLifecycleState.SETTLED,
    TypedDeliveryLifecycleState.INTERRUPTED,
    TypedDeliveryLifecycleState.RECOVERY_REQUIRED,
  ].includes(delivery.lifecycle_state)) return { inbox, delivery };
  if (delivery.lifecycle_state !== TypedDeliveryLifecycleState.CLAIMED) {
    throw new Error(`typed delivery ${envelopeId} cannot accept from ${delivery.lifecycle_state}`);
  }
  const acceptedAt = delivery.accepted_at || iso(at);
  const next = replaceTypedDelivery(inbox, envelopeId, {
    // On-disk recovery records use `started` here.
    state: delivery.state === 'completed' ? 'completed' : 'started',
    lifecycle_state: TypedDeliveryLifecycleState.ACCEPTED,
    accepted_at: acceptedAt,
    accepted_attempt_id: delivery.accepted_attempt_id ?? delivery.attempt_id ?? null,
    turn_id: turnId ?? delivery.turn_id ?? null,
    started_at: delivery.started_at || acceptedAt,
  });
  inbox.last_accepted_envelope_id = envelopeId;
  return { inbox, delivery: next };
}

export function settleTypedDelivery(inbox, envelopeId, { turnId = null, completionStatus = null, at = Date.now() } = {}) {
  const delivery = getTypedDelivery(inbox, envelopeId);
  if (!delivery) return { inbox, delivery: null };
  if (delivery.lifecycle_state === TypedDeliveryLifecycleState.SETTLED) return { inbox, delivery };
  if (delivery.lifecycle_state !== TypedDeliveryLifecycleState.ACCEPTED) {
    throw new Error(`typed delivery ${envelopeId} cannot settle from ${delivery.lifecycle_state}`);
  }
  const completedAt = iso(at);
  const next = replaceTypedDelivery(inbox, envelopeId, {
    state: 'completed',
    lifecycle_state: TypedDeliveryLifecycleState.SETTLED,
    turn_id: turnId ?? delivery.turn_id ?? null,
    settled_at: completedAt,
    completed_at: completedAt,
    completion_status: completionStatus,
  });
  if (inbox.in_flight_envelope_id === envelopeId) inbox.in_flight_envelope_id = null;
  inbox.last_completed_envelope_id = envelopeId;
  return { inbox, delivery: next };
}

export function interruptTypedDelivery(inbox, envelopeId, { turnId = null, completionStatus = null, at = Date.now() } = {}) {
  const delivery = getTypedDelivery(inbox, envelopeId);
  if (!delivery) return { inbox, delivery: null };
  if (delivery.lifecycle_state === TypedDeliveryLifecycleState.INTERRUPTED) return { inbox, delivery };
  if (delivery.lifecycle_state !== TypedDeliveryLifecycleState.ACCEPTED) {
    throw new Error(`typed delivery ${envelopeId} cannot interrupt from ${delivery.lifecycle_state}`);
  }
  const interruptedAt = iso(at);
  const next = replaceTypedDelivery(inbox, envelopeId, {
    state: 'failed',
    lifecycle_state: TypedDeliveryLifecycleState.INTERRUPTED,
    turn_id: turnId ?? delivery.turn_id ?? null,
    interrupted_at: interruptedAt,
    completed_at: interruptedAt,
    completion_status: completionStatus,
  });
  if (inbox.in_flight_envelope_id === envelopeId) inbox.in_flight_envelope_id = null;
  return { inbox, delivery: next };
}

export function requireTypedDeliveryRecovery(inbox, envelopeId, { at = Date.now(), error = null } = {}) {
  const delivery = getTypedDelivery(inbox, envelopeId);
  if (!delivery) throw new Error(`typed delivery ${envelopeId} is not claimed`);
  if (delivery.lifecycle_state === TypedDeliveryLifecycleState.RECOVERY_REQUIRED) return { inbox, delivery };
  if (![TypedDeliveryLifecycleState.CLAIMED, TypedDeliveryLifecycleState.ACCEPTED].includes(delivery.lifecycle_state)) {
    throw new Error(`typed delivery ${envelopeId} cannot require recovery from ${delivery.lifecycle_state}`);
  }
  const recoveryAt = iso(at);
  const next = replaceTypedDelivery(inbox, envelopeId, {
    state: 'recovery_pending',
    lifecycle_state: TypedDeliveryLifecycleState.RECOVERY_REQUIRED,
    // A start response may have been lost after the native server accepted it.
    // Freeze the first attempt as unsafe-to-replay even though the outcome is
    // unknown; the dashboard must correlate a later retry to its own attempt.
    accepted_attempt_id: delivery.accepted_attempt_id ?? delivery.attempt_id ?? null,
    recovery_required_at: recoveryAt,
    last_error: error ?? delivery.last_error ?? null,
  });
  return { inbox, delivery: next };
}

export function typedDeliveryResult(delivery, { duplicate = false, httpStatus = 200, attemptId = null } = {}) {
  return {
    ok: true,
    accepted: [
      TypedDeliveryLifecycleState.ACCEPTED,
      TypedDeliveryLifecycleState.SETTLED,
      TypedDeliveryLifecycleState.INTERRUPTED,
      TypedDeliveryLifecycleState.RECOVERY_REQUIRED,
    ].includes(delivery.lifecycle_state),
    duplicate,
    http_status: httpStatus,
    envelope_id: delivery.envelope_id,
    // The response correlates to the publish attempt which produced it; the
    // immutable acceptance lineage is carried separately. A lost response can
    // therefore be retried as B without pretending first acceptance was B.
    attempt_id: attemptId ?? delivery.attempt_id ?? null,
    accepted_attempt_id: delivery.accepted_attempt_id ?? null,
    turn_id: delivery.turn_id ?? null,
    // Canonical state for new adapters; the legacy state remains visible for
    // existing registry readers.
    delivery_state: delivery.lifecycle_state,
    legacy_delivery_state: delivery.state,
    claimed_at: delivery.claimed_at ?? null,
    accepted_at: delivery.accepted_at ?? null,
  };
}

export function parseTypedDeliveryResponse(result, { envelopeId = null, attemptId = null } = {}) {
  if (!result?.typed_worker || typeof result.body !== 'string') return null;
  try {
    const body = JSON.parse(result.body);
    if (!body || typeof body !== 'object'
      || typeof body.envelope_id !== 'string'
      || (envelopeId != null && body.envelope_id !== envelopeId)
      || (attemptId != null && body.attempt_id !== attemptId)
      || typeof body.accepted !== 'boolean'
      || !Object.values(TypedDeliveryLifecycleState).includes(body.delivery_state)
      || (body.accepted && typeof body.accepted_attempt_id !== 'string')) return null;
    return body;
  } catch {
    return null;
  }
}

export function typedEnvelopeMetadata(envelope, { attemptId = crypto.randomUUID() } = {}) {
  const target = envelope?.target_session_id ?? envelope?.recipient_session_id ?? null;
  if (!envelope?.id || !target || !envelope?.kind || !envelope?.created_at || !envelope?.expires_at || !attemptId) {
    throw new Error('typed delivery requires a durable envelope id, target, kind, created_at, expires_at, and attempt_id');
  }
  return {
    envelope_id: envelope.id,
    sender_session_id: envelope.sender_session_id ?? null,
    target_session_id: target,
    kind: envelope.kind,
    created_at: envelope.created_at,
    expires_at: envelope.expires_at,
    attempt_id: attemptId,
  };
}

function validateTypedEnvelope(body, canonicalId) {
  const createdAt = Date.parse(body?.created_at || '');
  const expiresAt = Date.parse(body?.expires_at || '');
  if (!body || typeof body !== 'object'
    || body.protocol_version !== TYPED_WORKER_PROTOCOL_VERSION
    || typeof body.envelope_id !== 'string' || !body.envelope_id
    || typeof body.content !== 'string' || !body.content
    || typeof body.target_session_id !== 'string' || body.target_session_id !== canonicalId
    || typeof body.kind !== 'string' || !body.kind
    || typeof body.attempt_id !== 'string' || !body.attempt_id
    || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt || expiresAt <= Date.now()) {
    return null;
  }
  return {
    protocol_version: TYPED_WORKER_PROTOCOL_VERSION,
    envelope_id: body.envelope_id,
    content: body.content,
    sender_session_id: typeof body.sender_session_id === 'string' ? body.sender_session_id : null,
    target_session_id: canonicalId,
    kind: body.kind,
    created_at: body.created_at,
    expires_at: body.expires_at,
    attempt_id: body.attempt_id,
  };
}

// Start a loopback-only authenticated endpoint. `onRequest` is intentionally a
// small escape hatch for adapter-owned operator routes
// approvals); it runs after health but before the durable delivery route.
export async function startTypedWorkerEndpoint({
  canonicalId,
  ownerToken,
  deliveryReady,
  acceptDelivery,
  onRequest = null,
  host = '127.0.0.1',
  maxBodyBytes = DEFAULT_TYPED_WORKER_MAX_BODY_BYTES,
  kind = 'typed-worker',
} = {}) {
  if (!canonicalId || !ownerToken || typeof deliveryReady !== 'function' || typeof acceptDelivery !== 'function') {
    throw new Error('canonicalId, ownerToken, deliveryReady, and acceptDelivery are required');
  }
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || '/', `http://${host}`);
      if (url.pathname === '/healthz' && request.method === 'GET') {
        const expected = url.searchParams.get('session_id') === canonicalId
          && sameEndpointSecret(url.searchParams.get('owner_token'), ownerToken);
        if (!expected) return sendEndpointJson(response, 404, { error: 'not found' });
        return sendEndpointJson(response, 200, {
          protocol_version: TYPED_WORKER_PROTOCOL_VERSION,
          kind,
          canonical_id: canonicalId,
          owner_token: ownerToken,
          delivery_ready: await deliveryReady(),
        });
      }
      if (onRequest && await onRequest({
        request, response, url, canonicalId, ownerToken,
        readBody: () => readBoundedRequestBody(request, { maxBytes: maxBodyBytes }),
        sendJson: (status, body) => sendEndpointJson(response, status, body),
        sameSecret: sameEndpointSecret,
      })) return;
      if (url.pathname !== '/brief' || request.method !== 'POST') return sendEndpointJson(response, 404, { error: 'not found' });
      const target = String(request.headers['x-golem-target-session'] || '');
      const owner = String(request.headers['x-golem-endpoint-owner'] || '');
      if (request.headers['x-sender'] !== 'dashboard'
        || target !== canonicalId
        || !sameEndpointSecret(owner, ownerToken)) {
        return sendEndpointJson(response, 403, { ok: false, error: 'typed delivery authentication failed' });
      }
      let body;
      try { body = JSON.parse(await readBoundedRequestBody(request, { maxBytes: maxBodyBytes })); } catch (error) {
        return sendEndpointJson(response, 400, { ok: false, error: error.message || 'invalid JSON delivery envelope' });
      }
      const envelope = validateTypedEnvelope(body, canonicalId);
      if (!envelope) {
        return sendEndpointJson(response, 400, { ok: false, error: `typed delivery requires protocol version ${TYPED_WORKER_PROTOCOL_VERSION}, envelope_id, non-empty content, and the canonical target` });
      }
      const result = await acceptDelivery(envelope);
      return sendEndpointJson(response, result.http_status ?? 200, result);
    })().catch((error) => sendEndpointJson(response, 500, { ok: false, error: error.message || String(error) }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('typed worker endpoint did not bind a loopback port');
  }
  return { server, host, port: address.port, kind };
}

export async function closeTypedWorkerEndpoint(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}
