import crypto from 'node:crypto';
import { DEFAULT_TYPED_WORKER_MAX_BODY_BYTES } from './typed-worker-endpoint.js';

export class NotificationError extends Error {
  constructor(message, code = 'INVALID_NOTIFICATION', status = 400) {
    super(message); this.name = 'NotificationError'; this.code = code; this.status = status;
  }
}
export const notificationBodyLimit = DEFAULT_TYPED_WORKER_MAX_BODY_BYTES;
export function validateOperationId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new NotificationError('request-id must be a UUID');
  }
  return id.toLowerCase();
}
export function validateNotificationText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new NotificationError('message must be nonblank text');
  return text;
}
export function validateNotificationSize(value) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > notificationBodyLimit) {
    throw new NotificationError(`encoded notification exceeds the transport limit (${notificationBodyLimit} bytes)`, 'NOTIFICATION_TOO_LARGE', 413);
  }
}
export function parseNotificationDuration(value) {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(String(value));
  if (!match) throw new NotificationError('duration requires an integer and ms, s, m, h, or d');
  const milliseconds = Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]]);
  if (!Number.isSafeInteger(milliseconds)) throw new NotificationError('duration overflows supported precision');
  return milliseconds;
}
export function normalizeNotificationTiming(value, nowMs = Date.now()) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['after_ms', 'every_ms'].includes(key))) throw new NotificationError('invalid notification timing');
  const every = value.every_ms ?? null;
  const after = value.after_ms ?? every;
  if (!Number.isSafeInteger(after) || after < 0 || (every !== null && (!Number.isSafeInteger(every) || every <= 0))) {
    throw new NotificationError('delay must be nonnegative and recurrence must be positive integer milliseconds');
  }
  if (![after, every ?? 0].every((duration) => Number.isFinite(new Date(nowMs + duration).getTime()))) throw new NotificationError('timing exceeds the supported date range');
  return { after_ms: after, every_ms: every };
}
export function notificationFingerprint({ sender, target, text, ticket = null, timing = null }) {
  return crypto.createHash('sha256').update(JSON.stringify({ sender, target, text, ticket, timing })).digest('hex');
}
export function notificationExit(receipt) {
  if (receipt?.kind === 'schedule') {
    if (!['active', 'completed', 'cancelled', 'blocked'].includes(receipt.state)) throw new Error('dashboard returned an invalid schedule receipt');
    return receipt.state === 'blocked' ? 1 : 0;
  }
  if (receipt?.kind !== 'message' || !['pending', 'queued', 'in_flight', 'accepted', 'settled', 'interrupted', 'cancelled', 'failed', 'blocked', 'expired', 'superseded', 'uncertain'].includes(receipt?.state)) {
    throw new Error('dashboard returned an invalid notification receipt');
  }
  if (receipt?.state === 'uncertain') return 3;
  if (['failed', 'blocked', 'expired', 'superseded'].includes(receipt?.state)) return 1;
  return 0;
}
