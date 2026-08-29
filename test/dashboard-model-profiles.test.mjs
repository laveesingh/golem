#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(repo, 'dashboard/server/index.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-dashboard-profiles-'));
const bin = path.join(temp, 'bin');
const state = path.join(temp, 'state');
const projects = path.join(temp, 'projects');
const ideas = path.join(temp, 'ideas');
const tracker = path.join(temp, 'tracker.db');
const port = 7634;
const originalPath = process.env.PATH || '';
let child;

fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, 'pi'), `#!${process.execPath}
const fs = require('node:fs');
const modeFile = process.env.GOLEM_FAKE_PI_MODE;
if (process.argv[2] === '--list-models') {
  if (fs.existsSync(modeFile) && fs.readFileSync(modeFile, 'utf8').trim() === 'fail') {
    process.stderr.write('catalog unavailable\\n');
    process.exit(17);
  }
  process.stdout.write('provider      model                     context  max-out  thinking  images\\n');
  process.stdout.write('xai           grok-4.6                  500K     500K     yes       yes\\n');
  process.stdout.write('omlx          Qwen3.8-27B-4bit          131.1K   8.2K     yes       yes\\n');
  process.exit(0);
}
if (process.argv[2] === '--version') process.stdout.write('0.84.3\\n');
`, { mode: 0o700 });
const modeFile = path.join(temp, 'pi-mode');

function start() {
  child = spawn(process.execPath, [server], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${originalPath}`,
      PORT: String(port),
      HOST: '127.0.0.1',
      GOLEM_HOME: state,
      GOLEM_TRACKER_DB: tracker,
      GOLEM_PROJECTS_ROOT: projects,
      GOLEM_IDEAS_ROOT: ideas,
      GOLEM_FAKE_PI_MODE: modeFile,
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (/fatal|EADDRINUSE/i.test(text)) process.stderr.write(text);
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('dashboard did not become healthy');
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body };
}

try {
  start();
  await waitForHealth();

  const initialProfiles = await request('/api/model-profiles');
  assert.equal(initialProfiles.status, 200);
  assert.equal(initialProfiles.body.seeded_from_roles, true);
  assert.ok(initialProfiles.body.profiles.length >= 1);

  const catalog = await request('/api/model-catalog');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.providers, ['xai', 'omlx']);
  assert.deepEqual(catalog.body.modelsByProvider.xai, ['grok-4.6']);
  assert.equal(catalog.body.source, 'pi');

  const created = await request('/api/model-profiles', {
    method: 'POST',
    body: JSON.stringify({ name: 'route-profile', provider: 'xai', model: 'grok-4.6', thinking: 'high' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'route-profile');

  const assigned = await request('/api/roles/reviewer', {
    method: 'PATCH',
    body: JSON.stringify({ default_profile: 'route-profile' }),
  });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.default_profile, 'route-profile');
  const roles = await request('/api/roles');
  assert.equal(roles.body.find((role) => role.name === 'reviewer').default_profile, 'route-profile');

  const blocked = await request('/api/model-profiles/route-profile', { method: 'DELETE' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /default model profile/);

  const cleared = await request('/api/roles/reviewer', {
    method: 'PATCH',
    body: JSON.stringify({ default_profile: null }),
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.default_profile, null);
  const deleted = await request('/api/model-profiles/route-profile', { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, 'route-profile');

  fs.writeFileSync(modeFile, 'fail\n');
  const stale = await request('/api/model-catalog/refresh', { method: 'POST', body: '{}' });
  assert.equal(stale.status, 200);
  assert.deepEqual(stale.body.providers, ['xai', 'omlx']);
  assert.equal(stale.body.source, 'cache');
  assert.equal(stale.body.stale, true);
  assert.match(stale.body.error, /catalog unavailable/);

  console.log('Dashboard model profiles journey passed: catalog parse/cache, profile CRUD, role default persistence, and delete guard');
} finally {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
