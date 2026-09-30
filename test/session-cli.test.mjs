#!/usr/bin/env node
// golem session list|attach: the herdr session table, project mapping,
// open-team counts, and the attach target rules. Temp GOLEM_HOME and a fake
// herdr seam; no herdr server.

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
const herdr = {
  sessionList: () => [
    { name: 'default', running: true },
    { name: 'demo-proj', running: true },
    { name: 'idle', running: false },
  ],
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
    sessionStop: (name) => { calls.push(`stop ${name}`); return true; },
    sessionDelete: (name) => { deleteTries += 1; if (deleteTries < 2) return false; calls.push(`delete ${name}`); return true; },
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
  assert.match(failing.err, /session demo-proj left open; agents failed to stop: builder1: identity mismatch/);
  assert.deepEqual(calls, [], 'a failed agent stop leaves the session and teams alone');
  assert.equal(listTeams({ includeClosed: false }).filter((t) => t.herdr_session === 'demo-proj').length, 1);

  const closed = await run(['close', 'demo-proj', '--json'], extra);
  assert.equal(closed.exit, 0, closed.err);
  const { resolution, ...receipt } = JSON.parse(closed.text);
  assert.equal(resolution.provenance.session, 'exact-target');
  assert.deepEqual(receipt, { session: 'demo-proj', stopped: ['builder1'], teams_closed: ['open-one'] });
  assert.deepEqual(calls, [`kill builder1 ${projectId} t1`, 'stop demo-proj', 'delete demo-proj']);
  assert.equal(listTeams({ includeClosed: false }).filter((t) => t.herdr_session === 'demo-proj').length, 0);

  const forced = await run(['close', 'idle', '--force'], { ...extra, env: { HERDR_SESSION: 'idle' } });
  assert.equal(forced.exit, 0, forced.err);
  assert.match(forced.text, /^session idle closed \(1 agents stopped, 0 teams closed\)$/);

  assert.equal((await run(['close', 'nope'], extra)).exit, 2);
  assert.equal((await run(['close'], extra)).exit, 2);
}

fs.rmSync(temp, { recursive: true, force: true });
console.log('session CLI passed: list table + JSON, project mapping, open-team count, attach by name and by project, unknown refusal, close with self-guard and fail-closed agent stop');
