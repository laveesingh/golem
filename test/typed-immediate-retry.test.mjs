import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
  acceptTypedDelivery,
  claimTypedDelivery,
  closeTypedWorkerEndpoint,
  normalizeTypedWorkerInbox,
  settleTypedDelivery,
  startTypedWorkerEndpoint,
  TYPED_WORKER_PROTOCOL_VERSION,
  typedDeliveryResult,
} from '../lib/typed-worker-endpoint.js';
import { readTypedDeliveryTombstone, upsertTypedDeliveryTombstone } from '../lib/typed-delivery-tombstones.js';
import { releaseEndpointLeases, renewEndpointLease, upsertSessionFact } from '../lib/session-facts.js';

// GOL-124 round-four production journey: a real dashboard's immediate route
// loses the first typed response after native acceptance. It must queue the
// original durable envelope, then the normal drainer may retry that same id
// without creating a second native turn.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-typed-immediate-'));
const state = path.join(temp, 'state');
const dashboardDb = path.join(temp, 'tracker.db');
const previous = {
  GOLEM_HOME: process.env.GOLEM_HOME,
  GOLEM_TRACKER_DB: process.env.GOLEM_TRACKER_DB,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};
process.env.GOLEM_HOME = state;
process.env.GOLEM_TRACKER_DB = dashboardDb;
process.env.XDG_CONFIG_HOME = path.join(temp, 'xdg');
fs.mkdirSync(state, { recursive: true });

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function unusedPort() {
  const { createServer } = await import('node:http');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function postJson(baseUrl, pathname, body, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* assertion below prints text */ }
  return { response, json, text };
}

async function waitForRetry(envelopeId, label) {
  return waitFor(() => {
    const db = new Database(dashboardDb, { readonly: true });
    try {
      const row = db.prepare('SELECT * FROM envelope_delivery_retries WHERE envelope_id = ?').get(envelopeId);
      return row?.status === 'delivered' ? row : null;
    } finally {
      db.close();
    }
  }, label, 20_000);
}

async function startDashboard(port) {
  let stderr = '';
  const child = spawn(process.execPath, ['dashboard/server/index.js'], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      GOLEM_HOME: state,
      GOLEM_TRACKER_DB: dashboardDb,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${baseUrl}/api/health`)).ok, `dashboard health (${stderr})`, 15_000);
  return { child, baseUrl, stderr: () => stderr };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const canonicalId = 'typed-immediate-lost-response';
const ownerToken = 'typed-immediate-owner-token';
let inbox = normalizeTypedWorkerInbox();
let nativeStarts = 0;
let endpointRequests = 0;
let dropFirstResponse = true;
let dropNextResponse = false;
let hangNextResponse = false;
let hangingResponse = false;
let releaseHangingResponse = null;
let nextResponseStatus = 202;
let forceBusy = false;
let pauseAfterNativeAcceptance = false;
let forceBusyAfterDuplicateEnvelopeId = null;
let endpoint;
let dashboard;

async function acceptNative(envelope) {
  const claim = claimTypedDelivery(inbox, envelope, {
    lookupTombstone: (envelopeId) => readTypedDeliveryTombstone(canonicalId, envelopeId),
  });
  if (claim.duplicate) {
    const result = typedDeliveryResult(claim.delivery, { duplicate: true, attemptId: envelope.attempt_id });
    if (forceBusyAfterDuplicateEnvelopeId === envelope.envelope_id) forceBusy = true;
    return result;
  }
  assert.equal(claim.busy, false, 'the controlled native worker is idle for its initial acceptance');
  nativeStarts += 1;
  const accepted = acceptTypedDelivery(inbox, envelope.envelope_id, { turnId: `native-${nativeStarts}` });
  upsertTypedDeliveryTombstone(canonicalId, accepted.delivery);
  const settled = settleTypedDelivery(inbox, envelope.envelope_id, { turnId: accepted.delivery.turn_id });
  upsertTypedDeliveryTombstone(canonicalId, settled.delivery);
  if (pauseAfterNativeAcceptance) forceBusy = true;
  return typedDeliveryResult(settled.delivery, { httpStatus: 202, attemptId: envelope.attempt_id });
}

try {
  endpoint = await startTypedWorkerEndpoint({
    canonicalId,
    ownerToken,
    kind: 'typed-worker',
    deliveryReady: () => !inbox.in_flight_envelope_id && !forceBusy,
    acceptDelivery: acceptNative,
    // The production endpoint owns authentication and schema validation. This
    // test-only response-loss seam runs after the authenticated health path so
    // the dashboard sees a real typed lease, while simulating bytes lost after
    // the native adapter accepted the first request.
    onRequest: async ({ request, response, url, readBody, sendJson, sameSecret }) => {
      if (url.pathname !== '/brief' || request.method !== 'POST') return false;
      assert.equal(request.headers['x-sender'], 'dashboard');
      assert.equal(request.headers['x-golem-target-session'], canonicalId);
      assert.equal(sameSecret(String(request.headers['x-golem-endpoint-owner'] || ''), ownerToken), true);
      const envelope = JSON.parse(await readBody());
      assert.equal(envelope.protocol_version, TYPED_WORKER_PROTOCOL_VERSION, 'dashboard emits the shared protocol version on every attempt');
      endpointRequests += 1;
      const result = await acceptNative(envelope);
      if (dropFirstResponse || dropNextResponse) {
        dropFirstResponse = false;
        dropNextResponse = false;
        response.destroy();
      } else if (hangNextResponse) {
        hangNextResponse = false;
        hangingResponse = true;
        await new Promise((resolve) => { releaseHangingResponse = resolve; });
      } else {
        sendJson(nextResponseStatus, result);
        nextResponseStatus = 202;
      }
      return true;
    },
  });
  renewEndpointLease({
    canonical_id: canonicalId,
    owner_token: ownerToken,
    host: endpoint.host,
    port: endpoint.port,
    kind: 'typed-worker',
    harness: 'pi',
  });
  upsertSessionFact({
    canonical_id: canonicalId,
    continuation_key: `typed-immediate:${canonicalId}`,
    harness: 'pi',
    locator: { raw_session_id: canonicalId },
    project_path: repo,
    status: 'idle',
    capabilities: { typed_worker: true, typed_worker_protocol: TYPED_WORKER_PROTOCOL_VERSION },
    delivery: { mode: 'typed-worker', push: true },
    provider: 'ollama', model: 'deepseek-v4-flash:0731-cloud', trust: 'host-full-trust',
    observations: { pi_version: '0.80.10', extension_version: '5.6.14' },
  });

  dashboard = await startDashboard(await unusedPort());
  await waitFor(async () => {
    const response = await fetch(`${dashboard.baseUrl}/api/native-sessions`);
    const sessions = response.ok ? await response.json() : [];
    return sessions.find((session) => session.session_id === canonicalId && session.alive) || null;
  }, `typed target discovery (${dashboard.stderr()})`);

  // The shared drainer deliberately applies a 60s per-session retry cooldown.
  // Each independent producer scenario below therefore gets a fresh temporary
  // dashboard process; this keeps the journey fast without weakening the
  // production scheduling rule that is covered separately by the drainer test.
  async function restartDashboardForIndependentRetry() {
    await stopProcess(dashboard?.child);
    dashboard = await startDashboard(await unusedPort());
    await waitFor(async () => {
      const response = await fetch(`${dashboard.baseUrl}/api/native-sessions`);
      const sessions = response.ok ? await response.json() : [];
      return sessions.find((session) => session.session_id === canonicalId && session.alive) || null;
    }, `typed target rediscovery (${dashboard.stderr()})`);
  }

  const created = await fetch(`${dashboard.baseUrl}/api/tickets`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: 'typed-immediate-000000', kind: 'task',
      title: 'typed immediate lost response', body: 'controlled production journey', created_by: 'human',
    }),
  });
  assert.equal(created.status, 201);
  const ticket = await created.json();
  const dispatched = await fetch(`${dashboard.baseUrl}/api/tickets/${encodeURIComponent(ticket.id)}/dispatch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: canonicalId, note: 'controlled native delivery; do not perform work' }),
  });
  assert.equal(dispatched.status, 200);
  const first = await dispatched.json();
  assert.equal(first.delivered, false, JSON.stringify(first));
  assert.equal(first.queued, true, 'ambiguous immediate typed delivery retains work in the shared queue');
  assert.equal(first.delivery.mode, 'shared_queue');
  assert.equal(nativeStarts, 1, 'the lost response happened after exactly one native start');
  assert.equal(endpointRequests, 1);
  assert.equal(fs.existsSync(path.join(state, 'pi-inbox', canonicalId)), false, 'the production Pi route never creates a second filesystem inbox');

  const immediateQueue = new Database(dashboardDb, { readonly: true });
  try {
    const row = immediateQueue.prepare('SELECT envelope_id, status FROM dispatch_queue WHERE ticket_id = ?').get(ticket.id);
    assert.equal(row?.envelope_id, first.envelope_id, 'the retry queue retains the original immutable envelope id');
    assert.equal(row?.status, 'pending');
    assert.equal(immediateQueue.prepare('SELECT COUNT(*) AS n FROM message_envelopes WHERE ticket_id = ?').get(ticket.id).n, 1, 'the failure does not mint a second envelope lineage');
  } finally {
    immediateQueue.close();
  }

  await waitFor(() => {
    const db = new Database(dashboardDb, { readonly: true });
    try {
      const row = db.prepare('SELECT envelope_id, status FROM dispatch_queue WHERE ticket_id = ?').get(ticket.id);
      return row?.status === 'delivered' ? row : null;
    } finally {
      db.close();
    }
  }, `shared retry of original envelope (${dashboard.stderr()})`, 15_000);
  assert.equal(endpointRequests, 2, 'the generic drainer retried the retained envelope once');
  assert.equal(nativeStarts, 1, 'the duplicate-safe retry did not start a second native turn');
  assert.equal(inbox.deliveries.filter((delivery) => delivery.envelope_id === first.envelope_id).length, 1, 'one native delivery mapping survives the lost response and retry');

  await restartDashboardForIndependentRetry();

  // The same original-envelope path serves every non-ticket producer. These
  // are real dashboard requests; the endpoint drops each first response only
  // after accepting and settling the native turn.
  async function assertOriginalRetry(label, send, envelopeIdFor) {
    const startsBefore = nativeStarts;
    const requestsBefore = endpointRequests;
    dropNextResponse = true;
    const result = await send();
    const envelopeId = envelopeIdFor(result);
    assert.ok(envelopeId, `${label} returns/creates a durable envelope id`);
    assert.equal(nativeStarts, startsBefore + 1, `${label} first request starts one native turn before its response is lost`);
    const beforeRetry = new Database(dashboardDb, { readonly: true });
    try {
      const row = beforeRetry.prepare('SELECT status FROM envelope_delivery_retries WHERE envelope_id = ?').get(envelopeId);
      assert.equal(row?.status, 'pending', `${label} retains the original envelope in the shared retry queue`);
    } finally { beforeRetry.close(); }
    await waitForRetry(envelopeId, `${label} original-envelope retry (${dashboard.stderr()})`);
    assert.equal(endpointRequests, requestsBefore + 2, `${label} retries the original envelope once`);
    assert.equal(nativeStarts, startsBefore + 1, `${label} duplicate retry does not create a second native turn`);
    assert.equal(inbox.deliveries.filter((delivery) => delivery.envelope_id === envelopeId).length, 1, `${label} has one native envelope mapping`);
    return { result, envelopeId };
  }

  const notification = await assertOriginalRetry('notification', () => postJson(dashboard.baseUrl, '/api/messages/notify', {
    project_id: 'typed-immediate-000000', sender_id: 'typed-notify-source', session_id: canonicalId, text: 'lost response notification',
  }), ({ json }) => json?.envelope_id);
  assert.equal(notification.result.response.status, 200, notification.result.text);
  assert.equal(notification.result.json?.queued, true, notification.result.text);

  await restartDashboardForIndependentRetry();

  const control = await assertOriginalRetry('control', () => postJson(dashboard.baseUrl, '/api/messages/control', {
    project_id: 'typed-immediate-000000', sender_id: 'typed-control-source', session_id: canonicalId,
    kind: 'session_notify', content: 'lost response control', metadata: { notification_text: 'lost response control' },
    legacy: { path: '/brief', body: 'lost response control' },
  }), ({ json }) => json?.envelope_id);
  assert.equal(control.result.response.status, 200, control.result.text);
  assert.equal(control.result.json?.queued, true, control.result.text);

  await restartDashboardForIndependentRetry();

  const commentTicket = await postJson(dashboard.baseUrl, '/api/tickets', {
    project_id: 'typed-immediate-000000', kind: 'task', title: 'typed comment retry', body: 'controlled', created_by: 'human',
  });
  assert.equal(commentTicket.response.status, 201, commentTicket.text);
  const createdComment = await postJson(dashboard.baseUrl, `/api/tickets/${encodeURIComponent(commentTicket.json.id)}/comments`, {
    author: 'human', body: 'lost response comment', tag: 'note', status: 'open',
  });
  assert.equal(createdComment.response.status, 201, createdComment.text);
  const comment = await assertOriginalRetry('comment dispatch', () => postJson(
    dashboard.baseUrl,
    `/api/comments/${encodeURIComponent(createdComment.json.id)}/dispatch`,
    { session_id: canonicalId },
  ), () => {
    const db = new Database(dashboardDb, { readonly: true });
    try {
      return db.prepare(`SELECT envelope_id FROM envelope_delivery_retries
        WHERE content LIKE ? ORDER BY rowid DESC LIMIT 1`).get('%lost response comment%')?.envelope_id ?? null;
    } finally { db.close(); }
  });
  assert.equal(comment.result.response.status, 502, comment.result.text);
  assert.equal(comment.result.json?.rolled_back, 0, comment.result.text);
  const commentAfterRetry = await (await fetch(`${dashboard.baseUrl}/api/tickets/${encodeURIComponent(commentTicket.json.id)}`)).json();
  const commentRetryDb = new Database(dashboardDb, { readonly: true });
  const commentDispatchDebug = commentRetryDb.prepare('SELECT status FROM comment_dispatches WHERE comment_id = ?').all(createdComment.json.id);
  commentRetryDb.close();
  assert.equal(commentAfterRetry.comments.find((entry) => entry.id === createdComment.json.id)?.dispatch_state, 'dispatched', 'comment stays visibly dispatched until the worker addresses it');
  assert.deepEqual(commentDispatchDebug.map((row) => row.status), ['delivered'], 'comment retry settles its original dispatch after correlated acceptance');

  // An accepted 503 is a completed typed opportunity, not a failed HTTP
  // notification: it reports success and settles its exact durable owners through the
  // same accepted-delivery predicate.
  nextResponseStatus = 503;
  const accepted503 = await postJson(dashboard.baseUrl, '/api/messages/notify', {
    project_id: 'typed-immediate-000000', sender_id: 'typed-notify-503', session_id: canonicalId, text: 'accepted 503 notification',
  });
  assert.equal(accepted503.response.status, 200, accepted503.text);
  assert.equal(accepted503.json?.ok, true, accepted503.text);
  assert.equal(accepted503.json?.queued, false, accepted503.text);
  nextResponseStatus = 503;
  const accepted503Control = await postJson(dashboard.baseUrl, '/api/messages/control', {
    project_id: 'typed-immediate-000000', sender_id: 'typed-control-503', session_id: canonicalId,
    kind: 'session_notify', content: 'accepted 503 control', metadata: { notification_text: 'accepted 503 control' },
    legacy: { path: '/brief', body: 'accepted 503 control' },
  });
  assert.equal(accepted503Control.response.status, 200, accepted503Control.text);
  assert.equal(accepted503Control.json?.ok, true, accepted503Control.text);
  assert.equal(accepted503Control.json?.queued, false, accepted503Control.text);

  // A typed capability survives a clean lease-release/rebind gap. Non-ticket
  // controls retain their original durable envelope instead of trying a
  // legacy route, then deliver once the same worker re-registers its lease.
  await restartDashboardForIndependentRetry();
  const startsBeforeLeaseGap = nativeStarts;
  const requestsBeforeLeaseGap = endpointRequests;
  releaseEndpointLeases(ownerToken, { canonicalId });
  const leaseGap = await postJson(dashboard.baseUrl, '/api/messages/notify', {
    project_id: 'typed-immediate-000000', sender_id: 'typed-lease-gap-source', session_id: canonicalId,
    text: 'typed capability lease gap notification',
  });
  assert.equal(leaseGap.response.status, 200, leaseGap.text);
  assert.equal(leaseGap.json?.queued, true, leaseGap.text);
  const leaseGapRetry = new Database(dashboardDb, { readonly: true });
  try {
    const row = leaseGapRetry.prepare('SELECT status, require_typed FROM envelope_delivery_retries WHERE envelope_id = ?').get(leaseGap.json?.envelope_id);
    assert.equal(row?.status, 'pending', 'lease-gap control retains the original envelope while no endpoint is reachable');
    assert.equal(row?.require_typed, 1, 'sticky typed capability fences the retry from a legacy fallback');
  } finally { leaseGapRetry.close(); }
  assert.equal(nativeStarts, startsBeforeLeaseGap, 'no native turn starts while the typed lease is absent');
  assert.equal(endpointRequests, requestsBeforeLeaseGap, 'no endpoint request is attempted through the lease gap');
  renewEndpointLease({
    canonical_id: canonicalId, owner_token: ownerToken, host: endpoint.host, port: endpoint.port,
    kind: 'typed-worker', harness: 'pi',
  });
  await waitForRetry(leaseGap.json.envelope_id, `lease-gap typed retry (${dashboard.stderr()})`);
  assert.equal(nativeStarts, startsBeforeLeaseGap + 1, 'rebound typed lease accepts the original non-ticket envelope once');
  assert.equal(endpointRequests, requestsBeforeLeaseGap + 1, 'shared retry uses the generic typed endpoint after rebind');

  // Both an immediate ticket queue and its original-envelope retry are owned
  // before transport. Kill the real isolated dashboard after native acceptance
  // but before its response/settlement; restart must finish stored settlement
  // without a second native turn.
  await restartDashboardForIndependentRetry();
  const startsBeforeCrash = nativeStarts;
  const requestsBeforeCrash = endpointRequests;
  hangingResponse = false;
  hangNextResponse = true;
  const crashTicket = await postJson(dashboard.baseUrl, '/api/tickets', {
    project_id: 'typed-immediate-000000', kind: 'task', title: 'typed immediate ticket crash window', body: 'controlled', created_by: 'human',
  });
  assert.equal(crashTicket.response.status, 201, crashTicket.text);
  const crashRequest = fetch(`${dashboard.baseUrl}/api/tickets/${encodeURIComponent(crashTicket.json.id)}/dispatch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: canonicalId, note: 'crash after native acceptance before response' }),
  }).catch((error) => ({ error }));
  await waitFor(() => hangingResponse && nativeStarts === startsBeforeCrash + 1, 'native acceptance before dashboard crash');
  const crashEnvelope = new Database(dashboardDb, { readonly: true });
  let crashEnvelopeId;
  try {
    const row = crashEnvelope.prepare(`SELECT envelope_id, status, publishing_owner
      FROM envelope_delivery_retries WHERE content LIKE ? ORDER BY rowid DESC LIMIT 1`).get('%crash after native acceptance%');
    crashEnvelopeId = row?.envelope_id;
    assert.equal(row?.status, 'publishing', 'retry ownership is durably leased before transport starts');
    assert.ok(row?.publishing_owner, 'the pre-transport retry row has an owner for crash recovery');
    const queue = crashEnvelope.prepare('SELECT status, publishing_owner FROM dispatch_queue WHERE envelope_id = ?').get(crashEnvelopeId);
    assert.equal(queue?.status, 'publishing', 'immediate ticket queue ownership is durably leased before transport starts');
    assert.ok(queue?.publishing_owner, 'immediate ticket queue retains an owner across the crash window');
  } finally { crashEnvelope.close(); }
  const crashedDashboard = dashboard;
  crashedDashboard.child.kill('SIGKILL');
  await waitFor(() => crashedDashboard.child.exitCode !== null || crashedDashboard.child.signalCode != null, 'isolated dashboard crash');
  releaseHangingResponse?.();
  await crashRequest;
  const expireCrashLease = new Database(dashboardDb);
  try {
    expireCrashLease.prepare("UPDATE envelope_delivery_retries SET publishing_expires_at = '2000-01-01T00:00:00.000Z' WHERE envelope_id = ?").run(crashEnvelopeId);
  } finally { expireCrashLease.close(); }
  dashboard = await startDashboard(await unusedPort());
  await waitFor(async () => {
    const response = await fetch(`${dashboard.baseUrl}/api/native-sessions`);
    const sessions = response.ok ? await response.json() : [];
    return sessions.find((session) => session.session_id === canonicalId && session.alive) || null;
  }, `typed target restart discovery (${dashboard.stderr()})`);
  await waitForRetry(crashEnvelopeId, `crash-window original-envelope recovery (${dashboard.stderr()})`);
  const settledCrashQueue = new Database(dashboardDb, { readonly: true });
  try {
    assert.equal(settledCrashQueue.prepare('SELECT status FROM dispatch_queue WHERE envelope_id = ?').get(crashEnvelopeId)?.status, 'delivered',
      'restart applies the owned ticket settlement before resolving its retry');
  } finally { settledCrashQueue.close(); }
  assert.equal(nativeStarts, startsBeforeCrash + 1, 'crash recovery retries the accepted envelope as a duplicate, never a second native turn');
  assert.equal(endpointRequests, requestsBeforeCrash + 2, 'dashboard restart reclaims and republishes the original owned retry once');

  // The regular `when_idle` queue has the same pre-transport ownership as
  // immediate dispatch. Keep it unreachable long enough to create a durable
  // queued row, then kill the real dashboard after its later native acceptance
  // but before the response/settlement. Restart must settle queue + retry once.
  await restartDashboardForIndependentRetry();
  const startsBeforeQueuedCrash = nativeStarts;
  const requestsBeforeQueuedCrash = endpointRequests;
  releaseEndpointLeases(ownerToken, { canonicalId });
  const queuedCrashTicket = await postJson(dashboard.baseUrl, '/api/tickets', {
    project_id: 'typed-immediate-000000', kind: 'task', title: 'typed queued ticket crash window', body: 'controlled', created_by: 'human',
  });
  assert.equal(queuedCrashTicket.response.status, 201, queuedCrashTicket.text);
  const queuedCrashDispatch = await postJson(
    dashboard.baseUrl,
    `/api/tickets/${encodeURIComponent(queuedCrashTicket.json.id)}/dispatch`,
    { session_id: canonicalId, mode: 'when_idle', note: 'queued crash after native acceptance before response' },
  );
  assert.equal(queuedCrashDispatch.response.status, 200, queuedCrashDispatch.text);
  assert.equal(queuedCrashDispatch.json?.queued, true, queuedCrashDispatch.text);
  assert.equal(nativeStarts, startsBeforeQueuedCrash, 'unreachable when_idle ticket remains queued before the endpoint rebinds');
  hangNextResponse = true;
  renewEndpointLease({
    canonical_id: canonicalId, owner_token: ownerToken, host: endpoint.host, port: endpoint.port,
    kind: 'typed-worker', harness: 'pi',
  });
  await waitFor(() => hangingResponse && nativeStarts === startsBeforeQueuedCrash + 1,
    'queued ticket native acceptance before dashboard crash');
  const queuedCrashDb = new Database(dashboardDb, { readonly: true });
  let queuedCrashEnvelopeId;
  try {
    queuedCrashEnvelopeId = queuedCrashDispatch.json?.envelope_id;
    const retry = queuedCrashDb.prepare('SELECT status, publishing_owner, settlement_json FROM envelope_delivery_retries WHERE envelope_id = ?').get(queuedCrashEnvelopeId);
    assert.equal(retry?.status, 'publishing', 'queued typed ticket reserves original retry ownership before endpoint transport');
    assert.ok(retry?.publishing_owner, 'queued typed retry retains its crash-recovery owner');
    const settlement = JSON.parse(retry.settlement_json);
    assert.equal(settlement?.queue?.id, queuedCrashDispatch.json?.queue_id, 'queued retry stores the exact queue owner for post-acceptance settlement');
    const queue = queuedCrashDb.prepare('SELECT status, publishing_owner FROM dispatch_queue WHERE id = ?').get(queuedCrashDispatch.json?.queue_id);
    assert.equal(queue?.status, 'publishing', 'ordinary queued ticket remains publishing until durable settlement');
    assert.ok(queue?.publishing_owner, 'ordinary queued ticket keeps its pre-transport queue owner');
  } finally { queuedCrashDb.close(); }
  const queuedCrashedDashboard = dashboard;
  queuedCrashedDashboard.child.kill('SIGKILL');
  await waitFor(() => queuedCrashedDashboard.child.exitCode !== null || queuedCrashedDashboard.child.signalCode != null, 'queued isolated dashboard crash');
  releaseHangingResponse?.();
  const expireQueuedCrash = new Database(dashboardDb);
  try {
    expireQueuedCrash.prepare("UPDATE envelope_delivery_retries SET publishing_expires_at = '2000-01-01T00:00:00.000Z' WHERE envelope_id = ?").run(queuedCrashEnvelopeId);
    expireQueuedCrash.prepare("UPDATE dispatch_queue SET publishing_expires_at = '2000-01-01T00:00:00.000Z' WHERE envelope_id = ?").run(queuedCrashEnvelopeId);
  } finally { expireQueuedCrash.close(); }
  dashboard = await startDashboard(await unusedPort());
  await waitFor(async () => {
    const response = await fetch(`${dashboard.baseUrl}/api/native-sessions`);
    const sessions = response.ok ? await response.json() : [];
    return sessions.find((session) => session.session_id === canonicalId && session.alive) || null;
  }, `queued typed target restart discovery (${dashboard.stderr()})`);
  await waitForRetry(queuedCrashEnvelopeId, `queued ticket crash-window recovery (${dashboard.stderr()})`);
  const settledQueuedCrash = new Database(dashboardDb, { readonly: true });
  try {
    assert.equal(settledQueuedCrash.prepare('SELECT status FROM dispatch_queue WHERE id = ?').get(queuedCrashDispatch.json?.queue_id)?.status, 'delivered',
      'settleDurableEnvelope delivers the ordinary queued row only after retained settlement completes');
  } finally { settledQueuedCrash.close(); }
  assert.equal(nativeStarts, startsBeforeQueuedCrash + 1, 'queued crash recovery preserves one native turn');
  assert.equal(endpointRequests, requestsBeforeQueuedCrash + 2, 'queued crash recovery retries the original immutable ticket envelope once');

  // An older comment retry must only CAS its own immutable dispatch id. Queue
  // a newer comment for the same ticket/session while the first accepted
  // response is lost, then allow only the older retry to settle.
  await restartDashboardForIndependentRetry();
  const exactCommentTicket = await postJson(dashboard.baseUrl, '/api/tickets', {
    project_id: 'typed-immediate-000000', kind: 'task', title: 'typed exact comment settlement', body: 'controlled', created_by: 'human',
  });
  assert.equal(exactCommentTicket.response.status, 201, exactCommentTicket.text);
  const olderComment = await postJson(dashboard.baseUrl, `/api/tickets/${encodeURIComponent(exactCommentTicket.json.id)}/comments`, {
    author: 'human', body: 'older lost-response comment', tag: 'note', status: 'open',
  });
  assert.equal(olderComment.response.status, 201, olderComment.text);
  pauseAfterNativeAcceptance = true;
  dropNextResponse = true;
  const olderDispatch = await postJson(dashboard.baseUrl, `/api/comments/${encodeURIComponent(olderComment.json.id)}/dispatch`, { session_id: canonicalId });
  assert.equal(olderDispatch.response.status, 502, olderDispatch.text);
  assert.equal(olderDispatch.json?.rolled_back, 0, olderDispatch.text);
  assert.equal(forceBusy, true, 'the fixture holds the worker after the older native acceptance so its retry cannot settle before the newer batch exists');
  const newerComment = await postJson(dashboard.baseUrl, `/api/tickets/${encodeURIComponent(exactCommentTicket.json.id)}/comments`, {
    author: 'human', body: 'newer pending comment', tag: 'note', status: 'open',
  });
  assert.equal(newerComment.response.status, 201, newerComment.text);
  const newerDispatch = await postJson(dashboard.baseUrl, `/api/comments/${encodeURIComponent(newerComment.json.id)}/dispatch`, { session_id: canonicalId });
  assert.equal(newerDispatch.response.status, 502, newerDispatch.text);
  assert.equal(newerDispatch.json?.rolled_back, 0, newerDispatch.text);
  const exactCommentDb = new Database(dashboardDb, { readonly: true });
  let olderEnvelopeId;
  let olderDispatchId;
  let newerDispatchId;
  try {
    olderEnvelopeId = exactCommentDb.prepare(`SELECT envelope_id FROM envelope_delivery_retries
      WHERE content LIKE ? ORDER BY rowid DESC LIMIT 1`).get('%older lost-response comment%')?.envelope_id;
    olderDispatchId = exactCommentDb.prepare('SELECT id FROM comment_dispatches WHERE comment_id = ?').get(olderComment.json.id)?.id;
    newerDispatchId = exactCommentDb.prepare('SELECT id FROM comment_dispatches WHERE comment_id = ?').get(newerComment.json.id)?.id;
    const settlement = JSON.parse(exactCommentDb.prepare('SELECT settlement_json FROM envelope_delivery_retries WHERE envelope_id = ?').get(olderEnvelopeId)?.settlement_json || 'null');
    assert.deepEqual(settlement?.comment_dispatch?.dispatch_ids, [olderDispatchId], 'older retry records only its exact comment-dispatch id');
    assert.equal(settlement?.comment_dispatch?.batch_id, null, 'single-comment settlement preserves its exact no-batch identity');
  } finally { exactCommentDb.close(); }
  pauseAfterNativeAcceptance = false;
  forceBusy = false;
  forceBusyAfterDuplicateEnvelopeId = olderEnvelopeId;
  await waitForRetry(olderEnvelopeId, `older exact comment retry (${dashboard.stderr()})`);
  const exactAfterOlder = new Database(dashboardDb, { readonly: true });
  try {
    assert.equal(exactAfterOlder.prepare('SELECT status FROM comment_dispatches WHERE id = ?').get(olderDispatchId)?.status, 'delivered',
      'older retry settles its own immutable comment-dispatch row');
    assert.equal(exactAfterOlder.prepare('SELECT status FROM comment_dispatches WHERE id = ?').get(newerDispatchId)?.status, 'pending',
      'older retry cannot advance a newer pending comment dispatch for the same ticket/session');
  } finally { exactAfterOlder.close(); }
  forceBusyAfterDuplicateEnvelopeId = null;
  forceBusy = false;
  // The shared drainer correctly applies its 60s one-opportunity cooldown
  // after the older retry. Restart the isolated dashboard to verify the newer
  // pending retry independently without weakening that production scheduler.
  await restartDashboardForIndependentRetry();
  const newerEnvelopeId = (() => {
    const db = new Database(dashboardDb, { readonly: true });
    try {
      return db.prepare(`SELECT envelope_id FROM envelope_delivery_retries
        WHERE content LIKE ? ORDER BY rowid DESC LIMIT 1`).get('%newer pending comment%')?.envelope_id;
    } finally { db.close(); }
  })();
  await waitForRetry(newerEnvelopeId, `newer exact comment retry (${dashboard.stderr()})`);

  // Terminal report can establish first lineage when acceptance HTTP was lost.
  // Keep the endpoint not-ready so the drainer cannot repair this by replay.
  pauseAfterNativeAcceptance = true;
  dropNextResponse = true;
  const callbackStarts = nativeStarts;
  const lostAdmission = await postJson(dashboard.baseUrl, '/api/messages/notify', {
    project_id: 'typed-immediate-000000', sender_id: 'callback-source', session_id: canonicalId,
    text: 'callback survives lost acceptance',
  });
  assert.equal(lostAdmission.json?.queued, true, lostAdmission.text);
  const callbackId = lostAdmission.json.envelope_id;
  const retained = inbox.deliveries.find((entry) => entry.envelope_id === callbackId);
  assert.equal(retained.accepted_attempt_id, readTypedDeliveryTombstone(canonicalId, callbackId).accepted_attempt_id);
  const terminalCallback = await postJson(dashboard.baseUrl, `/api/message-envelopes/${callbackId}/lifecycle`, {
    state: 'settled', attempt_id: retained.attempt_id, accepted_attempt_id: retained.accepted_attempt_id,
  }, { 'x-golem-target-session': canonicalId, 'x-golem-endpoint-owner': ownerToken });
  assert.equal(terminalCallback.response.status, 200, terminalCallback.text);
  await waitForRetry(callbackId, 'terminal callback settlement without acceptance response');
  const inspected = await fetch(`${dashboard.baseUrl}/api/message-envelopes/${callbackId}`);
  assert.equal(inspected.status, 200);
  const receipt = await inspected.json();
  assert.equal(receipt.envelope_id, callbackId);
  assert.equal(receipt.state, 'settled');
  assert.equal(Object.hasOwn(receipt, 'content'), false);
  const withContent = await (await fetch(`${dashboard.baseUrl}/api/message-envelopes/${callbackId}?view=receipt&content=1`)).json();
  assert.match(withContent.content, /callback survives lost acceptance/);
  assert.equal(nativeStarts, callbackStarts + 1);
  pauseAfterNativeAcceptance = false; forceBusy = false;

  console.log('typed immediate retry production journey passed: ticket/notification/control/comment lost response -> original shared envelope retry -> one native start; accepted-503, typed lease-gap, immediate+queued-ticket crash-after-accept settlement recovery, and exact older-comment CAS');
} finally {
  await stopProcess(dashboard?.child);
  await closeTypedWorkerEndpoint(endpoint?.server);
  if (previous.GOLEM_HOME == null) delete process.env.GOLEM_HOME; else process.env.GOLEM_HOME = previous.GOLEM_HOME;
  if (previous.GOLEM_TRACKER_DB == null) delete process.env.GOLEM_TRACKER_DB; else process.env.GOLEM_TRACKER_DB = previous.GOLEM_TRACKER_DB;
  if (previous.XDG_CONFIG_HOME == null) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME;
  fs.rmSync(temp, { recursive: true, force: true });
}
