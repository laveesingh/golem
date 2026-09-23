// Integration test for tracker-client.js — exercises the FULL HTTP client
// against a real dashboard server, on a throwaway port + temp config + temp DB.
//
// It NEVER touches the live :7420 dashboard or the real ~/.config/golem state:
//   - the dashboard child runs on PORT=7616 (HOST=127.0.0.1),
//   - GOLEM_TRACKER_DB points at a temp file,
//   - XDG_CONFIG_HOME points at a temp dir, so the dashboard self-registers
//     dashboard.json INTO that temp dir, and the client reads it from there.
//
// Exit 0 on full success; exit 1 on any failed assertion or round-trip.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import url from 'node:url';
import crypto from 'node:crypto';
import net from 'node:net';
import { createServer } from 'node:http';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { projectIdFor } from '../../lib/project-id.js';
import { createGolemClient, GolemClientError } from '../../lib/golem-client.js';
import { GOLEM_TOOL_CONTRACTS, RETIRED_GOLEM_TOOL_CONTRACTS } from '../../lib/golem-tool-contracts.js';
import { createGolemToolRuntime } from '../../lib/golem-tool-runtime.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DASHBOARD_SERVER = path.resolve(__dirname, '../../../dashboard/server/index.js');
const CHANNEL_DIR = process.env.GOLEM_CHANNEL_SOURCE ? path.resolve(process.env.GOLEM_CHANNEL_SOURCE) : __dirname;
const CHANNEL_SERVER = path.join(CHANNEL_DIR, 'index.js');
const CHANNEL_ROOT = path.resolve(CHANNEL_DIR, '../..');

const HOST = '127.0.0.1';
const SESSION_ID = 'test-session-aaaa-bbbb-cccc';
const PROJECT_ID = 'testproj-abc123'; // synthetic contract id; we pass it explicitly
const SECOND_PROJECT_ID = 'otherproj-def456';
const ChannelNotificationSchema = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({
    content: z.string(),
    meta: z.object({ kind: z.string() }).passthrough(),
  }).passthrough(),
});

// --- temp sandbox ----------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-tracker-test-'));
const tmpConfigHome = path.join(tmpRoot, 'config'); // XDG_CONFIG_HOME
const tmpGolemHome = path.join(tmpConfigHome, 'golem');
const tmpDb = path.join(tmpRoot, 'tracker.db');
const projectsRoot = path.join(tmpRoot, 'projects');
const ideasRoot = path.join(tmpRoot, 'ideas');
const uniqueProjectRoot = path.join(tmpRoot, 'trialroomai');
const duplicateProjectRootA = path.join(tmpRoot, 'duplicate-a');
const duplicateProjectRootB = path.join(tmpRoot, 'duplicate-b');
const claudeSessionsDir = path.join(tmpRoot, '.claude', 'sessions');
const uniqueProjectId = projectIdFor(uniqueProjectRoot);
fs.mkdirSync(tmpGolemHome, { recursive: true });
for (const directory of [projectsRoot, ideasRoot, uniqueProjectRoot, duplicateProjectRootA, duplicateProjectRootB, claudeSessionsDir]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(path.join(tmpGolemHome, 'projects.json'), JSON.stringify({
  version: 1,
  projects: [
    { id: 'registry-trialroomai', name: 'trialroomai', path: uniqueProjectRoot, kind: 'external' },
    { id: 'registry-duplicate-a', name: 'duplicate-human-name', path: duplicateProjectRootA, kind: 'external' },
    { id: 'registry-duplicate-b', name: 'duplicate-human-name', path: duplicateProjectRootB, kind: 'external' },
  ],
}));
process.env.GOLEM_HOME = tmpGolemHome;

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : null;
      probe.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

// Wait until the dashboard self-registers dashboard.json and the API routes are
// ready (we poll /api/tickets, which 200s once routes are up).
async function waitForDashboard(timeoutMs = 15000) {
  const dashJson = path.join(tmpConfigHome, 'golem', 'dashboard.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(dashJson)) {
      try {
        const doc = JSON.parse(fs.readFileSync(dashJson, 'utf8'));
        if (doc.url) {
          const res = await fetch(`${doc.url}/api/tickets`).catch(() => null);
          if (res && res.ok) return doc;
        }
      } catch {
        /* not ready yet */
      }
    }
    await sleep(200);
  }
  throw new Error('dashboard did not become ready within timeout');
}

async function waitForChannelEntry(sessionId, timeoutMs = 15000, predicate = () => true) {
  const channelsFile = path.join(tmpGolemHome, 'channels.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const channels = JSON.parse(fs.readFileSync(channelsFile, 'utf8')).channels || [];
      const channel = channels.find((entry) => entry.session_id === sessionId);
      if (channel?.host && channel?.port && predicate(channel)) return channel;
    } catch {
      /* channel has not registered yet */
    }
    await sleep(50);
  }
  throw new Error('channel did not register within timeout');
}

async function waitForChannel(timeoutMs = 15000) {
  const channel = await waitForChannelEntry(SESSION_ID, timeoutMs);
  return `http://${channel.host}:${channel.port}`;
}

function writeClaudeSession({ sessionId, pid, cwd = uniqueProjectRoot, name, status = 'idle' }) {
  fs.writeFileSync(path.join(claudeSessionsDir, `${pid}.json`), JSON.stringify({
    sessionId,
    pid,
    cwd,
    name: name || null,
    status,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }));
}

let child;
let mcpClient;
let mcpTransport;
let identityMcpClient;
let identityMcpTransport;
let noIdentityMcpClient;
let noIdentityMcpTransport;
let ccFallbackMcpClient;
let ccFallbackMcpTransport;
let unsupportedCcMcpClient;
let unsupportedCcMcpTransport;
let uninitializedCcChild;
let cliFirstMcpClient;
let cliFirstMcpTransport;
let mutantMcpClient;
let mutantMcpTransport;
let proxy = null;
let proxyPort = null;
let silentUpstream = null;
const silentSockets = new Set();
// The proxy's own upstream wait is bounded; the hung-upstream check below must
// complete well inside it.
const PROXY_UPSTREAM_TIMEOUT_MS = 1500;
let bridgeCaptureServer;
let port;

function toolText(result) {
  return result?.content?.find((part) => part.type === 'text')?.text ?? '';
}

async function callToolFrom(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = toolText(result);
  let json = null;
  if (!result.isError && text) {
    try { json = JSON.parse(text); } catch { /* non-JSON success */ }
  }
  return { result, text, json };
}

async function callTool(name, args) {
  return callToolFrom(mcpClient, name, args);
}

async function main() {
  // 1) Spawn the dashboard server in the sandbox.
  port = await availablePort();
  child = spawn('node', [DASHBOARD_SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST,
      GOLEM_TRACKER_DB: tmpDb,
      GOLEM_HOME: tmpGolemHome,
      XDG_CONFIG_HOME: tmpConfigHome,
      GOLEM_PROJECTS_ROOT: projectsRoot,
      GOLEM_IDEAS_ROOT: ideasRoot,
      HOME: tmpRoot,
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stderr.write(`[dash] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[dash:err] ${d}`));

  const doc = await waitForDashboard();
  check('dashboard self-registered dashboard.json', !!doc.url, JSON.stringify(doc));
  check('dashboard.json url points at our test port', String(doc.url).includes(`:${port}`), doc.url);

  // 2) Configure env so the client resolves THIS dashboard + identity, then
  //    import the client (its helpers read env/fs lazily at call time).
  process.env.XDG_CONFIG_HOME = tmpConfigHome;
  process.env.GOLEM_HOME = tmpGolemHome;
  process.env.GOLEM_CEO_SESSION_ID = SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;

  const client = await import(url.pathToFileURL(path.join(CHANNEL_DIR, 'tracker-client.js')).href + `?t=${Date.now()}`);

  check('dashboardBaseUrl() reads temp dashboard.json', client.dashboardBaseUrl() === doc.url,
    `got ${client.dashboardBaseUrl()} want ${doc.url}`);
  check('currentSessionId() reflects GOLEM_CEO_SESSION_ID', client.currentSessionId() === SESSION_ID,
    client.currentSessionId());
  check('currentSessionId() ignores injected ids when launcher-bound', client.currentSessionId('spoofed-model-session') === SESSION_ID,
    client.currentSessionId('spoofed-model-session'));

  // The same contracts and trusted-identity runtime are consumable without MCP.
  // This is the native-adapter seam Pi will call through registerTool().
  const sharedClient = createGolemClient({ baseUrl: doc.url, callerSessionId: SESSION_ID });
  const nativeRuntime = createGolemToolRuntime({
    client: sharedClient,
    callerSessionId: SESSION_ID,
    projectId: PROJECT_ID,
  });
  const registered = [];
  nativeRuntime.register((definition) => registered.push(definition), {
    names: ['ticket_get', 'ticket_create', 'ticket_update'],
  });
  check('native runtime registers wrappers from shared contracts',
    registered.length === 3 && registered.every((entry) => typeof entry.execute === 'function'),
    registered.map((entry) => entry.name).join(','));
  check('shared contract source explicitly records retired subscription surface',
    GOLEM_TOOL_CONTRACTS.every((entry) => !entry.name.includes('subscribe')) && !!RETIRED_GOLEM_TOOL_CONTRACTS.subscriptions);

  const nativeCreated = await nativeRuntime.invoke('ticket_create', {
    title: 'native contract identity journey',
    created_by: 'spoofed-model-session',
    actor: 'spoofed-model-session',
    author: 'spoofed-model-session',
    project_id: SECOND_PROJECT_ID,
  });
  check('native runtime ignores model project_id in favor of trusted project context', nativeCreated.project_id === PROJECT_ID, nativeCreated.project_id);
  check('native runtime injects trusted creator identity', nativeCreated.created_by === SESSION_ID, nativeCreated.created_by);
  check('native runtime refuses model identity impersonation by construction',
    !JSON.stringify(nativeCreated).includes('spoofed-model-session'));

  let deterministicError;
  try { await sharedClient.getTicket('GOL-999999999'); } catch (err) { deterministicError = err; }
  check('shared client exposes structured non-retryable 4xx errors',
    deterministicError instanceof GolemClientError && deterministicError.status === 404 && deterministicError.retryable === false,
    JSON.stringify(deterministicError));
  const offlineClient = createGolemClient({
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl: async () => { throw new Error('synthetic transport outage'); },
  });
  let retryableError;
  try { await offlineClient.listTickets(); } catch (err) { retryableError = err; }
  check('shared client exposes structured retryable transport errors',
    retryableError instanceof GolemClientError && retryableError.code === 'GOLEM_TRANSPORT_ERROR' && retryableError.retryable === true,
    JSON.stringify(retryableError));
  let invalidBaseError;
  try { createGolemClient({ baseUrl: 'not a valid URL' }); } catch (err) { invalidBaseError = err; }
  check('shared client structures malformed base URL errors as non-retryable',
    invalidBaseError instanceof GolemClientError && invalidBaseError.code === 'GOLEM_INVALID_ARGUMENT' && invalidBaseError.retryable === false,
    JSON.stringify(invalidBaseError));
  const brokenBodyClient = createGolemClient({
    baseUrl: doc.url,
    fetchImpl: async () => ({ status: 200, text: async () => { throw new Error('synthetic body read failure'); } }),
  });
  let bodyReadError;
  try { await brokenBodyClient.listTickets(); } catch (err) { bodyReadError = err; }
  check('shared client structures response-body transport errors as retryable',
    bodyReadError instanceof GolemClientError && bodyReadError.code === 'GOLEM_TRANSPORT_ERROR' && bodyReadError.retryable === true,
    JSON.stringify(bodyReadError));

  // 3) createTicket → getTicket round-trip.
  const created = await client.createTicket({
    project_id: PROJECT_ID,
    title: 'Test ticket from client',
    body: 'acceptance: round-trips',
    kind: 'task',
    assignee: SESSION_ID,
    created_by: SESSION_ID,
  });
  check('createTicket returns an id', !!created?.id, JSON.stringify(created));
  check('createTicket persisted project_id', created.project_id === PROJECT_ID, created.project_id);
  check('createTicket default state todo', created.state === 'todo', created.state);

  const foreignSpec = await client.createTicket({
    project_id: SECOND_PROJECT_ID,
    title: 'Foreign project spec',
    body: 'Must never appear in the explicitly scoped project result.',
    kind: 'spec',
    created_by: SESSION_ID,
  });
  check('createTicket preserves a second explicit project scope',
    foreignSpec.project_id === SECOND_PROJECT_ID,
    JSON.stringify(foreignSpec));

  const fetched = await client.getTicket(created.id);
  check('getTicket returns the same title', fetched?.title === 'Test ticket from client', fetched?.title);
  check('getTicket includes comments array', Array.isArray(fetched?.comments), typeof fetched?.comments);

  // 4) listTickets — project filter, then assignee (mine) filter.
  const byProject = await client.listTickets({ project: PROJECT_ID });
  check('listTickets(project) finds the ticket', byProject.some((t) => t.id === created.id), `n=${byProject.length}`);
  check('listTickets(project) excludes another project',
    !byProject.some((t) => t.id === foreignSpec.id),
    JSON.stringify(byProject));

  const mine = await client.listTickets({ project: PROJECT_ID, assignee: SESSION_ID });
  check('listTickets(assignee=mine) finds the ticket', mine.some((t) => t.id === created.id), `n=${mine.length}`);

  const notMine = await client.listTickets({ project: PROJECT_ID, assignee: 'human' });
  check('listTickets(assignee=human) excludes it', !notMine.some((t) => t.id === created.id), `n=${notMine.length}`);

  // 5) updateTicket(state) → in_progress.
  const updated = await client.updateTicket(created.id, { state: 'in_progress', actor: SESSION_ID });
  check('updateTicket flips state to in_progress', updated.state === 'in_progress', updated.state);
  const reFetched = await client.getTicket(created.id);
  check('getTicket sees the persisted state', reFetched.state === 'in_progress', reFetched.state);

  // 6) addComment.
  const comment = await client.addComment(created.id, { author: SESSION_ID, body: 'progress: did the thing' });
  check('addComment returns a comment', !!comment?.id || !!comment?.body, JSON.stringify(comment));
  const withComment = await client.getTicket(created.id);
  check('getTicket now has the comment', withComment.comments.some((c) => /did the thing/.test(c.body)),
    `n=${withComment.comments.length}`);

  // 7) GOL-151: streams are gone from the client surface and the REST API.
  check('client exposes no stream helpers', client.createStream === undefined && client.listStreams === undefined,
    Object.keys(client).filter((k) => /stream/i.test(k)).join(', '));
  const streamRoute = await fetch(`http://${HOST}:${port}/api/streams`);
  check('GET /api/streams is gone', streamRoute.status === 404, String(streamRoute.status));

  // 8) listDispatchable (no live native sessions in the sandbox → empty array, but must 200).
  const dispatchable = await client.listDispatchable(PROJECT_ID);
  check('listDispatchable returns an array', Array.isArray(dispatchable), typeof dispatchable);

  // 9) Error path — non-2xx surfaces the server error + status.
  let threw = null;
  try {
    await client.getTicket('does-not-exist-id');
  } catch (e) {
    threw = e;
  }
  check('getTicket(unknown) throws with status', threw && /404/.test(threw.message), threw?.message);

  let missingProject = null;
  try {
    await client.createTicket({ title: 'must fail before HTTP' });
  } catch (e) {
    missingProject = e;
  }
  check('createTicket without project scope fails at the transport boundary',
    missingProject && /project_id is required at the MCP-to-REST boundary/.test(missingProject.message),
    missingProject?.message);

  let badCreate = null;
  try {
    await client.createTicket({ project_id: PROJECT_ID }); // missing title → 400
  } catch (e) {
    badCreate = e;
  }
  check('createTicket(no title) throws 400 with server error', badCreate && /400/.test(badCreate.message), badCreate?.message);

  // 10) A Claude channel HTTP child is not dispatchable until the host sends
  // the MCP `initialized` notification. This raw stdio child deliberately
  // starts its listener but never initializes the MCP connection.
  const uninitializedCcId = 'cc-not-initialized';
  uninitializedCcChild = spawn(process.execPath, [CHANNEL_SERVER], {
    cwd: CHANNEL_ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: tmpConfigHome,
      GOLEM_HOME: tmpGolemHome,
      GOLEM_CEO_SESSION_ID: uninitializedCcId,
      CLAUDE_CODE_SESSION_ID: '',
      GOLEM_CHANNEL_PORT: '0',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      CLAUDE_CODE_USE_FOUNDRY: '',
      HOME: tmpRoot,
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  uninitializedCcChild.stderr?.on('data', (d) => process.stderr.write(`[uninitialized-cc:err] ${d}`));
  const uninitializedChannel = await waitForChannelEntry(
    uninitializedCcId,
    15_000,
    (channel) => channel.consumer_reason === 'mcp_not_initialized',
  );
  check('CC registry row is explicitly not ready before MCP initialization',
    uninitializedChannel.consumer_ready === false && uninitializedChannel.delivery_ready === false,
    JSON.stringify(uninitializedChannel));
  const uninitializedConsult = await fetch(`http://${uninitializedChannel.host}:${uninitializedChannel.port}/consult`, {
    method: 'POST',
    headers: { 'X-Sender': 'dashboard', 'Content-Type': 'application/json' },
    body: JSON.stringify({ consult_id: 'cns-preinit', question: 'must not be accepted' }),
  });
  check('dedicated consult route is retired', uninitializedConsult.status === 404, await uninitializedConsult.text());
  writeClaudeSession({ sessionId: uninitializedCcId, pid: uninitializedCcChild.pid, name: 'preinit-cc' });
  fs.writeFileSync(path.join(tmpGolemHome, 'sessions.json'), JSON.stringify({ sessions: [{
    session_id: uninitializedCcId,
    project_id: uniqueProjectId,
    project_path: uniqueProjectRoot,
    hook_ppid: uninitializedCcChild.pid,
    harness: 'claudecode',
    name: 'preinit-cc',
    status: 'idle',
    last_seen_at: new Date().toISOString(),
  }] }));
  await sleep(3_500);
  const beforeInitDispatchable = await client.listDispatchable('trialroomai');
  check('unique project name resolves while pre-initialization CC stays non-dispatchable',
    Array.isArray(beforeInitDispatchable) && !beforeInitDispatchable.some((row) => row.session_id === uninitializedCcId),
    JSON.stringify(beforeInitDispatchable));
  const ambiguousProject = await fetch(`${doc.url}/api/sessions/dispatchable?project=${encodeURIComponent('duplicate-human-name')}`);
  const ambiguousProjectText = await ambiguousProject.text();
  check('duplicate human project names return an explicit ambiguity error',
    ambiguousProject.status === 400 && /ambiguous.*pass an exact project_id/i.test(ambiguousProjectText),
    `${ambiguousProject.status} ${ambiguousProjectText}`);
  uninitializedCcChild.stdin.end();
  await Promise.race([new Promise((resolve) => uninitializedCcChild.once('exit', resolve)), sleep(1_000)]);
  if (uninitializedCcChild.exitCode === null) uninitializedCcChild.kill('SIGTERM');
  uninitializedCcChild = null;

  // 11) Drive the real channel MCP handler over stdio.
  mcpClient = new Client({ name: 'golem-ticket-transition-journey', version: '1.0.0' });
  mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [CHANNEL_SERVER],
    cwd: CHANNEL_ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: tmpConfigHome,
      GOLEM_HOME: tmpGolemHome,
      GOLEM_CEO_SESSION_ID: SESSION_ID,
      GOLEM_CHANNEL_PORT: '0',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      CLAUDE_CODE_USE_FOUNDRY: '',
      HOME: tmpRoot,
    },
    stderr: 'pipe',
  });
  mcpTransport.stderr?.on('data', (d) => process.stderr.write(`[mcp:err] ${d}`));
  const channelEvents = [];
  mcpClient.setNotificationHandler(ChannelNotificationSchema, (notification) => channelEvents.push(notification));
  await mcpClient.connect(mcpTransport);

  const channelUrl = await waitForChannel();
  const leases = JSON.parse(fs.readFileSync(path.join(tmpGolemHome, 'endpoint-leases.json'), 'utf8')).leases;
  const lease = leases.find((row) => row.canonical_id === SESSION_ID);
  const validHealth = await fetch(`${channelUrl}/healthz?${new URLSearchParams({ session_id: SESSION_ID, owner_token: lease.owner_token })}`);
  check('identity-bound lease health succeeds', validHealth.status === 200, await validHealth.text());
  const wrongSessionHealth = await fetch(`${channelUrl}/healthz?${new URLSearchParams({ session_id: 'wrong-session', owner_token: lease.owner_token })}`);
  check('lease health rejects wrong canonical session', wrongSessionHealth.status === 403, await wrongSessionHealth.text());
  const wrongOwnerHealth = await fetch(`${channelUrl}/healthz?${new URLSearchParams({ session_id: SESSION_ID, owner_token: 'wrong-owner' })}`);
  check('lease health rejects wrong owner token', wrongOwnerHealth.status === 403, await wrongOwnerHealth.text());
  const roleResponse = await fetch(`${channelUrl}/role`, {
    method: 'POST',
    headers: { 'X-Sender': 'dashboard', 'Content-Type': 'text/plain' },
    body: 'Role assignment test',
  });
  const rolePayload = await roleResponse.json();
  check('POST /role returns role_assign', roleResponse.status === 202 && rolePayload.kind === 'role_assign', JSON.stringify(rolePayload));
  await sleep(50);
  const roleEvent = channelEvents.find((event) => event.params?.meta?.kind === 'role_assign');
  check('POST /role emits role_assign channel event', roleEvent?.params?.content === 'Role assignment test', JSON.stringify(channelEvents));
  check('POST /role never emits a brief event', !channelEvents.some((event) => event.params?.meta?.kind === 'brief'), JSON.stringify(channelEvents));

  const correlatedBrief = await fetch(`${channelUrl}/brief`, {
    method: 'POST',
    headers: { 'X-Sender': 'dashboard', 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Correlated dispatch', envelope_id: 'env-channel-metadata', target_session_id: SESSION_ID }),
  });
  check('POST /brief accepts envelope metadata', correlatedBrief.status === 202, `status ${correlatedBrief.status}`);
  await sleep(50);
  const briefEvent = channelEvents.find((event) => event.params?.content === 'Correlated dispatch');
  check('POST /brief carries envelope metadata to channel event', briefEvent?.params?.meta?.envelope_id === 'env-channel-metadata' && briefEvent?.params?.meta?.target_session_id === SESSION_ID, JSON.stringify(briefEvent));

  // GOL-365: Pi and Claude are the only harnesses. One MCP child per session
  // means there are no sibling bridges: the bridge registry is gone, an
  // unbound MCP registers nothing, and a launcher-bound session ignores
  // model-reachable injected ids.
  check('launcher-bound identity ignores injected caller id', client.currentSessionId('ses_identity_sibling_b') === SESSION_ID, client.currentSessionId('ses_identity_sibling_b'));

  const ccFallbackId = 'ses_claude_env_fallback';
  ccFallbackMcpClient = new Client({ name: 'golem-cc-env-fallback-journey', version: '1.0.0' });
  const ccFallbackNotifications = [];
  ccFallbackMcpClient.setNotificationHandler(ChannelNotificationSchema, (notification) => ccFallbackNotifications.push(notification));
  ccFallbackMcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [CHANNEL_SERVER],
    cwd: CHANNEL_ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: tmpConfigHome,
      GOLEM_HOME: tmpGolemHome,
      GOLEM_CEO_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: ccFallbackId,
      GOLEM_CHANNEL_PORT: '0',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      CLAUDE_CODE_USE_FOUNDRY: '',
      HOME: tmpRoot,
    },
    stderr: 'pipe',
  });
  await ccFallbackMcpClient.connect(ccFallbackMcpTransport);
  const ccFallbackChannel = await waitForChannelEntry(ccFallbackId, 15_000, (channel) => channel.consumer_ready === true);
  const ccFallbackChannels = JSON.parse(fs.readFileSync(path.join(tmpGolemHome, 'channels.json'), 'utf8')).channels;
  check('initialized Anthropic-configured CC registers an eligible channel',
    ccFallbackChannel.harness === 'claudecode' && ccFallbackChannel.delivery_ready === true,
    JSON.stringify(ccFallbackChannel));

  writeClaudeSession({ sessionId: ccFallbackId, pid: ccFallbackChannel.pid, name: 'supported-cc' });
  fs.writeFileSync(path.join(tmpGolemHome, 'sessions.json'), JSON.stringify({ sessions: [{
    session_id: ccFallbackId,
    project_id: uniqueProjectId,
    project_path: uniqueProjectRoot,
    hook_ppid: ccFallbackChannel.pid,
    harness: 'claudecode',
    name: 'supported-cc',
    status: 'idle',
    last_seen_at: new Date().toISOString(),
  }] }));
  await sleep(3_500);
  const supportedByHumanProjectName = await client.listDispatchable('trialroomai');
  check('unique human project name resolves to its canonical project dispatchables',
    supportedByHumanProjectName.some((row) => row.session_id === ccFallbackId && row.project_id === uniqueProjectId && row.reachable === true),
    JSON.stringify(supportedByHumanProjectName));

  const unsupportedCcId = 'cc-custom-provider';
  const unsupportedCcNotifications = [];
  unsupportedCcMcpClient = new Client({ name: 'golem-unsupported-cc-journey', version: '1.0.0' });
  unsupportedCcMcpClient.setNotificationHandler(ChannelNotificationSchema, (notification) => unsupportedCcNotifications.push(notification));
  unsupportedCcMcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [CHANNEL_SERVER],
    cwd: CHANNEL_ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: tmpConfigHome,
      GOLEM_HOME: tmpGolemHome,
      GOLEM_CEO_SESSION_ID: unsupportedCcId,
      CLAUDE_CODE_SESSION_ID: '',
      GOLEM_CHANNEL_PORT: '0',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      CLAUDE_CODE_USE_FOUNDRY: '',
      HOME: tmpRoot,
    },
    stderr: 'pipe',
  });
  unsupportedCcMcpTransport.stderr?.on('data', (d) => process.stderr.write(`[unsupported-cc:err] ${d}`));
  await unsupportedCcMcpClient.connect(unsupportedCcMcpTransport);
  const unsupportedChannel = await waitForChannelEntry(
    unsupportedCcId,
    15_000,
    (channel) => channel.consumer_reason === 'unsupported_custom_base_url',
  );
  check('custom-provider CC stays explicitly ineligible after MCP initialization',
    unsupportedChannel.consumer_ready === false && unsupportedChannel.delivery_ready === false,
    JSON.stringify(unsupportedChannel));
  check('channel metadata persists no provider URL or auth secret',
    !/11434|ANTHROPIC_(?:BASE_URL|API_KEY|AUTH_TOKEN)/.test(JSON.stringify(unsupportedChannel)),
    JSON.stringify(unsupportedChannel));
  writeClaudeSession({ sessionId: unsupportedCcId, pid: unsupportedChannel.pid, name: 'unsupported-cc' });
  fs.writeFileSync(path.join(tmpGolemHome, 'sessions.json'), JSON.stringify({ sessions: [
    {
      session_id: ccFallbackId,
      project_id: uniqueProjectId,
      project_path: uniqueProjectRoot,
      hook_ppid: ccFallbackChannel.pid,
      harness: 'claudecode',
      name: 'supported-cc',
      status: 'idle',
      last_seen_at: new Date().toISOString(),
    },
    {
      session_id: unsupportedCcId,
      project_id: uniqueProjectId,
      project_path: uniqueProjectRoot,
      hook_ppid: unsupportedChannel.pid,
      harness: 'claudecode',
      name: 'unsupported-cc',
      status: 'idle',
      last_seen_at: new Date().toISOString(),
    },
  ] }));
  await sleep(3_500);
  const readinessFilteredDispatchables = await client.listDispatchable('trialroomai');
  check('dashboard dispatchability keeps supported CC and excludes unsupported-provider CC',
    readinessFilteredDispatchables.some((row) => row.session_id === ccFallbackId)
      && !readinessFilteredDispatchables.some((row) => row.session_id === unsupportedCcId),
    JSON.stringify(readinessFilteredDispatchables));



  const tools = await mcpClient.listTools();
  check('MCP advertises the canonical shared contract source without schema drift',
    JSON.stringify(tools.tools) === JSON.stringify(GOLEM_TOOL_CONTRACTS),
    `mcp=${tools.tools.length} shared=${GOLEM_TOOL_CONTRACTS.length}`);
  // GOL-377: the boot instructions string is injected prose — only its
  // presence is a mechanic.
  const bootInstructions = mcpClient.getInstructions?.() || '';
  check('boot instructions are injected non-empty', bootInstructions.trim().length > 0, bootInstructions.slice(0, 120));
  check('MCP omits retired subscription and consult wrapper tools', !tools.tools.some((tool) => ['subscribe', 'unsubscribe', 'subscriptions_list', 'consult_request', 'consult_reply', 'consult_status'].includes(tool.name)), tools.tools.map((tool) => tool.name).join(', '));
  check('MCP retires worker lifecycle tools', !tools.tools.some((tool) => ['session_spawn', 'session_kill'].includes(tool.name)), tools.tools.map((tool) => tool.name).join(', '));
  // GOL-366 fix round 1: the retired delivery/discovery tools never execute.
  // A CallTool of either name must fall through to the unknown-tool error and
  // perform no delivery or discovery side effect. The SDK client surfaces an
  // unknown-tool response as a thrown McpError, so catch and assert it.
  const retiredOutcome = async (name, args) => {
    try {
      const result = await callTool(name, args);
      return { isError: !!result.result.isError, text: result.text };
    } catch (error) {
      return { isError: true, text: String(error?.message ?? error) };
    }
  };
  const retiredNotify = await retiredOutcome('session_notify', { to: SESSION_ID, text: 'retired tool must not deliver' });
  const retiredDiscovery = await retiredOutcome('sessions_dispatchable', {});
  check('retired session_notify direct call fails closed (unknown tool, no delivery)',
    retiredNotify.isError && /unknown tool: session_notify/.test(retiredNotify.text), retiredNotify.text);
  check('retired sessions_dispatchable direct call fails closed (unknown tool, no discovery)',
    retiredDiscovery.isError && /unknown tool: sessions_dispatchable/.test(retiredDiscovery.text), retiredDiscovery.text);
  const spoofedCallerRead = await callTool('ticket_get', {
    id: 'GOL-199',
    __golem_session_id: 'spoofed-model-session',
  });
  check('CC rejects conflicting injected identity before tool dispatch',
    spoofedCallerRead.result.isError && /conflicts with the launcher binding/.test(spoofedCallerRead.text),
    spoofedCallerRead.text);
  check('respond tool is retired — native chat response replaces it', !tools.tools.some((tool) => tool.name === 'respond'), tools.tools.map((tool) => tool.name).join(', '));
  // GOL-150: the phase machine is gone. ticket_update({state}) is the only
  // lifecycle API, so no transition tool may reappear in the advertised set.
  check('MCP no longer lists ticket_transition', !tools.tools.some((tool) => tool.name === 'ticket_transition'), tools.tools.map((tool) => tool.name).join(', '));
  check('shared contract source records the retired transition surface',
    GOLEM_TOOL_CONTRACTS.every((entry) => entry.name !== 'ticket_transition') && !!RETIRED_GOLEM_TOOL_CONTRACTS.ticket_transition);
  const updateTool = tools.tools.find((tool) => tool.name === 'ticket_update');
  check('ticket_update ships a non-empty description', !!updateTool && String(updateTool.description || '').trim().length > 0,
    updateTool?.description);
  // GOL-151: three doc types, no streams, no waves.
  check('MCP no longer lists stream tools', !tools.tools.some((tool) => /^stream_/.test(tool.name)), tools.tools.map((tool) => tool.name).join(', '));
  check('shared contract source records the retired stream surface',
    GOLEM_TOOL_CONTRACTS.every((entry) => !entry.name.startsWith('stream_')) && !!RETIRED_GOLEM_TOOL_CONTRACTS.streams);
  const createTool = tools.tools.find((tool) => tool.name === 'ticket_create');
  check('ticket_create schema exposes the kind enum',
    !!createTool && !!createTool.inputSchema?.properties?.kind, JSON.stringify(createTool?.inputSchema?.properties?.kind));

  const defaultKind = await callTool('ticket_create', { project: PROJECT_ID, title: 'MCP default kind' });
  check('ticket_create defaults to task', !defaultKind.result.isError && defaultKind.json?.kind === 'task', defaultKind.text);
  check('created payload carries no stream_id or wave',
    defaultKind.json && !('stream_id' in defaultKind.json) && !('wave' in defaultKind.json), defaultKind.text);
  const supportingDoc = await callTool('ticket_create', { project: PROJECT_ID, title: 'MCP supporting doc', kind: 'doc' });
  check('ticket_create accepts the doc type', !supportingDoc.result.isError && supportingDoc.json?.kind === 'doc', supportingDoc.text);
  for (const retired of ['work-item', 'fix', 'question', 'decision']) {
    const rejected = await callTool('ticket_create', { project: PROJECT_ID, title: `MCP retired kind ${retired}`, kind: retired });
    check(`retired kind ${retired} is rejected`, rejected.result.isError === true && /invalid kind/.test(rejected.text), rejected.text);
  }

  const createViaMcp = async (title) => {
    const out = await callTool('ticket_create', { project: PROJECT_ID, title, kind: 'task', assignee: SESSION_ID });
    check(`ticket_create succeeds: ${title}`, !out.result.isError && !!out.json?.id, out.text);
    return out.json;
  };

  const specBody = [
    '# Context',
    'This spec proves explicit project scope survives MCP, HTTP, and SQLite persistence.',
    '',
    '## Acceptance criteria',
    '- The ticket remains a spec.',
    '- The requested project remains authoritative routing scope.',
  ].join('\n');
  const specCreated = await callTool('ticket_create', {
    project: PROJECT_ID,
    title: 'MCP explicit-project spec creation',
    body: specBody,
    kind: 'spec',
    assignee: SESSION_ID,
    source_ref: 'github:example/repo#42',
  });
  check('MCP creates a spec with explicit project scope',
    !specCreated.result.isError
      && specCreated.json?.kind === 'spec'
      && specCreated.json?.project_id === PROJECT_ID,
    specCreated.text);
  const persistedSpec = await callTool('ticket_get', { id: specCreated.json?.id });
  check('MCP spec round-trips through REST and SQLite',
    !persistedSpec.result.isError
      && persistedSpec.json?.body === specBody
      && persistedSpec.json?.project_id === PROJECT_ID,
    persistedSpec.text);
  check('GitHub bridge source_ref survives MCP, REST, and SQLite',
    persistedSpec.json?.source_ref === 'github:example/repo#42',
    persistedSpec.text);
  // The bridge link is repairable by a human over REST but never through the
  // agent-facing MCP surface: ticket_update's whitelist omits source_ref, so a
  // wrong ref cannot be silently rewritten by whoever filed it.
  const agentRewrite = await callTool('ticket_update', { id: specCreated.json?.id, source_ref: 'github:evil/repo#1', title: 'MCP explicit-project spec creation' });
  const afterAgentRewrite = await callTool('ticket_get', { id: specCreated.json?.id });
  check('MCP ticket_update cannot rewrite a bridge source_ref',
    !agentRewrite.result.isError && afterAgentRewrite.json?.source_ref === 'github:example/repo#42',
    afterAgentRewrite.text);
  const humanRepair = await fetch(`http://${HOST}:${port}/api/tickets/${encodeURIComponent(specCreated.json?.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_ref: 'github:example/repo#99', actor: 'human' }),
  });
  const afterRepair = await callTool('ticket_get', { id: specCreated.json?.id });
  check('human REST PATCH repairs a wrong bridge source_ref',
    humanRepair.ok && afterRepair.json?.source_ref === 'github:example/repo#99',
    `${humanRepair.status} ${afterRepair.text}`);
  const scopedSpecs = await callTool('ticket_list', { project: PROJECT_ID, kind: 'spec' });
  check('MCP project-scoped spec list does not widen across projects',
    !scopedSpecs.result.isError
      && Array.isArray(scopedSpecs.json)
      && scopedSpecs.json.some((ticket) => ticket.id === specCreated.json?.id)
      && !scopedSpecs.json.some((ticket) => ticket.id === foreignSpec.id),
    scopedSpecs.text);

  // GOL-150: the whole lifecycle runs through ticket_update({state}) — one
  // walk from creation to done, with every hop re-read through ticket_get so
  // the state is proven persisted rather than echoed.
  const walk = await createViaMcp('MCP full state lifecycle walk');
  check('new tickets start in todo', walk.state === 'todo', JSON.stringify(walk.state));
  check('created ticket payload carries no phase field', !('phase' in walk), JSON.stringify(Object.keys(walk)));

  const started = await callTool('ticket_update', { id: walk.id, state: 'in_progress' });
  check('ticket_update moves todo -> in_progress', !started.result.isError && started.json?.state === 'in_progress', started.text);
  check('ticket_update response carries no phase field', started.json && !('phase' in started.json), started.text);

  await callTool('ticket_comment', { id: walk.id, body: 'Closing brief: implementation complete with mechanical evidence.' });
  const review = await callTool('ticket_update', { id: walk.id, state: 'review' });
  check('ticket_update moves in_progress -> review', !review.result.isError && review.json?.state === 'review', review.text);

  const dispatched = await callTool('ticket_dispatch', { id: walk.id, session_id: SESSION_ID, note: 'verification routing' });
  check('review work still dispatches for verification', !dispatched.result.isError, dispatched.text);
  const dispatchBody = channelEvents.filter((event) => event.params?.meta?.kind === 'brief').at(-1)?.params?.content || '';
  check('ticket dispatch carries authenticated return route',
    dispatchBody.includes(`Authenticated delegating session_id: ${SESSION_ID}`)
      && dispatchBody.includes('Return notification: notify that exact recipient id')
      && dispatchBody.includes('golem:team-ops')
      && !/session_notify\(/.test(dispatchBody),
    dispatchBody);

  const closed = await callTool('ticket_update', { id: walk.id, state: 'done' });
  check('ticket_update closes review -> done through MCP alone', !closed.result.isError && closed.json?.state === 'done', closed.text);
  const closedRead = await callTool('ticket_get', { id: walk.id });
  check('done state persists through REST and SQLite', closedRead.json?.state === 'done', closedRead.text);
  check('ticket_get payload carries no phase field', closedRead.json && !('phase' in closedRead.json), closedRead.text);

  // No ladder, no gates: any state is reachable in one hop, in either
  // direction, with no artifact enforcement in the way.
  const jump = await createViaMcp('MCP direct state jump');
  const jumped = await callTool('ticket_update', { id: jump.id, state: 'done' });
  check('todo -> done needs no intermediate hop or artifact', !jumped.result.isError && jumped.json?.state === 'done', jumped.text);
  const reopened = await callTool('ticket_update', { id: jump.id, state: 'in_progress' });
  check('done -> in_progress reopens without a rejection lane', !reopened.result.isError && reopened.json?.state === 'in_progress', reopened.text);
  const blockedOut = await callTool('ticket_update', { id: jump.id, state: 'blocked' });
  check('blocked needs no reason artifact', !blockedOut.result.isError && blockedOut.json?.state === 'blocked', blockedOut.text);

  const badState = await callTool('ticket_update', { id: jump.id, state: 'building' });
  check('a retired phase name is not a valid state', badState.result.isError === true, badState.text);
  check('invalid state error is preserved verbatim', /invalid state 'building'/.test(badState.text), badState.text);
  const afterBadState = await callTool('ticket_get', { id: jump.id });
  check('rejected state update leaves the ticket unchanged', afterBadState.json?.state === 'blocked', afterBadState.text);

  const listed = await callTool('ticket_list', { project: PROJECT_ID, state: 'blocked' });
  check('state filter still lists tickets by lifecycle',
    Array.isArray(listed.json) && listed.json.some((ticket) => ticket.id === jump.id), listed.text);
  check('list payloads carry no phase field',
    Array.isArray(listed.json) && listed.json.every((ticket) => !('phase' in ticket)), listed.text);

  // GOL-335 D2: a trusted launch selection advertises the CLI-first surface.
  // Advertisement, server instructions, and direct-call rejection must agree,
  // and identity rejection keeps its precedence over the surface intercept.
  // A counting proxy sits at the service boundary (it forwards every request
  // to the real isolated dashboard) so discovery/delivery requests are counted,
  // not inferred from channel-event absence. Module-scoped handle so the outer
  // finally can close it if main() aborts before its own cleanup.
  const proxyCounts = new Map();
  const countKey = (method, urlPath) => `${method} ${urlPath.split('?')[0]}`;
  let proxyUpstream = JSON.parse(fs.readFileSync(path.join(tmpGolemHome, 'dashboard.json'), 'utf8')).url.replace(/\/+$/, '');
  // An ephemeral port reserved and released: a real closed allowed port for the
  // refusal check (port 1 is fetch-forbidden locally, not a network refusal).
  const reservedPortServer = net.createServer();
  await new Promise((resolve) => reservedPortServer.listen(0, HOST, resolve));
  const closedUpstreamPort = reservedPortServer.address().port;
  await new Promise((resolve) => reservedPortServer.close(resolve));
  proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      proxyCounts.set(countKey(req.method, req.url), (proxyCounts.get(countKey(req.method, req.url)) || 0) + 1);
      // A real fetch failure (unreachable or hung upstream) must yield a
      // bounded 502 response object that satisfies the header/arrayBuffer reads
      // below; AbortSignal.timeout bounds the proxy's own wait.
      const upstream = await fetch(`${proxyUpstream}${req.url}`, {
        method: req.method, headers: { ...req.headers, host: new URL(proxyUpstream).host },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
        signal: AbortSignal.timeout(PROXY_UPSTREAM_TIMEOUT_MS),
      }).catch((error) => new Response(`proxy upstream unreachable: ${error?.cause?.code ?? error?.name ?? error}`, {
        status: 502, headers: { 'content-type': 'text/plain' },
      }));
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      res.end(Buffer.from(await upstream.arrayBuffer().catch(() => new Uint8Array())));
    });
  });
  await new Promise((resolve) => proxy.listen(0, HOST, resolve));
  proxyPort = proxy.address().port;
  fs.writeFileSync(path.join(tmpGolemHome, 'dashboard.json'), JSON.stringify({ url: `http://127.0.0.1:${proxyPort}` }));
  // GOL-365: Pi and Claude are the only harnesses — the full shared contract
  // list is the only tool surface. No launch-time selection exists, so the
  // retired delivery/discovery tools never advertise and never intercept.
  const soleSurfaceTools = await mcpClient.listTools();
  const soleSurfaceNames = soleSurfaceTools.tools.map((tool) => tool.name);
  check('the sole surface omits retired delivery and discovery tools',
    ['session_notify', 'sessions_dispatchable', 'subscribe', 'unsubscribe', 'consult_request'].every((name) => !soleSurfaceNames.includes(name)),
    soleSurfaceNames.join(', '));
  check('the sole surface keeps tracker, dispatch, ack, role and context tools',
    ['ack', 'ticket_list', 'ticket_get', 'ticket_create', 'ticket_update', 'ticket_comment',
      'ticket_comment_update', 'ticket_comment_reply', 'session_role', 'ticket_dispatch', 'project_context']
      .every((name) => soleSurfaceNames.includes(name)),
    soleSurfaceNames.join(', '));
  const soleRoleTool = soleSurfaceTools.tools.find((tool) => tool.name === 'session_role');
  check('session_role ships a non-empty description', !!soleRoleTool && String(soleRoleTool.description || '').trim().length > 0,
    JSON.stringify(soleRoleTool));

  // Real failure/cleanup checks on the proxy fixture itself.
  // (1) A real network hang: an accepting-never-responding loopback upstream,
  // bounded by AbortSignal.timeout in the proxy and a client deadline here.
  silentUpstream = net.createServer((socket) => {
    silentSockets.add(socket);
    socket.on('close', () => silentSockets.delete(socket));
    socket.resume(); // accept and never respond
  });
  await new Promise((resolve) => silentUpstream.listen(0, HOST, resolve));
  proxyUpstream = `http://127.0.0.1:${silentUpstream.address().port}`;
  const hangStart = Date.now();
  const hangResponse = await fetch(`http://127.0.0.1:${proxyPort}/api/health`, { signal: AbortSignal.timeout(10_000) });
  const hangMs = Date.now() - hangStart;
  check('accepting-never-responding upstream yields the bounded 502 within the proxy deadline (real network hang, not a forbidden port)',
    hangResponse.status === 502 && hangMs < 5000, `status=${hangResponse.status} elapsed=${hangMs}ms`);
  check('proxy counted the hung request at the service boundary',
    (proxyCounts.get('GET /api/health') || 0) >= 1, JSON.stringify([...proxyCounts]));

  // (2) Refusal against an ephemeral closed allowed port (real ECONNREFUSED).
  proxyUpstream = `http://127.0.0.1:${closedUpstreamPort}`;
  const refusalResponse = await fetch(`http://127.0.0.1:${proxyPort}/api/health`, { signal: AbortSignal.timeout(10_000) });
  check('closed allowed upstream port yields the bounded 502 refusal',
    refusalResponse.status === 502, `status=${refusalResponse.status}`);

  // (3) Cleanup: close proxy and silent upstream; the listener must refuse
  // connections afterwards and the hung socket must be destroyed.
  await new Promise((resolve) => proxy.close(resolve));
  proxy = null;
  for (const socket of silentSockets) socket.destroy();
  await new Promise((resolve) => silentUpstream.close(resolve));
  silentUpstream = null;
  const refusalAfterClose = await fetch(`http://127.0.0.1:${proxyPort}/api/health`, { signal: AbortSignal.timeout(5_000) })
    .then(() => 'still-open')
    .catch((error) => error?.cause?.code ?? error?.code ?? 'closed');
  check('proxy cleanup closes the listener (connection refused after close)',
    refusalAfterClose !== 'still-open', String(refusalAfterClose));
  check('hung upstream socket is destroyed with the silent server', silentSockets.size === 0, `remaining=${silentSockets.size}`);
}

main()
  .catch((err) => {
    failures++;
    console.error('UNHANDLED:', err?.stack || err);
  })
  .finally(async () => {
    // Kill child, clean temp.
    try { await mcpClient?.close(); } catch { /* ignore */ }
    try { await mcpTransport?.close(); } catch { /* ignore */ }
    try { await identityMcpClient?.close(); } catch { /* ignore */ }
    try { await identityMcpTransport?.close(); } catch { /* ignore */ }
    try { await noIdentityMcpClient?.close(); } catch { /* ignore */ }
    try { await noIdentityMcpTransport?.close(); } catch { /* ignore */ }
    try { await ccFallbackMcpClient?.close(); } catch { /* ignore */ }
    try { await ccFallbackMcpTransport?.close(); } catch { /* ignore */ }
    try { await cliFirstMcpClient?.close(); } catch { /* ignore */ }
    try { await cliFirstMcpTransport?.close(); } catch { /* ignore */ }
    try { await unsupportedCcMcpClient?.close(); } catch { /* ignore */ }
    try { await unsupportedCcMcpTransport?.close(); } catch { /* ignore */ }
    try { uninitializedCcChild?.kill('SIGKILL'); } catch { /* ignore */ }
    try { await new Promise((resolve) => bridgeCaptureServer?.close(resolve) ?? resolve()); } catch { /* ignore */ }
    try { if (proxy) await new Promise((resolve) => proxy.close(resolve)); } catch { /* ignore */ }
    try { for (const socket of silentSockets) socket.destroy(); } catch { /* ignore */ }
    try { if (silentUpstream) await new Promise((resolve) => silentUpstream.close(resolve)); } catch { /* ignore */ }
    try { child?.kill('SIGKILL'); } catch { /* ignore */ }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    if (failures === 0) {
      console.log('\nALL PASS (exit 0)');
      process.exit(0);
    } else {
      console.log(`\n${failures} FAILURE(S) (exit 1)`);
      process.exit(1);
    }
  });
