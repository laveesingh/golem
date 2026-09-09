// A projection of durable delivery facts, not a second lifecycle or job result.
// Shared by inspection/admission responses; never expose transport credentials.
export function notificationReceipt(envelope, retry = null, { includeContent = false } = {}) {
  if (!envelope) return null;
  const raw = envelope.delivery_state || 'pending';
  let state;
  if (['cancelled', 'expired', 'superseded'].includes(envelope.status)) state = envelope.status;
  else if (raw === 'recovery_required') state = 'uncertain';
  else if (raw === 'settled') state = 'settled';
  else if (raw === 'interrupted') state = 'interrupted';
  else if (['accepted', 'published'].includes(raw)) state = 'accepted';
  else if (raw === 'claimed' && envelope.accepted_attempt_id) state = 'accepted'; // queued native admission
  else if (retry?.status === 'blocked') state = 'blocked';
  else if (retry?.status === 'publishing') state = 'in_flight';
  else if (['pending', 'publishing'].includes(retry?.status)) state = 'queued';
  else if (envelope.status === 'delivery_failed') state = 'failed';
  else state = 'pending';
  const accepted = raw === 'recovery_required' ? null
    : ['accepted', 'published', 'settled', 'interrupted'].includes(raw)
      || (raw === 'claimed' && Boolean(envelope.accepted_attempt_id));
  const error = envelope.delivery_error || envelope.last_error || retry?.last_error || null;
  const receipt = {
    kind: 'message', id: envelope.id, envelope_id: envelope.id, message_kind: envelope.kind,
    sender_session_id: envelope.sender_session_id ?? envelope.sender_id ?? null,
    target_session_id: envelope.target_session_id ?? envelope.recipient_session_id ?? null,
    project_id: envelope.project_id ?? null, ticket_id: envelope.ticket_id ?? null,
    state, delivery_state: raw, accepted,
    may_have_been_delivered: retry?.status === 'publishing'
      || ['claimed', 'accepted', 'published', 'settled', 'interrupted', 'recovery_required'].includes(raw),
    acceptance_basis: accepted ? (raw === 'published' ? 'channel_submission' : 'native_input') : null,
    attempt_id: envelope.delivery_attempt_id ?? null,
    accepted_attempt_id: envelope.accepted_attempt_id ?? null,
    created_at: envelope.created_at,
    accepted_at: envelope.accepted_at ?? (raw === 'published' ? envelope.delivered_at ?? null : null),
    settled_at: envelope.settled_at ?? null,
    retry_status: retry?.status ?? null,
    reason: error ? String(error).slice(0, 2000) : null,
    next_action: raw === 'recovery_required' || state === 'blocked' ? 'inspect_before_recovery'
      : ['queued', 'in_flight', 'pending'].includes(state) ? 'inspect_original_operation' : null,
    work_outcome: 'not_evaluated',
  };
  if (includeContent) {
    try { receipt.content = JSON.parse(envelope.payload || '{}').content ?? ''; }
    catch { receipt.content = ''; }
  }
  return receipt;
}
