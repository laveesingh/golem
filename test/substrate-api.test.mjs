#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(repo, 'dashboard/server/index.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-substrate-test-'));
const state = path.join(temp, 'state');
const tracker = path.join(temp, 'tracker.db');
const port = 7954;
let child;

fs.mkdirSync(state, { recursive: true });
process.env.GOLEM_HOME = state;
process.env.GOLEM_TRACKER_DB = tracker;

function startServer() {
  child = spawn(process.execPath, [server], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      GOLEM_HOME: state,
      GOLEM_TRACKER_DB: tracker,
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Server failed to start');
}

async function request(urlPath, options = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

try {
  startServer();
  await waitForHealth();

  // 1. List Substrate Skills
  const skillsRes = await request('/api/substrate/skills');
  assert.equal(skillsRes.status, 200);
  assert.ok(Array.isArray(skillsRes.body));
  assert.ok(skillsRes.body.length >= 10);
  const leadSkill = skillsRes.body.find((s) => s.slug === 'lead');
  assert.ok(leadSkill, 'lead skill should exist in skills list');
  assert.equal(leadSkill.slug, 'lead');
  assert.ok(leadSkill.word_count > 0);

  // 2. Get Single Skill Detail
  const leadDetail = await request('/api/substrate/skills/lead');
  assert.equal(leadDetail.status, 200);
  assert.equal(leadDetail.body.slug, 'lead');
  assert.ok(leadDetail.body.body.includes('Lead'));
  assert.ok(leadDetail.body.raw.startsWith('---'));

  // 3. Create, Update, and Delete a Temporary Substrate Skill
  const testSlug = `test-temp-skill-${Date.now()}`;
  const created = await request('/api/substrate/skills', {
    method: 'POST',
    body: JSON.stringify({
      slug: testSlug,
      name: 'Test Temporary Skill',
      description: 'Used for automated test verification',
      body: '## When to Use\nTesting only.\n\n## Procedure\n1. Run tests.\n',
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.slug, testSlug);
  assert.equal(created.body.name, 'Test Temporary Skill');

  // Verify it exists in filesystem
  const createdFilePath = path.join(repo, 'substrate', 'skills', testSlug, 'SKILL.md');
  assert.ok(fs.existsSync(createdFilePath));

  // Update the skill
  const updated = await request(`/api/substrate/skills/${testSlug}`, {
    method: 'PUT',
    body: JSON.stringify({
      raw: '---\nname: Updated Temp Skill\ndescription: Updated description\n---\n\n# Updated Body\nContent here.\n',
    }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'Updated Temp Skill');

  // Delete the skill
  const deleted = await request(`/api/substrate/skills/${testSlug}`, {
    method: 'DELETE',
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.ok, true);
  assert.equal(fs.existsSync(createdFilePath), false, 'skill file should be removed after deletion');

  // 4. Instructions (AGENTS.md)
  const instrRes = await request('/api/substrate/instructions');
  assert.equal(instrRes.status, 200);
  assert.equal(instrRes.body.path, 'instructions/AGENTS.md');
  assert.ok(instrRes.body.raw.length > 0);

  // 5. Roles
  const rolesRes = await request('/api/substrate/roles');
  assert.equal(rolesRes.status, 200);
  assert.ok(Array.isArray(rolesRes.body));
  assert.ok(rolesRes.body.some((r) => r.role === 'lead' && r.builtin === true));
  assert.ok(rolesRes.body.some((r) => r.role === 'builder' && r.builtin === true));

  // 6. Substrate Status & Sync
  const statusRes = await request('/api/substrate/status');
  assert.equal(statusRes.status, 200);
  assert.ok(statusRes.body.global);

  console.log('✅ Substrate API tests passed cleanly!');
} finally {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
