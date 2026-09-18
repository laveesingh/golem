// Schedule persistence is part of the tracker connection/transaction owner.
// No network, model judgement, task mutation, or second delivery truth here.
import crypto from 'node:crypto';
import { NotificationError, validateNotificationSize } from '../../lib/notification-contract.js';
import { typedEnvelopeMetadata } from '../../lib/typed-worker-endpoint.js';
import { renderNotificationContent } from '../../lib/notification-presentation.js';

export function notificationHandedOff(envelope) {
  return !!envelope && (['published', 'accepted', 'settled', 'interrupted'].includes(envelope.delivery_state)
    || (envelope.delivery_state === 'claimed' && !!envelope.accepted_attempt_id));
}
export function createNotificationSchedules({ db, tracker }) {
  const get = (id) => db.prepare('SELECT * FROM notification_schedules WHERE id = ?').get(id) ?? null;
  const block = (id, reason, nowMs = Date.now()) => db.transaction(() => {
    const changed = db.prepare("UPDATE notification_schedules SET status = 'blocked', blocked_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'")
      .run(String(reason).slice(0, 2000), new Date(nowMs).toISOString(), id);
    const row = get(id);
    if (changed.changes && row.current_envelope_id && !notificationHandedOff(tracker.getEnvelope(row.current_envelope_id))) {
      db.prepare("UPDATE envelope_delivery_retries SET status='blocked', last_error=? WHERE envelope_id=? AND status='pending'")
        .run(String(reason).slice(0, 2000), row.current_envelope_id);
    }
    if (changed.changes) tracker.recordEvent({ project_id: row.target_project_id, topic: `schedule/${id}`,
      type: 'notification_schedule_blocked', actor: 'golem-scheduler', data: { schedule_id: id, reason: String(reason).slice(0, 2000) } });
    return row;
  }).immediate();
  const receipt = (id, { includeContent = false } = {}) => {
    const row = get(id); if (!row) return null;
    return { kind: 'schedule', id: row.id, state: row.status, creator_id: row.creator_id, creator_kind: row.creator_kind,
      owner_project_id: row.owner_project_id, target_session_id: row.target_session_id, project_id: row.target_project_id,
      created_at: row.created_at, next_due_at: row.next_due_at, interval_ms: row.interval_ms,
      occurrence_seq: row.occurrence_seq, cancelled_at: row.cancelled_at, reason: row.blocked_reason,
      current_occurrence: row.current_envelope_id ? tracker.getEnvelopeReceipt(row.current_envelope_id) : null,
      work_outcome: 'not_evaluated', ...(includeContent ? { content: row.message_text, ticket_context: row.ticket_context } : {}) };
  };
  return {
    get, receipt, block,
    list({ creatorId = null } = {}) {
      return db.prepare('SELECT id FROM notification_schedules WHERE (@creator IS NULL OR creator_id = @creator) ORDER BY created_at DESC, id DESC')
        .all({ creator: creatorId }).map((row) => receipt(row.id));
    },
    create({ id, fingerprint, sender, target, text, ticket = null, timing, ownerProject = null, targetProject = null, requireTyped = false, nowMs = Date.now() }) {
      return db.transaction(() => {
        if (tracker.getEnvelope(id)) throw new NotificationError('request-id already belongs to a message', 'OPERATION_CONFLICT', 409);
        const existing = get(id);
        if (existing) {
          if (existing.request_fingerprint !== fingerprint) throw new NotificationError('request-id already belongs to a different schedule', 'OPERATION_CONFLICT', 409);
          return receipt(id);
        }
        const ts = new Date(nowMs).toISOString();
        db.prepare(`INSERT INTO notification_schedules
          (id, creator_id, creator_kind, owner_project_id, target_session_id, target_project_id,
           request_fingerprint, message_text, ticket_context, after_ms, interval_ms, require_typed, next_due_at, created_at, updated_at)
          VALUES (@id,@sender,@kind,@ownerProject,@target,@targetProject,@fingerprint,@text,@ticket,@after,@every,@typed,@due,@ts,@ts)`)
          .run({ id, sender, kind: sender.startsWith('human:') ? 'human' : 'session', ownerProject, target, targetProject,
            fingerprint, text, ticket, after: timing.after_ms, every: timing.every_ms, typed: requireTyped ? 1 : 0,
            due: new Date(nowMs + timing.after_ms).toISOString(), ts });
        tracker.recordEvent({ project_id: targetProject, topic: `schedule/${id}`, type: 'notification_schedule_created', actor: sender,
          data: { schedule_id: id, target_session_id: target, next_due_at: new Date(nowMs + timing.after_ms).toISOString(), interval_ms: timing.every_ms } });
        return receipt(id);
      }).immediate();
    },
    pendingBatch(afterId = '') {
      return db.prepare(`SELECT s.* FROM notification_schedules s JOIN message_envelopes e ON e.id=s.current_envelope_id
        WHERE s.status='active' AND s.id > ? AND e.delivery_state IN ('pending','claimed') AND e.accepted_attempt_id IS NULL
        ORDER BY s.id LIMIT 100`).all(afterId);
    },
    reconcile(nowMs = Date.now()) {
      // Pending occurrences do not occupy this query, so unreachable targets
      // cannot starve reconciliation of completed/uncertain occurrences.
      const rows = db.prepare(`SELECT s.* FROM notification_schedules s
        LEFT JOIN message_envelopes e ON e.id = s.current_envelope_id
        LEFT JOIN envelope_delivery_retries r ON r.envelope_id = e.id
        WHERE s.status = 'active' AND s.current_envelope_id IS NOT NULL
          AND (e.id IS NULL OR e.delivery_state='recovery_required' OR e.status IN ('cancelled','expired','superseded')
            OR (r.status IN ('blocked','cancelled') AND e.delivery_state IN ('pending','claimed') AND e.accepted_attempt_id IS NULL)
            OR (s.interval_ms IS NULL AND (e.delivery_state IN ('published','accepted','settled','interrupted')
              OR (e.delivery_state='claimed' AND e.accepted_attempt_id IS NOT NULL))))
        ORDER BY s.id LIMIT 100`).all();
      for (const row of rows) db.transaction(() => {
        const current = get(row.id); if (current?.status !== 'active' || current.current_envelope_id !== row.current_envelope_id) return;
        const envelope = tracker.getEnvelope(current.current_envelope_id), retry = tracker.getEnvelopeRetry(current.current_envelope_id);
        if (!envelope || envelope.delivery_state === 'recovery_required' || ['cancelled', 'expired', 'superseded'].includes(envelope.status)
          || (!notificationHandedOff(envelope) && ['blocked', 'cancelled'].includes(retry?.status))) {
          block(row.id, envelope?.delivery_error || retry?.last_error || 'occurrence requires inspection', nowMs);
        } else if (current.interval_ms == null && notificationHandedOff(envelope)) {
          db.prepare("UPDATE notification_schedules SET status='completed', next_due_at=NULL, updated_at=? WHERE id=? AND status='active'")
            .run(new Date(nowMs).toISOString(), row.id);
          tracker.recordEvent({ project_id: current.target_project_id, topic: `schedule/${row.id}`,
            type: 'notification_schedule_handoff_completed', actor: 'golem-scheduler', data: { schedule_id: row.id, envelope_id: current.current_envelope_id } });
        }
      }).immediate();
    },
    due(nowMs = Date.now()) {
      return db.prepare(`SELECT s.* FROM notification_schedules s LEFT JOIN message_envelopes e ON e.id=s.current_envelope_id
        WHERE s.status='active' AND s.next_due_at <= @now
          AND (s.current_envelope_id IS NULL OR (s.interval_ms IS NOT NULL
            AND e.status NOT IN ('cancelled','expired','superseded')
            AND (e.delivery_state IN ('published','accepted','settled','interrupted') OR (e.delivery_state='claimed' AND e.accepted_attempt_id IS NOT NULL))))
        ORDER BY s.next_due_at, s.id LIMIT 100`).all({ now: new Date(nowMs).toISOString() });
    },
    emit(observed, { nowMs = Date.now() } = {}) {
      return db.transaction(() => {
        if (observed.status !== 'active' || !Number.isFinite(Date.parse(observed.next_due_at)) || Date.parse(observed.next_due_at) > nowMs) return null;
        const current = get(observed.id);
        if (!current || current.status !== 'active' || current.occurrence_seq !== observed.occurrence_seq
          || current.next_due_at !== observed.next_due_at || current.current_envelope_id !== observed.current_envelope_id) return null;
        if (current.current_envelope_id) {
          const prior = tracker.getEnvelope(current.current_envelope_id);
          if (current.interval_ms == null || !notificationHandedOff(prior) || ['cancelled','expired','superseded'].includes(prior.status)) return null;
        }
        const sequence = current.occurrence_seq + 1;
        if (!Number.isSafeInteger(sequence)) { block(current.id, 'occurrence sequence exceeds supported precision', nowMs); return null; }
        const dueMs = Date.parse(current.next_due_at);
        const next = current.interval_ms == null ? null
          : dueMs + (Math.floor((nowMs - dueMs) / current.interval_ms) + 1) * current.interval_ms;
        if (next !== null && !Number.isFinite(new Date(next).getTime())) { block(current.id, 'next due time exceeds supported date range', nowMs); return null; }
        const ts = new Date(nowMs).toISOString();
        const won = db.prepare(`UPDATE notification_schedules SET occurrence_seq=@sequence, next_due_at=@next, updated_at=@ts
          WHERE id=@id AND status='active' AND occurrence_seq=@old_sequence AND next_due_at=@due
            AND current_envelope_id IS @pointer`).run({ id: current.id, sequence, old_sequence: observed.occurrence_seq,
              due: observed.next_due_at, pointer: observed.current_envelope_id, next: next == null ? null : new Date(next).toISOString(), ts });
        if (won.changes !== 1) return null;
        const content = renderNotificationContent({ sender: current.creator_id, target: current.target_session_id,
          text: current.message_text, ticket: current.ticket_context,
          schedule: { id: current.id, sequence, due_at: current.next_due_at, created_at: current.created_at } });
        const envelopeId = crypto.randomUUID();
        validateNotificationSize({ ...typedEnvelopeMetadata({ id: envelopeId, kind: 'session_notify',
          sender_session_id: current.creator_id, target_session_id: current.target_session_id,
          created_at: new Date().toISOString(), expires_at: new Date(8640000000000000).toISOString() }), content });
        const envelope = tracker.createControlEnvelope({ id: envelopeId, sender_id: current.creator_id,
          recipient_session_id: current.target_session_id, project_id: current.target_project_id,
          payload: { content, notification_text: current.message_text, schedule_id: current.id, occurrence_seq: sequence, due_at: current.next_due_at } });
        db.prepare('UPDATE message_envelopes SET schedule_id=?, occurrence_seq=? WHERE id=?').run(current.id, sequence, envelope.id);
        tracker.enqueueEnvelopeRetry(envelope.id, { session_id: current.target_session_id, content,
          legacy: { path: '/brief', body: content }, require_typed: !!current.require_typed });
        db.prepare('UPDATE notification_schedules SET current_envelope_id=? WHERE id=?').run(envelope.id, current.id);
        tracker.recordEvent({ project_id: current.target_project_id, topic: `schedule/${current.id}`,
          type: 'notification_schedule_emitted', actor: 'golem-scheduler', data: { schedule_id: current.id, envelope_id: envelope.id, occurrence_seq: sequence, due_at: current.next_due_at } });
        return tracker.getEnvelope(envelope.id);
      }).immediate();
    },
    cancel(id, { caller = null, human = false, nowMs = Date.now() } = {}) {
      if (typeof human !== 'boolean') throw new NotificationError('human mode must be a boolean');
      return db.transaction(() => {
        const row = get(id);
        if (!row) throw new NotificationError('schedule not found', 'SCHEDULE_NOT_FOUND', 404);
        if ((!human && (!caller || caller !== row.creator_id)) || (human && caller)) throw new NotificationError('only the creator or explicit unbound human can cancel this schedule', 'SCHEDULE_OWNER_MISMATCH', 403);
        if (row.status === 'cancelled') return receipt(id);
        const ts = new Date(nowMs).toISOString();
        db.prepare("UPDATE notification_schedules SET status='cancelled', next_due_at=NULL, cancelled_at=?, updated_at=? WHERE id=?").run(ts, ts, id);
        if (row.current_envelope_id) {
          const envelope = tracker.getEnvelope(row.current_envelope_id), retry = tracker.getEnvelopeRetry(row.current_envelope_id);
          if (envelope && retry?.status !== 'publishing' && !notificationHandedOff(envelope) && envelope.delivery_state !== 'recovery_required') {
            if (!envelope.delivery_attempt_id) tracker.resolveEnvelope(envelope.id, { status: 'cancelled' });
            // A past typed attempt can be outcome-unknown. Stop retries without
            // inventing an accepted id or rejecting a later genuine callback.
            db.prepare("UPDATE envelope_delivery_retries SET status='cancelled', last_error=?, resolved_at=? WHERE envelope_id=? AND status IN ('pending','blocked')")
              .run(envelope.delivery_attempt_id ? 'schedule cancelled after an attempt; prior delivery may have occurred' : 'schedule cancelled before publication', ts, envelope.id);
          }
        }
        tracker.recordEvent({ project_id: row.target_project_id, topic: `schedule/${id}`, type: 'notification_schedule_cancelled',
          actor: human ? 'human:cli' : caller, data: { schedule_id: id, envelope_id: row.current_envelope_id } });
        return receipt(id);
      }).immediate();
    },
  };
}
