import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '../mcp/channel/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../mcp/channel/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

// GOL-130, rebuilt for the Pi/Claude-only world (GOL-365): one isolated,
// behavior-level matrix over the real dashboard/SQLite and real channel
// processes. The Pi stand-in is the rendered golem extension on a real harness
// stub; the Claude stand-in is the real MCP channel child. Every leg proves
// canonical actor identity end to end.
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-cross-harness-matrix-'));
const home = path.join(temp, 'home');
const xdg = path.join(temp, 'xdg');
const dbPath = path.join(temp, 'tracker.db');
const project = path.join(temp, 'project');
const hooks = path.join(temp, 'hooks');
const channelEntrypoint = path.join(repo, 'mcp', 'channel', 'index.js');

function linkPiTui(render) {
  const piCli = fs.realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
  let current = path.dirname(piCli);
  let source = null;
  while (current && current !== path.dirname(current)) {
    const candidate = path.join(current, 'node_modules', '@earendil-works', 'pi-tui');
    if (fs.existsSync(candidate)) {
      source = candidate;
      break;
    }
    current = path.dirname(current);
  }
  if (!source) throw new Error(`Could not find @earendil-works/pi-tui starting from ${piCli}`);
  const scope = path.join(render, 'node_modules', '@earendil-works');
  fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(source, path.join(scope, 'pi-tui'), 'dir');
}

process.env.GOLEM_HOME = home;
process.env.XDG_CONFIG_HOME = xdg;
process.env.GOLEM_TRACKER_DB = dbPath;

const { openTrackerDb } = await import('../dashboard/server/tracker-db.js');
const { readChannels } = await import('../dashboard/server/channels.js');
const { readSessionFacts } = await import('../lib/session-facts.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitFor(check, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function startDashboard() {
  let stderr = '';
  const port = await unusedPort();
  const child = spawn(process.execPath, ['dashboard/server/index.js'], {
    cwd: repo,
    env: {
      ...process.env,
      GOLEM_HOME: home,
      XDG_CONFIG_HOME: xdg,
      GOLEM_TRACKER_DB: dbPath,
      GOLEM_PROJECTS_ROOT: path.join(temp, 'projects'),
      GOLEM_IDEAS_ROOT: path.join(temp, 'ideas'),
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${base}/api/health`)).ok, `dashboard health (${stderr})`, 15_000);
  return { child, base, stderr: () => stderr };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function text(result) {
  return result?.content?.find((part) => part.type === 'text')?.text ?? '';
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${text(result)}`);
  const body = text(result);
  if (!body) return null;
  try { return JSON.parse(body); } catch { return body; }
}

async function startChannelClient({ sessionId = '', name }) {
  const notifications = [];
  const client = new Client({ name, version: '1.0.0' });
  client.fallbackNotificationHandler = async (notification) => { notifications.push(notification); };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [channelEntrypoint],
    cwd: repo,
    env: {
      ...process.env,
      GOLEM_HOME: home,
      XDG_CONFIG_HOME: xdg,
      GOLEM_DASHBOARD_URL: dashboard.base,
      GOLEM_CHANNEL_PORT: '0',
      GOLEM_CHANNEL_HEARTBEAT_MS: '50',
      GOLEM_CEO_SESSION_ID: sessionId,
      CLAUDE_CODE_SESSION_ID: '',
    },
    stderr: 'pipe',
  });
  await client.connect(transport);
  return { client, transport, notifications };
}

async function createTicket(title) {
  const response = await fetch(`${dashboard.base}/api/tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: projectId,
      kind: 'task',
      title,
      body: 'Cross-harness controlled delivery journey. Do not edit files or call external tools.',
      created_by: 'human',
    }),
  });
  if (response.status !== 201) assert.fail(await response.text());
  return response.json();
}

async function dispatchFromHuman(ticket, target, { mode = 'now', note = CONTROLLED_NOTE } = {}) {
  const response = await fetch(`${dashboard.base}/api/tickets/${encodeURIComponent(ticket.id)}/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: target, sender_id: 'human', mode, note }),
  });
  if (response.status !== 200) assert.fail(await response.text());
  return response.json();
}

async function dispatchFrom(client, ticket, target) {
  return call(client, 'ticket_dispatch', {
    id: ticket.id,
    session_id: target,
    note: CONTROLLED_NOTE,
  });
}

function rawEnvelope(envelopeId) {
  const tracker = openTrackerDb(dbPath);
  try {
    const envelope = tracker.getEnvelope(envelopeId);
    assert.ok(envelope, `durable envelope ${envelopeId} exists`);
    return envelope;
  } finally {
    tracker.close();
  }
}

async function assertEnvelope(envelopeId, { sender, target }) {
  const envelope = rawEnvelope(envelopeId);
  assert.equal(envelope.sender_session_id, sender, 'durable envelope preserves canonical sender');
  assert.equal(envelope.target_session_id, target, 'durable envelope preserves canonical target');
  const viewResponse = await fetch(`${dashboard.base}/api/message-envelopes/${encodeURIComponent(envelopeId)}`);
  assert.equal(viewResponse.status, 200);
  const view = await viewResponse.json();
  assert.equal(view.session_id, target);
  assert.equal(view.facts.filter((fact) => fact.kind === 'delivery_opportunity').length, 1, 'one actionable dashboard delivery fact');
  return { envelope, view };
}

async function acknowledgeAndAct(client, ticket, envelopeId, target) {
  await call(client, 'ack', { kind: 'brief', envelope_id: envelopeId, summary: 'matrix delivery understood' });
  await call(client, 'ticket_comment', {
    id: ticket.id,
    body: `GOL-475 target action by ${target}`,
    tag: 'note',
  });
  const response = await fetch(`${dashboard.base}/api/tickets/${encodeURIComponent(ticket.id)}`);
  assert.equal(response.status, 200);
  const hydrated = await response.json();
  assert.equal(hydrated.comments.filter((comment) => comment.author === target).length, 1,
    `subsequent target tracker action is attributed to ${target}`);
  const envelope = await (await fetch(`${dashboard.base}/api/message-envelopes/${encodeURIComponent(envelopeId)}`)).json();
  assert.equal(envelope.facts.filter((fact) => fact.kind === 'acknowledged').length, 1, 'exactly one recipient acknowledgement fact');
}

function createPiHarness(extension, sessionId) {
  const handlers = new Map();
  const tools = new Map();
  const sent = [];
  let leaf = 0;
  let harness;
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendUserMessage(content) {
      sent.push(content);
      queueMicrotask(async () => {
        await harness.emit('input', { source: 'extension', text: content });
        await harness.emit('agent_start', { prompt: content });
      });
    },
  };
  extension(pi);
  const ctx = {
    cwd: project,
    mode: 'tui',
    model: { provider: 'ollama', id: 'deepseek-v4-flash:0731-cloud' },
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    shutdown() {},
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => path.join(temp, `${sessionId}.jsonl`),
      getSessionName: () => 'GOL-130 Pi matrix worker',
      getLeafId: () => `pi-leaf-${leaf}`,
    },
  };
  harness = {
    sent,
    tools,
    async emit(event, payload = {}) {
      let result;
      if (event === 'agent_start') {
        for (const handler of handlers.get('before_agent_start') || []) {
          const changed = await handler({ prompt: payload.prompt || '', systemPrompt: 'Pi base prompt' }, ctx);
          if (changed !== undefined) result = changed;
        }
        leaf += 1;
      }
      for (const handler of handlers.get(event) || []) {
        const changed = await handler(payload, ctx);
        if (changed !== undefined) result = changed;
      }
      return result;
    },
    start: () => harness.emit('session_start', { reason: 'startup' }),
    settle: () => harness.emit('agent_settled', {}),
    shutdown: () => harness.emit('session_shutdown', { reason: 'shutdown' }),
  };
  return harness;
}

async function invokePi(harness, name, args) {
  const result = await harness.tools.get(name).execute(`pi-${name}`, args, undefined, undefined, {
    cwd: project,
    sessionManager: { getSessionId: () => 'pi-matrix-worker' },
  });
  assert.equal(result.details?.ok, true, result.content?.[0]?.text || `${name} failed`);
  return result.details.result;
}

async function acknowledgeAndActPi(harness, ticket, envelopeId, target) {
  await invokePi(harness, 'ack', { kind: 'brief', envelope_id: envelopeId, summary: 'Pi matrix delivery understood' });
  await invokePi(harness, 'ticket_comment', { id: ticket.id, body: `GOL-130 target action by ${target}`, tag: 'note' });
  const hydrated = await (await fetch(`${dashboard.base}/api/tickets/${encodeURIComponent(ticket.id)}`)).json();
  assert.equal(hydrated.comments.filter((comment) => comment.author === target).length, 1,
    `subsequent Pi tracker action is attributed to ${target}`);
  await harness.settle();
}

const CONTROLLED_NOTE = 'CONTROLLED GOL-475 MATRIX: acknowledge the tracker envelope, write no files, make no external calls, reply with one sentence only, then stop.';
let dashboard;
let ccSource;
let ccTarget;
let ccThird;
let piTarget;
let projectId;

try {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({
    version: 1,
    projects: [{ id: 'matrix-project', name: 'matrix-human-project', path: project, kind: 'external' }],
  }));
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# GOL-130 isolated project\n');
  fs.writeFileSync(path.join(hooks, 'session-register.sh'), '#!/usr/bin/env bash\nexit 0\n');
  fs.writeFileSync(path.join(hooks, 'journal-route.sh'), '#!/usr/bin/env bash\nexit 0\n');

  dashboard = await startDashboard();
  process.env.GOLEM_DASHBOARD_URL = dashboard.base;
  process.env.GOLEM_PI_VERSION = '0.84.3';
  process.env.GOLEM_PI_EXTENSION_VERSION = '5.6.15';
  execFileSync(process.execPath, [path.join(repo, 'cli', 'golem.js'), 'sync', '--target', 'pi'], {
    cwd: repo, env: { ...process.env, GOLEM_HOME: home, XDG_CONFIG_HOME: xdg }, stdio: 'pipe',
  });
  const renderedPi = path.join(home, 'renders', 'pi');
  linkPiTui(renderedPi);
  const executablePi = path.join(renderedPi, 'golem.mjs');
  fs.copyFileSync(path.join(renderedPi, 'golem.ts'), executablePi);
  const piExtension = (await import(`${pathToFileURL(executablePi).href}?gol130=${Date.now()}`)).default;
  piTarget = createPiHarness(piExtension, 'pi-matrix-worker');
  await piTarget.start();
  projectId = 'matrix-project';

  ccSource = await startChannelClient({ sessionId: 'cc-matrix-source', name: 'golem-matrix-cc-source' });
  ccTarget = await startChannelClient({ sessionId: 'cc-matrix-target', name: 'golem-matrix-cc-target' });
  ccThird = await startChannelClient({ sessionId: 'cc-matrix-third', name: 'golem-matrix-cc-third' });
  await waitFor(async () => (await readChannels()).filter((channel) => (
    channel.session_id === 'cc-matrix-source' || channel.session_id === 'cc-matrix-target' || channel.session_id === 'cc-matrix-third'
  )).length === 3, 'generic CC channel registrations');

  // Claude → Pi through the real Pi extension endpoint and its registered
  // ticket_dispatch tool. Proves the typed route keeps canonical actor identity
  // rather than treating Pi as a dashboard-only target.
  const ccToPi = await createTicket('matrix Claude Code to Pi');
  const ccToPiDispatch = await dispatchFrom(ccSource.client, ccToPi, 'pi-matrix-worker');
  assert.equal(ccToPiDispatch.delivered, true, JSON.stringify(ccToPiDispatch));
  await assertEnvelope(ccToPiDispatch.envelope_id, { sender: 'cc-matrix-source', target: 'pi-matrix-worker' });
  await acknowledgeAndActPi(piTarget, ccToPi, ccToPiDispatch.envelope_id, 'pi-matrix-worker');

  const piToCc = await createTicket('matrix Pi to Claude Code');
  const piToCcDispatch = await invokePi(piTarget, 'ticket_dispatch', { id: piToCc.id, session_id: 'cc-matrix-target', note: CONTROLLED_NOTE });
  assert.equal(piToCcDispatch.delivered, true, JSON.stringify(piToCcDispatch));
  await assertEnvelope(piToCcDispatch.envelope_id, { sender: 'pi-matrix-worker', target: 'cc-matrix-target' });
  await waitFor(() => ccTarget.notifications.some((message) => message.method === 'notifications/claude/channel'
    && JSON.stringify(message).includes(piToCcDispatch.envelope_id)), 'Pi to CC channel delivery');
  await acknowledgeAndAct(ccTarget.client, piToCc, piToCcDispatch.envelope_id, 'cc-matrix-target');

  // CC ↔ CC over the generic channel route.
  const ccToCc = await createTicket('matrix Claude Code to Claude Code');
  const ccCcDispatch = await dispatchFrom(ccSource.client, ccToCc, 'cc-matrix-target');
  assert.equal(ccCcDispatch.delivered, true, JSON.stringify(ccCcDispatch));
  await assertEnvelope(ccCcDispatch.envelope_id, { sender: 'cc-matrix-source', target: 'cc-matrix-target' });
  await waitFor(() => ccTarget.notifications.filter((message) => message.method === 'notifications/claude/channel'
    && JSON.stringify(message).includes(ccCcDispatch.envelope_id)).length === 1,
    'one CC channel delivery for the CC envelope');
  await acknowledgeAndAct(ccTarget.client, ccToCc, ccCcDispatch.envelope_id, 'cc-matrix-target');

  // Tracker (dashboard-human) → Pi typed delivery through the drainer.
  const humanToPi = await createTicket('matrix tracker to Pi');
  const humanPiDispatch = await dispatchFromHuman(humanToPi, 'pi-matrix-worker');
  assert.equal(humanPiDispatch.delivered, true, JSON.stringify(humanPiDispatch));
  await assertEnvelope(humanPiDispatch.envelope_id, { sender: 'human', target: 'pi-matrix-worker' });
  await acknowledgeAndActPi(piTarget, humanToPi, humanPiDispatch.envelope_id, 'pi-matrix-worker');

  // Tracker (dashboard-human) → Claude Code channel push.
  const humanToCc = await createTicket('matrix tracker to Claude Code');
  const humanCcDispatch = await dispatchFromHuman(humanToCc, 'cc-matrix-target');
  assert.equal(humanCcDispatch.delivered, true, JSON.stringify(humanCcDispatch));
  await assertEnvelope(humanCcDispatch.envelope_id, { sender: 'human', target: 'cc-matrix-target' });
  await waitFor(() => ccTarget.notifications.filter((message) => message.method === 'notifications/claude/channel'
    && JSON.stringify(message).includes(humanCcDispatch.envelope_id)).length === 1,
    'one CC channel delivery for the human envelope');
  await acknowledgeAndAct(ccTarget.client, humanToCc, humanCcDispatch.envelope_id, 'cc-matrix-target');

  // Pi → Pi (self-dispatch through the shared queue, delivered once).
  const piToPi = await createTicket('matrix Pi to Pi');
  const piSelfDispatch = await invokePi(piTarget, 'ticket_dispatch', { id: piToPi.id, session_id: 'pi-matrix-worker', note: CONTROLLED_NOTE });
  assert.equal(piSelfDispatch.delivered === true || piSelfDispatch.queued === true, true, JSON.stringify(piSelfDispatch));
  await assertEnvelope(piSelfDispatch.envelope_id, { sender: 'pi-matrix-worker', target: 'pi-matrix-worker' });

  // A dead target never claims delivery: the envelope stays durable for retry
  // (offline sessions come back), and the response says delivered=false.
  const offlineDispatch = await fetch(`${dashboard.base}/api/tickets/${encodeURIComponent((await createTicket('matrix offline retry hold')).id)}/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'cc-never-registered', sender_id: 'human', mode: 'now', note: CONTROLLED_NOTE }),
  });
  const offlineBody = await offlineDispatch.json();
  assert.equal(offlineBody.delivered, false, `offline target must not claim delivery: ${JSON.stringify(offlineBody)}`);
  assert.ok(offlineBody.envelope_id, 'offline dispatch retains a durable envelope');

  const spoof = await ccSource.client.callTool({ name: 'ticket_create', arguments: {
    project: projectId,
    title: 'GOL-130 spoof must fail',
    body: 'must never persist',
    __golem_session_id: 'cc-matrix-target',
  } });
  assert.equal(spoof.isError, true, 'model-supplied actor cannot impersonate another session');
  assert.match(text(spoof), /conflicts with the launcher binding/i);

  console.log('GOL-130 cross-harness matrix passed: bidirectional Pi/Claude dispatch (plus tracker-human routes), durable identity+ack+target action, and spoof rejection');
} finally {
  await piTarget?.shutdown().catch(() => {});
  await ccSource?.client?.close().catch(() => {});
  await ccTarget?.client?.close().catch(() => {});
  await ccThird?.client?.close().catch(() => {});
  await stopChild(dashboard?.child);
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}