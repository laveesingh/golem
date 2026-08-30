#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'cli/golem.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-t1-'));
const bin = path.join(temp, 'bin');
const project = path.join(temp, 'project');
const state = path.join(temp, 'state');
const capture = path.join(temp, 'pi-launch.json');
const render = path.join(state, 'renders', 'pi', 'golem.ts');
const originalEnv = {
  GOLEM_HOME: process.env.GOLEM_HOME,
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  GOLEM_PI_CAPTURE: process.env.GOLEM_PI_CAPTURE,
  GOLEM_DASHBOARD_URL: process.env.GOLEM_DASHBOARD_URL,
};

fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.dirname(render), { recursive: true });
fs.writeFileSync(render, '// test bridge placeholder\n');
const fakePi = path.join(bin, 'pi');
fs.writeFileSync(fakePi, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.length === 3 && process.argv[2] === '--version') {
  process.stdout.write('0.84.3\\n');
  process.exit(0);
}
fs.writeFileSync(process.env.GOLEM_PI_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }, null, 2));
process.exit(0);
`, { mode: 0o700 });

Object.assign(process.env, {
  GOLEM_HOME: state,
  HOME: path.join(temp, 'home'),
  PATH: `${bin}${path.delimiter}${originalEnv.PATH ?? ''}`,
  GOLEM_PI_CAPTURE: capture,
  GOLEM_DASHBOARD_URL: 'http://127.0.0.1:1',
});

// A version-1 registry without exec is a legitimate pre-preset installation.
// The current reader must migrate it once, then record provenance for later
// loss detection.
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

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: project,
    env: { ...process.env },
    encoding: 'utf8',
  });
}

function capturedArgs() {
  return JSON.parse(fs.readFileSync(capture, 'utf8')).args;
}

try {
  const {
    createRole,
    readRoleRegistry,
    updateRoleExec,
    updateRoleMeta,
  } = await import('../lib/session-role.js');
  const {
    GLOBAL_ROLE_EXEC_DEFAULTS,
    resolveRoleExecution,
    resolveRolePreset,
    validateRolePreset,
  } = await import('../lib/role-preset.js');

  const seeded = readRoleRegistry();
  for (const role of ['builder', 'explorer', 'reviewer']) {
    assert.deepEqual(seeded.find((row) => row.name === role)?.exec, {
      harness: 'pi',
      provider: 'ollama-cloud',
      model: 'deepseek-v4-flash:0731',
      thinking: 'medium',
      name: null,
    });
  }
  const migratedIndex = JSON.parse(fs.readFileSync(path.join(state, 'roles', 'index.json'), 'utf8'));
  assert.equal(migratedIndex.version, 2);
  assert.deepEqual(migratedIndex.roles.find((row) => row.name === 'explorer').exec, seeded.find((row) => row.name === 'explorer').exec);
  const provenance = JSON.parse(fs.readFileSync(path.join(state, 'roles', 'registry-state.json'), 'utf8'));
  assert.deepEqual(Object.keys(provenance.known_exec).sort(), ['builder', 'explorer', 'reviewer']);
  assert.deepEqual(GLOBAL_ROLE_EXEC_DEFAULTS, { harness: 'pi', provider: 'ollama-cloud' });

  assert.deepEqual(resolveRolePreset('explorer'), [
    '--provider', 'ollama-cloud',
    '--model', 'deepseek-v4-flash:0731',
    '--thinking', 'medium',
  ]);
  assert.deepEqual(resolveRolePreset('explorer', { thinking: 'max' }).slice(-2), ['--thinking', 'max']);

  createRole({
    name: 'preset',
    exec: {
      provider: 'role-provider',
      model: 'role-model',
      thinking: 'low',
      name: 'role-session',
    },
  });
  assert.deepEqual(resolveRoleExecution('preset'), {
    harness: 'pi',
    provider: 'role-provider',
    model: 'role-model',
    thinking: 'low',
    name: 'role-session',
  });
  assert.deepEqual(resolveRoleExecution('preset', {
    provider: 'flag-provider',
    model: 'flag-model',
    thinking: 'max',
    name: 'flag-session',
  }), {
    harness: 'pi',
    provider: 'flag-provider',
    model: 'flag-model',
    thinking: 'max',
    name: 'flag-session',
  });
  updateRoleExec('preset', { thinking: 'high' });
  assert.equal(resolveRoleExecution('preset').thinking, 'high');
  assert.equal(readRoleRegistry().find((row) => row.name === 'preset').exec.thinking, 'high');
  assert.throws(() => updateRoleMeta('builder', { exec: null }), /cannot remove execution preset for builtin role/);
  updateRoleMeta('preset', { exec: null });
  const identityOnlyPreset = readRoleRegistry().find((row) => row.name === 'preset');
  assert.equal(Object.hasOwn(identityOnlyPreset, 'exec'), false, 'non-builtin preset can become identity-only');
  const identityOnlyState = JSON.parse(fs.readFileSync(path.join(state, 'roles', 'registry-state.json'), 'utf8'));
  assert.equal(Object.hasOwn(identityOnlyState.known_exec, 'preset'), false, 'cleared preset is removed from provenance');
  updateRoleExec('preset', { provider: 'role-provider', model: 'role-model', thinking: 'high', name: 'role-session' });
  updateRoleMeta('preset', { glyph: 'PR' });
  assert.equal(readRoleRegistry().find((row) => row.name === 'preset').exec.thinking, 'high');
  assert.throws(() => updateRoleExec('preset', { thinking: 'invalid' }), /thinking must be one of/);
  assert.equal(resolveRoleExecution('preset').thinking, 'high', 'invalid writes do not reach the registry');
  assert.throws(() => updateRoleMeta('preset', { exec: { harness: 'claude' } }), /harness must be/);
  assert.throws(() => createRole({
    name: 'bad-preset',
    exec: { provider: 'p', model: 'm', thinking: 'invalid' },
  }), /thinking must be one of/);

  // Simulate a stale pre-exec writer rewriting the current index. The
  // provenance sidecar must make the next read fail instead of re-seeding the
  // lost builder preset with the builtin default.
  updateRoleExec('builder', { provider: 'openai-codex', model: 'gpt-5.6-luna', thinking: 'max' });
  const roleIndexPath = path.join(state, 'roles', 'index.json');
  const roleStatePath = path.join(state, 'roles', 'registry-state.json');
  const knownGoodIndex = JSON.parse(fs.readFileSync(roleIndexPath, 'utf8'));
  const captureWarnings = (fn) => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      return { value: fn(), warnings };
    } finally {
      console.warn = originalWarn;
    }
  };
  fs.rmSync(roleStatePath);
  const missingStateRecovery = captureWarnings(() => readRoleRegistry());
  assert.equal(missingStateRecovery.value.find((row) => row.name === 'builder').exec.model, 'gpt-5.6-luna');
  assert.ok(missingStateRecovery.warnings.some((line) => /provenance.*missing.*rebuilt from the intact version-2 index/i.test(line)));
  assert.equal(JSON.parse(fs.readFileSync(roleStatePath, 'utf8')).known_exec.builder.model, 'gpt-5.6-luna');

  fs.writeFileSync(roleStatePath, JSON.stringify({ version: 1, broken: true }) + '\n');
  const corruptStateRecovery = captureWarnings(() => readRoleRegistry());
  assert.equal(corruptStateRecovery.value.find((row) => row.name === 'builder').exec.model, 'gpt-5.6-luna');
  assert.ok(corruptStateRecovery.warnings.some((line) => /provenance.*corrupt.*rebuilt from the intact version-2 index/i.test(line)));
  assert.equal(JSON.parse(fs.readFileSync(roleStatePath, 'utf8')).known_exec.builder.model, 'gpt-5.6-luna');

  const wipedIndex = { version: 1, roles: knownGoodIndex.roles.map((row) => {
    const next = { ...row };
    delete next.exec;
    return next;
  }) };
  fs.writeFileSync(roleIndexPath, JSON.stringify(wipedIndex, null, 2) + '\n');
  assert.throws(() => readRoleRegistry(), /role registry lost execution preset.*Recovery: restore/);
  fs.writeFileSync(roleIndexPath, JSON.stringify(knownGoodIndex, null, 2) + '\n');
  assert.equal(readRoleRegistry().find((row) => row.name === 'builder').exec.model, 'gpt-5.6-luna');

  assert.deepEqual(validateRolePreset({ model: 'model-only', thinking: 'medium' }), {
    harness: 'pi',
    provider: 'ollama-cloud',
    model: 'model-only',
    thinking: 'medium',
    name: null,
  });
  assert.throws(() => validateRolePreset({ harness: 'claude', provider: 'p', model: 'm', thinking: 'medium' }, { applyDefaults: false }), /harness must be/);
  assert.throws(() => validateRolePreset({ harness: 'pi', provider: 'p', model: 'm', thinking: 'invalid' }, { applyDefaults: false }), /thinking must be one of/);
  assert.throws(() => validateRolePreset({ harness: 'pi', provider: null, model: 'm', thinking: 'medium' }, { applyDefaults: false }), /provider is required/);
  assert.throws(() => validateRolePreset({ harness: 'pi', provider: 'p', model: null, thinking: 'medium' }, { applyDefaults: false }), /model is required/);
  assert.throws(() => resolveRolePreset('unknown-role'), /unknown role/);

  const explorerLaunch = run(['pi', '--role', 'explorer']);
  assert.equal(explorerLaunch.status, 0, explorerLaunch.stderr);
  assert.deepEqual(capturedArgs(), [
    '--extension', render,
    '--provider', 'ollama-cloud',
    '--model', 'deepseek-v4-flash:0731',
    '--thinking', 'medium',
  ]);

  const explicitThinking = run(['pi', '--role', 'explorer', '--thinking', 'max']);
  assert.equal(explicitThinking.status, 0, explicitThinking.stderr);
  assert.deepEqual(capturedArgs(), [
    '--extension', render,
    '--provider', 'ollama-cloud',
    '--model', 'deepseek-v4-flash:0731',
    '--thinking', 'max',
  ]);

  const explicitAll = run([
    'pi', '--role', 'preset', '--provider', 'flag-provider', '--model', 'flag-model',
    '--thinking', 'max', '--name', 'golemtest-t1-custom',
  ]);
  assert.equal(explicitAll.status, 0, explicitAll.stderr);
  assert.deepEqual(capturedArgs(), [
    '--extension', render,
    '--provider', 'flag-provider',
    '--model', 'flag-model',
    '--thinking', 'max',
    '--name', 'golemtest-t1-custom',
  ]);

  const bare = run(['pi', '--thinking', 'high', 'prompt with spaces']);
  assert.equal(bare.status, 0, bare.stderr);
  assert.deepEqual(capturedArgs(), [
    '--extension', render,
    '--thinking', 'high', 'prompt with spaces',
  ], 'bare golem pi keeps native passthrough behavior');

  const unknown = run(['pi', '--role', 'unknown-role']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown role/);
  assert.doesNotMatch(unknown.stderr, /at file:/);

  const noPreset = run(['pi', '--role', 'lead']);
  assert.equal(noPreset.status, 2);
  assert.match(noPreset.stderr, /no execution preset/);
  assert.match(noPreset.stderr, /builder, explorer, reviewer/);
  assert.doesNotMatch(noPreset.stderr, /model is required/);

  const modelWithoutProvider = run(['pi', '--model', 'model-only']);
  assert.equal(modelWithoutProvider.status, 2);
  assert.match(modelWithoutProvider.stderr, /requires --provider and --model together/);

  console.log('Role preset journey passed: seeded registry, global defaults, precedence, validation, composed Pi argv, and bare-launch compatibility');
} finally {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
