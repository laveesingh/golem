#!/usr/bin/env node
// GOL-371 journey: two teams on real herdr under a throwaway GOLEM_HERDR_SESSION.
// Covers: two teams each get builder1 through the real CLI
// (`golem agent create builder --team <slug>`); a lead spawns into its own
// team; unbound spawn without --team refuses; team lead moves the lead;
// team close retires only its own team (agents + workspace).
// Temp GOLEM_HOME and temp HOME only (the pane inherits PATH with the fixture
// fake pi first, so no real Pi boots). Cleanup in finally: live workers
// killed, throwaway session stopped and deleted, zero server processes left.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'cli', 'golem.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-team-journey-'));
const home = path.join(temp, 'home');
const project = path.join(temp, 'project');
const bin = path.join(temp, 'bin');
const state = path.join(temp, 'state');
const registrationDir = path.join(temp, 'registrations');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(state, { recursive: true });
fs.mkdirSync(registrationDir, { recursive: true });
fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# journey project\n');

const herdrSession = `golem-test-${process.pid}-journey`;
// Short xdg root for the herdr socket, OUTSIDE temp: with temp HOME and no
// XDG override the socket lands under $HOME/.config and exceeds sun_path's
// 104-byte limit. Removed only after the session is stopped.
const xdgHome = `/tmp/golem-test-xdg-${process.pid}-journey`;
const envKeys = ['GOLEM_HOME', 'HOME', 'PATH', 'GOLEM_HERDR_SESSION', 'GOLEM_DASHBOARD_URL', 'XDG_CONFIG_HOME',
  'GOLEM_TEST_REGISTRATION_DIR', 'GOLEM_TEST_PROJECT_ID',
  'GOLEM_WORKER_READY_TIMEOUT_MS', 'GOLEM_WORKER_POLL_MS'];
const originalEnv = {};
for (const key of envKeys) originalEnv[key] = process.env[key];

// Fixture fake pi: registers readiness like the worker-journey fixture. The
// pane runs it because temp HOME has no login profile, so the inherited
// PATH's bin/pi wins over the real Pi.
const fakePi = path.join(bin, 'pi');
fs.writeFileSync(fakePi, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.length === 3 && process.argv[2] === '--version') {
  process.stdout.write('0.84.3\\n');
  process.exit(0);
}
const args = process.argv.slice(2);
const nameIndex = args.indexOf('--name');
const name = nameIndex >= 0 ? args[nameIndex + 1] : null;
if (!name) process.exit(17);
const registrationDir = process.env.GOLEM_TEST_REGISTRATION_DIR;
fs.writeFileSync(path.join(registrationDir, name + '.json'), JSON.stringify({
  session_id: 'golemtest-team-session-' + name,
  name,
  role: null,
  harness: 'pi',
  project_id: process.env.GOLEM_TEST_PROJECT_ID,
  status: 'idle',
}));
process.stdout.write('[team journey worker ' + name + '] ready\\n');
for (const signal of ['SIGTERM', 'SIGHUP']) process.once(signal, () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o700 });

const { projectIdFor } = await import('../lib/project-id.js');
const projectId = projectIdFor(project);

Object.assign(process.env, {
  GOLEM_HOME: state,
  HOME: home,
  PATH: `${bin}${path.delimiter}${originalEnv.PATH ?? ''}`,
  GOLEM_HERDR_SESSION: herdrSession,
  XDG_CONFIG_HOME: xdgHome,
  GOLEM_TEST_REGISTRATION_DIR: registrationDir,
  GOLEM_TEST_PROJECT_ID: projectId,
  GOLEM_WORKER_READY_TIMEOUT_MS: '30000',
  GOLEM_WORKER_POLL_MS: '250',
});

const { readWorkers } = await import('../lib/worker-registry.js');
const { listTeams, setTeamLead } = await import('../lib/team-registry.js');
const { resolveCallerTeam } = await import('../lib/team-context.js');
const { listHerdrWorkspaces, projectHerdrSession } = await import('../lib/team-herdr.js');
const { killWorker } = await import('../lib/worker-manager.js');
const { paneList } = await import('../lib/herdr-driver.js');
const { runTeam } = await import('../cli/team.js');

function readBody(request) {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
  });
}

let server;

// Fake dashboard: dispatchable serves the fixture registration files, but
// only for workers whose row is still live — like the real dashboard, dead
// sessions are not dispatchable.
function dashboardRows() {
  const liveNames = new Set();
  try {
    const workers = JSON.parse(fs.readFileSync(path.join(state, 'workers.json'), 'utf8')).workers ?? [];
    for (const worker of workers) {
      if (['spawning', 'live'].includes(String(worker.state || '').toLowerCase())) liveNames.add(worker.name);
    }
  } catch {}
  const rows = [];
  for (const file of fs.readdirSync(registrationDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const row = JSON.parse(fs.readFileSync(path.join(registrationDir, file), 'utf8'));
      // A registration file asserts readiness: the roster carries
      // delivery_ready, which enrich keeps as-is.
      if (liveNames.has(row.name)) rows.push({ ...row, delivery_ready: true });
    } catch {}
  }
  return rows;
}

async function startDashboard() {
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/health') {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/api/sessions/dispatchable' && request.method === 'GET') {
      const wanted = url.searchParams.get('project');
      response.end(JSON.stringify(dashboardRows().filter((row) => !wanted || row.project_id === wanted)));
      return;
    }
    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/role$/);
    if (match && request.method === 'POST') {
      await readBody(request);
      response.end(JSON.stringify({ ok: true, saved: true }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.GOLEM_DASHBOARD_URL = `http://127.0.0.1:${server.address().port}`;
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: project, env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function strayPiCount(name) {
  const found = spawnSync('pgrep', ['-f', '--', `--name ${name}`], { encoding: 'utf8' });
  return String(found.stdout || '').trim().split('\n').filter(Boolean).length;
}

async function main() {
  assert.equal(projectHerdrSession(projectId), herdrSession, 'tests run under the throwaway session');
  await startDashboard();

  // The pane's `golem pi` needs its render (isolated GOLEM_HOME).
  const syncResult = spawnSync(process.execPath, [cli, 'sync', '--target', 'pi'], { cwd: repo, env: { ...process.env }, encoding: 'utf8' });
  assert.equal(syncResult.status, 0, `sync --target pi failed: ${syncResult.stderr}`);

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

  // Two teams in one project each get builder1 through the real CLI.
  const alphaSpawned = await runCli(['agent', 'create', 'builder', '--team', 'alpha-team', '--project', project, '--json']);
  assert.equal(alphaSpawned.status, 0, alphaSpawned.stderr);
  const alphaAgent = JSON.parse(alphaSpawned.stdout);
  assert.equal(alphaAgent.name, 'builder1');
  assert.equal(alphaAgent.team, 'alpha-team');
  assert.equal(alphaAgent.host, 'herdr');
  assert.equal(alphaAgent.dispatchable, true);
  const betaSpawned = await runCli(['agent', 'create', 'builder', '--team', 'beta-team', '--project', project, '--json']);
  assert.equal(betaSpawned.status, 0, betaSpawned.stderr);
  const betaAgent = JSON.parse(betaSpawned.stdout);
  assert.equal(betaAgent.name, 'builder1');
  assert.equal(betaAgent.team, 'beta-team');

  const alphaBuilder = readWorkers().find((worker) => worker.team_id === alpha.team_id);
  const betaBuilder = readWorkers().find((worker) => worker.team_id === beta.team_id);
  assert.equal(alphaBuilder.name, 'builder1');
  assert.equal(betaBuilder.name, 'builder1');
  assert.equal(alphaBuilder.state, 'live');
  assert.equal(betaBuilder.state, 'live');
  assert.equal(alphaBuilder.herdr_agent_name, 'alpha-team-builder1');
  assert.equal(betaBuilder.herdr_agent_name, 'beta-team-builder1');
  assert.equal(alphaBuilder.herdr_workspace_id, alpha.herdr_workspace_id);
  assert.equal(betaBuilder.herdr_workspace_id, beta.herdr_workspace_id);
  console.log(JSON.stringify({ cli_spawns: ['alpha-team-builder1', 'beta-team-builder1'], team_workspaces: true }));

  // A lead spawns into its own team (G8): lead the alpha team, resolve.
  // (A CLI subprocess cannot bind a lead session — no pi ancestry in tests —
  // so the lead default stays covered at the resolveCallerTeam unit level,
  // while everything around it goes through the real CLI.)
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
  const refused = await runCli(['agent', 'create', 'builder', '--project', project]);
  assert.equal(refused.status, 2, 'unbound spawn without --team refuses');
  assert.match(refused.stderr, /no team: pass --team or run golem team lead <team>/);

  // team close retires only its own team: the CLI-spawned agents are live.
  const panesBefore = new Map(paneList(herdrSession).map((pane) => [pane.pane_id, pane]));
  assert.ok(panesBefore.has(alphaBuilder.herdr_pane_id), 'alpha pane exists before close');
  assert.ok(panesBefore.has(betaBuilder.herdr_pane_id), 'beta pane exists before close');
  // Both teams run builder1, so survivors are counted, not emptied: each
  // live worker contributes its golem-pi wrapper plus its fake pi.
  const piBefore = strayPiCount('builder1');
  assert.ok(piBefore >= 2, `both builder1 workers run before close (saw ${piBefore})`);

  const closed = await runCli(['team', 'close', 'alpha-team', '--project', project, '--json']);
  assert.equal(closed.status, 0, closed.stderr);
  const closeResult = JSON.parse(closed.stdout);
  assert.equal(closeResult.state, 'closed');
  assert.deepEqual(closeResult.stopped, ['builder1']);
  assert.equal(closeResult.workspace_closed, true);

  const panesAfter = new Map(paneList(herdrSession).map((pane) => [pane.pane_id, pane]));
  assert.ok(!panesAfter.has(alphaBuilder.herdr_pane_id), 'alpha pane closed');
  assert.ok(panesAfter.has(betaBuilder.herdr_pane_id), 'beta pane kept');
  assert.equal(strayPiCount('builder1'), piBefore - 2, 'only the beta builder1 processes survive the close');
  const { findWorker } = await import('../lib/worker-registry.js');
  assert.equal(findWorker('builder1', { projectId, teamId: alpha.team_id }).state, 'dead');
  assert.equal(findWorker('builder1', { projectId, teamId: beta.team_id }).state, 'live');

  const workspaces = await listHerdrWorkspaces(herdrSession);
  assert.ok(!workspaces.some((row) => row.workspace_id === alpha.herdr_workspace_id), 'alpha workspace closed');
  assert.ok(workspaces.some((row) => row.workspace_id === beta.herdr_workspace_id), 'beta workspace kept');

  const listed = await runCli(['agent', 'list', '--scope', 'project', '--project', project, '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout);
  assert.ok(rows.some((row) => row.team_id === beta.team_id), 'list shows team rows');
  const tabled = await runCli(['agent', 'list', '--scope', 'project', '--project', project]);
  assert.match(tabled.stdout, /TEAM/, 'table carries the TEAM column');

  console.log(JSON.stringify({ teams: ['alpha-team', 'beta-team'], builder1_per_team: true, close_isolated: true }));
  console.log('team journey passed: per-team builder1 via CLI, lead resolution, unbound refusal, lead move, isolated close');
}

let failed = null;
try {
  await main();
} catch (error) {
  failed = error;
} finally {
  // Kill live workers first (needs the server), then stop the throwaway
  // session BEFORE removing any dir, then verify zero sessions/processes.
  try {
    const rows = readWorkers().filter((worker) => ['spawning', 'live', 'failed'].includes(worker.state) && !worker.tmux_session);
    for (const row of rows) {
      await killWorker(row.name, { projectId: row.project_id, teamId: row.team_id ?? null }).catch(() => {});
    }
  } catch {}
  const { sessionStop, sessionDelete, sessionList } = await import('../lib/herdr-driver.js').catch(() => ({ sessionStop: null, sessionList: null }));
  const throwaway = process.env.GOLEM_HERDR_SESSION;
  if (sessionStop && sessionDelete && throwaway && throwaway.startsWith('golem-test-')) {
    try { sessionStop(throwaway); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try { sessionDelete(throwaway); } catch {}
    const remaining = sessionList().filter((row) => String(row?.name ?? row ?? '') === throwaway);
    assert.equal(remaining.length, 0, `throwaway herdr session is gone: ${JSON.stringify(remaining)}`);
    const pgrep = spawnSync('pgrep', ['-f', `herdr --session ${throwaway}`], { encoding: 'utf8' });
    assert.equal(String(pgrep.stdout || '').trim(), '', `no throwaway herdr server process remains: ${pgrep.stdout}`);
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(xdgHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
if (failed) throw failed;
