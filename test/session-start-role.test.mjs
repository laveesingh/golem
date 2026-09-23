#!/usr/bin/env node
// GOL-382 R3/R11: the SessionStart hook picks the boot role card from the
// session registry, then GOLEM_ROLE, then roles.default in config.json. No role
// name is hard-coded in the hook. Plumbing only: the check compares the
// injected text against the card files, whatever they say.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(repo, 'substrate', 'hooks', 'tracker-context.sh');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-session-start-'));
const home = path.join(temp, 'state');
const project = path.join(temp, 'project');
fs.mkdirSync(path.join(project, '.git'), { recursive: true });
fs.mkdirSync(path.join(home, 'roles'), { recursive: true });

// Distinct overlay cards so each assertion names exactly one role.
const roles = ['lead', 'reviewer', 'orchestrator-x'];
for (const role of roles) fs.writeFileSync(path.join(home, 'roles', `${role}.md`), `# card-marker-${role}\n`);

function boot({ sessionId = 'sess-1', env = {}, event = 'SessionStart' } = {}) {
  const result = spawnSync('bash', [hook], {
    cwd: project,
    input: JSON.stringify({ session_id: sessionId, cwd: project, hook_event_name: event }),
    env: { ...process.env, GOLEM_HOME: home, HOME: path.join(temp, 'home'), CLAUDE_CODE_SESSION_ID: '', GOLEM_ROLE: '', ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout)?.hookSpecificOutput?.additionalContext ?? '';
  return roles.filter((role) => context.includes(`card-marker-${role}`));
}

function writeConfig(value) {
  const file = path.join(home, 'config.json');
  if (value === undefined) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, JSON.stringify(value));
}

function writeSessions(rows) {
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ version: 1, sessions: rows }));
}

try {
  writeSessions([]);

  writeConfig(undefined);
  assert.deepEqual(boot(), ['lead'], 'no config file: an unassigned session boots as lead');

  writeConfig({ dispatch: {} });
  assert.deepEqual(boot(), ['lead'], 'config without roles.default: lead');

  writeConfig({ roles: { default: 'reviewer' } });
  assert.deepEqual(boot(), ['reviewer'], 'roles.default picks the card');

  writeConfig({ roles: { default: null } });
  assert.deepEqual(boot(), [], 'roles.default null: no card');

  writeConfig({ roles: { default: '../../etc/passwd' } });
  assert.deepEqual(boot(), [], 'a path-shaped default is refused');

  writeConfig({ roles: { default: 'reviewer' } });
  assert.deepEqual(boot({ event: 'Other' }), [], 'the default applies only to a SessionStart payload');

  assert.deepEqual(boot({ env: { GOLEM_ROLE: 'orchestrator-x' } }), ['orchestrator-x'], 'GOLEM_ROLE from a launcher beats the default');

  writeSessions([{ session_id: 'sess-1', role: 'lead' }]);
  assert.deepEqual(boot({ env: { GOLEM_ROLE: 'orchestrator-x' } }), ['lead'], 'a stored session role beats GOLEM_ROLE');

  console.log('session-start role test passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
