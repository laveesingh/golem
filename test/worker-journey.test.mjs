#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectIdFor } from '../lib/project-id.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'cli/golem.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-t2-'));
const bin = path.join(temp, 'bin');
const project = path.join(temp, 'project');
const state = path.join(temp, 'state');
const registrationDir = path.join(temp, 'registrations');
const lockState = path.join(temp, 'lock-state');
const socket = `golemtest-t2-${process.pid}`;
const projectId = projectIdFor(project);
const originalEnv = {};
const envKeys = [
  'GOLEM_HOME', 'HOME', 'PATH', 'GOLEM_DASHBOARD_URL', 'GOLEM_TMUX_SOCKET',
  'GOLEM_TEST_REGISTRATION_DIR', 'GOLEM_TEST_PROJECT_ID', 'GOLEM_WORKER_READY_TIMEOUT_MS',
  'GOLEM_WORKER_POLL_MS', 'GOLEM_WORKER_REQUEST_TIMEOUT_MS', 'GOLEM_TMUX_BIN',
  'GOLEM_TMUX_CAPTURE', 'GOLEM_FAKE_NO_REGISTER', 'GOLEM_WORKER_CLI', 'GOLEM_BIN',
  'XDG_CONFIG_HOME',
];
for (const key of envKeys) originalEnv[key] = process.env[key];

fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(registrationDir, { recursive: true });
fs.mkdirSync(lockState, { recursive: true });
fs.mkdirSync(path.join(state, 'renders', 'pi'), { recursive: true });
fs.writeFileSync(path.join(state, 'renders', 'pi', 'golem.ts'), '// test bridge placeholder\n');

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
  GOLEM_TMUX_SOCKET: socket,
  GOLEM_TEST_REGISTRATION_DIR: registrationDir,
  GOLEM_TEST_PROJECT_ID: projectId,
  GOLEM_WORKER_READY_TIMEOUT_MS: '1200',
  GOLEM_WORKER_POLL_MS: '50',
  GOLEM_WORKER_REQUEST_TIMEOUT_MS: '500',
  XDG_CONFIG_HOME: path.join(temp, 'xdg'),
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
      response.end(JSON.stringify(dashboardRows().filter((row) => !wanted || row.project_id === wanted)));
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
console.log(row.name);`;
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
    attachSwarm,
    enrichDispatchableRows,
    killWorker,
    listWorkerViews,
    peekWorker,
    peekSessionTerminal,
    sendWorkerKeys,
    spawnWorker,
  } = await import('../lib/worker-manager.js');
  const {
    hasSession,
    killSession,
    processIdsInGroup,
  } = await import('../lib/tmux-driver.js');

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
  const claimedNames = claimed.map((result) => result.stdout);
  assert.equal(new Set(claimedNames).size, 5, JSON.stringify(claimedNames));
  assert.deepEqual(readWorkers({ file: path.join(lockState, 'workers.json') }).map((row) => row.name).sort(), claimedNames.slice().sort());
  console.log(JSON.stringify({ lock_claims: claimedNames.sort() }));

  const cliSpawnTable = await runCli(['spawn', 'golemtest-t2', '--name', 'golemtest-t2-cli-table', '--project', project]);
  assert.equal(cliSpawnTable.status, 0, cliSpawnTable.stderr);
  assert.match(cliSpawnTable.stdout, /^NAME\s+PROJECT\s+ROLE\s+STATE\s+MODEL\s+STATUS\s+IDLE\s+ATTACH HINT/m);
  assert.match(cliSpawnTable.stdout, /golemtest-t2-cli-table/);
  const cliSpawnedTable = readWorkers().find((worker) => worker.name === 'golemtest-t2-cli-table');
  assert.equal(cliSpawnedTable.state, 'live');
  const cliSpawnJson = await runCli(['spawn', 'golemtest-t2', '--name', 'golemtest-t2-cli-json', '--project', project, '--json']);
  assert.equal(cliSpawnJson.status, 0, cliSpawnJson.stderr);
  const cliSpawned = JSON.parse(cliSpawnJson.stdout);
  assert.equal(JSON.stringify(cliSpawned, null, 2) + '\n', cliSpawnJson.stdout);
  assert.equal(cliSpawned.state, 'live');
  assert.equal(cliSpawned.name, 'golemtest-t2-cli-json');

  const spawned = await Promise.all(Array.from({ length: 5 }, () => spawnWorker({ role: 'golemtest-t2', project })));
  const names = spawned.map((worker) => worker.name);
  const tmuxNames = spawned.map((worker) => worker.tmux_session);
  assert.equal(new Set(names).size, 5, JSON.stringify(names));
  assert.equal(new Set(tmuxNames).size, 5, JSON.stringify(tmuxNames));
  assert.ok(spawned.every((worker) => worker.state === 'live' && worker.dispatchable));
  const enriched = enrichDispatchableRows([{ session_id: spawned[0].session_id, project_id: projectId }], { projectId });
  assert.equal(enriched[0].worker_tmux_session, spawned[0].tmux_session);
  assert.equal(enriched[0].worker_state, 'live');
  assert.equal(enriched[0].worker_attach_hint, `golem attach ${spawned[0].name}`);
  console.log(JSON.stringify({ parallel_workers: names.slice().sort(), tmux_sessions: tmuxNames.slice().sort(), dispatchable_worker_fields: true }));

  const directListed = await listWorkerViews({ project });
  assert.ok(directListed.every((worker) => worker.dispatchable));
  const cliList = await runCli(['list', '--project', project]);
  assert.equal(cliList.status, 0, cliList.stderr);
  assert.match(cliList.stdout, /^NAME\s+PROJECT\s+ROLE\s+STATE\s+MODEL\s+STATUS\s+IDLE\s+ATTACH HINT/m);
  assert.match(cliList.stdout, /golemtest-t2-cli-table/);
  assert.doesNotMatch(cliList.stdout, /^\[/, 'table output is the default');
  const cliListJson = await runCli(['list', '--project', project, '--json']);
  assert.equal(cliListJson.status, 0, cliListJson.stderr);
  const listed = JSON.parse(cliListJson.stdout);
  assert.equal(JSON.stringify(listed, null, 2) + '\n', cliListJson.stdout);
  assert.equal(listed.length, 7);
  assert.ok(listed.every((worker) => worker.dispatchable && worker.model === 'deepseek-v4-flash:0731'));
  console.log(JSON.stringify({ cli_list_count: listed.length, table_default: true, json_stable: true, statuses: listed.map((worker) => worker.status).sort() }));

  const cliPeek = await runCli(['peek', names[0], '--project', project, '--lines', '3']);
  assert.equal(cliPeek.status, 0, cliPeek.stderr);
  assert.match(cliPeek.stdout, /golemtest-t2 worker/);
  assert.equal(hasSession(names[0]), true);
  console.log(JSON.stringify({ peek_name: names[0], peek_contains_ready: true }));

  const terminalPeek = await peekSessionTerminal(spawned[0].session_id, { lines: 3, projectId });
  assert.equal(terminalPeek.ok, true);
  assert.match(terminalPeek.text, /golemtest-t2 worker/);
  assert.equal(terminalPeek.name, spawned[0].name);

  const cliKillTable = await runCli(['kill', cliSpawnedTable.name, '--project', project]);
  assert.equal(cliKillTable.status, 0, cliKillTable.stderr);
  assert.match(cliKillTable.stdout, /^NAME\s+PROJECT\s+ROLE\s+STATE\s+MODEL\s+STATUS\s+IDLE\s+ATTACH HINT/m);
  assert.match(cliKillTable.stdout, /golemtest-t2-cli-table/);
  const killedTable = readWorkers().find((worker) => worker.name === cliSpawnedTable.name);
  assert.equal(killedTable.state, 'dead');
  assert.deepEqual(processIdsInGroup(cliSpawnedTable.pid), []);
  assert.equal(hasSession(cliSpawnedTable.name), false);

  const cliKillJson = await runCli(['kill', cliSpawned.name, '--project', project, '--json']);
  assert.equal(cliKillJson.status, 0, cliKillJson.stderr);
  const killedByCli = JSON.parse(cliKillJson.stdout);
  assert.equal(JSON.stringify(killedByCli, null, 2) + '\n', cliKillJson.stdout);
  assert.equal(killedByCli.state, 'dead');
  assert.deepEqual(processIdsInGroup(cliSpawned.pid), []);
  assert.equal(hasSession(cliSpawned.name), false);
  console.log(JSON.stringify({ cli_kill: [cliSpawnedTable.name, cliSpawned.name], table_default: true, json_stable: true, survivors: [] }));

  for (const worker of spawned) {
    const killed = await killWorker(worker.name, { projectId });
    assert.equal(killed.state, 'dead');
    assert.deepEqual(processIdsInGroup(worker.pid), []);
    assert.equal(hasSession(worker.name), false);
  }
  console.log(JSON.stringify({ teardown: 'all seven worker process groups empty', survivors: [] }));

  const pruneNow = Date.now();
  const oldTombstone = names[0];
  const boundaryTombstone = names[1];
  const youngTombstone = names[2];
  updateWorker(spawned[0].worker_id, {
    state: 'dead',
    ended_at: new Date(pruneNow - WORKER_TOMBSTONE_TTL_MS - 100).toISOString(),
  });
  updateWorker(spawned[1].worker_id, {
    state: 'dead',
    ended_at: new Date(pruneNow - WORKER_TOMBSTONE_TTL_MS).toISOString(),
  });
  updateWorker(spawned[2].worker_id, {
    state: 'dead',
    ended_at: new Date(pruneNow - 60 * 60 * 1000).toISOString(),
  });
  const afterPrune = listWorkers({ projectId, now: pruneNow });
  assert.equal(afterPrune.some((worker) => worker.name === oldTombstone), false);
  assert.equal(afterPrune.some((worker) => worker.name === boundaryTombstone), true);
  assert.equal(afterPrune.some((worker) => worker.name === youngTombstone), true);
  const persistedAfterPrune = JSON.parse(fs.readFileSync(path.join(state, 'workers.json'), 'utf8')).workers;
  assert.equal(persistedAfterPrune.some((worker) => worker.name === oldTombstone), false);
  const hiddenDead = await runCli(['list', '--project', project]);
  assert.equal(hiddenDead.status, 0, hiddenDead.stderr);
  assert.equal(hiddenDead.stdout.trim(), 'No workers.');
  const allDead = await runCli(['list', '--project', project, '--all', '--json']);
  assert.equal(allDead.status, 0, allDead.stderr);
  const allDeadRows = JSON.parse(allDead.stdout);
  assert.ok(allDeadRows.some((worker) => worker.name === youngTombstone));
  assert.equal(allDeadRows.some((worker) => worker.name === oldTombstone), false);
  const allDeadTable = await runCli(['list', '--project', project, '--all']);
  assert.equal(allDeadTable.status, 0, allDeadTable.stderr);
  assert.match(allDeadTable.stdout, /unavailable \(dead\)/);
  assert.doesNotMatch(allDeadTable.stdout, /golem attach/);
  console.log(JSON.stringify({ list_filter: 'dead hidden; --all includes retained dead', prune: 'older-than-24h removed; exact boundary retained', dead_attach_hint: 'marked unavailable' }));

  const missingLauncher = path.join(temp, 'golemtest-t2-missing-launcher');
  process.env.GOLEM_WORKER_CLI = missingLauncher;
  await assert.rejects(
    () => spawnWorker({ role: 'golemtest-t2', name: 'golemtest-t2-missing-launcher', project }),
    /does not point to an existing executable path/,
  );
  const missingLauncherRow = readWorkers().find((worker) => worker.name === 'golemtest-t2-missing-launcher');
  assert.equal(missingLauncherRow.state, 'failed');
  assert.equal(hasSession(missingLauncherRow.name), false);
  delete process.env.GOLEM_WORKER_CLI;

  process.env.GOLEM_BIN = 'golemtest-t2-pathless';
  await assert.rejects(
    () => spawnWorker({ role: 'golemtest-t2', name: 'golemtest-t2-pathless', project }),
    /does not point to an existing executable path/,
  );
  const pathlessLauncherRow = readWorkers().find((worker) => worker.name === 'golemtest-t2-pathless');
  assert.equal(pathlessLauncherRow.state, 'failed');
  assert.equal(hasSession(pathlessLauncherRow.name), false);
  delete process.env.GOLEM_BIN;
  console.log(JSON.stringify({ launcher_path: 'missing override and bare PATH fallback rejected', tmux_session_created: false }));

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
  assert.ok(recycledDead.pid > 0);
  assert.ok(processIdsInGroup(recycledDead.pid).includes(recycledDead.pid));
  const deadClaim = claimWorker({
    role: 'golemtest-t2',
    projectId,
    projectRoot: project,
    cwd: project,
    name: 'golemtest-t2-dead',
    preset: { harness: 'pi', provider: 'ollama-cloud', model: 'deepseek-v4-flash:0731', thinking: 'medium', name: null },
  });
  updateWorker(deadClaim.worker_id, {
    state: 'dead',
    pid: recycledDead.pid,
    session_id: 'golemtest-t2-session-dead',
  });
  const deadKillProbe = path.join(temp, 'golemtest-t2-dead-kill-called');
  const deadTmux = path.join(bin, 'golemtest-t2-dead-tmux');
  fs.writeFileSync(deadTmux, `#!/bin/sh
printf 'called\\n' > ${JSON.stringify(deadKillProbe)}
exit 0
`, { mode: 0o700 });
  process.env.GOLEM_TMUX_BIN = deadTmux;
  const deadResult = await killWorker(deadClaim.name, { projectId });
  assert.equal(deadResult.state, 'dead');
  assert.equal(fs.existsSync(deadKillProbe), false, 'dead rows must not invoke tmux or process teardown');
  assert.ok(processIdsInGroup(recycledDead.pid).includes(recycledDead.pid));
  delete process.env.GOLEM_TMUX_BIN;

  const staleClaim = claimWorker({
    role: 'golemtest-t2',
    projectId,
    projectRoot: project,
    cwd: project,
    name: 'golemtest-t2-stale',
    preset: { harness: 'pi', provider: 'ollama-cloud', model: 'deepseek-v4-flash:0731', thinking: 'medium', name: null },
  });
  updateWorker(staleClaim.worker_id, {
    state: 'failed',
    pid: recycledDead.pid,
    session_id: 'golemtest-t2-session-stale',
  });
  const staleResult = await killWorker(staleClaim.name, { projectId });
  assert.equal(staleResult.state, 'dead');
  assert.ok(processIdsInGroup(recycledDead.pid).includes(recycledDead.pid), 'recycled unrelated pgid must not be signalled');
  console.log(JSON.stringify({ stale_pgid: recycledDead.pid, stale_kill: 'no signal', unrelated_group_alive: true }));
  recycledDead.kill('SIGTERM');
  await new Promise((resolve) => recycledDead.once('exit', resolve));
  recycled = null;

  const missingSocketTmux = path.join(bin, 'golemtest-t2-missing-socket-tmux');
  fs.writeFileSync(missingSocketTmux, `#!/bin/sh
echo 'error connecting to golem socket (No such file or directory)' >&2
exit 1
`, { mode: 0o700 });
  process.env.GOLEM_TMUX_BIN = missingSocketTmux;
  assert.equal(killSession('golemtest-t2-missing-socket'), false);
  delete process.env.GOLEM_TMUX_BIN;
  console.log(JSON.stringify({ missing_socket: 'treated as already stopped' }));

  const fakeTmux = path.join(bin, 'golemtest-t2-tmux');
  const attachCapture = path.join(temp, 'golemtest-t2-attach-argv.txt');
  fs.writeFileSync(fakeTmux, `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(attachCapture)}
exit 0
`, { mode: 0o700 });
  process.env.GOLEM_TMUX_BIN = fakeTmux;
  process.env.GOLEM_TMUX_CAPTURE = attachCapture;
  const cliAttach = await runCli(['attach', cliSpawned.name, '--project', project]);
  assert.equal(cliAttach.status, 0, cliAttach.stderr);
  const attachArgs = fs.readFileSync(attachCapture, 'utf8').trim().split('\n');
  assert.deepEqual(attachArgs.slice(0, 2), ['-L', socket]);
  assert.equal(attachArgs[2], '-f');
  assert.equal(attachArgs[3], path.join(repo, 'lib', 'golem-tmux.conf'));
  assert.deepEqual(attachArgs.slice(-3), ['attach-session', '-t', cliSpawned.name]);
  delete process.env.GOLEM_TMUX_BIN;
  delete process.env.GOLEM_TMUX_CAPTURE;
  console.log(JSON.stringify({ cli_attach: cliSpawned.name, attached_without_mutation: true }));

  // --- per-project sockets: claim-time derivation and collision rules ---
  const socketRegistryFile = path.join(temp, 'socket-claims-workers.json');
  const savedTmuxSocket = process.env.GOLEM_TMUX_SOCKET;
  delete process.env.GOLEM_TMUX_SOCKET;
  const derivedClaim = claimWorker({
    role: 'builder',
    projectId: 'golem-38ab8a',
    projectRoot: project,
    cwd: project,
    preset: { harness: 'pi' },
    file: socketRegistryFile,
  });
  assert.equal(derivedClaim.tmux_socket, 'golem-golem-38ab8a');
  const crossProjectClaim = claimWorker({
    role: 'builder',
    projectId: 'swarm-123456',
    preset: { harness: 'pi' },
    file: socketRegistryFile,
  });
  assert.equal(derivedClaim.name, 'builder1');
  assert.equal(crossProjectClaim.name, 'builder1');
  assert.equal(crossProjectClaim.tmux_socket, 'golem-swarm-123456');
  // Turn the swarm project's builder1 into a legacy row: occupied, no stored socket, on 'golem'.
  updateWorker(crossProjectClaim.worker_id, { tmux_socket: null }, { file: socketRegistryFile });
  // Same project + same name is a collision regardless of socket — an explicit name is rejected…
  assert.throws(
    () => claimWorker({ role: 'builder', projectId: 'swarm-123456', name: 'builder1', preset: { harness: 'pi' }, file: socketRegistryFile }),
    /worker name already exists: builder1/,
  );
  // …and auto-naming skips to the next free index within that project.
  const sameProjectNext = claimWorker({
    role: 'builder',
    projectId: 'swarm-123456',
    preset: { harness: 'pi' },
    file: socketRegistryFile,
  });
  assert.equal(sameProjectNext.name, 'builder2');
  assert.equal(sameProjectNext.tmux_socket, 'golem-swarm-123456');
  // A different project still starts fresh at builder1: per-socket uniqueness applies across projects only.
  const freshProjectClaim = claimWorker({
    role: 'builder',
    projectId: 'pinned-abcdef',
    preset: { harness: 'pi' },
    file: socketRegistryFile,
  });
  assert.equal(freshProjectClaim.name, 'builder1');
  // Pin every row onto one socket and the cross-project per-socket collision returns: another
  // project's reviewer1 on the same pinned socket blocks this project's reviewer1.
  process.env.GOLEM_TMUX_SOCKET = 'golem';
  const pinnedFirst = claimWorker({ role: 'reviewer', projectId: 'pinned-abcdef', preset: { harness: 'pi' }, file: socketRegistryFile });
  assert.equal(pinnedFirst.name, 'reviewer1');
  assert.equal(pinnedFirst.tmux_socket, 'golem');
  const pinnedSecond = claimWorker({ role: 'reviewer', projectId: 'pinned-zzzzzz', preset: { harness: 'pi' }, file: socketRegistryFile });
  assert.equal(pinnedSecond.name, 'reviewer2');
  assert.equal(pinnedSecond.tmux_socket, 'golem');
  process.env.GOLEM_TMUX_SOCKET = savedTmuxSocket;
  console.log(JSON.stringify({
    socket_derivation: 'tmux_socket=golem-<project_id> recorded at claim',
    same_project_guard: 'legacy live row rejects builder1 in its own project and sequences to builder2',
    cross_project_freedom: 'builder1 claimed in two projects; reviewer1 in two projects only while their sockets differ',
    pinned_socket_collision: 'one pinned socket → reviewer2 for the second project',
  }));

  // --- findWorker refuses two active rows sharing name + project ---
  const ambiguityFile = path.join(temp, 'ambiguity-workers.json');
  delete process.env.GOLEM_TMUX_SOCKET;
  const ambiguityA = claimWorker({ role: 'builder', projectId: 'amb-111111', name: 'golemtest-t2-dup', preset: { harness: 'pi' }, file: ambiguityFile });
  const ambiguityB = claimWorker({ role: 'builder', projectId: 'other-222222', name: 'golemtest-t2-dup', preset: { harness: 'pi' }, file: ambiguityFile });
  process.env.GOLEM_TMUX_SOCKET = savedTmuxSocket;
  // Forge the state the claim rules now prevent: same name, same project, both occupied.
  updateWorker(ambiguityB.worker_id, { project_id: 'amb-111111' }, { file: ambiguityFile });
  assert.throws(() => findWorker('golemtest-t2-dup', { projectId: 'amb-111111', file: ambiguityFile }), /ambiguous within one project/);
  assert.throws(() => findWorker('golemtest-t2-dup', { file: ambiguityFile }), /ambiguous/);
  // Tombstoning one row restores normal resolution to the survivor.
  updateWorker(ambiguityB.worker_id, { state: 'dead', ended_at: new Date().toISOString() }, { file: ambiguityFile });
  assert.equal(findWorker('golemtest-t2-dup', { projectId: 'amb-111111', file: ambiguityFile })?.worker_id, ambiguityA.worker_id);
  console.log(JSON.stringify({ find_worker_guard: 'two active rows sharing name+project refused even with --project' }));

  // --- golem attach --project . with no name, empty swarm: derived per-project socket ---
  const emptyProject = path.join(temp, 'empty-project');
  fs.mkdirSync(emptyProject, { recursive: true });
  const swarmCapture = path.join(temp, 'golemtest-t2-swarm-argv.txt');
  const swarmTmux = path.join(bin, 'golemtest-t2-swarm-tmux');
  fs.writeFileSync(swarmTmux, `#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(swarmCapture)}
exit 0
`, { mode: 0o700 });
  process.env.GOLEM_TMUX_BIN = swarmTmux;
  delete process.env.GOLEM_TMUX_SOCKET;
  const cliSwarmAttach = await runCli(['attach', '--project', emptyProject]);
  process.env.GOLEM_TMUX_SOCKET = savedTmuxSocket;
  delete process.env.GOLEM_TMUX_BIN;
  assert.equal(cliSwarmAttach.status, 0, cliSwarmAttach.stderr);
  const swarmArgs = fs.readFileSync(swarmCapture, 'utf8').trim().split('\n');
  assert.deepEqual(swarmArgs.slice(0, 2), ['-L', `golem-${projectIdFor(emptyProject)}`]);
  assert.deepEqual(swarmArgs.slice(-1), ['attach-session']);
  assert.ok(!swarmArgs.includes('-t'), 'swarm attach must not target a single session');
  console.log(JSON.stringify({ swarm_attach_empty: `no occupied rows → attach targeted derived golem-${projectIdFor(emptyProject)} with no -t` }));

  // --- legacy rows without tmux_socket fall back to the shared 'golem' socket ---
  const mixedProject = path.join(temp, 'mixed-project');
  fs.mkdirSync(mixedProject, { recursive: true });
  const mixedProjectId = projectIdFor(mixedProject);
  const legacyClaimRow = claimWorker({
    role: 'builder',
    projectId: mixedProjectId,
    projectRoot: mixedProject,
    cwd: mixedProject,
    name: 'golemtest-t2-legacy-socket',
    preset: { harness: 'pi' },
  });
  updateWorker(legacyClaimRow.worker_id, { tmux_socket: null, state: 'live' });
  const legacyTmuxCapture = path.join(temp, 'golemtest-t2-legacy-argv.txt');
  const legacyTmux = path.join(bin, 'golemtest-t2-legacy-tmux');
  fs.writeFileSync(legacyTmux, `#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(legacyTmuxCapture)}
exit 0
`, { mode: 0o700 });
  process.env.GOLEM_TMUX_BIN = legacyTmux;
  delete process.env.GOLEM_TMUX_SOCKET;
  await peekWorker('golemtest-t2-legacy-socket', { projectId: mixedProjectId, lines: 3 });
  process.env.GOLEM_TMUX_SOCKET = savedTmuxSocket;
  delete process.env.GOLEM_TMUX_BIN;
  const legacyArgs = fs.readFileSync(legacyTmuxCapture, 'utf8').trim().split('\n');
  assert.deepEqual(legacyArgs.slice(0, 2), ['-L', 'golem']);
  assert.ok(legacyArgs.includes('golemtest-t2-legacy-socket'));
  console.log(JSON.stringify({ legacy_row_fallback: 'peek on a row without tmux_socket ran tmux -L golem' }));

  // --- mixed era: the project's occupied rows decide the swarm attach socket ---
  const mixedCapture = path.join(temp, 'golemtest-t2-mixed-argv.txt');
  const mixedTmux = path.join(bin, 'golemtest-t2-mixed-tmux');
  fs.writeFileSync(mixedTmux, `#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(mixedCapture)}
exit 0
`, { mode: 0o700 });
  process.env.GOLEM_TMUX_BIN = mixedTmux;
  delete process.env.GOLEM_TMUX_SOCKET;
  // golemtest-t2-legacy-socket (live, no tmux_socket) is the only occupied row → legacy 'golem'.
  attachSwarm(mixedProjectId);
  const mixedArgs = fs.readFileSync(mixedCapture, 'utf8').trim().split('\n');
  assert.deepEqual(mixedArgs.slice(0, 2), ['-L', 'golem']);
  assert.deepEqual(mixedArgs.slice(-1), ['attach-session']);
  assert.ok(!mixedArgs.includes('-t'), 'swarm attach must not target a single session');
  // A second occupied row on the derived socket must make the choice explicit, not silent.
  const spanClaim = claimWorker({
    role: 'builder',
    projectId: mixedProjectId,
    projectRoot: mixedProject,
    cwd: mixedProject,
    name: 'golemtest-t2-span',
    preset: { harness: 'pi' },
  });
  assert.equal(spanClaim.tmux_socket, `golem-${mixedProjectId}`);
  assert.throws(() => attachSwarm(mixedProjectId), (error) => {
    assert.match(error.message, /span more than one tmux socket/);
    assert.ok(error.message.includes('golem → golemtest-t2-legacy-socket'), error.message);
    assert.ok(error.message.includes(`golem-${mixedProjectId} → golemtest-t2-span`), error.message);
    return true;
  });
  process.env.GOLEM_TMUX_SOCKET = savedTmuxSocket;
  delete process.env.GOLEM_TMUX_BIN;
  updateWorker(legacyClaimRow.worker_id, { state: 'dead', ended_at: new Date().toISOString() });
  updateWorker(spanClaim.worker_id, { state: 'dead', ended_at: new Date().toISOString() });
  console.log(JSON.stringify({
    mixed_era_swarm_attach: 'occupied legacy row pinned swarm attach to the golem socket',
    swarm_span_refusal: 'two occupied sockets rejected with a per-socket worker breakdown',
  }));

  process.env.GOLEM_FAKE_NO_REGISTER = '1';
  process.env.GOLEM_WORKER_READY_TIMEOUT_MS = '250';
  const failedName = 'golemtest-t2-failed';
  await assert.rejects(
    () => spawnWorker({ role: 'golemtest-t2', name: failedName, project }),
    /did not become dispatchable within/,
  );
  const failed = readWorkers().find((worker) => worker.name === failedName);
  assert.equal(failed.state, 'failed');
  assert.equal(hasSession(failedName), true);
  const failedList = await runCli(['list', '--project', project, '--json']);
  assert.equal(failedList.status, 0, failedList.stderr);
  assert.ok(JSON.parse(failedList.stdout).some((worker) => worker.name === failedName && worker.state === 'failed'));
  assert.match(await peekWorker(failedName, { projectId, lines: 3 }), /golemtest-t2 worker/);
  console.log(JSON.stringify({ failed_spawn: failedName, state: failed.state, tmux_left_for_peek: true }));
  await killWorker(failedName, { projectId });
  assert.deepEqual(processIdsInGroup(failed.pid), []);
  assert.equal(hasSession(failedName), false);

  console.log('Worker journey passed: locked naming, detached tmux workers, dispatchable readiness, table/JSON list-spawn-kill output, dead-row filtering and 24h prune, peek, attach argv, per-project sockets with same-project name guard and legacy golem fallback, mixed-era swarm attach with span refusal, stale-pgid guard, missing-socket handling, failed inspection, and zero-survivor teardown');
} finally {
  if (recycled && recycled.exitCode === null) {
    try {
      recycled.kill('SIGKILL');
      await new Promise((resolve) => recycled.once('exit', resolve));
    } catch {}
  }
  recycled = null;
  delete process.env.GOLEM_TMUX_BIN;
  delete process.env.GOLEM_TMUX_CAPTURE;
  const { killWorker: cleanupKill } = await import('../lib/worker-manager.js').catch(() => ({ killWorker: null }));
  if (cleanupKill) {
    try {
      const rows = JSON.parse(fs.readFileSync(path.join(state, 'workers.json'), 'utf8')).workers || [];
      for (const row of rows.filter((worker) => ['spawning', 'live', 'failed'].includes(worker.state))) {
        await cleanupKill(row.name, { projectId }).catch(() => {});
      }
    } catch {}
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
