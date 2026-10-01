#!/usr/bin/env node
// GOL-422 durable recovery journey: a temporary SQLite DB survives a drainer
// restart, emits one ping, then exactly one escalation. No ticket ownership or
// queue row is touched; ping acknowledgement resolves the original root.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { strict as assert } from 'node:assert';
import { openTrackerDb } from '../server/tracker-db.js';
import { initDispatchDrainer } from '../server/dispatch-queue.js';
import { createPrivateScratchFixture, archivePrivateScratchFixture } from './_scratch.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-422-'));
const dbPath = path.join(dir, 'tracker.db');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ticket = { kind: 'task', title: 'GOL-422 recovery', body: '' };
let tracker;
let created;
let drainer;
let pushed = [];
const state = { nativeSessions: () => [] };
const chat = { record() {} };
const start = () => initDispatchDrainer({ tracker, state, chat, listChannels: async () => [], buildDispatchBrief: () => '', broadcastWS() {}, pushBrief: async (content, session, meta) => { pushed.push({ content, session, meta }); return { ok: true, status: 200 }; } });

try {
  tracker = openTrackerDb(dbPath);
  created = createPrivateScratchFixture(tracker, dbPath, ticket);
  const root = tracker.createDispatchEnvelope(created.id, { session_id: 'target', actor: 'sender', sender_id: 'sender' });
  tracker.markEnvelopeDelivery(root.id); // config default window is 5m; make the test due without sleeping.
  const sql = (statement, ...args) => tracker.raw().prepare(statement).run(...args);
  sql("UPDATE message_envelopes SET ack_deadline_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", root.id);
  const ownerBefore = tracker.getTicket(created.id);
  drainer = start();
  await wait(5_300);
  drainer.close();
  assert.equal(pushed.length, 1, 'first due pass sent exactly one ping');
  let rootAfterPing = tracker.getEnvelope(root.id);
  assert.ok(rootAfterPing.ping_envelope_id, 'root durably links ping');
  assert.equal(ownerBefore.assignee, tracker.getTicket(created.id).assignee, 'ping did not change assignee');
  assert.equal(ownerBefore.dispatched_to, tracker.getTicket(created.id).dispatched_to, 'ping did not change dispatched target');
  // Restart with the same DB and make the post-ping opportunity due.
  sql("UPDATE message_envelopes SET escalate_after = '2000-01-01T00:00:00.000Z' WHERE id = ?", root.id);
  drainer = start();
  await wait(5_300);
  drainer.close();
  rootAfterPing = tracker.getEnvelope(root.id);
  assert.equal(pushed.length, 2, 'restart sent exactly one escalation');
  assert.ok(rootAfterPing.escalation_envelope_id, 'root durably links escalation');
  assert.equal(tracker.getEnvelope(rootAfterPing.escalation_envelope_id)?.kind, 'escalation', 'child uses the envelope protocol escalation kind');
  assert.equal(pushed[1].session, 'sender', 'escalation used stored reply route');
  // Repeated pass cannot duplicate the child.
  drainer = start(); await wait(5_300); drainer.close();
  assert.equal(pushed.length, 2, 'repeated tick did not duplicate escalation');
  // Acknowledge-via-ping explicitly resolves root and preserves ownership.
  const root2 = tracker.createDispatchEnvelope(created.id, { session_id: 'target', actor: 'sender', sender_id: 'sender' });
  tracker.markEnvelopeDelivery(root2.id);
  sql("UPDATE message_envelopes SET ack_deadline_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", root2.id);
  drainer = start(); await wait(5_300); drainer.close();
  const ping = tracker.getEnvelope(tracker.getEnvelope(root2.id).ping_envelope_id);
  tracker.acknowledgeEnvelope(ping.id, { target_session_id: 'target', summary: 'picked up' });
  const ackedRoot = tracker.getEnvelope(root2.id);
  assert.ok(ackedRoot.acknowledged_at && ackedRoot.ack_via_envelope_id === ping.id, 'ping acknowledgement resolved root');
  const pushedBeforeLegacy = pushed.length;
  // GOL-140 envelope-less delivery attempts still produce their legacy warning,
  // rather than being consumed by GOL-422 durable recovery.
  const legacyAttempt = tracker.markDispatchDeliveryAttempted(created.id, { session_id: 'legacy-target', actor: 'legacy-sender' });
  assert.equal(legacyAttempt.data.envelope_id, null, 'legacy attempt has no durable envelope id');
  sql("UPDATE events SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", legacyAttempt.id);
  drainer = start(); await wait(5_300); drainer.close();
  const legacyWarning = tracker.raw().prepare(`SELECT id FROM events
    WHERE type = 'dispatch_unacked_warning'
      AND CAST(json_extract(data, '$.delivery_event_id') AS INTEGER) = ?`).get(legacyAttempt.id);
  assert.ok(legacyWarning, 'legacy envelope-less delivery retained its GOL-140 warning');
  assert.equal(pushed.length, pushedBeforeLegacy, 'legacy warning did not create another durable child');
  console.log('PASS GOL-422 drainer/restart journey');
} finally {
  drainer?.close();
  if (created) archivePrivateScratchFixture(tracker, created.id);
  try { tracker?.close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}
