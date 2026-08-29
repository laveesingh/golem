#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const server = path.join(repo, 'dashboard/server/index.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-smoke-gol4-'));
const state = path.join(temp, 'state');
const project = path.join(temp, 'project');
const tracker = path.join(temp, 'tracker.db');
const port = 7842;
let child;

fs.mkdirSync(state, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# GOL-4 Smoke Project\n');

process.env.GOLEM_HOME = state;
process.env.GOLEM_TRACKER_DB = tracker;

const { claimWorker, updateWorker } = await import('../../lib/worker-registry.js');
const { projectIdFor } = await import('../../lib/project-id.js');
const typed = await import('../../lib/typed-worker-endpoint.js');
const facts = await import('../../lib/session-facts.js');
const projectId = projectIdFor(project);

fs.writeFileSync(path.join(state, 'projects.json'), JSON.stringify({
  projects: [{ id: projectId, name: 'GOL-4 Smoke Project', path: project, kind: 'auto' }],
}));

const worker = claimWorker({
  role: 'builder',
  projectId,
  projectRoot: project,
  cwd: project,
  name: 'smoke-builder1',
  preset: { harness: 'pi', provider: 'ollama', model: 'deepseek-v4-flash', thinking: 'medium', name: 'smoke-builder1' },
});

const sessionId = 'session-smoke-gol4-001';
const ownerToken = 'token-smoke-gol4-001';
updateWorker(worker.worker_id, {
  session_id: sessionId,
  state: 'live',
});

facts.upsertSessionFact({
  canonical_id: sessionId,
  continuation_key: 'continuation-smoke-gol4',
  harness: 'pi',
  locator: { raw_session_id: sessionId, session_file: path.join(state, 'pi-sessions', 'smoke.jsonl') },
  project_path: project,
  name: 'smoke-builder1',
  status: 'busy',
  provider: 'ollama',
  model: 'deepseek-v4-flash',
  delivery: { mode: 'typed-worker', push: true, ready: true },
  capabilities: { typed_worker: true, typed_worker_protocol: typed.TYPED_WORKER_PROTOCOL_VERSION },
  trust: 'host-full-trust',
  lifecycle_event: 'agent_turn_started',
  observations: { adapter_state: 'active', delivery_state: 'accepted', pi_version: '0.84.3', extension_version: '5.12.0' },
  observed_at: new Date().toISOString(),
});

const receivedEnvelopes = [];
const endpoint = await typed.startTypedWorkerEndpoint({
  canonicalId: sessionId,
  ownerToken,
  kind: 'typed-worker',
  deliveryReady: () => true,
  acceptDelivery: async (envelope) => {
    receivedEnvelopes.push(envelope);
    return {
      ok: true,
      accepted: true,
      http_status: 200,
      envelope_id: envelope.envelope_id,
      attempt_id: envelope.attempt_id,
      turn_id: 'turn-smoke-1',
      delivery_state: 'accepted',
    };
  },
});

fs.writeFileSync(path.join(state, 'sessions.json'), JSON.stringify({
  sessions: [{
    session_id: sessionId,
    name: 'smoke-builder1',
    harness: 'pi',
    project_path: project,
    status: 'busy',
    role: 'builder',
    last_seen_at: new Date().toISOString(),
  }],
}));

function startServer() {
  child = spawn(process.execPath, [server], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      GOLEM_HOME: state,
      GOLEM_TRACKER_DB: tracker,
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Server failed to start');
}

async function request(urlPath, options = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

try {
  startServer();
  await waitForHealth();

  // 1. Test terminal peek endpoint for registered session
  const terminalRes = await request(`/api/native-sessions/${sessionId}/terminal?lines=50`);
  assert.equal(terminalRes.status, 200);
  assert.equal(terminalRes.body.session_id, sessionId);
  assert.equal(terminalRes.body.lines, 50);

  // 2. Test sending message / steer to background agent
  const messageRes = await request(`/api/native-sessions/${sessionId}/message`, {
    method: 'POST',
    body: JSON.stringify({ text: 'Please summarize test status' }),
  });
  assert.equal(messageRes.status, 200);
  assert.equal(messageRes.body.ok, true);

  // 3. Test interrupt endpoint
  const interruptRes = await request(`/api/native-sessions/${sessionId}/interrupt`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(interruptRes.status, 200);
  assert.equal(interruptRes.body.ok, true);

  console.log('✅ GOL-4 background agent peek & interaction smoke tests passed successfully!');
} finally {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
  }
  if (endpoint?.server) {
    await typed.closeTypedWorkerEndpoint(endpoint.server);
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
