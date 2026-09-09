// GOL-329/S1: real endpoint + adapter + isolated replay SQLite. Native input is
// a controlled counter; the full native process is covered by pi-journey.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-pi-failures-'));
process.env.GOLEM_HOME = root;
process.env.GOLEM_TYPED_DELIVERY_TOMBSTONES_DB = path.join(root, 'replay.db');
fs.writeFileSync(path.join(root, 'dashboard.json'), JSON.stringify({ url: 'http://127.0.0.1:1' }));
const project = path.join(root, 'project');
fs.mkdirSync(path.join(project, '.git'), { recursive: true });
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
const { PiNativeAdapter } = await import('../lib/pi-native-adapter.js');
const { closeTypedWorkerEndpoint } = await import('../lib/typed-worker-endpoint.js');
const { closeTypedDeliveryStores, closeTypedDeliveryStore } = await import('../lib/typed-delivery-tombstones.js');
const adapters = [];
let holder, callbackServer;

async function make(id = crypto.randomUUID()) {
  const sent = [];
  let idle = true;
  const adapter = new PiNativeAdapter({ on() {}, sendUserMessage(text) { sent.push(text); } }, {
    home: root, heartbeatIntervalMs: 60_000, acceptTimeoutMs: 60_000,
  });
  const ctx = {
    cwd: project, isIdle: () => idle, model: { provider: 'test', id: 'test' },
    abort() { idle = true; }, shutdown() {},
    sessionManager: {
      getSessionId: () => id, getSessionFile: () => path.join(root, `${id}.jsonl`),
      getSessionName: () => 'isolated-worker', getLeafId: () => `leaf-${sent.length}`,
    },
  };
  adapters.push(adapter);
  await adapter.sessionStart({ reason: 'test' }, ctx);
  const envelope = (eid, attempt = 'attempt-a') => ({
    protocol_version: 1, envelope_id: eid, attempt_id: attempt,
    target_session_id: id, sender_session_id: 'isolated-sender', kind: 'session_notify',
    content: `input-${eid}`, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
  const post = async (eid, attempt) => {
    const response = await fetch(`http://127.0.0.1:${adapter.endpoint.port}/brief`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-sender': 'dashboard',
        'x-golem-target-session': id, 'x-golem-endpoint-owner': adapter.ownerToken },
      body: JSON.stringify(envelope(eid, attempt)), signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
  const start = async (eid) => {
    adapter.input({ source: 'extension', text: `input-${eid}` }, ctx);
    adapter.beforeAgentStart({ prompt: `input-${eid}` }, ctx);
    idle = false;
    await adapter.agentStart({}, ctx);
  };
  const settle = async () => { idle = true; await adapter.agentSettled({}, ctx); };
  const crash = async () => {
    clearInterval(adapter.heartbeat); clearTimeout(adapter.pendingAcceptance?.timer);
    await closeTypedWorkerEndpoint(adapter.endpoint.server);
    adapter.endpoint = null;
  };
  return { adapter, ctx, sent, id, post, start, settle, crash, busy: () => { idle = false; adapter.state = 'active'; } };
}

try {
  const h = await make();
  const read = h.adapter.readRecord.bind(h.adapter);
  let locked = false;
  h.adapter.readRecord = () => {
    if (h.adapter.state === 'starting' && !locked) {
      locked = true;
      closeTypedDeliveryStore();
      holder = new DatabaseSync(process.env.GOLEM_TYPED_DELIVERY_TOMBSTONES_DB);
      holder.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
    }
    return read();
  };
  const refused = await h.post('locked');
  assert.equal(refused.status, 503);
  assert.equal(refused.body.failure_stage, 'before_native');
  assert.equal(refused.body.accepted, false);
  assert.equal(h.sent.length, 0);
  assert.equal(h.adapter.pendingAcceptance, null);
  assert.equal(h.adapter.state, 'idle', 'failed preflight cannot strand starting');
  assert.equal(h.adapter.deliveryReady(), false, 'storage fault is not advertised ready');
  holder.exec('ROLLBACK'); holder.close(); holder = null;
  const retried = await h.post('locked', 'attempt-b');
  assert.equal(retried.body.accepted, true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.adapter.deliveryReady(), false, 'real starting reservation is not ready');
  await h.start('locked'); await h.settle();
  assert.equal(h.adapter.deliveryReady(), true);
  console.log('pre-native SQLite lock -> safe refusal -> recovery -> one injection: passed');

  const queued = await make();
  const first = await queued.post('queued');
  assert.equal(first.body.accepted_attempt_id, 'attempt-a');
  const duplicate = await queued.post('queued', 'attempt-b');
  assert.equal(duplicate.body.accepted, true, 'duplicate queued acceptance is not status200/accepted=false');
  assert.equal(duplicate.body.accepted_attempt_id, 'attempt-a');
  assert.equal(queued.sent.length, 1);
  await queued.crash(); // no shutdown hook: real crash boundary
  const resumed = await make(queued.id);
  const replay = await resumed.post('queued', 'attempt-c');
  assert.equal(replay.body.delivery_state, 'recovery_required');
  assert.equal(replay.body.accepted_attempt_id, 'attempt-a');
  assert.equal(resumed.sent.length, 0);
  assert.equal(resumed.adapter.deliveryReady(), false);
  console.log('queued duplicate and abrupt restart preserve first lineage without replay: passed');

  const postInput = await make();
  const originalWrite = postInput.adapter.writeRecord.bind(postInput.adapter);
  let fault = true;
  postInput.adapter.writeRecord = (record) => {
    if (fault && record.inbox.deliveries.some((d) => d.native_handoff === 'enqueued')) {
      fault = false;
      throw new Error('injected failure after native invocation');
    }
    return originalWrite(record);
  };
  const uncertain = await postInput.post('after');
  assert.equal(uncertain.body.delivery_state, 'recovery_required');
  assert.equal(uncertain.body.failure_stage, 'after_native');
  assert.equal(uncertain.body.accepted_attempt_id, 'attempt-a');
  assert.equal(postInput.sent.length, 1);
  assert.equal((await postInput.post('after', 'attempt-b')).body.accepted_attempt_id, 'attempt-a');
  assert.equal(postInput.sent.length, 1);
  assert.equal(postInput.adapter.pendingAcceptance, null, 'uncertainty ends the temporary waiter');
  assert.notEqual(postInput.adapter.input({ source: 'interactive', text: 'inspect recovery' }, postInput.ctx)?.action, 'handled', 'operator input is not swallowed by a dead waiter');
  console.log('post-invocation failure remains uncertain, never replayable: passed');

  const timed = await make();
  timed.adapter.acceptTimeoutMs = 10;
  await timed.post('timed');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(timed.adapter.pendingAcceptance, null, 'timeout also ends the temporary waiter');
  assert.equal(timed.adapter.readRecord().inbox.deliveries[0].lifecycle_state, 'recovery_required');
  assert.notEqual(timed.adapter.input({ source: 'interactive', text: 'inspect timeout' }, timed.ctx)?.action, 'handled');

  const active = await make(); active.busy();
  // Normal WAL writer contention: lookups work, but the replay write after
  // native input fails. Local acceptance must already be durable and retained.
  holder = new DatabaseSync(process.env.GOLEM_TYPED_DELIVERY_TOMBSTONES_DB);
  holder.exec('BEGIN IMMEDIATE');
  const steered = await active.post('steer');
  assert.equal(steered.body.accepted, true);
  assert.equal(active.sent.length, 1);
  assert.equal(active.adapter.readRecord().inbox.deliveries[0].lifecycle_state, 'accepted');
  assert.equal(active.adapter.deliveryReady(), false);
  holder.exec('ROLLBACK'); holder.close(); holder = null;
  assert.equal(active.adapter.recoverStorage(), true);
  assert.equal(active.adapter.deliveryReady(), true);
  const rename = fs.renameSync;
  let terminalFault = true;
  fs.renameSync = (from, to) => {
    if (terminalFault && to === active.adapter.recordFile) {
      terminalFault = false;
      throw new Error('injected terminal record write failure');
    }
    return rename(from, to);
  };
  try { await active.settle(); } finally { fs.renameSync = rename; }
  assert.ok(active.adapter.pendingRecord, 'terminal fact retained in memory for retry');
  assert.equal(active.adapter.deliveryReady(), false);
  assert.equal(active.adapter.recoverStorage(), true);
  assert.equal(active.adapter.readRecord().inbox.deliveries[0].lifecycle_state, 'settled');
  assert.equal(active.adapter.deliveryReady(), true);
  assert.equal((await active.post('steer', 'attempt-b')).body.delivery_state, 'settled');
  assert.equal(active.sent.length, 1);
  console.log('post-input replay contention and terminal-write failure heal without duplicate input: passed');

  let callbackCount = 0, releaseReport, arrived, rejectAcknowledgement = false;
  const reportArrived = new Promise((resolve) => { arrived = resolve; });
  callbackServer = http.createServer((req, res) => {
    req.resume(); callbackCount += 1;
    releaseReport = () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: !rejectAcknowledgement, lifecycle: 'settled', settled: true })); };
    if (callbackCount === 1) arrived(); else releaseReport();
  });
  await new Promise((resolve) => callbackServer.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(root, 'dashboard.json'), JSON.stringify({ url: `http://127.0.0.1:${callbackServer.address().port}` }));
  const concurrent = await make();
  await concurrent.post('first'); await concurrent.start('first');
  const settling = concurrent.settle();
  await reportArrived;
  assert.equal((await concurrent.post('next')).body.accepted, true);
  releaseReport(); await settling;
  assert.ok(concurrent.adapter.readRecord().inbox.deliveries.some((d) => d.envelope_id === 'next'), 'terminal callback must not overwrite a new admission');
  await concurrent.adapter.flushTerminalReports();
  assert.equal(callbackCount, 1, 'acknowledged terminal facts are not rewritten through the replay DB on every heartbeat');
  rejectAcknowledgement = true;
  const unconfirmed = await make();
  await unconfirmed.post('unconfirmed'); await unconfirmed.start('unconfirmed'); await unconfirmed.settle();
  assert.notEqual(unconfirmed.adapter.readRecord().inbox.deliveries[0].terminal_reported, true, 'HTTP200 alone is not a durable terminal acknowledgement');
  rejectAcknowledgement = false;
  await unconfirmed.adapter.flushTerminalReports();
  assert.equal(unconfirmed.adapter.readRecord().inbox.deliveries[0].terminal_reported, true);
  assert.equal(unconfirmed.sent.length, 1);
  console.log('terminal callback concurrency and acknowledged-report suppression: passed');
} finally {
  if (holder) { try { holder.exec('ROLLBACK'); } catch {} holder.close(); }
  for (const adapter of adapters) {
    clearInterval(adapter.heartbeat); clearTimeout(adapter.pendingAcceptance?.timer); clearTimeout(adapter.pendingControl?.timer);
    if (adapter.endpoint) await closeTypedWorkerEndpoint(adapter.endpoint.server);
  }
  if (callbackServer) await new Promise((resolve) => callbackServer.close(resolve));
  closeTypedDeliveryStores();
  fs.rmSync(root, { recursive: true, force: true });
}
