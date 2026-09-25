#!/usr/bin/env node
// golem session list|attach: the herdr session table, project mapping,
// open-team counts, and the attach target rules. Temp GOLEM_HOME and a fake
// herdr seam; no herdr server.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-session-cli-'));
process.env.GOLEM_HOME = path.join(temp, 'state');
delete process.env.XDG_CONFIG_HOME;
delete process.env.GOLEM_HERDR_SESSION;
fs.mkdirSync(process.env.GOLEM_HOME, { recursive: true });

const projectId = 'demo-proj-abcdef';
fs.writeFileSync(path.join(process.env.GOLEM_HOME, 'projects.json'), JSON.stringify({ projects: [{ project_id: projectId, name: 'Demo Proj' }] }));

const { createTeam, closeTeam } = await import('../lib/team-registry.js');
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
  const exit = await runSession('session', args, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), cwd: temp, herdr, ...extra });
  return { exit, text: out.join('\n'), err: err.join('\n') };
}

// list: JSON rows carry status, the mapped project, and open teams only.
{
  const listed = await run(['list', '--json']);
  assert.equal(listed.exit, 0, listed.err);
  assert.deepEqual(JSON.parse(listed.text), [
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
  assert.match(unknown.err, /unknown herdr session: nope \(known: default, demo-proj, idle\)/);
  assert.equal(attached.length, 2, 'unknown session never reaches herdr');
  assert.equal((await run(['attach', 'a', 'b'])).exit, 2);
  assert.equal((await run(['bogus'])).exit, 2);
}

fs.rmSync(temp, { recursive: true, force: true });
console.log('session CLI passed: list table + JSON, project mapping, open-team count, attach by name and by project, unknown refusal');
