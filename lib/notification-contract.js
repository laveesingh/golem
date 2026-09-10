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
export function notificationFingerprint({ sender, target, text, ticket = null, timing = null }) {
  return crypto.createHash('sha256').update(JSON.stringify({ sender, target, text, ticket, timing })).digest('hex');
}
export function notificationExit(receipt) {
  if (receipt?.kind !== 'message' || !['pending', 'queued', 'in_flight', 'accepted', 'settled', 'interrupted', 'cancelled', 'failed', 'blocked', 'expired', 'superseded', 'uncertain'].includes(receipt?.state)) {
    throw new Error('dashboard returned an invalid notification receipt');
  }
  if (receipt?.state === 'uncertain') return 3;
  if (['failed', 'blocked', 'expired', 'superseded'].includes(receipt?.state)) return 1;
  return 0;
}
