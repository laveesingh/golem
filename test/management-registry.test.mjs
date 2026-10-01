#!/usr/bin/env node
// GOL-408: temp files and native seams only; no live resources/dashboard.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-management-'));
delete process.env.GOLEM_HERDR_SESSION;
delete process.env.HERDR_ENV;
process.env.GOLEM_HOME = path.join(temp, 'state');
const service = await import('../lib/management-registry.js');
const teams = await import('../lib/team-registry.js');
const workers = await import('../lib/worker-registry.js');
const locks = await import('../lib/management-lock.js');
const { spawnWorker, enrichDispatchableRows } = await import('../lib/worker-manager.js');
let count = 0;
const check = (label, fn) => { fn(); console.log(`ok ${++count} - ${label}`); };
const fixture = name => { process.env.GOLEM_HOME = path.join(temp, name); fs.mkdirSync(process.env.GOLEM_HOME, { recursive: true }); };
const raw = (name, data) => fs.writeFileSync(path.join(process.env.GOLEM_HOME, name), JSON.stringify(data));
const bytes = () => Object.fromEntries(['teams.json', 'workers.json', 'herdr-mappings.json'].map(name => [name, fs.existsSync(path.join(process.env.GOLEM_HOME, name)) ? fs.readFileSync(path.join(process.env.GOLEM_HOME, name), 'utf8') : null]));
const teamRow = (id, project, session, owner = null) => ({ team_id: id, project_id: project, label: id, slug: id, herdr_session: session,
  herdr_workspace_id: `${id}:workspace`, owner_session_id: owner, member_session_ids: [], closed_at: null });
const workerRow = (id, project, session, team, sid) => ({ worker_id: id, project_id: project, herdr_session: session, herdr_agent_name: `legacy-${id}`,
  name: id, role: 'builder', team_id: team, session_id: sid, state: 'live', herdr_pane_id: `${id}:pane` });
const create = (label, project = 'p', session = 'exact-p') => teams.createTeam({ label, projectId: project, herdrSession: session });
const claim = team => workers.claimWorker({ role: 'builder', projectId: team.project_id, teamId: team.team_id, preset: { harness: 'pi' } });
try {
  fixture('migration');
  raw('teams.json', { version: 1, teams: [teamRow('a', 'p', 'legacy-exact', 'external-owner'), teamRow('b', 'q', 'legacy-shared'), teamRow('c', 'r', 'legacy-shared'), teamRow('d', 'u', 'native-u')] });
  raw('workers.json', { version: 1, workers: [workerRow('w', 'p', 'legacy-exact', 'a', 'managed'), workerRow('z', 'u', 'contradictory-u', 'd', 'managed-u'),
    { worker_id: 'expired', project_id: 'p', state: 'dead', ended_at: '2000-01-01' }] });
  const before = bytes();
  const snapshot = service.readManagementSnapshot();
  const plan = service.planManagementImport(snapshot);
  check('exact-handle plan scopes conflicts and preserves contradictory placement', () => {
    assert.equal(plan.projects.p.session, 'legacy-exact');
    assert.equal(plan.projects.q.association, 'conflicted');
    assert.equal(plan.projects.r.association, 'conflicted');
    assert.deepEqual(plan.projects.u.conflicts[0].facts.handles, ['native-u', 'contradictory-u']);
    assert.match(plan.projects.u.conflicts[0].corrective_command, /golem session adopt/);
  });
  const projected = teams.listTeams();
  assert.ok(projected.find(t => t.team_id === 'a').member_session_ids.includes('managed'));
  workers.readWorkers(); teams.findTeam('a'); service.mappedSessionForProject('p');
  enrichDispatchableRows([{ session_id: 'external-owner', project_id: 'p' }]);
  check('evidence/list reads are byte-identical and do not prune expired workers', () => {
    assert.deepEqual(bytes(), before); assert.equal(workers.readWorkers().length, 3);
    assert.equal(fs.existsSync(path.join(process.env.GOLEM_HOME, 'management-backup-v2')), false);
  });
  teams.joinTeam('a', 'new-external');
  const imported = service.readManagementSnapshot();
  check('consistent projects import independently; exact legacy handles/names survive', () => {
    assert.equal(imported.teams.version, 2);
    assert.equal(imported.teams.imports.p.membership, 'complete');
    assert.equal(imported.teams.imports.q.association, 'conflicted');
    assert.equal(imported.mappings.projects.p.session, 'legacy-exact');
    assert.equal(imported.workers.workers.find(w => w.worker_id === 'w').herdr_agent_name, 'legacy-w');
    assert.equal(imported.workers.workers.find(w => w.worker_id === 'z').herdr_session, 'contradictory-u');
  });
  const backupDir = path.join(process.env.GOLEM_HOME, 'management-backup-v2');
  const manifestBytes = fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestBytes);
  check('private immutable backup contains original checksums and schema versions', () => {
    assert.equal(fs.statSync(path.join(backupDir, 'manifest.json')).mode & 0o777, 0o600);
    for (const kind of ['teams', 'workers']) {
      const source = JSON.parse(fs.readFileSync(path.join(backupDir, manifest.files[kind].snapshot), 'utf8')).bytes;
      assert.equal(source, before[`${kind}.json`]);
      assert.equal(manifest.files[kind].sha256, crypto.createHash('sha256').update(source).digest('hex'));
      assert.equal(manifest.files[kind].schema_version, 1);
      assert.equal(fs.statSync(path.join(backupDir, manifest.files[kind].snapshot)).mode & 0o777, 0o600);
    }
  });
  teams.joinTeam('a', 'new-external');
  assert.equal(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'), manifestBytes);
  check('import/backup retry is idempotent without native work', () => assert.equal(teams.findTeam('a').member_session_ids.filter(id => id === 'managed').length, 1));
  service.adoptProjectAssociation('u', 'native-u');
  check('exact adoption repairs only the selected association, preserving contradictory placement', () => {
    assert.equal(service.mappedSessionForProject('u'), 'native-u');
    assert.equal(workers.readWorkers().find(w => w.worker_id === 'z').herdr_session, 'contradictory-u');
    assert.throws(() => service.adoptProjectAssociation('q', 'legacy-exact'), /owned by project p/);
  });

  fixture('interrupted-import');
  raw('teams.json', { version: 1, teams: [teamRow('a', 'p', 'exact')] });
  raw('workers.json', { version: 1, workers: [workerRow('w', 'p', 'exact', 'a', 'sid')] });
  const original = bytes();
  assert.throws(() => service.withManagementTransaction(() => null, { afterCanonicalCommit: () => { throw new Error('import interruption'); } }), /import interruption/);
  assert.equal(service.readManagementSnapshot().teams.version, 2);
  const interruptedManifest = fs.readFileSync(path.join(process.env.GOLEM_HOME, 'management-backup-v2', 'manifest.json'), 'utf8');
  service.withManagementTransaction(() => null);
  assert.equal(fs.readFileSync(path.join(process.env.GOLEM_HOME, 'management-backup-v2', 'manifest.json'), 'utf8'), interruptedManifest);
  check('interrupted schema import resumes durable metadata without reimport/backup replacement', () => {
    assert.deepEqual(teams.findTeam('a').member_session_ids, ['sid']);
    const blob = JSON.parse(fs.readFileSync(path.join(process.env.GOLEM_HOME, 'management-backup-v2', 'teams.snapshot'), 'utf8')).bytes;
    assert.equal(blob, original['teams.json']);
  });

  fixture('authority');
  const a = create('a'), b = create('b');
  const w = claim(a);
  workers.updateWorker(w.worker_id, { session_id: 'conversation', state: 'live', herdr_pane_id: 'physical-a', pid: 123 });
  const placement = workers.findWorker('builder1');
  teams.joinTeam(b.team_id, 'conversation', { owner: true });
  check('transfer changes canonical membership, not role/native placement/handle', () => {
    const view = workers.findWorker('builder1');
    assert.equal(view.team_id, b.team_id);
    for (const key of ['role', 'herdr_pane_id', 'herdr_session', 'herdr_agent_name', 'pid']) assert.equal(view[key], placement[key]);
    assert.deepEqual(teams.findTeam(b.team_id).member_session_ids, []);
  });
  teams.joinTeam(b.team_id, 'next-owner', { owner: true });
  assert.deepEqual(teams.findTeam(b.team_id).member_session_ids, ['conversation']);
  teams.leaveTeam('conversation');
  const cache = JSON.parse(fs.readFileSync(path.join(process.env.GOLEM_HOME, 'workers.json')));
  cache.workers[0].team_id = a.team_id; raw('workers.json', cache);
  check('v2 leave cannot resurrect from stale worker cache; external owner projects canonically', () => {
    assert.equal(workers.findWorker('builder1').team_id, null);
    assert.equal(service.effectiveTeamForSession('conversation'), null);
    assert.equal(enrichDispatchableRows([{ session_id: 'next-owner', project_id: 'p' }])[0].team_id, b.team_id);
  });
  assert.throws(() => workers.updateWorker(w.worker_id, { team_id: a.team_id }), /canonical team service/);
  assert.throws(() => service.mutateTeams(registry => {
    registry.teams.find(t => t.team_id === a.team_id).member_session_ids.push('next-owner');
  }), /canonical membership conflict/);
  assert.throws(() => service.withManagementTransaction(state => {
    service.transferMembershipIn(state, b.team_id, 'conversation');
  }, { afterCanonicalCommit: () => { throw new Error('injected cache crash'); } }), /injected cache crash/);
  check('interrupted derived-cache refresh still exposes canonical membership', () => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.GOLEM_HOME, 'workers.json'))).workers[0].team_id, a.team_id);
    assert.equal(workers.findWorker('builder1').team_id, b.team_id);
  });
  service.withManagementTransaction(() => null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.GOLEM_HOME, 'workers.json'))).workers[0].team_id, b.team_id);

  fixture('membership-conflict');
  raw('teams.json', { version: 1, teams: [teamRow('a', 'p', 's', 'sid'), teamRow('b', 'p', 's')] });
  raw('workers.json', { version: 1, workers: [workerRow('old-cache', 'p', 's', 'b', 'sid')] });
  assert.equal(service.planManagementImport().projects.p.membership, 'conflicted');
  teams.joinTeam('b', 'sid');
  teams.leaveTeam('sid'); service.withManagementTransaction(() => null);
  check('explicit targeted choice repairs only its membership conflict and leave stays left', () => {
    assert.equal(service.effectiveTeamForSession('sid'), null);
    assert.equal(service.readManagementSnapshot().teams.imports.p.membership, 'complete');
  });

  fixture('names');
  const longA = create('a'.repeat(50)), longB = create(`${'a'.repeat(49)}b`);
  const first = claim(longA), second = claim(longB);
  check('long-prefix teams allocate distinct opaque native handles', () => {
    assert.notEqual(first.herdr_agent_name, second.herdr_agent_name);
    assert.match(first.herdr_agent_name, /^g-[0-9a-f]{28}$/);
    assert.equal(first.name, second.name);
  });
  service.mutateTeams(registry => { const row = registry.teams.find(t => t.team_id === longA.team_id); row.label = 'renamed'; row.slug = 'renamed'; });
  const reused = create('a'.repeat(50));
  assert.notEqual(claim(reused).herdr_agent_name, first.herdr_agent_name);
  const colliding = 'candidate-1', next = 'candidate-2'; let allocation = 0;
  const collision = workers.claimWorker({ role: 'explorer', projectId: 'p', preset: {}, teamId: longB.team_id,
    nativeNames: [service.allocateNativeHandle(colliding)], runtimeId: () => [colliding, next][allocation++] });
  check('genuine native collision reallocates stable runtime identity', () => {
    assert.equal(collision.worker_id, next); assert.equal(allocation, 2);
  });
  fixture('uncertainty');
  const uncertainTeam = create('uncertain'); const doomed = claim(uncertainTeam);
  service.beforeNativeCall(doomed.operation_id);
  const state = service.readManagementSnapshot();
  state.mappings.intents[0].owner = { pid: 999999999, birth: 'dead', token: 'dead' };
  raw('herdr-mappings.json', state.mappings);
  service.recoverManagementIntents({ probe: () => null });
  check('dead creator before ID capture remains unresolved, never relaunches or guesses', () => {
    assert.equal(service.pendingManagementLaunches({ teamId: uncertainTeam.team_id })[0].phase, 'unresolved');
    assert.throws(() => service.beforeNativeCall(doomed.operation_id), /fenced/);
    assert.throws(() => teams.closeTeam(uncertainTeam.team_id), /partial.*operation IDs/);
  });
  const recovery = service.readManagementSnapshot().mappings.intents.find(i => i.operation_id === doomed.operation_id);
  assert.deepEqual(recovery.resources, []);

  fixture('creator-token');
  const tokenTeam = create('token-team'); const tokenWorker = claim(tokenTeam);
  const tokenState = service.readManagementSnapshot();
  tokenState.mappings.intents[0].owner.incarnation = 'previous-process-token';
  raw('herdr-mappings.json', tokenState.mappings);
  check('same PID/birth cannot reuse an ended creator incarnation token', () => {
    assert.throws(() => service.beforeNativeCall(tokenWorker.operation_id), /fenced/);
    service.recoverManagementIntents();
    assert.equal(service.readManagementSnapshot().mappings.intents[0].phase, 'cancelled');
  });

  fixture('legacy-provisioning');
  raw('teams.json', { version: 1, teams: [teamRow('a', 'p', 'exact')] });
  raw('workers.json', { version: 1, workers: [{ ...workerRow('legacy-launch', 'p', 'exact', 'a', null), state: 'spawning', herdr_pane_id: null }] });
  assert.equal(service.planManagementImport().projects.p.provisioning[0].phase, 'unresolved');
  service.withManagementTransaction(() => null);
  const legacyIntent = service.readManagementSnapshot().mappings.intents[0];
  service.withManagementTransaction(() => null);
  check('legacy pending creators import as stable unresolved operations, never new launches', () => {
    assert.equal(service.readManagementSnapshot().mappings.intents.length, 1);
    assert.equal(service.readManagementSnapshot().mappings.intents[0].operation_id, legacyIntent.operation_id);
    assert.throws(() => teams.closeTeam('a'), /partial/);
  });

  fixture('missing-result');
  const { runTeam } = await import('../cli/team.js');
  const output = [];
  const status = await runTeam('team', ['create', 'Example', '--project', 'cli-fixture-111111', '--json'], {
    stdout: text => output.push(text), resolveContext: () => null,
    herdr: { projectHerdrSession: () => 'exact-cli', ensureProjectSession: async () => ({ started: false }),
      createTeamWorkspace: () => null, closeTeamWorkspace: () => false },
  });
  check('missing native IDs remain unresolved through the shipped team-create failure seam', () => {
    assert.equal(status, 1, output.join(''));
    assert.equal(service.readManagementSnapshot().mappings.intents[0].phase, 'unresolved');
    assert.equal(teams.listTeams()[0].lifecycle, 'closing');
    assert.equal(teams.listTeams()[0].closed_at, null);
  });

  fixture('locks');
  const lockFile = path.join(process.env.GOLEM_HOME, 'management.lock');
  assert.throws(() => locks.withManagementLock(async () => null), /async\/thenable/);
  assert.throws(() => locks.withManagementLock(() => Promise.resolve()), /async\/thenable/);
  assert.equal(fs.existsSync(lockFile), false);
  const alive = locks.ownerIncarnation(); fs.writeFileSync(lockFile, JSON.stringify(alive));
  fs.utimesSync(lockFile, new Date(0), new Date(0));
  check('old live lock is never stolen by age; callbacks reject thenables', () => {
    assert.throws(() => locks.withManagementLock(() => assert.fail('stolen')), /lock busy/);
    assert.equal(JSON.parse(fs.readFileSync(lockFile)).token, alive.token);
  });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, birth: 'previous-incarnation', token: 'old' }));
  assert.equal(locks.withManagementLock(() => 42), 42);
  const ready = path.join(temp, 'child-lock-ready');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { withManagementLock } from ${JSON.stringify(path.join(repo, 'lib/management-lock.js'))};
    withManagementLock(() => { fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000); });
  `], { env: { ...process.env }, stdio: 'ignore' });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(ready), 'child entered real lock');
    fs.utimesSync(lockFile, new Date(0), new Date(0));
    assert.throws(() => locks.withManagementLock(() => null), /busy/);
    const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
    assert.equal(locks.withManagementLock(() => 'reclaimed'), 'reclaimed');
    check('real live owner not evicted; ended PID incarnation is reclaimed', () => assert.ok(true));
  } finally { if (child.exitCode == null && child.signalCode == null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; } }

  // Each barrier exercises the shipped spawn service; callback seams change
  // native timing, not admission/commit/membership code.
  for (const stage of ['before-native', 'after-pane', 'before-commit', 'delayed-pane']) {
    fixture(`race-${stage}`);
    const target = create('target'), unrelated = create('other');
    let arrived, release;
    const reached = new Promise(resolve => { arrived = resolve; });
    const paused = new Promise(resolve => { release = resolve; });
    let paneCalls = 0, runCalls = 0, activePanes = [];
    const native = {
      agentList: () => [], ensureSession: async () => ({ started: false }), workspaceList: () => [{ workspace_id: 'existing' }],
      workspaceCreate: () => ({ workspace_id: 'new-workspace' }), workspaceClose: () => true,
      tabCreate: async ({ workspaceId }) => {
        assert.equal(locks.managementLockHeld(), false); paneCalls++;
        if (stage === 'delayed-pane') { arrived(); await paused; }
        const pane = { pane_id: 'owned-pane', tab_id: 'owned-tab', workspace_id: workspaceId };
        activePanes.push(pane); return { tab: { tab_id: pane.tab_id }, pane };
      },
      tabClose: ({ tabId }) => { assert.equal(tabId, 'owned-tab'); activePanes = []; return true; },
      paneList: () => activePanes,
      paneRun: () => { runCalls++; return true; }, paneProcessInfo: () => null,
      agentRename: () => ({}), agentGet: () => ({}),
    };
    teams.setTeamWorkspace(target.team_id, 'existing');
    const running = spawnWorker({ role: 'builder', project: 'p', teamId: target.team_id }, {
      native, resolveProject: async () => ({ projectId: 'p', projectRoot: temp }), resolveExecution: () => ({ harness: 'pi' }),
      registration: async () => ({ session_id: `registered-${stage}` }), detected: async () => null, assign: async () => null,
      barrier: async (at, worker) => {
        if (at === 'after-pane') {
          const captured = service.readManagementSnapshot().mappings.intents.find(i => i.operation_id === worker.operation_id);
          assert.equal(captured.resources.at(-1).pane_id, 'owned-pane', 'exact native ID durable before next await');
        }
        if (at === 'before-commit') assert.equal(service.effectiveTeamForSession(`registered-${stage}`), null, 'registration is not yet a canonical member');
        if (at === stage) { arrived(); await paused; }
      },
    });
    const rejected = assert.rejects(running, /fenced|not open/);
    await reached;
    assert.equal(locks.managementLockHeld(), false, 'no lock retained while native/barrier awaits');
    const closing = service.beginManagementClose({ teamId: target.team_id });
    assert.equal(closing.lifecycle, 'closing');
    assert.throws(() => claim(target), /closing.*operation/);
    assert.equal(claim(unrelated).state, 'spawning', 'unrelated target remains usable');
    if (stage === 'delayed-pane') {
      const timeout = await service.waitForManagementLaunches({ teamId: target.team_id }, { timeoutMs: 5, pollMs: 1 });
      assert.equal(timeout.completed, false); assert.equal(timeout.pending[0].phase, 'native_call');
      assert.throws(() => service.finishManagementClose({ teamId: target.team_id }), /partial/);
    }
    release(); await rejected;
    const settled = await service.waitForManagementLaunches({ teamId: target.team_id }, { timeoutMs: 10 });
    assert.equal(settled.completed, true);
    assert.equal(service.finishManagementClose({ teamId: target.team_id }).lifecycle, 'closed');
    assert.equal(service.effectiveTeamForSession(`registered-${stage}`), null);
    assert.deepEqual(activePanes, []);
    if (stage === 'before-native') assert.equal(paneCalls, 0);
    if (stage === 'after-pane') assert.equal(runCalls, 0);
    check(`create/close barrier ${stage}: late result cleanup, fenced publication, bounded retry`, () => assert.ok(true));
  }

  fixture('spawn-success');
  const successTeam = create('team-label');
  let workspaceCreates = 0, inventories = 0, renamedHandle;
  const success = await spawnWorker({ role: 'builder', project: 'p', teamId: successTeam.team_id }, {
    native: {
      ensureSession: async () => { assert.equal(locks.managementLockHeld(), false); return { started: false }; },
      workspaceList: () => [{ workspace_id: 'unowned-same-label', label: 'team-label' }],
      workspaceCreate: ({ label }) => { assert.equal(label, 'team-label', 'no extra agents workspace'); workspaceCreates++; return { workspace_id: 'new-owned' }; },
      agentList: () => { inventories++; return inventories === 1 ? [] : [{ name: workers.readWorkers()[0].herdr_agent_name }]; },
      tabCreate: ({ workspaceId }) => { assert.equal(workspaceId, 'new-owned'); return { tab: { tab_id: 'new-tab' }, pane: { pane_id: 'new-pane', tab_id: 'new-tab' } }; },
      paneRun: () => true, paneProcessInfo: () => null, agentRename: ({ name }) => { renamedHandle = name; }, agentGet: () => ({}),
    }, resolveProject: async () => ({ projectId: 'p', projectRoot: temp }), resolveExecution: () => ({ harness: 'pi' }),
    detected: async () => null, registration: async () => ({ session_id: 'new-conversation' }), assign: async () => null,
  });
  check('successful spawn skips label reuse/extra workspace and reallocates a late collision before launch', () => {
    assert.equal(workspaceCreates, 1); assert.equal(success.state, 'live');
    assert.equal(success.herdr_agent_name, renamedHandle); assert.equal(success.herdr_workspace_id, 'new-owned');
    assert.equal(service.effectiveTeamForSession(success.session_id).team_id, successTeam.team_id);
    assert.equal(service.readManagementSnapshot().mappings.intents.find(i => i.operation_id === success.operation_id).phase, 'ready');
  });

  // Mutation check in a disposable source mirror: prove the commit fence
  // assertion fails when revalidation is removed, without editing checkout.
  if (!process.argv.includes('--mutation-child')) {
    const mirror = path.join(temp, 'mutation'); fs.mkdirSync(path.join(mirror, 'test'), { recursive: true });
    fs.cpSync(path.join(repo, 'lib'), path.join(mirror, 'lib'), { recursive: true });
    const probe = `import assert from 'node:assert/strict';
import * as s from '../lib/management-registry.js';
import * as t from '../lib/team-registry.js';
import * as w from '../lib/worker-registry.js';
const a=t.createTeam({label:'a',projectId:'p',herdrSession:'s'});
const x=w.claimWorker({role:'builder',projectId:'p',preset:{}});
s.beforeNativeCall(x.operation_id); s.recordNativeResult(x.operation_id,{type:'tab',tab_id:'t',pane_id:'p',created:true});
s.beginManagementClose({session:'s'});
assert.throws(()=>s.commitAdmission(x.operation_id,{sessionId:'late'}),/fenced/);
`;
    fs.writeFileSync(path.join(mirror, 'test', 'probe.mjs'), probe);
    const file = path.join(mirror, 'lib', 'management-registry.js');
    const source = fs.readFileSync(file, 'utf8');
    const fence = "if (!validAdmission(state, intent) || terminal.has(intent.phase) || intent.phase === 'unresolved') throw";
    assert.ok(source.includes(fence));
    const env = { ...process.env, GOLEM_HOME: path.join(temp, 'mutation-good') };
    const good = spawnSync(process.execPath, [path.join(mirror, 'test', 'probe.mjs')], { env, encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr);
    fs.writeFileSync(file, source.replace(fence, 'if (false) throw'));
    const bad = spawnSync(process.execPath, [path.join(mirror, 'test', 'probe.mjs')], { env: { ...env, GOLEM_HOME: path.join(temp, 'mutation-bad') }, encoding: 'utf8' });
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /Missing expected exception/);
    check('mutation sensitivity: removing commit revalidation makes the regression fail', () => assert.ok(true));
    const beforeFence = "if (terminal.has(intent.phase) || intent.phase === 'unresolved' || !validAdmission(state, intent)) {";
    const beforeProbe = probe.replace("s.beforeNativeCall(x.operation_id); s.recordNativeResult(x.operation_id,{type:'tab',tab_id:'t',pane_id:'p',created:true});", '')
      .replace("s.commitAdmission(x.operation_id,{sessionId:'late'})", 's.beforeNativeCall(x.operation_id)');
    fs.writeFileSync(path.join(mirror, 'test', 'probe.mjs'), beforeProbe);
    fs.writeFileSync(file, source);
    const beforeGood = spawnSync(process.execPath, [path.join(mirror, 'test', 'probe.mjs')], { env: { ...env, GOLEM_HOME: path.join(temp, 'before-good') }, encoding: 'utf8' });
    assert.equal(beforeGood.status, 0, beforeGood.stderr);
    assert.ok(source.includes(beforeFence)); fs.writeFileSync(file, source.replace(beforeFence, 'if (false) {'));
    const beforeBad = spawnSync(process.execPath, [path.join(mirror, 'test', 'probe.mjs')], { env: { ...env, GOLEM_HOME: path.join(temp, 'before-bad') }, encoding: 'utf8' });
    assert.notEqual(beforeBad.status, 0); assert.match(beforeBad.stderr, /Missing expected exception/);
    check('mutation sensitivity: removing pre-native fence makes the regression fail', () => assert.ok(true));
    const resultProbe = probe.replace("s.beforeNativeCall(x.operation_id); s.recordNativeResult(x.operation_id,{type:'tab',tab_id:'t',pane_id:'p',created:true});", 's.beforeNativeCall(x.operation_id);')
      .replace("assert.throws(()=>s.commitAdmission(x.operation_id,{sessionId:'late'}),/fenced/);", "assert.equal(s.recordNativeResult(x.operation_id,{type:'tab',tab_id:'t',pane_id:'p',created:true}).valid,false);");
    fs.writeFileSync(path.join(mirror, 'test', 'probe.mjs'), resultProbe); fs.writeFileSync(file, source);
    const resultGood = spawnSync(process.execPath, [path.join(mirror, 'test', 'probe.mjs')], { env: { ...env, GOLEM_HOME: path.join(temp, 'result-good') }, encoding: 'utf8' });
    assert.equal(resultGood.status, 0, resultGood.stderr);
    assert.ok(source.includes('const valid = validAdmission(state, intent);'));
    fs.writeFileSync(file, source.replace('const valid = validAdmission(state, intent);', 'const valid = true;'));
    const resultBad = spawnSync(process.execPath, [path.join(mirror, 'test', 'probe.mjs')], { env: { ...env, GOLEM_HOME: path.join(temp, 'result-bad') }, encoding: 'utf8' });
    assert.notEqual(resultBad.status, 0); assert.match(resultBad.stderr, /true !== false/);
    check('mutation sensitivity: removing native-result revalidation makes the regression fail', () => assert.ok(true));
  }
  console.log(`management registry passed: ${count} checks (migration, authority, names, locks, native races, mutation sensitivity)`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
