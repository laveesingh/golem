#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectIdFor } from '../lib/project-id.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'cli/golem.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-t3-'));
const bin = path.join(temp, 'bin');
const project = path.join(temp, 'project');
const state = path.join(temp, 'state');
const captureDir = path.join(temp, 'pi-captures');
const registrationDir = path.join(temp, 'registrations');
const render = path.join(state, 'renders', 'pi', 'golem.ts');
const herdrSession = `golem-test-${process.pid}-profiles`;
// Short xdg root for the herdr socket, OUTSIDE temp so removing temp never
// deletes the socket mid-run; removed only after the session is stopped.
const xdgHome = `/tmp/golem-test-xdg-${process.pid}-profiles`;
const projectId = projectIdFor(project);
const originalEnv = {};
const envKeys = [
  'GOLEM_HOME', 'HOME', 'PATH', 'GOLEM_DASHBOARD_URL', 'GOLEM_HERDR_SESSION',
  'GOLEM_TEST_REGISTRATION_DIR', 'GOLEM_TEST_PROJECT_ID', 'GOLEM_TEST_PI_CAPTURE_DIR',
  'GOLEM_WORKER_READY_TIMEOUT_MS', 'GOLEM_WORKER_POLL_MS', 'GOLEM_WORKER_REQUEST_TIMEOUT_MS',
  'GOLEM_WORKER_CLI', 'GOLEM_BIN', 'XDG_CONFIG_HOME',
];
for (const key of envKeys) originalEnv[key] = process.env[key];

fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.join(temp, 'home'), { recursive: true });
fs.mkdirSync(captureDir, { recursive: true });
fs.mkdirSync(registrationDir, { recursive: true });
fs.mkdirSync(path.dirname(render), { recursive: true });
fs.writeFileSync(render, '// test bridge placeholder\n');

// One fake pi covers both journeys: bare `golem pi` runs (no --name: capture
// argv and exit) and worker launches (--name: register readiness, capture the
// RESOLVED argv golem pi passed, then stay alive until killed).
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
fs.mkdirSync(process.env.GOLEM_TEST_PI_CAPTURE_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.GOLEM_TEST_PI_CAPTURE_DIR, (name || 'bare') + '.json'), JSON.stringify(args, null, 2));
if (!name) process.exit(0);
if (process.env.GOLEM_FAKE_NO_REGISTER !== '1') {
  fs.writeFileSync(path.join(process.env.GOLEM_TEST_REGISTRATION_DIR, name + '.json'), JSON.stringify({
    session_id: 'golemtest-t3-session-' + name,
    name,
    role: null,
    harness: 'pi',
    launch_nonce: process.env.GOLEM_PI_LAUNCH_NONCE,
    project_id: process.env.GOLEM_TEST_PROJECT_ID,
    status: 'idle',
  }));
}
process.stdout.write('[golemtest-t3 worker ' + name + '] ready\\n');
for (const signal of ['SIGTERM', 'SIGHUP']) process.once(signal, () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o700 });

// GOL-382 R11: a fake claude for the Claude spawn journey. `golem claude`
// runs it inside the herdr pane; it captures argv plus the launch env and
// registers the session id golem chose through --session-id.
fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const name = flag('--name');
const sessionId = flag('--session-id');
if (!name || !sessionId) process.exit(0);
fs.mkdirSync(process.env.GOLEM_TEST_PI_CAPTURE_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.GOLEM_TEST_PI_CAPTURE_DIR, 'claude-' + name + '.json'), JSON.stringify({
  args, role: process.env.GOLEM_ROLE || null, ceo: process.env.GOLEM_CEO_SESSION_ID || null,
}, null, 2));
fs.writeFileSync(path.join(process.env.GOLEM_TEST_REGISTRATION_DIR, 'claude-' + name + '.json'), JSON.stringify({
  session_id: sessionId,
  name,
  role: null,
  harness: 'claudecode',
  project_id: process.env.GOLEM_TEST_PROJECT_ID,
  status: 'idle',
}));
for (const signal of ['SIGTERM', 'SIGHUP']) process.once(signal, () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o700 });

Object.assign(process.env, {
  GOLEM_HOME: state,
  HOME: path.join(temp, 'home'),
  PATH: `${bin}${path.delimiter}${originalEnv.PATH ?? ''}`,
  GOLEM_DASHBOARD_URL: 'http://127.0.0.1:1',
  GOLEM_HERDR_SESSION: herdrSession,
  GOLEM_TEST_REGISTRATION_DIR: registrationDir,
  GOLEM_TEST_PI_CAPTURE_DIR: captureDir,
  GOLEM_TEST_PROJECT_ID: projectId,
  GOLEM_WORKER_READY_TIMEOUT_MS: '30000',
  GOLEM_WORKER_POLL_MS: '50',
  GOLEM_WORKER_REQUEST_TIMEOUT_MS: '500',
  XDG_CONFIG_HOME: xdgHome,
});
delete process.env.GOLEM_WORKER_CLI;
delete process.env.GOLEM_BIN;

// Version-1 registry without exec: the current reader seeds the builtin execs
// (identical for builder/explorer/reviewer), which the profiles first-load must
// then dedupe into ONE shared profile.
fs.mkdirSync(path.join(state, 'roles'), { recursive: true });
fs.writeFileSync(path.join(state, 'roles', 'index.json'), JSON.stringify({
  version: 1,
  roles: [
    { name: 'lead', color: '#a78bfa', glyph: 'LD', builtin: true },
    { name: 'builder', color: '#4ade80', glyph: 'BU', builtin: true },
    { name: 'explorer', color: '#38bdf8', glyph: 'EX', builtin: true },
    { name: 'reviewer', color: '#f472b6', glyph: 'RV', builtin: true },
  ],
}, null, 2) + '\n');

function readBody(request) {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
  });
}

let server;

function dashboardRows() {
  const rows = [];
  for (const file of fs.readdirSync(registrationDir)) {
    if (!file.endsWith('.json')) continue;
    try { rows.push(JSON.parse(fs.readFileSync(path.join(registrationDir, file), 'utf8'))); } catch {}
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

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd ?? project,
    env: { ...process.env },
    encoding: 'utf8',
  });
}

function runCollecting(args) {
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

function capturedPiArgs(name = 'bare') {
  return JSON.parse(fs.readFileSync(path.join(captureDir, `${name}.json`), 'utf8'));
}

const profilesFile = () => path.join(state, 'profiles.json');

try {
  await startDashboard();
  const { readRoleRegistry, updateRoleExec } = await import('../lib/session-role.js');
  const { resolveRoleExecution, resolveRolePreset } = await import('../lib/role-preset.js');
  const {
    createProfile, deleteProfile, getProfile, getRoleDefault, listProfiles,
    loadProfilesStore, renameProfile, setRoleDefault, updateProfile,
  } = await import('../lib/model-profiles.js');
  const { readWorkers } = await import('../lib/worker-registry.js');
  const { createTeam } = await import('../lib/team-registry.js');
  const { killWorker } = await import('../lib/worker-manager.js');

  // --- 1. First-load seed: dedupe + role_defaults ------------------------
  readRoleRegistry(); // seeds identical builtin execs for builder/explorer/reviewer
  const seeded = loadProfilesStore();
  assert.equal(seeded.version, 1);
  assert.equal(seeded.seeded_from_roles, true);
  assert.equal(seeded.profiles.length, 1, 'three identical builtin execs dedupe to one profile');
  const shared = seeded.profiles[0];
  assert.equal(shared.name, 'deepseek-v4-flash-0731-medium');
  assert.deepEqual(
    { harness: shared.harness, provider: shared.provider, model: shared.model, thinking: shared.thinking },
    { harness: 'pi', provider: 'ollama-cloud', model: 'deepseek-v4-flash:0731', thinking: 'medium' },
  );
  assert.deepEqual(seeded.role_defaults, {
    builder: 'deepseek-v4-flash-0731-medium',
    designer: 'deepseek-v4-flash-0731-medium',
    explorer: 'deepseek-v4-flash-0731-medium',
    reviewer: 'deepseek-v4-flash-0731-medium',
  });
  assert.equal(fs.existsSync(profilesFile()), true, 'seed persists profiles.json');
  assert.equal(getRoleDefault('reviewer'), 'deepseek-v4-flash-0731-medium');

  // exec retained on every builtin role; the exec-loss detector never fired.
  const registry = readRoleRegistry();
  for (const role of ['builder', 'designer', 'explorer', 'reviewer']) {
    assert.equal(Object.hasOwn(registry.find((row) => row.name === role), 'exec'), true, `exec retained on ${role}`);
  }
  console.log(JSON.stringify({ seed: '3 identical execs -> 1 shared profile', role_defaults: 3, exec_retained: true }));

  // --- 2. Idempotency: first-load twice -> same single profile -----------
  fs.rmSync(profilesFile());
  const reseeded = loadProfilesStore();
  assert.equal(reseeded.profiles.length, 1);
  assert.equal(reseeded.profiles[0].name, 'deepseek-v4-flash-0731-medium', 'seed name is deterministic');
  assert.deepEqual(reseeded.role_defaults, seeded.role_defaults);
  const again = loadProfilesStore();
  assert.equal(again.profiles.length, 1, 'in-place second load does not duplicate');
  console.log(JSON.stringify({ idempotent_seed: true, profiles_after_two_first_loads: 1 }));

  // --- 3. Store helpers + referential integrity ---------------------------
  const grok = createProfile({ name: 'grok-4.6-high', provider: 'xai', model: 'grok-4.6', thinking: 'high' });
  assert.deepEqual(getProfile('grok-4.6-high'), grok);
  const luna = createProfile({ name: 'luna-max', provider: 'openai-codex', model: 'gpt-5.6-luna', thinking: 'max' });
  updateProfile('grok-4.6-high', { thinking: 'xhigh' });
  assert.equal(getProfile('grok-4.6-high').thinking, 'xhigh');
  updateProfile('grok-4.6-high', { thinking: 'high' });
  assert.throws(() => createProfile({ name: 'luna-max', provider: 'xai', model: 'grok-4.6', thinking: 'high' }), /profile already exists/);
  assert.throws(() => createProfile({ name: 'bad\nname', provider: 'xai', model: 'grok-4.6', thinking: 'high' }), /profile name must be 1-80 characters/);
  assert.throws(() => createProfile({ name: 'bad-thinking', provider: 'xai', model: 'grok-4.6', thinking: 'turbo' }), /profile thinking must be one of/);
  assert.throws(() => deleteProfile('deepseek-v4-flash-0731-medium'), /default model profile for role\(s\) builder, designer, explorer, reviewer/);
  renameProfile('grok-4.6-high', 'grok-4.6-xhigh');
  assert.equal(getProfile('grok-4.6-high'), null);
  setRoleDefault('reviewer', 'grok-4.6-xhigh'); // rename did not strand reviewer's pointer below
  renameProfile('grok-4.6-xhigh', 'grok-4.6-high');
  assert.equal(getRoleDefault('reviewer'), 'grok-4.6-high', 'rename rewrites role_defaults pointers');
  setRoleDefault('reviewer', null);
  setRoleDefault('reviewer', 'grok-4.6-high');
  assert.throws(() => setRoleDefault('reviewer', 'missing-profile'), /unknown model profile/);
  assert.throws(() => setRoleDefault('no-such-role', 'grok-4.6-high'), /unknown role/);
  console.log(JSON.stringify({ helpers: 'create/update/rename rewrite pointers/delete guarded' }));

  // --- 4. Resolution precedence (D8): --profile > role default > exec -----
  setRoleDefault('reviewer', 'grok-4.6-high');
  // Default profile beats the role's exec (builtin exec is flash/medium).
  assert.deepEqual(resolveRoleExecution('reviewer'), {
    harness: 'pi', provider: 'xai', model: 'grok-4.6', thinking: 'high', name: null,
  });
  // Explicit profile beats the role default.
  assert.deepEqual(resolveRoleExecution('reviewer', { profile: 'luna-max' }), {
    harness: 'pi', provider: 'openai-codex', model: 'gpt-5.6-luna', thinking: 'max', name: null,
  });
  // Raw overrides win per-field over the profile.
  assert.deepEqual(resolveRoleExecution('reviewer', { profile: 'luna-max', model: 'raw-model' }), {
    harness: 'pi', provider: 'openai-codex', model: 'raw-model', thinking: 'max', name: null,
  });
  assert.deepEqual(resolveRolePreset('reviewer', { profile: 'luna-max' }), [
    '--provider', 'openai-codex',
    '--model', 'gpt-5.6-luna',
    '--thinking', 'max',
  ]);
  assert.throws(() => resolveRoleExecution('reviewer', { profile: 'nope' }), /unknown model profile "nope".*luna-max/);
  // A role default alone satisfies resolution even with no exec on the role.
  setRoleDefault('lead', 'luna-max');
  assert.deepEqual(resolveRoleExecution('lead'), {
    harness: 'pi', provider: 'openai-codex', model: 'gpt-5.6-luna', thinking: 'max', name: null,
  });
  setRoleDefault('lead', null);
  assert.throws(() => resolveRoleExecution('lead'), /no execution preset \(no default model profile and no exec\)/);
  // Role exec edited after seeding still flows when the role has no default;
  // when a default exists, the profile wins (D8 — exec is the leftover layer).
  updateRoleExec('builder', { provider: 'zai', model: 'glm-5.3', thinking: 'medium' });
  assert.equal(resolveRoleExecution('builder').model, 'deepseek-v4-flash:0731', 'default profile beats edited exec');
  setRoleDefault('builder', null);
  assert.equal(resolveRoleExecution('builder').model, 'glm-5.3', 'leftover exec used once default cleared');
  console.log(JSON.stringify({ precedence: '--profile > default > exec', raw_overrides_win: true }));

  // --- 5. CLI journeys ----------------------------------------------------
  const profileLaunch = run(['pi', '--role', 'reviewer', '--profile', 'luna-max']);
  assert.equal(profileLaunch.status, 0, profileLaunch.stderr);
  assert.deepEqual(capturedPiArgs().slice(2), [
    '--provider', 'openai-codex',
    '--model', 'gpt-5.6-luna',
    '--thinking', 'max',
  ]);

  const rawWins = run(['pi', '--role', 'reviewer', '--profile', 'luna-max', '--model', 'raw-model']);
  assert.equal(rawWins.status, 0, rawWins.stderr);
  assert.deepEqual(capturedPiArgs().slice(2), [
    '--provider', 'openai-codex',
    '--model', 'raw-model',
    '--thinking', 'max',
  ], 'raw --model beats the profile');

  const defaultLaunch = run(['pi', '--role', 'reviewer']);
  assert.equal(defaultLaunch.status, 0, defaultLaunch.stderr);
  assert.deepEqual(capturedPiArgs().slice(2), [
    '--provider', 'xai',
    '--model', 'grok-4.6',
    '--thinking', 'high',
  ], 'role default profile resolves without --profile');

  const bareProfile = run(['pi', '--profile', 'grok-4.6-high']);
  assert.equal(bareProfile.status, 0, bareProfile.stderr);
  assert.deepEqual(capturedPiArgs().slice(2), [
    '--provider', 'xai',
    '--model', 'grok-4.6',
    '--thinking', 'high',
  ], 'bare golem pi decomposes a profile into provider/model/thinking');

  const unknownProfile = run(['pi', '--role', 'reviewer', '--profile', 'nope']);
  assert.equal(unknownProfile.status, 2);
  assert.match(unknownProfile.stderr, /unknown model profile "nope"/);
  assert.match(unknownProfile.stderr, /luna-max/);
  assert.doesNotMatch(unknownProfile.stderr, /at file:/);
  assert.equal(updateProfile('grok-4.6-high', { name: 'Review profile' }).name, 'Review profile');
  assert.equal(getProfile('Review profile').name, 'Review profile');
  assert.equal(getRoleDefault('reviewer'), 'Review profile', 'updateProfile name rewrites role pointers');
  updateProfile('Review profile', { name: 'grok-4.6-high' });
  console.log(JSON.stringify({ cli_pi: 'profile / raw-wins / default / bare / unknown', profile_names_allow_spaces: true }));

  // --- 6. Spawn journeys: preset honesty + forwarded --profile -----------
  // NOTE: pass the explicit project path (not '.') — projectFromInput resolves
  // '.' through the real /private cwd, which hashes differently from the
  // /var symlink form the test computes projectIdFor() from.
  // GOL-371: spawns join a team. Seed the row directly (no herdr workspace —
  // this suite exercises the herdr host, not the team workspace).
  createTeam({ label: 'Model Team', projectId, herdrSession });
  const spawnedDefault = await runCollecting(['agent', 'create', 'reviewer', '--name', 'golemtest-t3-default', '--team', 'model-team', '--project', project]);
  assert.equal(spawnedDefault.status, 0, spawnedDefault.stderr);
  const spawnedOverride = await runCollecting(['agent', 'create', 'reviewer', '--profile', 'luna-max', '--name', 'golemtest-t3-override', '--team', 'model-team', '--project', project]);
  assert.equal(spawnedOverride.status, 0, spawnedOverride.stderr);

  const defaultRow = readWorkers().find((worker) => worker.name === 'golemtest-t3-default');
  const overrideRow = readWorkers().find((worker) => worker.name === 'golemtest-t3-override');
  assert.equal(defaultRow.state, 'live');
  assert.equal(overrideRow.state, 'live');
  assert.equal(defaultRow.preset.model, 'grok-4.6', 'worker preset records the role default resolution');
  assert.equal(overrideRow.preset.model, 'gpt-5.6-luna', 'worker preset records the RESOLVED override, not the role default');
  assert.equal(overrideRow.preset.thinking, 'max');

  // The child `golem pi` inside the herdr pane: default worker resolves without flags;
  // override worker receives --profile and emits the resolved exec itself.
  // (--role is consumed by the child golem wrapper — pi only sees the resolved
  // preset + --name.)
  const childDefault = capturedPiArgs('golemtest-t3-default');
  assert.ok(childDefault.includes('--name'));
  assert.equal(childDefault.includes('--role'), false, 'child consumes --role itself');
  assert.equal(childDefault.includes('--profile'), false);
  assert.deepEqual(childDefault.slice(childDefault.indexOf('--provider'), childDefault.indexOf('--provider') + 6), [
    '--provider', 'xai', '--model', 'grok-4.6', '--thinking', 'high',
  ]);
  const childOverride = capturedPiArgs('golemtest-t3-override');
  // --profile is consumed by the child `golem pi` wrapper; the proof it was
  // forwarded (and resolved) is the emitted exec: the role default is grok, so
  // luna values in the pi argv can only come from the forwarded --profile.
  assert.equal(childOverride.includes('--profile'), false, 'child consumes --profile itself');
  assert.deepEqual(childOverride.slice(childOverride.indexOf('--provider'), childOverride.indexOf('--provider') + 6), [
    '--provider', 'openai-codex', '--model', 'gpt-5.6-luna', '--thinking', 'max',
  ]);

  const listOutput = await runCollecting(['agent', 'list', '--scope', 'project', '--project', project]);
  assert.equal(listOutput.status, 0, listOutput.stderr);
  assert.match(listOutput.stdout, /golemtest-t3-default/);
  assert.match(listOutput.stdout, /grok-4\.6/);
  assert.match(listOutput.stdout, /gpt-5\.6-luna/, 'agent list shows the resolved override model');
  // An external session on the stub roster (no worker record) appears with
  // host external through the real roster path.
  fs.writeFileSync(path.join(registrationDir, 'external-lead.json'), JSON.stringify({
    session_id: 'golemtest-t3-external',
    name: 'external-lead',
    role: 'lead',
    harness: 'pi',
    project_id: process.env.GOLEM_TEST_PROJECT_ID,
    status: 'idle',
  }));
  const listJson = await runCollecting(['agent', 'list', '--scope', 'project', '--project', project, '--json']);
  assert.equal(listJson.status, 0, listJson.stderr);
  const listRows = JSON.parse(listJson.stdout);
  const externalRow = listRows.find((row) => row.session_id === 'golemtest-t3-external');
  assert.ok(externalRow, 'external roster session is listed');
  assert.equal(externalRow.host, 'external');
  assert.equal(externalRow.team, null);
  console.log(JSON.stringify({ spawn: 'default + override workers live', list_shows: ['grok-4.6', 'gpt-5.6-luna'] }));

  // --- 7. Claude profiles and a Claude spawn (GOL-382 R11) --------------
  assert.throws(() => createProfile({ name: 'claude-no-model', harness: 'claude' }), /model is required/);
  assert.throws(() => createProfile({ name: 'claude-bad-effort', harness: 'claude', model: 'claude-x', thinking: 'off' }), /thinking must be one of low/);
  const claudeProfile = createProfile({ name: 'claude-test', harness: 'claude', model: 'claude-test-model', thinking: 'high' });
  assert.equal(claudeProfile.harness, 'claude');
  assert.equal(claudeProfile.provider, null, 'a claude profile carries no provider');
  assert.equal(resolveRoleExecution('reviewer', { profile: 'claude-test' }).harness, 'claude', 'a claude profile resolves to the claude harness');
  const piWithClaude = await runCollecting(['pi', '--role', 'reviewer', '--profile', 'claude-test']);
  assert.equal(piWithClaude.status, 2, 'golem pi refuses a claude profile');
  assert.match(piWithClaude.stderr, /runs on claude, not pi/);

  const spawnedClaude = await runCollecting(['agent', 'create', 'reviewer', '--profile', 'claude-test', '--name', 'golemtest-t3-claude', '--team', 'model-team', '--project', project]);
  assert.equal(spawnedClaude.status, 0, spawnedClaude.stderr);
  const claudeRow = readWorkers().find((worker) => worker.name === 'golemtest-t3-claude');
  assert.equal(claudeRow.state, 'live');
  assert.equal(claudeRow.preset.harness, 'claude');
  const claudeLaunch = JSON.parse(fs.readFileSync(path.join(captureDir, 'claude-golemtest-t3-claude.json'), 'utf8'));
  const launchFlag = (flag) => claudeLaunch.args[claudeLaunch.args.indexOf(flag) + 1];
  assert.equal(claudeRow.session_id, launchFlag('--session-id'), 'the row binds exactly the session id golem chose');
  assert.equal(claudeLaunch.ceo, claudeRow.session_id, 'GOLEM_CEO_SESSION_ID carries the same id for the channel');
  assert.equal(claudeLaunch.role, 'reviewer', 'GOLEM_ROLE reaches the pane for the boot card');
  assert.equal(launchFlag('--model'), 'claude-test-model');
  assert.equal(launchFlag('--effort'), 'high');
  assert.ok(claudeLaunch.args.includes('--dangerously-load-development-channels'), 'the golem claude wrapper loads the channel');

  for (const row of [defaultRow, overrideRow, claudeRow]) {
    const killed = await killWorker(row.name, { projectId: row.project_id });
    assert.equal(killed.state, 'dead');
  }
  assert.equal(fs.existsSync(path.join(captureDir, 'claude-golemtest-t3-claude.json')), true);
  console.log(JSON.stringify({ teardown: 'pi and claude workers killed' }));

  console.log('Model profiles journey passed: deduped seed, idempotent first-load, precedence --profile > default > exec, raw overrides win, spawn preset honesty, forwarded --profile, claude profiles and exact claude spawn');
} finally {
  // Best-effort kill of leaked workers first (needs the server), then stop
  // the throwaway session BEFORE removing any dir — the server does not die
  // on its own and dir removal would orphan it unreachable.
  try {
    const { readWorkers: readRows } = await import('../lib/worker-registry.js');
    const { killWorker: killRow } = await import('../lib/worker-manager.js');
    for (const row of readRows().filter((worker) => ['spawning', 'live', 'failed'].includes(worker.state) && !worker.tmux_session)) {
      await killRow(row.name, { projectId: row.project_id }).catch(() => {});
    }
  } catch {}
  const { sessionStop, sessionDelete, sessionList } = await import('../lib/herdr-driver.js');
  const throwaway = process.env.GOLEM_HERDR_SESSION;
  if (throwaway && throwaway.startsWith('golem-test-')) {
    try { sessionStop(throwaway); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try { sessionDelete(throwaway); } catch {}
    const remaining = sessionList().filter((row) => String(row?.name ?? row ?? '') === throwaway);
    assert.equal(remaining.length, 0, `throwaway herdr session is gone: ${JSON.stringify(remaining)}`);
    const pgrep = spawnSync('pgrep', ['-f', `herdr --session ${throwaway}`], { encoding: 'utf8' });
    assert.equal(String(pgrep.stdout || '').trim(), '', `no throwaway herdr server process remains: ${pgrep.stdout}`);
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
  fs.rmSync(xdgHome, { recursive: true, force: true });
}
