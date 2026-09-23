#!/usr/bin/env node
// GOL-371 journey: two teams on real herdr under a throwaway GOLEM_HERDR_SESSION.
// Covers: two teams each get builder1; a lead spawns into its own team;
// unbound spawn without --team refuses; team lead moves the lead;
// team close retires only its own team (agents + workspace).
// Temp GOLEM_HOME only. Cleanup in finally: no golem-test-* session left,
// no leftover sleeper processes.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'cli', 'golem.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-team-journey-'));
const home = path.join(temp, 'home');
const project = path.join(temp, 'project');
const bin = path.join(temp, 'bin');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# journey project\n');

const herdrSession = `golem-test-${process.pid}-journey`;
const envKeys = ['GOLEM_HOME', 'GOLEM_HERDR_SESSION', 'GOLEM_TMUX_BIN', 'XDG_CONFIG_HOME'];
const originalEnv = {};
for (const key of envKeys) originalEnv[key] = process.env[key];
process.env.GOLEM_HOME = home;
process.env.GOLEM_HERDR_SESSION = herdrSession;
delete process.env.XDG_CONFIG_HOME;

// Fake tmux: kill-session is a no-op so team close exercises the process-group
// stop path without a tmux server.
const fakeTmux = path.join(bin, 'fake-tmux');
fs.writeFileSync(fakeTmux, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
process.env.GOLEM_TMUX_BIN = fakeTmux;

const { projectIdFor } = await import('../lib/project-id.js');
const { claimWorker, updateWorker, findWorker } = await import('../lib/worker-registry.js');
const { listTeams, setTeamLead } = await import('../lib/team-registry.js');
const { resolveCallerTeam } = await import('../lib/team-context.js');
const { listHerdrWorkspaces, stopAndDeleteSession, projectHerdrSession } = await import('../lib/team-herdr.js');
const { processIdsInGroup } = await import('../lib/tmux-driver.js');
const { runTeam } = await import('../cli/team.js');

const projectId = projectIdFor(project);
const sleepers = [];

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function startSleeper(workerName) {
  const child = spawn('sh', ['-c', `exec -a "pi --name ${workerName}" sleep 300`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  sleepers.push(child);
  return child;
}

function stopSleeper(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}

async function main() {
  assert.equal(projectHerdrSession(projectId), herdrSession, 'tests run under the throwaway session');

  // Two teams, created from an unbound shell: no lead, own workspaces.
  const alphaCreated = await runCli(['team', 'create', 'Alpha Team', '--project', project, '--json']);
  assert.equal(alphaCreated.status, 0, alphaCreated.stderr);
  const alpha = JSON.parse(alphaCreated.stdout);
  assert.equal(alpha.slug, 'alpha-team');
  assert.equal(alpha.lead, null);
  assert.ok(alpha.herdr_workspace_id, 'workspace created');

  const betaCreated = await runCli(['team', 'create', 'Beta Team', '--project', project, '--json']);
  assert.equal(betaCreated.status, 0, betaCreated.stderr);
  const beta = JSON.parse(betaCreated.stdout);
  assert.equal(beta.slug, 'beta-team');
  assert.notEqual(beta.herdr_workspace_id, alpha.herdr_workspace_id, 'each team has its own workspace');

  const dup = await runCli(['team', 'create', 'alpha team', '--project', project, '--json']);
  assert.equal(dup.status, 2, 'duplicate slug refuses');
  assert.match(dup.stdout + dup.stderr, /team slug already exists/);

  // Two teams in one project can each have a builder1.
  const preset = { harness: 'pi', model: 'journey-model' };
  const alphaBuilder = claimWorker({ role: 'builder', projectId, preset, teamId: alpha.team_id });
  const betaBuilder = claimWorker({ role: 'builder', projectId, preset, teamId: beta.team_id });
  assert.equal(alphaBuilder.name, 'builder1');
  assert.equal(betaBuilder.name, 'builder1');

  // A lead spawns into its own team (G8): lead the alpha team, resolve.
  setTeamLead(alpha.team_id, 'lead-A');
  const teams = listTeams({ projectId });
  const resolved = resolveCallerTeam({
    projectId,
    callerSessionId: 'lead-A',
    teams,
    workerRow: null,
  });
  assert.equal(resolved.team_id, alpha.team_id, 'lead-A spawns into alpha');

  // team lead moves the lead: lead-A takes beta, alpha is cleared.
  const leadStdout = [];
  const leadCode = await runTeam('team', ['lead', 'beta-team', '--project', projectId], {
    stdout: (text) => leadStdout.push(text),
    stderr: () => {},
    cwd: project,
    resolveContext: () => ({ sessionId: 'lead-A', projectId }),
  });
  assert.equal(leadCode, 0, leadStdout.join('\n'));
  const afterMove = listTeams({ projectId });
  assert.equal(afterMove.find((row) => row.team_id === beta.team_id).lead_session_id, 'lead-A');
  assert.equal(afterMove.find((row) => row.team_id === alpha.team_id).lead_session_id, null);
  assert.equal(
    resolveCallerTeam({ projectId, callerSessionId: 'lead-A', teams: afterMove }).team_id,
    beta.team_id,
    'lead-A now spawns into beta',
  );

  // An unbound spawn without --team refuses.
  const refused = await runCli(['spawn', 'builder', '--project', project]);
  assert.equal(refused.status, 2, 'unbound spawn without --team refuses');
  assert.match(refused.stderr, /no team: pass --team or run golem team lead <team>/);

  // team close retires only its own team: live sleepers in both teams.
  const sleeperA = startSleeper(alphaBuilder.name);
  const sleeperB = startSleeper(betaBuilder.name);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(processIdsInGroup(sleeperA.pid).length > 0, 'sleeper A runs');
  assert.ok(processIdsInGroup(sleeperB.pid).length > 0, 'sleeper B runs');
  updateWorker(alphaBuilder.worker_id, { pid: sleeperA.pid, session_id: 'sess-alpha-1', state: 'live' });
  updateWorker(betaBuilder.worker_id, { pid: sleeperB.pid, session_id: 'sess-beta-1', state: 'live' });

  const closed = await runCli(['team', 'close', 'alpha-team', '--project', project, '--json']);
  assert.equal(closed.status, 0, closed.stderr);
  const closeResult = JSON.parse(closed.stdout);
  assert.equal(closeResult.state, 'closed');
  assert.deepEqual(closeResult.stopped, ['builder1']);
  assert.equal(closeResult.workspace_closed, true);

  assert.equal(processIdsInGroup(sleeperA.pid).length, 0, 'alpha agent process group is empty');
  assert.ok(processIdsInGroup(sleeperB.pid).length > 0, 'beta agent survives');
  assert.equal(findWorker('builder1', { projectId, teamId: alpha.team_id }).state, 'dead');
  assert.equal(findWorker('builder1', { projectId, teamId: beta.team_id }).state, 'live');

  const workspaces = listHerdrWorkspaces(herdrSession);
  assert.ok(!workspaces.some((row) => row.workspace_id === alpha.herdr_workspace_id), 'alpha workspace closed');
  assert.ok(workspaces.some((row) => row.workspace_id === beta.herdr_workspace_id), 'beta workspace kept');

  const listed = await runCli(['list', '--project', project, '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout);
  assert.ok(rows.some((row) => row.team_id === beta.team_id), 'list shows team rows');
  const tabled = await runCli(['list', '--project', project]);
  assert.match(tabled.stdout, /TEAM/, 'table carries the TEAM column');

  stopSleeper(sleeperB);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(processIdsInGroup(sleeperB.pid).length, 0, 'beta sleeper reaped in cleanup');
  console.log(JSON.stringify({ teams: ['alpha-team', 'beta-team'], builder1_per_team: true, close_isolated: true }));
  console.log('team journey passed: per-team builder1, lead resolution, unbound refusal, lead move, isolated close');
}

let failed = null;
try {
  await main();
} catch (error) {
  failed = error;
} finally {
  for (const child of sleepers) stopSleeper(child);
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    const check = spawnSync(process.execPath, ['-e', ''], { env: process.env });
    void check;
    stopAndDeleteSession(herdrSession);
  } catch (error) {
    if (!failed) failed = error;
  }
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}
if (failed) throw failed;
