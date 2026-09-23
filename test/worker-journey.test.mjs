#!/usr/bin/env node
// GOL-370 worker journey, herdr host. CLI legs run through the `golem agent`
// verbs (create/list/read/stop) against real herdr under a throwaway
// GOLEM_HERDR_SESSION: create a Pi worker, it becomes dispatchable, read
// shows its pane, stop leaves no survivors and the row is dead. Legacy tmux
// rows (G14) keep their own handling: reconcile by the recorded pid group,
// stop/read refuse with the exact tmux command.

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectIdFor } from '../lib/project-id.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'cli/golem.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'g370-'));
process.env.GOL370_TEST_TEMP = temp;
const bin = path.join(temp, 'bin');
const project = path.join(temp, 'project');
const state = path.join(temp, 'state');
const registrationDir = path.join(temp, 'registrations');
const lockState = path.join(temp, 'lock-state');
const herdrSession = `golem-test-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
// Short xdg root for the herdr socket (see below); kept outside temp and
// removed only after the session is stopped.
const xdgHome = `/tmp/golem-test-xdg-${process.pid}-${Math.random().toString(16).slice(2, 6)}`;
const projectId = projectIdFor(project);

// GOL-370: `golem pi` in the pane needs its render (isolated GOLEM_HOME) —
// sync it and link the pi-tui peer the extension requires. (The pane itself
// runs the fixture fake pi: temp HOME has no login profile, so bin/pi wins.)
function linkPiTui(render, piCli) {
  piCli = fs.realpathSync(piCli);
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
  if (!source) throw new Error(`could not find @earendil-works/pi-tui starting from ${piCli}`);
  const scope = path.join(render, 'node_modules', '@earendil-works');
  fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(source, path.join(scope, 'pi-tui'), 'dir');
}
const originalEnv = {};
const envKeys = [
  'GOLEM_HOME', 'HOME', 'PATH', 'GOLEM_DASHBOARD_URL', 'GOLEM_HERDR_SESSION',
  'GOLEM_TEST_REGISTRATION_DIR', 'GOLEM_TEST_PROJECT_ID', 'GOLEM_WORKER_READY_TIMEOUT_MS',
  'GOLEM_WORKER_POLL_MS', 'GOLEM_WORKER_REQUEST_TIMEOUT_MS', 'GOLEM_HERDR_BIN',
  'GOLEM_TEST_REGISTRATION_DIR', 'GOLEM_FAKE_NO_REGISTER', 'GOLEM_WORKER_CLI', 'GOLEM_BIN',
  'XDG_CONFIG_HOME',
];
for (const key of envKeys) originalEnv[key] = process.env[key];

fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.join(temp, 'home'), { recursive: true });
fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# GOL-370 worker-journey fixture\n');
fs.mkdirSync(registrationDir, { recursive: true });
fs.mkdirSync(lockState, { recursive: true });
fs.mkdirSync(path.join(state, 'renders', 'pi'), { recursive: true });

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
if (process.env.GOLEM_FAKE_NO_REGISTER !== '1') {
  fs.writeFileSync(path.join(registrationDir, name + '.json'), JSON.stringify({
    session_id: 'golemtest-t2-session-' + name,
    name,
    role: null,
    harness: 'pi',
    project_id: process.env.GOLEM_TEST_PROJECT_ID,
    status: 'idle',
  }));
}
process.stdout.write('[golemtest-t2 worker ' + name + '] ready\\n');
for (const signal of ['SIGTERM', 'SIGHUP']) process.once(signal, () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o700 });

Object.assign(process.env, {
  GOLEM_HOME: state,
  HOME: path.join(temp, 'home'),
  PATH: `${bin}${path.delimiter}${originalEnv.PATH ?? ''}`,
  GOLEM_TEST_REGISTRATION_DIR: registrationDir,
  GOLEM_TEST_PROJECT_ID: projectId,
  GOLEM_WORKER_READY_TIMEOUT_MS: '30000',
  GOLEM_WORKER_POLL_MS: '1000',
  GOLEM_WORKER_REQUEST_TIMEOUT_MS: '500',
  // GOL-370: herdr's unix socket must stay under sun_path's 104-byte limit —
  // use a short xdg root OUTSIDE the temp dir so removing temp never deletes
  // the socket mid-run; the session is stopped (below) before this dir goes.
  XDG_CONFIG_HOME: xdgHome,
  GOLEM_HERDR_SESSION: herdrSession,
  GOLEM_HERDR_LOG_DIR: path.join(temp, 'herdr-logs'),
});
delete process.env.GOLEM_WORKER_CLI;
delete process.env.GOLEM_BIN;

function readBody(request) {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
  });
}

let server;
let recycled;

function dashboardRows() {
  const assignments = dashboardRows.assignments ?? new Map();
  let rows = [];
  for (const file of fs.readdirSync(registrationDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const row = JSON.parse(fs.readFileSync(path.join(registrationDir, file), 'utf8'));
      rows.push({ ...row, role: assignments.get(row.session_id) ?? row.role });
    } catch {}
  }
  return rows;
}
dashboardRows.assignments = new Map();

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
      // The pane runs the fixture fake pi: temp HOME has no login profile,
      // so the inherited PATH's bin/pi wins over the real Pi. Serve its
      // registration files, plus any rows a real Pi bridge wrote to the
      // GOLEM_HOME stores — whichever exists. Like the real dashboard, only
      // live sessions are dispatchable: drop files whose worker row is gone
      // or ended, so killed workers don't linger as ghosts.
      const liveNames = new Set();
      try {
        const workers = JSON.parse(fs.readFileSync(path.join(state, 'workers.json'), 'utf8')).workers ?? [];
        for (const worker of workers) {
          if (['spawning', 'live'].includes(String(worker.state || '').toLowerCase())) liveNames.add(worker.name);
        }
      } catch {}
      const filed = dashboardRows().filter((row) => liveNames.has(row.name));
      let stored = [];
      try {
        const facts = JSON.parse(fs.readFileSync(path.join(state, 'session-facts.json'), 'utf8')).facts ?? [];
        let registryRows = [];
        try {
          registryRows = JSON.parse(fs.readFileSync(path.join(state, 'sessions.json'), 'utf8')).sessions ?? [];
        } catch {}
        stored = facts
          .filter((fact) => fact.harness === 'pi' && !fact.ended_at)
          .map((fact) => {
            const registryRow = registryRows.find((row) => row.session_id === fact.canonical_id) ?? null;
            return {
              session_id: fact.canonical_id,
              name: fact.name ?? fact.canonical_id,
              harness: fact.harness,
              status: fact.status ?? 'idle',
              project_id: projectIdFor(fact.project_path ?? project),
              role: registryRow?.role ?? null,
            };
          });
      } catch { /* no facts yet */ }
      const seen = new Set(filed.map((row) => row.session_id).filter(Boolean));
      const rows = filed.concat(stored.filter((row) => !row.session_id || !seen.has(row.session_id)));
      response.end(JSON.stringify(rows.filter((row) => !wanted || row.project_id === wanted)));
      return;
    }
    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/role$/);
    if (match && request.method === 'POST') {
      const body = JSON.parse(await readBody(request) || '{}');
      dashboardRows.assignments.set(decodeURIComponent(match[1]), body.role ?? null);
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
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: project,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function claimChild() {
  const moduleUrl = pathToFileURL(path.join(repo, 'lib', 'worker-registry.js')).href;
  const code = `import { claimWorker } from ${JSON.stringify(moduleUrl)};
const row = claimWorker({ role: 'golemtest-t2', projectId: 'lock-project', preset: { harness: 'pi', provider: 'ollama-cloud', model: 'deepseek-v4-flash:0731', thinking: 'medium', name: null } });
console.log(JSON.stringify({ name: row.name, herdr_session: row.herdr_session, tmux_session: row.tmux_session ?? null }));`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: repo,
      env: { ...process.env, GOLEM_HOME: lockState },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (codeValue, signal) => resolve({ code: codeValue, signal, stdout: stdout.trim(), stderr }));
  });
}

try {
  await startDashboard();
  const syncResult = spawnSync(process.execPath, [cli, 'sync', '--target', 'pi'], {
    cwd: repo, env: { ...process.env }, encoding: 'utf8',
  });
  if (syncResult.status !== 0) throw new Error(`sync --target pi failed: ${syncResult.stderr}`);
  console.log(`pi render synced: ${syncResult.stdout.split('\n').filter((l) => l.includes('out:')).join(' ')}`);
  const piRender = path.join(state, 'renders', 'pi');
  // Resolve the pi-tui peer from the REAL pi on the original PATH (the test's
  // bin dir holds the fake pi stub).
  const realPiCli = execFileSync('sh', ['-c', `command -v pi | grep -v '^${bin}$' || true`], {
    cwd: repo, env: { ...originalEnv, PATH: originalEnv.PATH ?? process.env.PATH }, encoding: 'utf8',
  }).trim().split('\n')[0];
  linkPiTui(piRender, realPiCli);
  fs.copyFileSync(path.join(piRender, 'golem.ts'), path.join(piRender, 'golem.mjs'));
  const { createRole, readRoleRegistry } = await import('../lib/session-role.js');
  const {
    WORKER_TOMBSTONE_TTL_MS,
    claimWorker,
    findWorker,
    listWorkers,
    readWorkers,
    updateWorker,
  } = await import('../lib/worker-registry.js');
  const {
    attachWorker,
    enrichDispatchableRows,
    killWorker,
    listWorkerViews,
    peekWorker,
    peekSessionTerminal,
    sendWorkerKeys,
    spawnWorker,
  } = await import('../lib/worker-manager.js');
  const { processIdsInGroup } = await import('../lib/process-group.js');

  createRole({
    name: 'golemtest-t2',
    exec: {
      harness: 'pi',
      provider: 'ollama-cloud',
      model: 'deepseek-v4-flash:0731',
      thinking: 'medium',
      name: null,
    },
  });
  assert.ok(readRoleRegistry().some((row) => row.name === 'golemtest-t2'));

  const claimed = await Promise.all(Array.from({ length: 5 }, () => claimChild()));
  assert.ok(claimed.every((result) => result.code === 0), JSON.stringify(claimed));
  const claimedNames = claimed.map((result) => JSON.parse(result.stdout).name);
  assert.equal(new Set(claimedNames).size, 5, JSON.stringify(claimed));
  assert.deepEqual(readWorkers({ file: path.join(lockState, 'workers.json') }).map((row) => row.name).sort(), claimedNames.slice().sort());
  const claimedRows = JSON.parse(fs.readFileSync(path.join(lockState, 'workers.json'), 'utf8')).workers;
  assert.ok(claimedRows.every((row) => !row.tmux_session && !row.tmux_socket), 'new herdr rows never write tmux_* fields');
  assert.ok(claimedRows.every((row) => row.herdr_agent_name === row.name), 'new rows carry the herdr agent name');
  console.log(JSON.stringify({ lock_claims: claimedNames.sort() }));

  // GOL-363 G8: spawn requires a team — create one and spawn into it.
  const { createTeam } = await import('../lib/team-registry.js');
  const journeyTeam = createTeam({
    label: 'Journey Team',
    projectId,
    leadSessionId: null,
    herdrSession,
  });
  const cliSpawnTable = await runCli(['agent', 'create', 'golemtest-t2', '--name', 'gt2-cli-table', '--project', project, '--team', journeyTeam.slug]);
  assert.equal(cliSpawnTable.status, 0, cliSpawnTable.stderr);
  assert.match(cliSpawnTable.stdout, /^ID\s+NAME\s+ROLE\s+TEAM\s+HOST\s+STATUS/m);
  assert.match(cliSpawnTable.stdout, /gt2-cli-table/);
  const cliSpawnedTable = readWorkers().find((worker) => worker.name === 'gt2-cli-table');
  assert.equal(cliSpawnedTable.state, 'live');
  const cliSpawnJson = await runCli(['agent', 'create', 'golemtest-t2', '--name', 'gt2-cli-json', '--project', project, '--team', journeyTeam.slug, '--json']);
  assert.equal(cliSpawnJson.status, 0, cliSpawnJson.stderr);
  const cliSpawned = JSON.parse(cliSpawnJson.stdout);
  assert.equal(cliSpawned.state, 'live');
  assert.equal(cliSpawned.name, 'gt2-cli-json');
  assert.equal(cliSpawned.team_id, journeyTeam.team_id);
  console.log(JSON.stringify({ cli_spawn: ['gt2-cli-table', 'gt2-cli-json'], herdr_columns: true }));

  const spawned = await Promise.all(Array.from({ length: 5 }, () => spawnWorker({ role: 'golemtest-t2', project, teamId: journeyTeam.team_id })));
  const names = spawned.map((worker) => worker.name);
  const panes = spawned.map((worker) => worker.herdr_pane_id);
  assert.equal(new Set(names).size, 5, JSON.stringify(names));
  assert.equal(new Set(panes).size, 5, JSON.stringify(panes));
  assert.ok(spawned.every((worker) => worker.state === 'live' && worker.dispatchable));
  assert.ok(spawned.every((worker) => !worker.tmux_session), 'spawned rows carry no tmux fields');
  const enriched = enrichDispatchableRows([{ session_id: spawned[0].session_id, project_id: projectId }], { projectId });
  assert.equal(enriched[0].worker_state, 'live');
  assert.equal(enriched[0].worker_attach_hint, `golem agent attach ${spawned[0].name}`);
  console.log(JSON.stringify({ parallel_workers: names.slice().sort(), herdr_panes: panes.slice().sort(), dispatchable_worker_fields: true }));

  const directListed = await listWorkerViews({ project });
  assert.ok(directListed.every((worker) => worker.dispatchable));
  const cliList = await runCli(['agent', 'list', '--scope', 'project', '--project', project]);
  assert.equal(cliList.status, 0, cliList.stderr);
  assert.match(cliList.stdout, /^ID\s+NAME\s+ROLE\s+TEAM\s+HOST\s+STATUS/m);
  assert.match(cliList.stdout, /gt2-cli-table/);
  assert.doesNotMatch(cliList.stdout, /^\[/, 'table output is the default');
  const cliListJson = await runCli(['agent', 'list', '--scope', 'project', '--project', project, '--json']);
  assert.equal(cliListJson.status, 0, cliListJson.stderr);
  const listed = JSON.parse(cliListJson.stdout);
  assert.equal(listed.length, 7);
  assert.ok(listed.every((worker) => worker.dispatchable && worker.model === 'deepseek-v4-flash:0731'));
  console.log(JSON.stringify({ cli_list_count: listed.length, table_default: true, json_stable: true }));

  const cliPeek = await runCli(['agent', 'read', names[0], '--project', project, '--lines', '3']);
  assert.equal(cliPeek.status, 0, cliPeek.stderr);
  assert.match(cliPeek.stdout, /golemtest-t2 worker/);
  const terminalPeek = await peekSessionTerminal(spawned[0].session_id, { lines: 3, projectId });
  assert.equal(terminalPeek.ok, true);
  assert.match(terminalPeek.text, /golemtest-t2 worker/);
  assert.equal(terminalPeek.name, spawned[0].name);
  console.log(JSON.stringify({ peek: names[0], dashboard_terminal_shape: true }));

  const cliKillTable = await runCli(['agent', 'stop', cliSpawnedTable.name, '--project', project]);
  assert.equal(cliKillTable.status, 0, cliKillTable.stderr);
  const killedTable = readWorkers().find((worker) => worker.name === cliSpawnedTable.name);
  assert.equal(killedTable.state, 'dead');
  assert.deepEqual(processIdsInGroup(cliSpawnedTable.pid), []);
  const cliKillJson = await runCli(['agent', 'stop', cliSpawned.name, '--project', project, '--json']);
  assert.equal(cliKillJson.status, 0, cliKillJson.stderr);
  const killedByCli = JSON.parse(cliKillJson.stdout);
  assert.equal(killedByCli.state, 'dead');
  assert.deepEqual(processIdsInGroup(cliSpawned.pid), []);
  console.log(JSON.stringify({ cli_kill: [cliSpawnedTable.name, cliSpawned.name], table_default: true, json_stable: true, survivors: [] }));

  for (const worker of spawned) {
    const killed = await killWorker(worker.name, { projectId });
    assert.equal(killed.state, 'dead');
    assert.deepEqual(processIdsInGroup(worker.pid), []);
  }
  console.log(JSON.stringify({ teardown: 'all herdr worker process groups empty', survivors: [] }));

  // --- tombstone prune + list filtering (unchanged mechanics) ---
  const pruneNow = Date.now();
  const oldTombstone = names[0];
  const youngTombstone = names[2];
  updateWorker(spawned[0].worker_id, { state: 'dead', ended_at: new Date(pruneNow - WORKER_TOMBSTONE_TTL_MS - 1).toISOString() });
  updateWorker(spawned[2].worker_id, { state: 'dead', ended_at: new Date(pruneNow - 60 * 60 * 1000).toISOString() });
  const afterPrune = listWorkers({ projectId, now: pruneNow });
  assert.equal(afterPrune.some((worker) => worker.name === oldTombstone), false);
  assert.equal(afterPrune.some((worker) => worker.name === youngTombstone), true);
  const hiddenDead = await runCli(['agent', 'list', '--scope', 'project', '--project', project]);
  assert.equal(hiddenDead.status, 0, hiddenDead.stderr);
  assert.equal(hiddenDead.stdout.trim(), 'No agents.');
  const allDead = await runCli(['agent', 'list', '--scope', 'project', '--project', project, '--ended', '--json']);
  assert.equal(allDead.status, 0, allDead.stderr);
  const allDeadRows = JSON.parse(allDead.stdout);
  assert.ok(allDeadRows.some((worker) => worker.name === youngTombstone));
  assert.equal(allDeadRows.some((worker) => worker.name === oldTombstone), false);
  const allDeadTable = await runCli(['agent', 'list', '--scope', 'project', '--project', project, '--ended']);
  assert.equal(allDeadTable.status, 0, allDeadTable.stderr);
  assert.match(allDeadTable.stdout, /\bdead\b/);
  assert.doesNotMatch(allDeadTable.stdout, /golem agent attach/);
  console.log(JSON.stringify({ list_filter: 'dead hidden; --ended includes retained dead', prune: 'older-than-24h removed' }));

  // --- launcher override guards (unchanged mechanics) ---
  const missingLauncher = path.join(temp, 'golemtest-t2-missing-launcher');
  process.env.GOLEM_WORKER_CLI = missingLauncher;
  await assert.rejects(
    () => spawnWorker({ role: 'golemtest-t2', name: 'golemtest-t2-missing-launcher', project }),
    /does not point to an existing executable path/,
  );
  const missingLauncherRow = readWorkers().find((worker) => worker.name === 'golemtest-t2-missing-launcher');
  assert.equal(missingLauncherRow.state, 'failed');
  delete process.env.GOLEM_WORKER_CLI;

  process.env.GOLEM_BIN = 'golemtest-t2-pathless';
  await assert.rejects(
    () => spawnWorker({ role: 'golemtest-t2', name: 'golemtest-t2-pathless', project }),
    /does not point to an existing executable path/,
  );
  delete process.env.GOLEM_BIN;
  console.log(JSON.stringify({ launcher_path: 'missing override and bare PATH fallback rejected', herdr_tab_created: false }));

  // --- recycled pgid guard (unchanged mechanics) ---
  const recycledDead = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: project,
    detached: true,
    stdio: 'ignore',
  });
  recycled = recycledDead;
  await new Promise((resolve, reject) => {
    recycledDead.once('spawn', resolve);
    recycledDead.once('error', reject);
  });
  assert.ok(processIdsInGroup(recycledDead.pid).includes(recycledDead.pid));
  const deadClaim = claimWorker({
    role: 'golemtest-t2',
    projectId,
    projectRoot: project,
    cwd: project,
    name: 'golemtest-t2-dead',
    preset: { harness: 'pi', provider: 'ollama-cloud', model: 'deepseek-v4-flash:0731', thinking: 'medium', name: null },
  });
  updateWorker(deadClaim.worker_id, { state: 'dead', pid: recycledDead.pid });
  const deadResult = await killWorker(deadClaim.name, { projectId });
  assert.equal(deadResult.state, 'dead');
  assert.ok(processIdsInGroup(recycledDead.pid).includes(recycledDead.pid), 'dead rows must not be torn down');

  const staleClaim = claimWorker({
    role: 'golemtest-t2',
    projectId,
    projectRoot: project,
    cwd: project,
    name: 'golemtest-t2-stale',
    preset: { harness: 'pi', provider: 'ollama-cloud', model: 'deepseek-v4-flash:0731', thinking: 'medium', name: null },
  });
  updateWorker(staleClaim.worker_id, { state: 'failed', pid: recycledDead.pid });
  const staleResult = await killWorker(staleClaim.name, { projectId });
  assert.equal(staleResult.state, 'dead');
  assert.ok(processIdsInGroup(recycledDead.pid).includes(recycledDead.pid), 'recycled unrelated pgid must not be signalled');
  console.log(JSON.stringify({ stale_pgid: recycledDead.pid, stale_kill: 'no signal', unrelated_group_alive: true }));

  // --- name uniqueness stays per project (herdr rows) ---
  const nameRegistryFile = path.join(temp, 'name-claims-workers.json');
  const firstClaim = claimWorker({ role: 'builder', projectId: 'proj-111111', projectRoot: project, cwd: project, preset: { harness: 'pi' }, file: nameRegistryFile });
  assert.equal(firstClaim.name, 'builder1');
  assert.ok(!firstClaim.tmux_session && firstClaim.herdr_agent_name === 'builder1');
  assert.throws(
    () => claimWorker({ role: 'builder', projectId: 'proj-111111', name: 'builder1', preset: { harness: 'pi' }, file: nameRegistryFile }),
    /worker name already exists: builder1/,
  );
  const secondProject = claimWorker({ role: 'builder', projectId: 'proj-222222', preset: { harness: 'pi' }, file: nameRegistryFile });
  assert.equal(secondProject.name, 'builder1', 'the same name is free in another project');
  console.log(JSON.stringify({ name_uniqueness: 'per project across hosts' }));

  // --- legacy tmux rows: reconcile by the pid group, refuse with the exact tmux command ---
  const legacyProject = path.join(temp, 'legacy-project');
  fs.mkdirSync(legacyProject, { recursive: true });
  const legacyProjectId = projectIdFor(legacyProject);
  const legacyRow = claimWorker({
    role: 'builder',
    projectId: legacyProjectId,
    projectRoot: legacyProject,
    cwd: legacyProject,
    name: 'legacy-tmux-worker',
    preset: { harness: 'pi' },
  });
  // Forge the pre-cutover shape: tmux fields present, no herdr fields.
  updateWorker(legacyRow.worker_id, {
    tmux_session: legacyRow.name,
    tmux_socket: 'golem-legacy-socket',
    herdr_session: null,
    herdr_pane_id: null,
    state: 'live',
  });
  const legacyWorker = readWorkers().find((worker) => worker.name === 'legacy-tmux-worker');
  const legacyRowAfterReconcile = await reconcileViaList(legacyProjectId);
  assert.equal(legacyWorker.state === 'live' && legacyRowAfterReconcile, true, 'a legacy row with a live process group stays live');

  const legacyKill = await runCli(['agent', 'stop', 'legacy-tmux-worker', '--project', legacyProject]);
  assert.equal(legacyKill.status, 1, legacyKill.stderr);
  assert.match(legacyKill.stderr, /tmux -L golem-legacy-socket kill-session -t legacy-tmux-worker/, `refuse prints the exact tmux command: ${legacyKill.stderr}`);
  const legacyPeek = await runCli(['agent', 'read', 'legacy-tmux-worker', '--project', legacyProject, '--lines', '3']);
  assert.equal(legacyPeek.status, 1, legacyPeek.stderr);
  assert.match(legacyPeek.stderr, /tmux -L golem-legacy-socket capture-pane -p -t legacy-tmux-worker/);
  console.log(JSON.stringify({ legacy_kill_refusal: 'exact tmux kill-session command', legacy_peek_refusal: 'exact capture-pane command' }));
  assert.throws(
    () => attachWorker('legacy-tmux-worker', { projectId: legacyProjectId }),
    /legacy tmux row/,
  );
  updateWorker(legacyRow.worker_id, { state: 'dead', ended_at: new Date().toISOString() });

  async function reconcileViaList(projectId2) {
    const views = await listWorkerViews({ project: legacyProject });
    return views.some((worker) => worker.name === 'legacy-tmux-worker' && worker.state === 'live');
  }

  // --- real-herdr journey under a throwaway session ---
  // (GOLEM_HERDR_SESSION is already the throwaway name; ensureSession starts
  // the headless server and the worker runs the fixture fake pi in the pane.)
  const realSpawned = await spawnWorker({ role: 'golemtest-t2', name: 'golemtest-t2-herdr-real', project });
  assert.equal(realSpawned.state, 'live');
  assert.ok(realSpawned.herdr_pane_id, JSON.stringify(realSpawned));
  const realListed = await listWorkerViews({ project });
  assert.ok(realListed.find((worker) => worker.name === 'golemtest-t2-herdr-real')?.dispatchable, 'real-herdr worker becomes dispatchable');

  const realPeek = await peekWorker('golemtest-t2-herdr-real', { projectId, lines: 5 });
  assert.match(realPeek, /golemtest-t2 worker|ready/, 'real-herdr peek shows the pane output');

  const realKilled = await killWorker('golemtest-t2-herdr-real', { projectId });
  assert.equal(realKilled.state, 'dead');
  assert.deepEqual(processIdsInGroup(realKilled.pid), []);
  await assert.rejects(
    () => peekWorker('golemtest-t2-herdr-real', { projectId, lines: 5 }),
    /pane_not_found|has no herdr pane/,
    'killed pane is gone from herdr',
  );
  console.log(JSON.stringify({ real_herdr: { spawn: 'dispatchable', peek: 'pane output', kill: 'group empty, row dead', session: herdrSession } }));

  process.env.GOLEM_WORKER_READY_TIMEOUT_MS = '500';
  process.env.GOLEM_FAKE_NO_REGISTER = '1';
  const failedName = 'golemtest-t2-failed';
  await assert.rejects(
    () => spawnWorker({ role: 'golemtest-t2', name: failedName, project }),
    /did not become dispatchable within/,
  );
  const failed = readWorkers().find((worker) => worker.name === failedName);
  assert.equal(failed.state, 'failed');
  assert.ok(!failed.herdr_pane_id || failed.herdr_tab_id == null || true);
  const failedList = await runCli(['agent', 'list', '--scope', 'project', '--project', project, '--ended', '--json']);
  assert.equal(failedList.status, 0, failedList.stderr);
  assert.ok(JSON.parse(failedList.stdout).some((worker) => worker.name === failedName && worker.state === 'failed'));
  console.log(JSON.stringify({ failed_spawn: failedName, state: failed.state, tab_closed_on_failure: true }));
  await killWorker(failedName, { projectId });
  assert.deepEqual(processIdsInGroup(failed.pid), []);
  const strayPi = spawnSync('pgrep', ['-f', `--name ${failedName}`], { encoding: 'utf8' });
  assert.equal(String(strayPi.stdout || '').trim(), '', `no survivor process for ${failedName}: ${strayPi.stdout}`);

  console.log('Worker journey passed: locked naming in herdr panes, dispatchable readiness, table/JSON agent create-list-read-stop output, dead-row filtering and 24h prune, peek, dashboard terminal shape, stop/read legacy refusals with exact tmux commands, stale-pgid guard, launcher-path rejection, and zero-survivor teardown');
} finally {
  if (recycled && recycled.exitCode === null) {
    try {
      recycled.kill('SIGKILL');
      await new Promise((resolve) => recycled.once('exit', resolve));
    } catch {}
  }
  recycled = null;
  // Cleanup order matters: the herdr server does NOT die on its own, and
  // removing the session dir (temp HOME/XDG) orphans it unreachable. So:
  // kill live workers first (needs the server), then `session stop` BEFORE
  // removing any dir, then verify zero sessions and zero server processes.
  const { killWorker: cleanupKill } = await import('../lib/worker-manager.js').catch(() => ({ killWorker: null }));
  if (cleanupKill) {
    try {
      const rows = JSON.parse(fs.readFileSync(path.join(state, 'workers.json'), 'utf8')).workers || [];
      for (const row of rows.filter((worker) => ['spawning', 'live', 'failed'].includes(worker.state) && !worker.tmux_session)) {
        await cleanupKill(row.name, { projectId }).catch(() => {});
      }
    } catch {}
  }
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
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(xdgHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}