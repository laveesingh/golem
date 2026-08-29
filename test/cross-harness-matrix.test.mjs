import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '../mcp/channel/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../mcp/channel/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

// GOL-475 is deliberately one isolated, behavior-level matrix. It uses the
// real dashboard/SQLite, real managed App Server supervisors, real generic
// channel processes, and the actual OpenCode shim bridge. The only harness
// stand-in is OpenCode's SDK client, whose promptAsync acceptance surface is
// the documented seam the shim owns.
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

const {
  CodexSupervisor,
  readCodexSupervisor,
} = await import('../lib/codex-supervisor.js');
const {
  TYPED_WORKER_PROTOCOL_VERSION,
  typedEnvelopeMetadata,
} = await import('../lib/typed-worker-endpoint.js');
const { readChannels } = await import('../dashboard/server/channels.js');
const { openTrackerDb } = await import('../dashboard/server/tracker-db.js');
const { readEndpointLeases, readSessionFacts } = await import('../lib/session-facts.js');

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

async function startChannelClient({ sessionId = '', managed = false, name }) {
  const notifications = [];
  const client = new Client({ name, version: '1.0.0' });
  // The installed SDK exposes this as a public Protocol field but does not
  // copy an options value into it in its constructor. Assign the documented
  // runtime surface after construction so generic channel notifications are
  // observed exactly as a real MCP host observes them.
  client.fallbackNotificationHandler = async (notification) => { notifications.push(notification); };
  const env = {
    ...process.env,
    GOLEM_HOME: home,
    XDG_CONFIG_HOME: xdg,
    GOLEM_DASHBOARD_URL: dashboard.base,
    GOLEM_CHANNEL_PORT: '0',
    GOLEM_CHANNEL_HEARTBEAT_MS: '50',
    GOLEM_CEO_SESSION_ID: sessionId,
    CLAUDE_CODE_SESSION_ID: '',
  };
  if (managed) {
    env.GOLEM_MANAGED_CODEX_BOUND = '1';
    env.GOLEM_MANAGED_CODEX_BOUND_SESSION_ID = sessionId;
    env.GOLEM_MANAGED_CODEX_MCP_ONLY = '1';
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [channelEntrypoint],
    cwd: repo,
    env,
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

async function waitForCodexCompletion(supervisor, envelopeId, label) {
  return waitFor(() => {
    const record = readCodexSupervisor(supervisor.canonicalId);
    const delivery = record?.inbox?.deliveries?.find((row) => row.envelope_id === envelopeId);
    return delivery?.state === 'completed' && record?.health?.delivery_ready === true ? delivery : null;
  }, label, 120_000);
}

function writeCodexStatus(supervisor, status) {
  const threadStatus = status === 'waiting'
    ? { type: 'active', activeFlags: ['waitingOnUserInput'] }
    : (status === 'idle' ? { type: 'idle' } : { type: 'active', activeFlags: [] });
  supervisor.noteThreadStatus({ threadId: supervisor.threadId, status: threadStatus });
}

async function waitForNativeStatus(sessionId, status) {
  const label = `${sessionId} native status ${status}`;
  try {
    return await waitFor(async () => {
      const rows = await (await fetch(`${dashboard.base}/api/native-sessions`)).json();
      return rows.find((row) => row.session_id === sessionId && row.status === status) || null;
    }, label, 15_000);
  } catch (error) {
    let nativeRow = null;
    let nativeRowsError = null;
    try {
      const response = await fetch(`${dashboard.base}/api/native-sessions`);
      nativeRow = (await response.json()).find((row) => row.session_id === sessionId) ?? null;
    } catch (fetchError) {
      nativeRowsError = fetchError.message;
    }
    const facts = readSessionFacts().filter((fact) => fact.canonical_id === sessionId);
    const latestFact = facts.sort((left, right) => String(right.observed_at).localeCompare(String(left.observed_at)))[0] ?? null;
    const leases = readEndpointLeases({ includeExpired: true }).filter((lease) => lease.canonical_id === sessionId);
    const record = readCodexSupervisor(sessionId);
    throw new Error(
      `${label} timed out; diagnostics=${JSON.stringify({
        latest_fact: latestFact,
        native_row: nativeRow,
        native_rows_error: nativeRowsError,
        leases,
        supervisor_record: record,
        dashboard_stderr: dashboard?.stderr?.().slice(-4000) ?? '',
      })}`,
      { cause: error },
    );
  }
}

async function typedBrief(record, envelope, { ownerToken = record.health.owner_token } = {}) {
  const payload = JSON.parse(envelope.payload);
  // Keep the direct authenticated retry on the exact same wire contract as
  // dashboard publication. This journey intentionally bypasses the dashboard
  // route to prove a restart duplicate against the endpoint itself, so it must
  // never recreate a partial pre-versioned payload here.
  const metadata = typedEnvelopeMetadata(envelope);
  const wireEnvelope = {
    ...metadata,
    content: payload.content,
    // Pin this last just as pushBrief() does: direct callers cannot downgrade
    // the endpoint contract by smuggling a stale protocol version.
    protocol_version: TYPED_WORKER_PROTOCOL_VERSION,
  };
  const response = await fetch(`http://${record.health.host}:${record.health.port}/brief`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sender': 'dashboard',
      'x-golem-target-session': record.canonical_id,
      'x-golem-endpoint-owner': ownerToken,
    },
    body: JSON.stringify(wireEnvelope),
  });
  return { response, body: await response.json(), wireEnvelope };
}

const CONTROLLED_NOTE = 'CONTROLLED GOL-475 MATRIX: acknowledge the tracker envelope, write no files, make no external calls, reply with one sentence only, then stop.';
let dashboard;
let codexSource;
let codexTarget;
let codexSourceMcp;
let codexTargetMcp;
let ccSource;
let ccTarget;
let ocTarget;
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
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# GOL-475 isolated project\n');
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
  const first = new CodexSupervisor({ canonicalId: 'codex-matrix-source', cwd: project });
  codexSource = first;
  const second = new CodexSupervisor({ canonicalId: 'codex-matrix-target', cwd: project });
  codexTarget = second;
  const [sourceRecord, targetRecord] = await Promise.all([codexSource.start(), codexTarget.start()]);
  projectId = targetRecord.project_id;
  assert.equal(sourceRecord.health.delivery_ready, true);
  assert.equal(targetRecord.health.delivery_ready, true);
  const codexByHumanProjectName = await waitFor(async () => {
    const response = await fetch(`${dashboard.base}/api/sessions/dispatchable?project=${encodeURIComponent('matrix-human-project')}`);
    if (!response.ok) return null;
    const rows = await response.json();
    return rows.find((row) => row.session_id === codexTarget.canonicalId && row.project_id === projectId) || null;
  }, 'managed Codex discovery by unique human project name', 15_000);
  assert.equal(codexByHumanProjectName.harness, 'codex');

  codexSourceMcp = await startChannelClient({ sessionId: codexSource.canonicalId, managed: true, name: 'golem-matrix-codex-source' });
  codexTargetMcp = await startChannelClient({ sessionId: codexTarget.canonicalId, managed: true, name: 'golem-matrix-codex-target' });
  ccSource = await startChannelClient({ sessionId: 'cc-matrix-source', name: 'golem-matrix-cc-source' });
  ccTarget = await startChannelClient({ sessionId: 'cc-matrix-target', name: 'golem-matrix-cc-target' });
  await waitFor(async () => (await readChannels()).filter((channel) => (
    channel.session_id === 'cc-matrix-source' || channel.session_id === 'cc-matrix-target'
  )).length === 2, 'generic CC channel registrations');

  await waitFor(async () => (await (await fetch(`${dashboard.base}/api/native-sessions`)).json())
    .some((row) => row.session_id === 'pi-matrix-worker' && row.delivery_ready), 'Pi typed-worker registration');

  // Codex ↔ Pi through the real Pi extension endpoint and its registered
  // ticket_dispatch tool. This proves both directions retain canonical actor
  // identity rather than treating Pi as a dashboard-only target.
  const codexToPi = await createTicket('matrix Codex to Pi');
  const codexToPiDispatch = await dispatchFrom(codexSourceMcp.client, codexToPi, 'pi-matrix-worker');
  assert.equal(codexToPiDispatch.delivered, true, JSON.stringify(codexToPiDispatch));
  await assertEnvelope(codexToPiDispatch.envelope_id, { sender: codexSource.canonicalId, target: 'pi-matrix-worker' });
  await acknowledgeAndActPi(piTarget, codexToPi, codexToPiDispatch.envelope_id, 'pi-matrix-worker');

  const piToCodex = await createTicket('matrix Pi to Codex');
  const piToCodexDispatch = await invokePi(piTarget, 'ticket_dispatch', { id: piToCodex.id, session_id: codexTarget.canonicalId, note: CONTROLLED_NOTE });
  assert.equal(piToCodexDispatch.delivered, true, JSON.stringify(piToCodexDispatch));
  await assertEnvelope(piToCodexDispatch.envelope_id, { sender: 'pi-matrix-worker', target: codexTarget.canonicalId });
  await acknowledgeAndAct(codexTargetMcp.client, piToCodex, piToCodexDispatch.envelope_id, codexTarget.canonicalId);
  await waitForCodexCompletion(codexTarget, piToCodexDispatch.envelope_id, 'Pi to Codex turn completion');

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

  // Tracker → Codex, with a real supervisor turn and target-owned ack/action.
  const trackerToCodex = await createTicket('matrix tracker to Codex');
  const trackerDispatch = await dispatchFromHuman(trackerToCodex, codexTarget.canonicalId);
  assert.equal(trackerDispatch.delivered, true, JSON.stringify(trackerDispatch));
  await assertEnvelope(trackerDispatch.envelope_id, { sender: 'human', target: codexTarget.canonicalId });
  await acknowledgeAndAct(codexTargetMcp.client, trackerToCodex, trackerDispatch.envelope_id, codexTarget.canonicalId);
  await waitForCodexCompletion(codexTarget, trackerDispatch.envelope_id, 'tracker to Codex turn completion');

  // Managed Codex → managed Codex.
  const codexToCodex = await createTicket('matrix Codex to Codex');
  const codexDispatch = await dispatchFrom(codexSourceMcp.client, codexToCodex, codexTarget.canonicalId);
  assert.equal(codexDispatch.delivered, true, JSON.stringify(codexDispatch));
  await assertEnvelope(codexDispatch.envelope_id, { sender: codexSource.canonicalId, target: codexTarget.canonicalId });
  await acknowledgeAndAct(codexTargetMcp.client, codexToCodex, codexDispatch.envelope_id, codexTarget.canonicalId);
  await waitForCodexCompletion(codexTarget, codexDispatch.envelope_id, 'Codex to Codex turn completion');

  // Managed Codex → existing generic CC channel; the MCP client receives one
  // concrete channel notification before it writes its acknowledgement/action.
  const codexToCc = await createTicket('matrix Codex to Claude Code');
  const codexToCcDispatch = await dispatchFrom(codexSourceMcp.client, codexToCc, 'cc-matrix-target');
  assert.equal(codexToCcDispatch.delivered, true, JSON.stringify(codexToCcDispatch));
  await assertEnvelope(codexToCcDispatch.envelope_id, { sender: codexSource.canonicalId, target: 'cc-matrix-target' });
  await waitFor(() => ccTarget.notifications.filter((message) => message.method === 'notifications/claude/channel'
    && JSON.stringify(message).includes(codexToCcDispatch.envelope_id)).length === 1,
    'one CC channel delivery for the Codex envelope');
  await acknowledgeAndAct(ccTarget.client, codexToCc, codexToCcDispatch.envelope_id, 'cc-matrix-target');

  // Existing generic CC → managed Codex.
  const ccToCodex = await createTicket('matrix Claude Code to Codex');
  const ccDispatch = await dispatchFrom(ccSource.client, ccToCodex, codexTarget.canonicalId);
  assert.equal(ccDispatch.delivered, true, JSON.stringify(ccDispatch));
  await assertEnvelope(ccDispatch.envelope_id, { sender: 'cc-matrix-source', target: codexTarget.canonicalId });
  await acknowledgeAndAct(codexTargetMcp.client, ccToCodex, ccDispatch.envelope_id, codexTarget.canonicalId);
  await waitForCodexCompletion(codexTarget, ccDispatch.envelope_id, 'CC to Codex turn completion');

  // Preserve the generic CC fixture as CC-only. A channel child whose parent is
  // the OpenCode bridge intentionally routes to that bridge, so close these
  // before installing the OC fixture rather than mixing harness topology.
  await ccSource.client.close();
  await ccTarget.client.close();
  ccSource = null;
  ccTarget = null;

  // Actual OpenCode shim/bridge path. Its SDK promptAsync acceptance is the
  // supported external boundary; all bridge/registry/channel code is real.
  const promptCalls = [];
  process.env.GOLEM_HOOKS_DIR = hooks;
  const { default: opencodeShim } = await import(`${pathToFileURL(path.join(repo, 'shims', 'opencode', 'index.js')).href}?gol475=${Date.now()}`);
  const ocSession = 'oc-matrix-target';
  const ocHooks = await opencodeShim({
    directory: project,
    client: {
      session: {
        list: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        prompt: async () => { throw new Error('matrix bridge must use promptAsync'); },
        promptAsync: async (request) => {
          promptCalls.push(request);
          return { data: undefined, response: { ok: true } };
        },
      },
    },
  });
  await ocHooks.event({ event: { type: 'session.created', properties: { info: {
    id: ocSession, directory: project, title: 'GOL-475 OpenCode target', time: { created: Date.now(), updated: Date.now() },
  } } } });
  await waitFor(() => fs.existsSync(path.join(home, 'opencode-bridges.json')), 'OpenCode bridge registry');
  ocTarget = await startChannelClient({ name: 'golem-matrix-opencode-target' });
  await waitFor(async () => (await readChannels()).some((channel) => channel.session_id === ocSession), 'OpenCode bridge channel registration');

  // Managed Codex → OpenCode bridge.
  const codexToOc = await createTicket('matrix Codex to OpenCode');
  const ocDispatch = await dispatchFrom(codexSourceMcp.client, codexToOc, ocSession);
  assert.equal(ocDispatch.delivered, true, JSON.stringify(ocDispatch));
  await assertEnvelope(ocDispatch.envelope_id, { sender: codexSource.canonicalId, target: ocSession });
  await waitFor(() => promptCalls.length === 1, 'one OpenCode promptAsync delivery');
  assert.match(promptCalls[0].body.parts[0].text, /<channel source="golem" kind="brief"/, 'OpenCode receives the generic channel brief exactly once');
  await acknowledgeAndAct(ocTarget.client, codexToOc, ocDispatch.envelope_id, ocSession);

  const ocToPi = await createTicket('matrix OpenCode to Pi');
  const ocToPiDispatch = await dispatchFrom(ocTarget.client, ocToPi, 'pi-matrix-worker');
  assert.equal(ocToPiDispatch.delivered, true, JSON.stringify(ocToPiDispatch));
  await assertEnvelope(ocToPiDispatch.envelope_id, { sender: ocSession, target: 'pi-matrix-worker' });
  await acknowledgeAndActPi(piTarget, ocToPi, ocToPiDispatch.envelope_id, 'pi-matrix-worker');

  const piToOc = await createTicket('matrix Pi to OpenCode');
  const piToOcDispatch = await invokePi(piTarget, 'ticket_dispatch', { id: piToOc.id, session_id: ocSession, note: CONTROLLED_NOTE });
  assert.equal(piToOcDispatch.delivered, true, JSON.stringify(piToOcDispatch));
  await assertEnvelope(piToOcDispatch.envelope_id, { sender: 'pi-matrix-worker', target: ocSession });
  await waitFor(() => promptCalls.some((request) => JSON.stringify(request).includes(piToOcDispatch.envelope_id)),
    'Pi to OpenCode promptAsync delivery');
  await acknowledgeAndAct(ocTarget.client, piToOc, piToOcDispatch.envelope_id, ocSession);

  // OpenCode bridge → managed Codex.
  const ocToCodex = await createTicket('matrix OpenCode to Codex');
  const ocToCodexDispatch = await dispatchFrom(ocTarget.client, ocToCodex, codexTarget.canonicalId);
  assert.equal(ocToCodexDispatch.delivered, true, JSON.stringify(ocToCodexDispatch));
  await assertEnvelope(ocToCodexDispatch.envelope_id, { sender: ocSession, target: codexTarget.canonicalId });
  await acknowledgeAndAct(codexTargetMcp.client, ocToCodex, ocToCodexDispatch.envelope_id, codexTarget.canonicalId);
  await waitForCodexCompletion(codexTarget, ocToCodexDispatch.envelope_id, 'OpenCode to Codex turn completion');

  // An idle UI row is not enough for a managed Codex target. delivery_ready:
  // false holds the queue without trying a turn; restore readiness and the real
  // drainer delivers exactly once when idle.
  codexTarget.updateRecord({ turn: { state: 'busy', kind: 'test-only-readiness-hold' } });
  codexTarget.updateRecord({ thread_status: { type: 'idle' } });
  codexTarget.persistLease(codexTarget.healthAddress);
  codexTarget.writeRuntimeFact('gol-475-matrix-status', { test_controlled: true });
  await waitForNativeStatus(codexTarget.canonicalId, 'idle');
  const directWhileNotReady = await createTicket('matrix managed Codex direct readiness hold');
  const turnsBeforeDirectHold = readCodexSupervisor(codexTarget.canonicalId).inbox.deliveries.length;
  const directHold = await dispatchFromHuman(directWhileNotReady, codexTarget.canonicalId);
  assert.equal(directHold.delivered, false, 'direct routing treats delivery_ready:false as unreachable');
  assert.equal(directHold.channel?.status, 503, 'direct routing does not call a non-ready typed target');
  assert.equal(readCodexSupervisor(codexTarget.canonicalId).inbox.deliveries.length, turnsBeforeDirectHold,
    'direct delivery readiness hold never starts a Codex turn');
  const held = await createTicket('matrix managed Codex delivery-ready hold');
  const heldDispatch = await dispatchFromHuman(held, codexTarget.canonicalId, { mode: 'when_idle' });
  assert.equal(heldDispatch.queued, true, 'delivery_ready:false makes an idle managed Codex target unreachable to queue eligibility');
  await sleep(5_500);
  const heldQueue = await (await fetch(`${dashboard.base}/api/dispatch-queue?session_id=${encodeURIComponent(codexTarget.canonicalId)}`)).json();
  assert.equal(heldQueue.filter((row) => row.id === heldDispatch.queue_id && row.status === 'pending').length, 1, 'busy/waiting hold never starts a Codex turn');
  codexTarget.updateRecord({ turn: { state: 'idle', kind: 'test-only-readiness-release' } });
  // Publish `waiting` into the dashboard's independently refreshed native
  // session cache before renewing the typed lease. Reversing this order makes
  // the queue drainer see its previous `idle` row for one tick and deliver
  // before the waiting hold has reached the cache.
  writeCodexStatus(codexTarget, 'waiting');
  await waitForNativeStatus(codexTarget.canonicalId, 'waiting');
  codexTarget.persistLease(codexTarget.healthAddress);
  await sleep(5_500);
  const waitingQueue = await (await fetch(`${dashboard.base}/api/dispatch-queue?session_id=${encodeURIComponent(codexTarget.canonicalId)}`)).json();
  assert.equal(waitingQueue.filter((row) => row.id === heldDispatch.queue_id && row.status === 'pending').length, 1, 'waiting also holds the durable queue');
  writeCodexStatus(codexTarget, 'idle');
  await waitForNativeStatus(codexTarget.canonicalId, 'idle');
  await waitForCodexCompletion(codexTarget, heldDispatch.envelope_id, 'idle drainer delivery completion');

  // Failed typed delivery retains the durable envelope. A retry with the same
  // id after the target is ready starts one, and only one, real App Server turn.
  codexTarget.updateRecord({ turn: { state: 'busy', kind: 'test-only-retry-hold' } });
  const retryTicket = await createTicket('matrix typed delivery retry');
  const failedDispatch = await dispatchFromHuman(retryTicket, codexTarget.canonicalId);
  assert.equal(failedDispatch.delivered, false, 'busy typed target rejects the first dashboard delivery attempt');
  const retryEnvelope = rawEnvelope(failedDispatch.envelope_id);
  const turnCountBeforeRetry = readCodexSupervisor(codexTarget.canonicalId).inbox.deliveries.length;
  codexTarget.updateRecord({ turn: { state: 'idle', kind: 'test-only-retry-release' } });
  codexTarget.persistLease(codexTarget.healthAddress);
  const retried = await typedBrief(readCodexSupervisor(codexTarget.canonicalId), retryEnvelope);
  assert.equal(retried.response.status, 202, JSON.stringify(retried.body));
  assert.equal(retried.wireEnvelope.protocol_version, TYPED_WORKER_PROTOCOL_VERSION,
    'first retry uses the pinned typed-worker protocol version');
  assert.equal(retried.wireEnvelope.kind, retryEnvelope.kind,
    'first retry preserves the durable envelope kind');
  assert.equal(retried.wireEnvelope.target_session_id, codexTarget.canonicalId,
    'first retry preserves the canonical worker target');
  assert.equal(retried.wireEnvelope.created_at, retryEnvelope.created_at,
    'first retry preserves durable creation time');
  assert.equal(retried.wireEnvelope.expires_at, retryEnvelope.expires_at,
    'first retry preserves durable expiry');
  assert.ok(retried.wireEnvelope.attempt_id,
    'first retry includes a fresh correlated delivery attempt id');
  await waitForCodexCompletion(codexTarget, retryEnvelope.id, 'retry App Server turn completion');
  assert.equal(readCodexSupervisor(codexTarget.canonicalId).inbox.deliveries.length, turnCountBeforeRetry + 1,
    'failed delivery retry creates one persisted Codex turn mapping');

  // A supervisor restart resumes its canonical thread. A repeated envelope is
  // idempotent and never starts a second target turn after recovery.
  const originalThread = codexTarget.threadId;
  await codexTarget.stop();
  codexTarget = new CodexSupervisor({ canonicalId: 'codex-matrix-target', cwd: project });
  const restarted = await codexTarget.start();
  assert.equal(restarted.thread_id, originalThread, 'target restart resumes the canonical Codex thread');
  const duplicate = await typedBrief(restarted, retryEnvelope);
  assert.equal(duplicate.response.status, 200, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.duplicate, true, 'supervisor restart reuses the durable envelope mapping');
  assert.equal(duplicate.wireEnvelope.protocol_version, TYPED_WORKER_PROTOCOL_VERSION,
    'restart duplicate uses the same pinned typed-worker protocol version');
  assert.equal(duplicate.wireEnvelope.envelope_id, retryEnvelope.id,
    'restart duplicate retains immutable envelope identity while issuing a new attempt');
  assert.notEqual(duplicate.wireEnvelope.attempt_id, retried.wireEnvelope.attempt_id,
    'restart duplicate carries a distinct delivery-attempt correlation');
  await sleep(250);
  assert.equal(readCodexSupervisor(codexTarget.canonicalId).inbox.deliveries.length, turnCountBeforeRetry + 1,
    'restart retry never starts a second Codex turn');

  const spoof = await codexSourceMcp.client.callTool({ name: 'ticket_create', arguments: {
    project: projectId,
    title: 'GOL-475 spoof must fail',
    body: 'must never persist',
    __golem_session_id: 'cc-matrix-source',
  } });
  assert.equal(spoof.isError, true, 'model-supplied actor cannot impersonate another harness');
  assert.match(text(spoof), /conflicts with the supervisor binding/i);

  console.log('GOL-130 cross-harness matrix passed: bidirectional Pi/Codex/CC/OpenCode dispatch, durable identity+ack+target action, delivery-ready queue holds, retry, restart, and spoof rejection');
} finally {
  await piTarget?.shutdown().catch(() => {});
  await ocTarget?.client?.close().catch(() => {});
  await ccSource?.client?.close().catch(() => {});
  await ccTarget?.client?.close().catch(() => {});
  await codexSourceMcp?.client?.close().catch(() => {});
  await codexTargetMcp?.client?.close().catch(() => {});
  await codexTarget?.stop({ deleteThread: true }).catch(() => {});
  await codexSource?.stop({ deleteThread: true }).catch(() => {});
  await stopChild(dashboard?.child);
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
