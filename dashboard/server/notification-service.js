import crypto from 'node:crypto';
import { NotificationError, validateOperationId, validateNotificationText, validateNotificationSize, notificationFingerprint, notificationExit, normalizeNotificationTiming } from '../../lib/notification-contract.js';
import { readSessionFacts, hasTypedWorkerCapability, isSessionFactTerminal } from '../../lib/session-facts.js';
import { isTypedWorkerChannel } from './channels.js';
import { typedEnvelopeMetadata } from '../../lib/typed-worker-endpoint.js';
import { projectIdFor } from '../../lib/project-id.js';
import { renderNotificationContent } from '../../lib/notification-presentation.js';

export function createNotificationService({ tracker, listTargets, listChannels, deliver, readFacts = readSessionFacts, nowMs = () => Date.now() }) {
  function response(id, delivery) {
    const schedule = tracker.schedules.receipt(id);
    if (schedule) return { ok: notificationExit(schedule) === 0, operation_id: id, schedule_id: id, queued: schedule.state === 'active', receipt: schedule };
    const receipt = tracker.getEnvelopeReceipt(id);
    return { ok: notificationExit(receipt) === 0, operation_id: id, envelope_id: id,
      queued: ['pending', 'publishing'].includes(receipt.retry_status), receipt, ...(delivery ? { delivery } : {}) };
  }
  async function admit(body, { caller = null }, id) {
    if (body.human != null && typeof body.human !== 'boolean') throw new NotificationError('human mode must be a boolean');
    if (body.human && body.sender_id && body.sender_id !== 'human:cli') throw new NotificationError('human mode conflicts with sender identity', 'INVALID_CALLER_CONTEXT');
    if (body.human && caller) throw new NotificationError('bound agents cannot use human mode', 'INVALID_CALLER_CONTEXT');
    const sender = body.human ? 'human:cli' : caller || body.sender_id;
    if (caller && body.sender_id && body.sender_id !== caller) throw new NotificationError('notification sender conflicts with caller', 'INVALID_CALLER_CONTEXT');
    if (body.operation_id && !caller && !body.human) throw new NotificationError('unbound mutation requires explicit human mode', 'INVALID_CALLER_CONTEXT');
    if (typeof sender !== 'string' || !sender.trim()) throw new NotificationError('notification sender is required');
    const target = body.session_id === 'self' ? caller : body.session_id;
    if (typeof target !== 'string' || !target.trim()) throw new NotificationError('an exact target session is required; self needs a bound session');
    const text = validateNotificationText(body.text);
    const ticket = body.ticket == null ? null : String(body.ticket).trim();
    if (body.ticket != null && !ticket) throw new NotificationError('ticket context must be nonblank');
    const clockNow = nowMs();
    const existingSchedule = tracker.schedules.get(id);
    const timing = normalizeNotificationTiming(body.timing, existingSchedule ? Date.parse(existingSchedule.created_at) : clockNow);
    if (timing && !caller && !body.human) throw new NotificationError('scheduled mutations require a bound caller or explicit human mode', 'INVALID_CALLER_CONTEXT');
    const fingerprint = notificationFingerprint({ sender, target, text, ticket, timing });
    if (existingSchedule) {
      if (!timing || existingSchedule.request_fingerprint !== fingerprint) throw new NotificationError('request-id already belongs to a different operation', 'OPERATION_CONFLICT', 409);
      return response(id);
    }
    const existing = tracker.getEnvelope(id);
    if (existing) {
      if (timing || existing.kind !== 'session_notify' || existing.request_fingerprint !== fingerprint) throw new NotificationError('request-id already belongs to a different operation', 'OPERATION_CONFLICT', 409);
      return response(id);
    }
    const facts = readFacts();
    const targetFact = facts.find((item) => item.canonical_id === target);
    const targets = await listTargets();
    const targetRow = targets.find((item) => item.session_id === target);
    const channels = await listChannels();
    const channel = channels.find((item) => item.session_id === target);
    if (body.operation_id && ((!targetRow && !targetFact && !channel) || isSessionFactTerminal(targetFact)
      || (targetRow?.alive === false && !channel))) throw new NotificationError('target session is unknown or ended', 'INVALID_NOTIFICATION_TARGET', 404);
    if (targetRow?.harness === 'claudecode' && targetRow.kind === 'background') {
      throw new NotificationError('background Claude sessions do not consume channel notifications; use a live interactive session', 'INVALID_NOTIFICATION_TARGET', 409);
    }
    const legacyPi = targetFact?.harness === 'pi' && !hasTypedWorkerCapability(targetFact)
      && targetFact?.delivery?.mode === 'next_turn' && targetFact?.delivery?.push === false;
    const typed = isTypedWorkerChannel(channel) || hasTypedWorkerCapability(targetFact) || (targetFact?.harness === 'pi' && !legacyPi);
    const content = renderNotificationContent({ sender, target, text, ticket,
      schedule: timing ? { id, sequence: timing.every_ms == null ? 1 : Number.MAX_SAFE_INTEGER,
        due_at: new Date(8640000000000000).toISOString(), created_at: new Date(clockNow).toISOString() } : null });
    const created_at = new Date().toISOString();
    const wire = { id, kind: 'session_notify', sender_session_id: sender, target_session_id: target,
      created_at, expires_at: new Date(Date.now() + 3600000).toISOString() };
    validateNotificationSize({ ...typedEnvelopeMetadata(wire), content });
    validateNotificationSize(body);
    const targetProject = targetRow?.project_id ?? (targetFact?.project_path ? projectIdFor(targetFact.project_path) : body.project_id ?? null);
    if (timing) {
      const creator = facts.find((item) => item.canonical_id === sender);
      tracker.schedules.create({ id, fingerprint, sender, target, text, ticket, timing, requireTyped: typed,
        ownerProject: creator?.project_path ? projectIdFor(creator.project_path) : body.project_id ?? null,
        targetProject, nowMs: clockNow });
      return response(id);
    }
    const admitted = tracker.admitNotification({ id, fingerprint, sender_id: sender, recipient_session_id: target,
      project_id: targetProject,
      payload: { content, notification_text: text, ticket_context: ticket }, require_typed: typed });
    if (!admitted.created) return response(id);
    const publication = await deliver(tracker, { envelope: admitted.envelope, sender_id: sender,
      recipient_session_id: target, kind: 'session_notify', content, legacy: { path: '/brief', body: content } });
    return response(id, publication.delivery);
  }
  return async function notify(body, context = {}) {
    const id = validateOperationId(body.operation_id ?? crypto.randomUUID());
    try { return await admit(body, context, id); }
    catch (error) { error.operation_id = id; throw error; }
  };
}
