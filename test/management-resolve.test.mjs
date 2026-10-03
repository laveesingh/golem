// GOL-409: pure precedence plus real worktree CLI/consumer/zero-write checks.
import { parseCliEnvelope } from './_cli-envelope.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseManagementList } from './_management-list.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-resolve-'));
const home = path.join(temp, 'state');
process.env.GOLEM_HOME = home; delete process.env.HERDR_ENV; delete process.env.GOLEM_HERDR_SESSION;
process.env.GOLEM_DASHBOARD_URL = 'http://127.0.0.1:1';
const { projectIdFor } = await import('../lib/project-id.js');
const { collectManagementContext } = await import('../lib/management-context.js');
const { resolveManagement } = await import('../lib/management-resolve.js');
const { managementQuery, operationPlan } = await import('../lib/management-cli.js');
const { runAgent } = await import('../cli/agent.js');
const { runTeam } = await import('../cli/team.js');
const { runSession } = await import('../cli/session.js');
const { runContext } = await import('../cli/context.js');
const { readWorkers } = await import('../lib/worker-registry.js');
const { enrichDispatchableRows, peekWorker } = await import('../lib/worker-manager.js');
const { joinTeam } = await import('../lib/team-registry.js');
const roots = ['a', 'b', 'new'].map(name => path.join(temp, name));
for (const root of roots) fs.mkdirSync(path.join(root, '.git'), { recursive: true });
const [pA, pB, pNew] = roots.map(projectIdFor);
const nativeSessions = [{ name: 'runtime-a', running: true }, { name: 'runtime-b', running: true }];
const ta = { team_id: 'team-a', label: 'Alpha', slug: 'alpha', project_id: pA, owner_session_id: 'caller-a', member_session_ids: ['sid-a'], herdr_session: 'runtime-a', herdr_workspace_id: 'wa', closed_at: null };
const tb = { ...ta, team_id: 'team-b', label: 'Beta', slug: 'beta', owner_session_id: 'caller-b', member_session_ids: ['sid-b', 'sid-only', 'caller-managed'], herdr_workspace_id: 'wb' };
const tc = { ...ta, team_id: 'team-c', label: 'Other', slug: 'other', project_id: pB, owner_session_id: 'caller-c', member_session_ids: ['sid-cross'], herdr_session: 'runtime-b', herdr_workspace_id: 'wc' };
const worker = (id, sid, name, team, root, workspace = team.herdr_workspace_id) => ({ worker_id: id, session_id: sid, name, role: 'builder', state: 'live',
  project_id: team.project_id, project_root: root, team_id: team.team_id, herdr_session: team.herdr_session, herdr_workspace_id: workspace,
  herdr_pane_id: `${workspace}:p1`, herdr_tab_id: `${workspace}:t1`, herdr_agent_name: `legacy-${id}`, preset: { harness: 'pi', model: 'fixture' } });
const fixtureWorkers = [worker('worker-a', 'sid-a', 'builder1', ta, roots[0]), worker('worker-b', 'sid-b', 'builder1', tb, roots[0]),
  worker('worker-only', 'sid-only', 'only-beta', tb, roots[0]), worker('worker-cross', 'sid-cross', 'builder1', tc, roots[1]),
  worker('worker-caller', 'caller-managed', 'caller', ta, roots[0]), { worker_id: 'expired', project_id: pA, state: 'dead', ended_at: '2000-01-01T00:00:00Z' }];
const write = (name, value) => fs.writeFileSync(path.join(home, name), JSON.stringify(value));
function seed({ version = 2, conflict = false, empty = false } = {}) {
  fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home);
  write('projects.json', { version: 1, projects: roots.map((root, i) => ({ id: [pA, pB, pNew][i], path: root, name: ['Alpha Project', 'Other Project', 'New Project'][i] })) });
  const teams = empty ? [] : [ta, tb, tc, ...(conflict ? [{ ...ta, team_id: 'conflict', slug: 'conflict', owner_session_id: null, member_session_ids: [], herdr_session: 'contradictory-runtime' }] : [])];
  write('teams.json', { version, teams, ...(version === 2 ? { revision: 1, imports: { [pA]: { membership: 'complete' }, [pB]: { membership: 'complete' } } } : {}) });
  write('workers.json', { version: 1, workers: empty ? [] : fixtureWorkers });
  write('sessions.json', { version: 1, sessions: empty ? [] : [{ session_id: 'sid-a', project_path: roots[0], cwd: roots[1], name: 'builder1' }, { session_id: 'external', project_id: pA, name: 'external' }] });
  write('session-facts.json', { version: 1, facts: [] });
  write('endpoint-leases.json', { version: 1, leases: [] });
  if (version === 2) write('herdr-mappings.json', { version: 1, revision: 1, projects: empty ? {} : {
    [pA]: { project_id: pA, session: 'runtime-a', lifecycle: 'open', generation: 0 }, [pB]: { project_id: pB, session: 'runtime-b', lifecycle: 'open', generation: 0 } }, intents: [] });
}
function bytes() {
  return Object.fromEntries(fs.readdirSync(home).sort().map(name => [name, fs.statSync(path.join(home, name)).isFile() ? fs.readFileSync(path.join(home, name), 'utf8') : '<directory>']));
}
let checks = 0, server;
const check = (name, fn) => { fn(); console.log(`ok ${++checks} - ${name}`); };
const collection = (extra = {}) => collectManagementContext({ cwd: roots[0], env: {}, resolveContext: () => null, nativeSessions, ...extra });
const query = async (input, extra = {}) => resolveManagement(input, await collection(extra));
const bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
const nativeLog = path.join(temp, 'native.jsonl');
const fakeNative = path.join(bin, 'herdr');
fs.writeFileSync(fakeNative, `#!${process.execPath}
const fs=require('fs');const raw=process.argv.slice(2);const args=raw[0]==='--session'?raw.slice(2):raw;
const key=args.join(' ');const mutation=!(key==='session list --json'||key==='agent list'||key.startsWith('pane read')||key.startsWith('agent get')||key==='pane list'||key.startsWith('pane process-info')||key==='pane current --current');
fs.appendFileSync(${JSON.stringify(nativeLog)},JSON.stringify({key,mutation})+'\\n');
if(key==='session list --json'){console.log(JSON.stringify({sessions:process.env.GOLEM_FIXTURE_EMPTY_NATIVE==='1'?[]:${JSON.stringify(nativeSessions)}}));}
else if(key==='agent list'){console.log(JSON.stringify({result:{agents:[]}}));}
else if(key.startsWith('pane read')){process.stdout.write('safe native scrollback');}
else if(key==='pane list'){console.log(JSON.stringify({result:{panes:${JSON.stringify(fixtureWorkers.filter(w => w.herdr_pane_id).map(w => ({ pane_id: w.herdr_pane_id, tab_id: w.herdr_tab_id, workspace_id: w.herdr_workspace_id })))}}}));}
else if(key.startsWith('pane process-info')){console.log(JSON.stringify({result:{process_info:{foreground_process_group_id:null,foreground_processes:[]}}}));}
else if(key.startsWith('agent get')){console.log(JSON.stringify({result:{agent:{name:args[2],pane_id:args[2],workspace_id:args[2].split(':')[0],tab_id:args[2].split(':')[0]+':t1'}}}));}
else if(key==='pane current --current'){console.log(JSON.stringify({result:{pane:{pane_id:'wa:moved',workspace_id:'wa',tab_id:'wa:t2',focused:false}}}));}
else if(key.startsWith('agent attach')||key===''){process.stdout.write('native attach UI text\\n');}
else {process.stderr.write('unexpected native mutation');process.exit(99);}
`, { mode: 0o700 });
fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\ncase "$4" in lstart=) exec /bin/ps "$@" ;; *) exit 1 ;; esac\n', { mode: 0o700 });
const childEnv = { ...process.env, HOME: path.join(temp, 'home'), GOLEM_HOME: home, GOLEM_HERDR_BIN: fakeNative,
  GOLEM_DASHBOARD_URL: 'http://127.0.0.1:1', PATH: `${bin}:${process.env.PATH}`, HERDR_ENV: '0' };
for (const key of ['CLAUDE_CODE_SESSION_ID', 'GOLEM_SESSION_ID', 'GOLEM_CEO_SESSION_ID', 'PI_SESSION_ID', 'GOLEM_MANAGED_CODEX_BOUND', 'GOLEM_HERDR_SESSION']) delete childEnv[key];
const cli = (args, extra = {}) => spawnSync(process.execPath, [path.join(repo, 'cli/golem.js'), ...args], { cwd: roots[0], env: { ...childEnv, ...extra }, encoding: 'utf8', timeout: 10000 });
const mutations = () => fs.existsSync(nativeLog) ? fs.readFileSync(nativeLog, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)).filter(row => row.mutation).length : 0;
const invoke = async (run, family, args, extra = {}) => { const output = []; const errors = []; const status = await run(family, args, {
  stdout: t => output.push(t), stderr: t => errors.push(t), cwd: roots[0], env: {}, resolveContext: () => null, ...extra });
  return { status, text: output.join('\n'), error: errors.join('\n') }; };
try {
  seed(); const baseBytes = bytes(); const evidence = await collection();
  check('collector is immutable/read-only; tombstones and pinned project survive cwd drift', () => {
    assert.ok(Object.isFrozen(evidence)); assert.ok(Object.isFrozen(evidence.agents)); assert.deepEqual(bytes(), baseBytes);
    assert.equal(evidence.agents.find(a => a.session_id === 'sid-a').project_id, pA);
    assert.equal(evidence.workers.some(w => w.worker_id === 'expired'), true);
  });
  const projectRecords = JSON.parse(fs.readFileSync(path.join(home, 'projects.json')));
  projectRecords.projects[0].id = 'legacy-registry-alias'; write('projects.json', projectRecords);
  const humanProject = await managementQuery({ operation: 'agent list', kind: 'agent', options: { '--project': 'Alpha Project' }, cwd: roots[1], env: {}, resolveContext: () => null });
  check('human/legacy project labels resolve to canonical registered root identity without runtime-name derivation', () => { assert.equal(humanProject.resolution.project_id, pA); assert.equal(humanProject.resolution.session, 'runtime-a'); });
  write('projects.json', { ...projectRecords, projects: projectRecords.projects.map((p, i) => i === 0 ? { ...p, id: pA } : p) });
  const exact = await query({ operation: 'agent read', kind: 'agent', target: 'sid-cross' }, { resolveContext: () => { throw new Error('caller discovery failed'); } });
  check('cross-project exact ID establishes parents before cwd/caller errors', () => { assert.equal(exact.ok, true); assert.equal(exact.project_id, pB); assert.equal(exact.team_id, tc.team_id); assert.equal(exact.provenance.project_id, 'exact-target'); assert.equal(exact.evidence.callerAgent.status, 'unavailable'); });
  const wrongParents = await query({ operation: 'agent stop', kind: 'agent', target: 'sid-cross', selectors: { project: pA, team: ta.team_id, session: 'runtime-a' } });
  check('contradictory explicit parents fail with actual target IDs and no effects', () => { assert.equal(wrongParents.ok, false); assert.equal(wrongParents.target, null); assert.ok(wrongParents.missing.some(c => c.message.includes('sid-cross'))); assert.deepEqual(bytes(), baseBytes); });
  const hard = await query({ operation: 'agent read', kind: 'agent', target: 'only-beta', selectors: { team: ta.team_id } });
  const preferred = await query({ operation: 'agent read', kind: 'agent', target: 'only-beta' }, { resolveContext: () => ({ sessionId: 'caller-a', projectId: pA }) });
  check('explicit team is hard; inferred team may fall back to unique project match', () => { assert.equal(hard.ok, false); assert.equal(hard.target, null); assert.ok(hard.candidates.every(c => c.team_id === ta.team_id)); assert.equal(preferred.ok, true); assert.equal(preferred.target.session_id, 'sid-only'); });
  const constrained = await query({ operation: 'agent create', kind: 'agent', requiresTeam: true, selectors: { project: pB } }, { resolveContext: () => ({ sessionId: 'caller-a', projectId: pA }) });
  check('explicit project discards incompatible implicit team', () => { assert.equal(constrained.project_id, pB); assert.equal(constrained.team_id, null); assert.equal(constrained.ok, false); assert.ok(constrained.candidates.every(c => c.project_id === pB)); });
  const movedEnv = { HERDR_ENV: '1', HERDR_SESSION: 'runtime-a', HERDR_PANE_ID: 'old-pane' };
  const paneQuery = () => ({ session: 'runtime-a', workspace_id: 'wa', pane_id: 'wa:moved', tab_id: 'wa:t2', focused: false });
  const human = await query({ operation: 'context', kind: 'context' }, { env: movedEnv, nativePaneQuery: paneQuery });
  const managed = await query({ operation: 'context', kind: 'context' }, { env: movedEnv, nativePaneQuery: paneQuery, resolveContext: () => ({ sessionId: 'caller-managed', projectId: pA }) });
  check('human pane uses actual workspace; managed logical transfer wins physical placement/cache', () => { assert.equal(human.team_id, ta.team_id); assert.equal(human.provenance.team_id, 'caller-pane-workspace'); assert.equal(managed.team_id, tb.team_id); assert.equal(managed.provenance.team_id, 'caller-agent-membership'); assert.equal(managed.placement.workspace_id, 'wa'); });
  const cwdOnly = await query({ operation: 'agent create', kind: 'agent', requiresTeam: true });
  check('cwd never guesses a team, even with a single scoped team', () => { const one = resolveManagement({ operation: 'agent create', kind: 'agent', requiresTeam: true }, { ...evidence, teams: [ta] }); assert.equal(cwdOnly.team_id, null); assert.equal(one.team_id, null); assert.equal(one.ok, false); });
  const callerSelf = await query({ operation: 'agent read', kind: 'agent', target: 'self', selectors: { caller: 'sid-cross' } });
  const noSelf = await query({ operation: 'agent read', kind: 'agent', target: 'self' });
  check('explicit caller selects self only; unresolved self asks for a concrete caller', () => { assert.equal(callerSelf.target.session_id, 'sid-cross'); assert.equal(callerSelf.project_id, pB); assert.equal(noSelf.ok, false); assert.ok(noSelf.corrected_command.includes('--caller')); });
  const malformed = resolveManagement({ operation: 'agent read', kind: 'agent', target: 'sid-cross' }, { ...evidence, sources: { ...evidence.sources,
    callerAgent: { status: 'resolved', value: { sessionId: 42 } }, callerPane: null, nativeSessions: { status: 'mystery', value: 'bad' } } });
  check('malformed/unavailable evidence remains diagnostic without breaking explicit targets', () => { assert.equal(malformed.ok, true); assert.equal(malformed.evidence.callerAgent.status, 'unavailable'); assert.equal(malformed.evidence.callerPane.status, 'unavailable'); });
  const overridden = await query({ operation: 'agent read', kind: 'agent', target: 'sid-a' }, { env: { GOLEM_HERDR_SESSION: 'different-target' } });
  const callerOverride = await query({ operation: 'context', kind: 'context' }, { env: { ...movedEnv, GOLEM_HERDR_SESSION: 'different-target' }, nativePaneQuery: paneQuery });
  check('target override cannot silently retarget exact controls or the inherited caller context', () => {
    assert.equal(overridden.ok, false); assert.ok(overridden.conflicts.some(c => c.message.includes('GOLEM_HERDR_SESSION')));
    assert.equal(callerOverride.ok, true); assert.equal(callerOverride.team_id, ta.team_id); assert.equal(callerOverride.placement.workspace_id, 'wa');
  });
  const positional = await query({ operation: 'session close', kind: 'session', target: 'runtime-a', selectors: { session: 'runtime-b' } });
  check('positional native handle and --session must agree', () => assert.equal(positional.ok, false));
  const newStart = await managementQuery({ operation: 'session start', kind: 'session', options: { '--project': pNew }, cwd: roots[2], env: {}, resolveContext: () => null, nativeSessions });
  check('implicit new start plan requests allocation without writing or guessing a handle', () => { assert.equal(newStart.resolution.ok, true); assert.equal(operationPlan(newStart).plan.association, 'allocation-required-on-real-mutation'); assert.equal(newStart.resolution.session, null); assert.deepEqual(bytes(), baseBytes); });

  let calls = 0;
  const manager = { spawnWorker: async () => { calls++; }, killWorker: async () => { calls++; }, attachWorker: async () => { calls++; return 0; },
    peekWorker: async (_name, options) => { assert.equal(options.workerId, 'worker-cross'); return 'explicit native read'; },
    listAgentRoster: async () => ({ roster: enrichDispatchableRows(evidence.agents.filter(a => a.session_id)), ended: [] }) };
  const explicitRead = await invoke(runAgent, 'agent', ['read', 'sid-cross', '--json'], { manager, resolveContext: () => { throw new Error('caller failed'); } });
  assert.equal(explicitRead.status, 0); assert.equal(parseCliEnvelope(explicitRead.text).resolution.project_id, pB);
  for (const args of [['create', 'builder', '--team', ta.team_id], ['stop', 'sid-cross'], ['attach', 'sid-cross'], ['role', 'clear', 'sid-cross']]) {
    const out = await invoke(runAgent, 'agent', [...args, '--dry-run', '--json'], { manager }); assert.equal(out.status, 0, out.text); assert.equal(parseCliEnvelope(out.text).dry_run, true);
  }
  check('actual agent dry-runs and explicit-target read survive failed caller discovery', () => { assert.equal(calls, 0); assert.deepEqual(bytes(), baseBytes); });
  const unknownDry = await invoke(runAgent, 'agent', ['stop', 'missing', '--dry-run', '--json'], { manager }); assert.equal(unknownDry.status, 2); assert.equal(parseCliEnvelope(unknownDry.text).dry_run, true);

  for (const [family, run, extra] of [['agent', runAgent, { manager }], ['team', runTeam, {}], ['session', runSession, { herdr: { sessionList: () => nativeSessions } }]]) {
    const result = await invoke(run, family, ['list', '--scope', 'all', '--json'], extra);
    assert.equal(result.status, 0, result.text); const receipt = parseCliEnvelope(result.text); parseManagementList(result.text); assert.equal(receipt.resolution.scope, 'global');
  }
  check('all three populated/global list receipts use one query-level schema-v2 shape', () => assert.deepEqual(bytes(), baseBytes));
  for (const args of [['context', '--json'], ['agent', 'list', '--scope', 'all', '--json'], ['team', 'list', '--scope', 'all', '--json'], ['session', 'list', '--json'],
    ['agent', 'create', 'builder', '--team', ta.team_id, '--dry-run', '--json'], ['team', 'create', 'New label', '--project', pNew, '--dry-run', '--json'],
    ['team', 'join', tb.team_id, '--agent', 'sid-a', '--dry-run', '--json'], ['team', 'close', ta.team_id, '--dry-run', '--json'], ['session', 'close', 'runtime-a', '--dry-run', '--json'], ['agent', 'read', 'sid-cross', '--json']]) {
    const result = cli(args); assert.equal(result.status, 0, result.stderr || result.stdout); const receipt = parseCliEnvelope(result.stdout);
    assert.ok(receipt.resolution); if (args[1] === 'list') parseManagementList(result.stdout);
  }
  check('absolute worktree CLI context/read/list/dry-run leaves all registry bytes and native mutation counters unchanged', () => { assert.deepEqual(bytes(), baseBytes); assert.equal(mutations(), 0); });
  const attached = cli(['agent', 'attach', 'sid-a', '--json']); assert.equal(attached.status, 0, attached.stderr); assert.equal(parseCliEnvelope(attached.stdout).attached, true); assert.match(attached.stderr, /native attach UI text/);
  const sessionAttached = cli(['session', 'attach', 'runtime-a', '--json']); assert.equal(sessionAttached.status, 0); assert.equal(parseCliEnvelope(sessionAttached.stdout).attached, true); assert.match(sessionAttached.stderr, /native attach UI text/);
  check('normal attach receipts have resolution and keep native UI off JSON stdout', () => assert.deepEqual(bytes(), baseBytes));
  seed({ empty: true }); const emptyBytes = bytes();
  for (const family of ['agent', 'team', 'session']) {
    const result = cli([family, 'list', '--scope', 'all', '--json'], { GOLEM_FIXTURE_EMPTY_NATIVE: '1' }); assert.equal(result.status, 0, result.stderr);
    const items = parseManagementList(result.stdout); assert.deepEqual(items, []);
    assert.equal(parseCliEnvelope(result.stdout).resolution.scope, 'global');
  }
  // Session inventory can be empty independently of metadata.
  const emptySession = await invoke(runSession, 'session', ['list', '--json'], { herdr: { sessionList: () => [] } }); assert.deepEqual(parseManagementList(emptySession.text), []);
  check('empty receipts retain query provenance and do not allocate metadata', () => assert.deepEqual(bytes(), emptyBytes));
  seed({ version: 1, conflict: true }); const oldBytes = bytes();
  const oldContext = cli(['context', '--project', pA, '--json']); assert.equal(oldContext.status, 0); assert.equal(parseCliEnvelope(oldContext.stdout).resolution.relations.association, 'conflicted');
  const oldDry = cli(['agent', 'create', 'builder', '--team', ta.team_id, '--dry-run', '--json']); assert.equal(oldDry.status, 2); assert.equal(parseCliEnvelope(oldDry.stdout).dry_run, true);
  check('v1 conflict plans/dry-runs preserve expired tombstones and byte identity without importing', () => assert.deepEqual(bytes(), oldBytes));

  seed();
  const projected = enrichDispatchableRows([{ session_id: 'sid-a', project_id: pA, delivery_ready: true }]); assert.ok(Array.isArray(projected));
  server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(projected)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); write('dashboard.json', { url: `http://127.0.0.1:${server.address().port}` });
  const client = await import('../mcp/channel/tracker-client.js'); const received = await client.listDispatchable(pA);
  check('actual roster projection and MCP HTTP reader keep REST arrays, not CLI envelopes', () => { assert.ok(Array.isArray(received)); assert.equal(received[0].session_id, 'sid-a'); assert.equal(received.schema_version, undefined); });
  server.close(); await once(server, 'close'); server = null;

  seed(); process.env.GOLEM_HERDR_BIN = fakeNative;
  const changedDuringRead = await invoke(runAgent, 'agent', ['read', 'sid-a', '--team', ta.team_id, '--json'], {
    manager: { peekWorker: async (name, options) => { joinTeam(tb.team_id, 'sid-a'); return peekWorker(name, options); } },
  });
  assert.equal(changedDuringRead.status, 2); assert.match(changedDuringRead.text, /explicit teamId.*conflicts with current agent/);
  const currentExact = await invoke(runAgent, 'agent', ['read', 'sid-a', '--json'], { manager: { peekWorker } });
  assert.equal(currentExact.status, 0); assert.equal(parseCliEnvelope(currentExact.text).resolution.team_id, tb.team_id);
  check('backend revalidates explicit constraints after transfer while an unconstrained exact ID remains usable', () => assert.ok(true));

  // Regression sensitivity uses a disposable source mirror, never checkout edits.
  const mirror = path.join(temp, 'mirror'); fs.cpSync(path.join(repo, 'lib'), path.join(mirror, 'lib'), { recursive: true });
  fs.cpSync(path.join(repo, 'cli'), path.join(mirror, 'cli'), { recursive: true }); fs.copyFileSync(path.join(repo, 'package.json'), path.join(mirror, 'package.json'));
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(mirror, 'node_modules'), 'dir');
  seed(); const mutationBytes = bytes();
  const probeArgs = [path.join(mirror, 'cli/golem.js'), 'agent', 'list', '--scope', 'all', '--json'];
  const good = spawnSync(process.execPath, probeArgs, { cwd: roots[0], env: childEnv, encoding: 'utf8', timeout: 10000 }); assert.equal(good.status, 0, good.stderr); assert.deepEqual(bytes(), mutationBytes);
  const file = path.join(mirror, 'lib/worker-registry.js'); const source = fs.readFileSync(file, 'utf8');
  const old = 'export function readWorkers(args = {}) { return readWorkersSnapshot(args).workers.map(copy); }'; assert.ok(source.includes(old));
  fs.writeFileSync(file, source.replace(old, 'export function readWorkers(args = {}) { pruneWorkerTombstones(args); return readWorkersSnapshot(args).workers.map(copy); }'));
  const bad = spawnSync(process.execPath, probeArgs, { cwd: roots[0], env: childEnv, encoding: 'utf8', timeout: 10000 });
  assert.equal(bad.status, 0, bad.stderr || bad.stdout); assert.notDeepEqual(bytes(), mutationBytes, 'byte-identity regression detects mutating old reads');
  check('disposable source mutation reintroducing read-time pruning breaks zero-write invariant', () => assert.ok(true));
  console.log(`management resolver passed: ${checks} checks (pure matrix, actual CLI, zero-write/native counters, D8 envelopes, unchanged REST/MCP, mutation sensitivity)`);
} finally { if (server) { server.closeAllConnections(); server.close(); } fs.rmSync(temp, { recursive: true, force: true }); }
