#!/usr/bin/env node
// golem session list|attach: the herdr session table, project mapping,
// open-team counts, and the attach target rules. Temp GOLEM_HOME and a fake
// herdr seam; no herdr server.

import { parseCliEnvelope } from './_cli-envelope.mjs';
import assert from 'node:assert/strict';
import { parseManagementList } from './_management-list.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-session-cli-'));
process.env.GOLEM_HOME = path.join(temp, 'state');
delete process.env.XDG_CONFIG_HOME;
delete process.env.GOLEM_HERDR_SESSION;
delete process.env.HERDR_ENV;
fs.mkdirSync(process.env.GOLEM_HOME, { recursive: true });

const projectId = 'demo-proj-abcdef';
fs.writeFileSync(path.join(process.env.GOLEM_HOME, 'projects.json'), JSON.stringify({ projects: [{ project_id: projectId, name: 'Demo Proj' }] }));

const { createTeam, closeTeam, listTeams } = await import('../lib/team-registry.js');
const { runSession } = await import('../cli/session.js');

createTeam({ projectId, label: 'Open one', herdrSession: 'demo-proj' });
closeTeam(createTeam({ projectId, label: 'Shut one', herdrSession: 'demo-proj' }).team_id);

const attached = [];
const nativeRows = [
  { name: 'default', running: true }, { name: 'demo-proj', running: true }, { name: 'idle', running: false },
];
const herdr = {
  sessionList: () => nativeRows.map(row => ({ ...row })),
  sessionAttach: (name) => { attached.push(name); return 0; },
};

async function run(args, extra = {}) {
  const out = [];
  const err = [];
  const exit = await runSession('session', args, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), cwd: temp, herdr, env: {}, ...extra });
  return { exit, text: out.join('\n'), err: err.join('\n') };
}

// list: JSON rows carry status, the mapped project, and open teams only.
{
  const listed = await run(['list', '--json']);
  assert.equal(listed.exit, 0, listed.err);
  assert.deepEqual(parseManagementList(listed.text), [
    { name: 'default', status: 'running', project: null, open_teams: 0 },
    { name: 'demo-proj', status: 'running', project: 'Demo Proj', open_teams: 1 },
    { name: 'idle', status: 'stopped', project: null, open_teams: 0 },
  ]);
  const table = await run(['list']);
  assert.equal(table.exit, 0);
  const lines = table.text.split('\n');
  assert.match(lines[0], /^SESSION\s+STATUS\s+PROJECT\s+OPEN TEAMS$/);
  assert.match(lines[1], /^-+( +-+){3}$/);
  assert.match(lines[3], /^demo-proj\s+running\s+Demo Proj\s+1$/);
}

// attach: a named known session, the --project default, and unknown refusal.
{
  assert.equal((await run(['attach', 'idle'])).exit, 0);
  assert.equal((await run(['attach', '--project', projectId])).exit, 0);
  assert.deepEqual(attached, ['idle', 'demo-proj']);
  const unknown = await run(['attach', 'nope']);
  assert.equal(unknown.exit, 2);
  assert.match(unknown.err, /session not found: nope.*candidates: default.*demo-proj.*idle.*try:/);
  assert.equal(attached.length, 2, 'unknown session never reaches herdr');
  assert.equal((await run(['attach', 'a', 'b'])).exit, 2);
  assert.equal((await run(['bogus'])).exit, 2);
}

// close: stops live agents in the session, closes its open teams, then
// stops and deletes the herdr session. Other sessions are untouched.
{
  const calls = [];
  const workerRows = [
    { name: 'builder1', project_id: projectId, team_id: 't1', herdr_session: 'demo-proj', state: 'live' },
    { name: 'old', project_id: projectId, team_id: 't1', herdr_session: 'demo-proj', state: 'dead' },
    { name: 'other', project_id: projectId, team_id: 't2', herdr_session: 'idle', state: 'live' },
  ];
  let deleteTries = 0;
  const closeHerdr = {
    ...herdr,
    sessionStop: (name) => { calls.push(`stop ${name}`); nativeRows.find(row => row.name === name).running = false; return true; },
    sessionDelete: (name) => { deleteTries += 1; if (deleteTries < 2) return false; calls.push(`delete ${name}`); nativeRows.splice(nativeRows.findIndex(row => row.name === name), 1); return true; },
  };
  const workers = {
    listWorkers: () => workerRows,
    killWorker: async (name, scope) => { calls.push(`kill ${name} ${scope.projectId} ${scope.teamId}`); },
  };
  const extra = { herdr: closeHerdr, workers, sleep: async () => {} };

  const self = await run(['close', 'demo-proj'], { ...extra, env: { HERDR_SESSION: 'demo-proj' } });
  assert.equal(self.exit, 2);
  assert.match(self.err, /refusing to close demo-proj: this terminal runs inside it/);
  assert.deepEqual(calls, [], 'self-close refusal touches nothing');

  const failing = await run(['close', 'demo-proj'], { ...extra, workers: { ...workers, killWorker: async () => { throw new Error('identity mismatch'); } } });
  assert.equal(failing.exit, 1);
  assert.match(failing.text + failing.err, /session demo-proj left open; agents failed to stop: builder1: identity mismatch/);
  assert.deepEqual(calls, [], 'a failed agent stop leaves the session and teams alone');
  assert.equal(listTeams({ includeClosed: false }).filter((t) => t.herdr_session === 'demo-proj').length, 1);

  const closed = await run(['close', 'demo-proj', '--json'], extra);
  assert.equal(closed.exit, 0, closed.err);
  const { resolution, schema_version, ...receipt } = parseCliEnvelope(closed.text);
  assert.equal(resolution.provenance.session, 'exact-target');
  assert.equal(receipt.ok, true); assert.equal(receipt.lifecycle, 'closed');
  assert.equal(receipt.session, 'demo-proj'); assert.deepEqual(receipt.stopped, ['builder1']); assert.deepEqual(receipt.teams_closed, ['open-one']);
  assert.equal(receipt.native_deleted, true); assert.ok(receipt.operation_id);
  assert.deepEqual(calls, [`kill builder1 ${projectId} t1`, 'stop demo-proj', 'delete demo-proj']);
  assert.equal(listTeams({ includeClosed: false }).filter((t) => t.herdr_session === 'demo-proj').length, 0);

  const forced = await run(['close', 'idle', '--force'], { ...extra, env: { HERDR_SESSION: 'idle' } });
  assert.equal(forced.exit, 0, forced.err);
  assert.match(forced.text, /^session idle closed \(1 agents stopped, 0 teams closed\)$/);

  assert.equal((await run(['close', 'nope'], extra)).exit, 2);
  assert.equal((await run(['close'], extra)).exit, 2);
}

// New session controls: exact adoption, opaque start, retained definitions,
// partial/retry outcomes and zero-write diagnostics.
{
  const freshProject = 'fresh-proj-111111';
  const mutable = [{ name: 'unowned-native', running: false }];
  let ensures = 0, stops = 0, failStop = false;
  const native = {
    sessionList: () => mutable.map(r => ({ ...r })), paneList: () => [],
    ensureSession: async name => { ensures++; const existing = mutable.find(r => r.name === name); const started = !existing?.running;
      if (existing) existing.running = true; else mutable.push({ name, running: true }); return { session: name, started }; },
    sessionStop: name => { stops++; if (failStop) return false; mutable.find(r => r.name === name).running = false; return true; },
    sessionDelete: name => { mutable.splice(mutable.findIndex(r => r.name === name), 1); return true; },
  };
  const emptyWorkers = { listWorkers: () => [], killWorker: async () => assert.fail('no managed target') };
  const extra = { herdr: native, workers: emptyWorkers, sleep: async () => {}, timeoutMs: 0 };
  const before = fs.readdirSync(process.env.GOLEM_HOME).sort().map(n => [n, fs.statSync(path.join(process.env.GOLEM_HOME, n)).isFile() ? fs.readFileSync(path.join(process.env.GOLEM_HOME, n), 'utf8') : '<directory>']);
  const planned = await run(['start', '--project', freshProject, '--dry-run', '--json'], extra);
  assert.equal(planned.exit, 0); assert.equal(parseCliEnvelope(planned.text).plan.association, 'allocation-required-on-real-mutation'); assert.equal(ensures, 0);
  const after = fs.readdirSync(process.env.GOLEM_HOME).sort().map(n => [n, fs.statSync(path.join(process.env.GOLEM_HOME, n)).isFile() ? fs.readFileSync(path.join(process.env.GOLEM_HOME, n), 'utf8') : '<directory>']);
  assert.deepEqual(after, before);
  const unowned = await run(['start', 'unowned-native', '--project', freshProject, '--json'], extra);
  assert.equal(unowned.exit, 2); assert.match(unowned.text, /unowned.*adopt/); assert.equal(ensures, 0);
  const adopted = await run(['adopt', 'unowned-native', '--project', freshProject, '--json'], extra);
  assert.equal(adopted.exit, 0, adopted.text); assert.equal(parseCliEnvelope(adopted.text).adopted, true);
  const repeatedAdopt = await run(['adopt', 'unowned-native', '--project', freshProject, '--json'], extra);
  assert.equal(parseCliEnvelope(repeatedAdopt.text).noop, true);
  const stolen = await run(['adopt', 'unowned-native', '--project', 'foreign-proj-222222', '--json'], extra);
  assert.equal(stolen.exit, 2); assert.match(stolen.text, /conflicts/);
  const started = await run(['start', '--project', freshProject, '--json'], extra);
  assert.equal(started.exit, 0, started.text); assert.equal(parseCliEnvelope(started.text).session, 'unowned-native'); assert.equal(parseCliEnvelope(started.text).started, true);
  const running = await run(['start', '--project', freshProject, '--json'], extra);
  assert.equal(running.exit, 0); assert.equal(parseCliEnvelope(running.text).noop, true);
  const kept = createTeam({ label: 'Kept definitions', projectId: freshProject, ownerSessionId: 'owner-retained', herdrSession: 'unowned-native' });
  const inspected = await run(['inspect', 'unowned-native', '--json'], extra);
  assert.equal(inspected.exit, 0); assert.equal(parseCliEnvelope(inspected.text).native_running, true); assert.equal(parseCliEnvelope(inspected.text).teams[0].team_id, kept.team_id);
  failStop = true;
  const partial = await run(['stop', 'unowned-native', '--json'], extra);
  assert.equal(partial.exit, 1); const partialValue = parseCliEnvelope(partial.text); assert.equal(partialValue.lifecycle, 'closing'); assert.match(partialValue.error.message, /stop failed/);
  failStop = false;
  const stopped = await run(['stop', 'unowned-native', '--json'], extra);
  assert.equal(stopped.exit, 0, stopped.text); const stoppedValue = parseCliEnvelope(stopped.text); assert.equal(stoppedValue.operation_id, partialValue.operation_id);
  assert.equal(stoppedValue.lifecycle, 'stopped'); assert.equal(mutable.some(r => r.name === 'unowned-native'), true);
  assert.equal(listTeams().find(t => t.team_id === kept.team_id).owner_session_id, 'owner-retained'); assert.equal(listTeams().find(t => t.team_id === kept.team_id).closed_at, null);
  const restarted = await run(['start', '--project', freshProject, '--json'], extra);
  assert.equal(restarted.exit, 0, restarted.text); assert.equal(parseCliEnvelope(restarted.text).session, 'unowned-native');
  const allocated = await run(['start', '--project', 'new-proj-333333', '--json'], extra);
  assert.equal(allocated.exit, 0, allocated.text); assert.match(parseCliEnvelope(allocated.text).session, /^g-[0-9a-f]{28}$/);
  const unknownRead = await run(['inspect', 'unowned-native', '--json'], { ...extra, herdr: { ...native, sessionList: () => { throw new Error('inventory probe unavailable'); } } });
  assert.equal(unknownRead.exit, 0); assert.equal(parseCliEnvelope(unknownRead.text).native_running, null); assert.equal(parseCliEnvelope(unknownRead.text).capabilities.attach.state, 'unavailable');
  const finalClose = await run(['close', 'unowned-native', '--json'], extra);
  assert.equal(finalClose.exit, 0, finalClose.text); assert.equal(parseCliEnvelope(finalClose.text).native_deleted, true);
  const closedRetry = await run(['close', 'unowned-native', '--json'], extra);
  assert.equal(closedRetry.exit, 0); assert.equal(parseCliEnvelope(closedRetry.text).noop, true);
  assert.equal(listTeams().find(t => t.team_id === kept.team_id).closed_at != null, true);
  assert.ok(stops >= 2);
}
// Startup uncertainty is never silently relaunched; exact adoption repairs
// only its recorded session. A late native result cannot publish ready.
{
  const { startManagedSession, stopManagedSession, adoptManagedSession } = await import('../lib/management-session.js');
  const { readManagementSnapshot } = await import('../lib/management-registry.js');
  const rows = []; let launches = 0;
  const native = { sessionList: () => rows, paneList: () => [],
    ensureSession: async session => { launches++; rows.push({ name: session, running: true }); throw new Error('startup response lost'); },
    sessionStop: session => { rows.find(r => r.name === session).running = false; return true; } };
  const failed = await startManagedSession('failure-proj-444444', { native });
  assert.equal(failed.lifecycle, 'unresolved'); assert.match(failed.error, /response lost/);
  await assert.rejects(startManagedSession('failure-proj-444444', { inventory: rows, native }), /unresolved.*operation/);
  assert.equal(launches, 1);
  adoptManagedSession('failure-proj-444444', failed.session, { inventory: rows });
  assert.equal(readManagementSnapshot().mappings.intents.find(i => i.operation_id === failed.operation_id).phase, 'reconciled');
  const missing = await startManagedSession('missing-proj-555555', { native: { ensureSession: async () => ({ started: true }) } });
  assert.equal(missing.lifecycle, 'unresolved'); assert.match(missing.error, /omitted exact IDs/);
  let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const racingNative = { ...native, ensureSession: async session => { rows.push({ name: session, running: true }); entered(session); await barrier; return { session, started: true }; } };
  const racing = startManagedSession('racing-proj-666666', { native: racingNative });
  const handle = await started;
  const stopped = await stopManagedSession(handle, { inventory: rows, native: racingNative, workers: { listWorkers: () => [] }, timeoutMs: 0 });
  assert.equal(stopped.ok, false); assert.equal(stopped.pending_operation_ids.length, 1);
  release(); const late = await racing;
  assert.equal(late.ok, false); assert.equal(late.lifecycle, 'closing');
  assert.equal(readManagementSnapshot().mappings.intents.find(i => i.operation_id === late.operation_id).phase, 'reconciled');
  const retried = await stopManagedSession(handle, { inventory: rows, native: racingNative, workers: { listWorkers: () => [] }, timeoutMs: 0 });
  assert.equal(retried.ok, true); assert.equal(retried.operation_id, stopped.operation_id); assert.equal(retried.lifecycle, 'stopped');
}
fs.rmSync(temp, { recursive: true, force: true });
console.log('session CLI passed: D8 list/attach, start/adopt/inspect/stop/close, stable ownership, retained definitions, dry-run byte identity, native uncertainty/adoption recovery, timeout/retry and late-start fence');
