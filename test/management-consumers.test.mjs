#!/usr/bin/env node
// Shared projection + actual CLI/HTTP/MCP consumers; isolated state and children.
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http'; import { spawn } from 'node:child_process'; import { once } from 'node:events';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-management-consumers-'));
process.env.GOLEM_HOME = path.join(temp, 'state'); delete process.env.GOLEM_HERDR_SESSION;
const { createTeam, joinTeam } = await import('../lib/team-registry.js');
const { claimWorker, updateWorker } = await import('../lib/worker-registry.js');
const { upsertSessionFact, readSessionFacts } = await import('../lib/session-facts.js');
const { projectManagementSnapshot } = await import('../lib/management-registry.js');
const { captureProcessGroup } = await import('../lib/process-group.js');
const { managementRosterSnapshot } = await import('../lib/management-capabilities.js');
const { enrichDispatchableRows, peekSessionTerminal } = await import('../lib/worker-manager.js');
const { buildRosterRows, runAgent } = await import('../cli/agent.js');
const projectId = 'consumer-proj-abcdef', session = 'owned-consumer-session';
const ownerId = '11111111-1111-1111-1111-111111111111', outsideId = '22222222-2222-2222-2222-222222222222';
const team = createTeam({ label: 'Consumer Team', projectId, herdrSession: session, ownerSessionId: ownerId });
const children = [0, 1].map(() => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }));
const exits = children.map(child => once(child, 'exit')); let server;
try {
  const managed = claimWorker({ role: 'builder', projectId, teamId: team.team_id, preset: { harness: 'pi' } });
  updateWorker(managed.worker_id, { state: 'live', session_id: 'managed-consumer', herdr_pane_id: 'managed-pane', herdr_tab_id: 'managed-tab', herdr_workspace_id: 'managed-w', process_ownership: captureProcessGroup(children[0].pid) });
  const file = path.join(temp, 'external-owner.jsonl');
  upsertSessionFact({ canonical_id: ownerId, harness: 'pi', project_id: projectId, name: 'external-owner', status: 'idle', locator: { raw_session_id: ownerId, session_file: file } });
  upsertSessionFact({ canonical_id: outsideId, harness: 'pi', project_id: projectId, name: 'outside', status: 'idle', locator: { raw_session_id: outsideId, session_file: path.join(temp, 'outside.jsonl') } });
  const nativeOwner = { agent: 'pi', pane_id: 'owner-pane', tab_id: 'owner-tab', workspace_id: 'owner-w', agent_session: { kind: 'path', value: file } };
  const nativeManaged = { pane_id: 'managed-pane', tab_id: 'managed-tab', workspace_id: 'managed-w' };
  let unavailable = false; let reads = 0; let attaches = 0;
  const native = { agentList: () => { if (unavailable) throw new Error('native source failed'); return [nativeManaged, nativeOwner]; },
    agentGet: ({ target }) => target === 'owner-pane' ? nativeOwner : nativeManaged,
    paneProcessInfo: ({ paneId }) => paneId === 'owner-pane' ? { foreground_process_group_id: children[1].pid, foreground_processes: [{ pid: children[1].pid, argv0: 'pi', argv: ['pi', '--session', file] }] } : { foreground_process_group_id: children[0].pid },
    paneRead: ({ paneId }) => { reads++; return `exact terminal ${paneId}`; }, agentAttach: () => { attaches++; return 0; } };
  const inputs = [{ session_id: 'managed-consumer', project_id: projectId, delivery_ready: false }, { session_id: ownerId, project_id: projectId, delivery_ready: true }, { session_id: outsideId, project_id: projectId, delivery_ready: true }];
  const facts = readSessionFacts();
  const registryBytes = () => JSON.stringify(['workers.json', 'teams.json', 'herdr-mappings.json', 'session-facts.json'].map(name => fs.readFileSync(path.join(process.env.GOLEM_HOME, name), 'utf8')));
  const beforeReads = registryBytes();
  const projected = enrichDispatchableRows(inputs, { projectId, native, facts });
  assert.equal(projected[0].capabilities.read.state, 'available'); assert.equal(projected[0].delivery_ready, false, 'control does not imply delivery');
  assert.equal(projected[1].host, 'external'); assert.equal(projected[1].team_id, team.team_id, 'external owner uses canonical relation'); assert.equal(projected[1].capabilities.read.state, 'available'); assert.equal(projected[1].capabilities.stop.state, 'available'); assert.equal(projected[1].capabilities.adopt.state, 'available');
  assert.equal(projected[2].capabilities.read.state, 'unsupported'); assert.equal(projected[2].delivery_ready, true, 'delivery does not imply native control');
  const duplicate = structuredClone(projectManagementSnapshot()); duplicate.workers.workers.push({ ...duplicate.workers.workers[0], worker_id: 'different-live-runtime' });
  const ambiguous = managementRosterSnapshot([inputs[0]], { snapshot: duplicate, facts, native })[0]; assert.equal(ambiguous.capabilities.stop.state, 'unavailable'); assert.equal(ambiguous.control_candidates.length, 2);
  const cliRows = buildRosterRows(projected, { teams: [team] });
  for (let i = 0; i < projected.length; i++) { assert.deepEqual(cliRows[i].capabilities, projected[i].capabilities); assert.deepEqual(cliRows[i].placement, projected[i].placement); assert.equal(cliRows[i].team_id, projected[i].team_id); }
  const run = async args => { const out = []; const exit = await runAgent('agent', [...args, '--json'], { cwd: temp, env: {}, native, resolveContext: () => null, manager: { listAgentRoster: async () => ({ roster: projected, ended: [] }) }, stdout: t => out.push(t), stderr: () => {} }); return { exit, value: JSON.parse(out.join('')) }; };
  const listed = await run(['list', '--scope', 'all']); assert.equal(listed.exit, 0); assert.equal(listed.value.schema_version, 2); assert.deepEqual(listed.value.items.map(r => r.capabilities), projected.map(r => r.capabilities));
  const externalRead = await run(['read', ownerId]); assert.equal(externalRead.exit, 0); assert.equal(externalRead.value.text, 'exact terminal owner-pane');
  const externalAttach = await run(['attach', ownerId]); assert.equal(externalAttach.exit, 0); assert.equal(attaches, 1);
  const outsideRead = await run(['read', outsideId]); assert.equal(outsideRead.exit, 1); assert.equal(outsideRead.value.capabilities.read.state, 'unsupported'); assert.ok(!/not found/.test(outsideRead.value.error));
  const terminal = await peekSessionTerminal(ownerId, { projectId, native }); assert.equal(terminal.ok, true); assert.equal(terminal.attach_hint, `golem agent attach ${ownerId}`); assert.deepEqual(terminal.capabilities, projected[1].capabilities);
  const beforeUnknown = reads; unavailable = true;
  const unknown = managementRosterSnapshot(inputs, { facts, native }); assert.equal(unknown[1].capabilities.read.state, 'unavailable'); assert.match(unknown[1].capabilities.read.reason, /native source failed/);
  const deniedTerminal = await peekSessionTerminal(ownerId, { projectId, native }); assert.equal(deniedTerminal.ok, false); assert.equal(reads, beforeUnknown, 'unavailable preview never reads another terminal'); unavailable = false;
  let requests = 0;
  server = http.createServer((req, res) => { requests++; assert.ok(req.url.startsWith('/api/sessions/dispatchable')); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(projected)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.GOLEM_DASHBOARD_URL = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(process.env.GOLEM_HOME, 'dashboard.json'), JSON.stringify({ url: process.env.GOLEM_DASHBOARD_URL }));
  const client = await import('../mcp/channel/tracker-client.js');
  assert.equal(client.dashboardBaseUrl(), process.env.GOLEM_DASHBOARD_URL, 'MCP private endpoint setup verified before any request');
  const received = await client.listDispatchable(projectId); assert.equal(requests, 1, 'actual MCP request reached this owned HTTP server'); assert.ok(Array.isArray(received)); assert.deepEqual(received.map(r => [r.team_id, r.capabilities, r.placement]), projected.map(r => [r.team_id, r.capabilities, r.placement]));
  const bytes = fs.readFileSync(path.join(process.env.GOLEM_HOME, 'workers.json'), 'utf8');
  managementRosterSnapshot(inputs, { snapshot: projectManagementSnapshot(), facts, native }); assert.equal(fs.readFileSync(path.join(process.env.GOLEM_HOME, 'workers.json'), 'utf8'), bytes);
  assert.equal(registryBytes(), beforeReads, 'all canonical registry/fact bytes remain unchanged');
  // Mapped external controls do not require adoption or process/lease evidence.
  native.paneProcessInfo = () => { throw new Error('process identity must not gate controls'); };
  native.paneLabel = () => true;
  native.paneMove = ({ workspaceId }) => ({ pane_id: 'owner-moved', tab_id: 'owner-moved-tab', workspace_id: workspaceId });
  const externalRename = await run(['rename', ownerId, 'external-renamed']); assert.equal(externalRename.exit, 0);
  const externalMove = await run(['move', ownerId, '--workspace', 'other-workspace']); assert.equal(externalMove.exit, 0);
  let nativeStops = 0;
  native.paneClose = ({ paneId }) => { assert.equal(paneId, 'owner-pane'); nativeStops++; process.kill(-children[1].pid, 'SIGTERM'); return true; };
  native.paneList = () => [];
  const externalStop = await run(['stop', ownerId]); assert.equal(externalStop.exit, 0, JSON.stringify(externalStop.value)); assert.equal(nativeStops, 1);
  assert.equal(readSessionFacts().find(f => f.canonical_id === ownerId).status, 'stopped');
  await exits[1];
  console.log('management consumers passed: shared managed/external owner/member projection, CLI v2 and HTTP/MCP arrays, readiness separation, external read/attach, unavailable terminal guard, zero-write snapshot');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  for (const child of children) if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
  await Promise.all(exits); fs.rmSync(temp, { recursive: true, force: true });
  console.log('management consumers cleanup passed: owned children/HTTP server ended before state removal');
}
