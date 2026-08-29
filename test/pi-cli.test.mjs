#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'cli/golem.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-pi-cli-'));
const bin = path.join(temp, 'bin');
const project = path.join(temp, 'project');
const state = path.join(temp, 'state');
const normalProfile = path.join(temp, 'home', '.pi', 'agent');
const normalSessions = path.join(temp, 'home', '.pi', 'sessions');
const capture = path.join(temp, 'pi-launch.json');
const signalCapture = path.join(temp, 'pi-signal.txt');
const sourceModels = path.join(normalProfile, 'models.json');
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(normalProfile, { recursive: true });
fs.writeFileSync(path.join(normalProfile, 'sentinel'), 'human profile\n');
const sourceModelsText = `${JSON.stringify({ providers: {
  openai: {
    modelOverrides: {
      'gpt-5.6-terra': { contextWindow: 1050000 },
    },
  },
  unrelated: { baseUrl: 'http://127.0.0.1:9999/v1', api: 'openai-completions', models: [{ id: 'must-not-copy' }] },
} }, null, 2)}\n`;
fs.writeFileSync(sourceModels, sourceModelsText, { mode: 0o600 });

const fakePi = path.join(bin, 'pi');
fs.writeFileSync(fakePi, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.length === 3 && process.argv[2] === '--version') {
  process.stdout.write((process.env.GOLEM_FAKE_PI_VERSION || '0.84.3') + '\\n');
  process.exit(0);
}
fs.writeFileSync(process.env.GOLEM_PI_CAPTURE, JSON.stringify({
  cwd: process.cwd(), args: process.argv.slice(2),
  profile: process.env.PI_CODING_AGENT_DIR,
  sessions: process.env.PI_CODING_AGENT_SESSION_DIR,
  launch_nonce: process.env.GOLEM_PI_LAUNCH_NONCE,
  pi_version: process.env.GOLEM_PI_VERSION,
  extension_version: process.env.GOLEM_PI_EXTENSION_VERSION,
}, null, 2));
if (process.env.GOLEM_FAKE_PI_WAIT === '1') {
  for (const signal of ['SIGTERM', 'SIGHUP']) process.once(signal, () => {
    fs.writeFileSync(process.env.GOLEM_PI_SIGNAL_CAPTURE, signal);
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
  setInterval(() => {}, 1000);
  return;
}
process.exit(Number(process.env.GOLEM_FAKE_PI_EXIT || 0));
`, { mode: 0o700 });

const baseEnv = {
  ...process.env,
  HOME: path.join(temp, 'home'),
  GOLEM_HOME: state,
  XDG_CONFIG_HOME: path.join(temp, 'xdg'),
  PATH: bin,
  PI_CODING_AGENT_DIR: normalProfile,
  PI_CODING_AGENT_SESSION_DIR: normalSessions,
  GOLEM_PI_CAPTURE: capture,
  GOLEM_PI_SIGNAL_CAPTURE: signalCapture,
  GOLEM_DASHBOARD_URL: 'http://127.0.0.1:1',
};
function run(args, env = baseEnv) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: 'utf8' });
}

async function waitForFile(file, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function proveForwardedSignal(signal) {
  fs.rmSync(capture, { force: true });
  fs.rmSync(signalCapture, { force: true });
  const wrapper = spawn(process.execPath, [cli, 'pi'], {
    cwd: project,
    env: { ...baseEnv, GOLEM_FAKE_PI_WAIT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  wrapper.stderr.on('data', (chunk) => { stderr += chunk; });
  await waitForFile(capture);
  wrapper.kill(signal);
  const outcome = await new Promise((resolve, reject) => {
    wrapper.once('error', reject);
    wrapper.once('close', (code, childSignal) => resolve({ code, signal: childSignal }));
  });
  assert.equal(fs.readFileSync(signalCapture, 'utf8'), signal, `${signal} was not forwarded to Pi`);
  assert.equal(outcome.code, null, stderr);
  assert.equal(outcome.signal, signal, stderr);
}

try {
  const help = run(['pi', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /golem pi \[--role <role>\] \[--profile <name>\] \[--provider <id> --model <id>\]/);
  assert.match(help.stdout, /--profile <name>\s+Model profile override/);
  assert.match(help.stdout, /--role <role>\s+Apply the role's validated Pi execution preset/);
  assert.match(help.stdout, /retains its\s+own profile, authentication, models, providers, extensions, and sessions/);
  assert.match(help.stdout, /Node\.js\s+>=22\.19/);

  const synced = run(['sync', '--target', 'pi']);
  assert.equal(synced.status, 0, synced.stderr);

  const launched = run([
    'pi', '--provider', 'ollama', '--model', 'deepseek-v4-flash:0731-cloud',
    '--resume', 'native-session-id', '--', '--thinking', 'high', 'prompt with spaces',
  ]);
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stderr, /dashboard unavailable.*degraded mode/);
  const record = JSON.parse(fs.readFileSync(capture, 'utf8'));
  const extension = path.join(state, 'renders', 'pi', 'golem.ts');
  assert.deepEqual(record.args, [
    '--extension', extension,
    '--provider', 'ollama', '--model', 'deepseek-v4-flash:0731-cloud',
    '--session', 'native-session-id', '--thinking', 'high', 'prompt with spaces',
  ]);
  assert.equal(record.cwd, fs.realpathSync(project));
  assert.equal(record.profile, normalProfile, 'golem pi preserves Pi\'s profile selection');
  assert.equal(record.sessions, normalSessions, 'golem pi preserves Pi\'s session selection');
  assert.equal(record.pi_version, '0.84.3');
  assert.match(record.extension_version, /^5\./);
  assert.match(record.launch_nonce, /^[0-9a-f-]{36}$/);
  assert.equal(record.args.includes('--no-extensions'), false, 'native Pi extension discovery remains enabled');
  assert.equal(fs.readFileSync(sourceModels, 'utf8'), sourceModelsText, 'golem pi never rewrites the Pi profile');
  assert.equal(fs.existsSync(path.join(state, 'pi-agent')), false, 'golem pi does not create a managed Pi profile');
  assert.equal(fs.existsSync(path.join(state, 'pi-sessions')), false, 'golem pi does not create a managed Pi session directory');

  const custom = run(['pi', '--provider', 'unrelated', '--model', 'must-not-copy']);
  assert.equal(custom.status, 0, custom.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')).args, [
    '--extension', extension,
    '--provider', 'unrelated', '--model', 'must-not-copy',
  ], 'provider/model selection is native Pi passthrough, not a Golem profile bridge');

  const nativeArgs = run(['pi', '--', '--session', 'native-direct', '--session-dir', '/tmp/native-pi-sessions', '--no-extensions']);
  assert.equal(nativeArgs.status, 0, nativeArgs.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')).args, [
    '--extension', extension,
    '--session', 'native-direct', '--session-dir', '/tmp/native-pi-sessions', '--no-extensions',
  ], 'native Pi flags after -- pass through unchanged');

  const noOverridesEnv = { ...baseEnv };
  delete noOverridesEnv.PI_CODING_AGENT_DIR;
  delete noOverridesEnv.PI_CODING_AGENT_SESSION_DIR;
  const defaults = run(['pi'], noOverridesEnv);
  assert.equal(defaults.status, 0, defaults.stderr);
  const defaultRecord = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(Object.hasOwn(defaultRecord, 'profile'), false, 'golem pi does not inject a profile override');
  assert.equal(Object.hasOwn(defaultRecord, 'sessions'), false, 'golem pi does not inject a session override');

  const nonStandardVersion = run(['pi'], { ...baseEnv, GOLEM_FAKE_PI_VERSION: '0.84.3' });
  assert.equal(nonStandardVersion.status, 0, nonStandardVersion.stderr);
  assert.equal(JSON.parse(fs.readFileSync(capture, 'utf8')).pi_version, '0.84.3');

  const wrongNodeRunner = path.join(temp, 'wrong-node.mjs');
  fs.writeFileSync(wrongNodeRunner, `Object.defineProperty(process.versions, 'node', { value: '22.18.0' });\nawait import(${JSON.stringify(cli)});\n`);
  const wrongNode = spawnSync(process.execPath, [wrongNodeRunner, 'pi'], {
    cwd: project, env: baseEnv, encoding: 'utf8',
  });
  assert.equal(wrongNode.status, 1, wrongNode.stderr);
  assert.match(wrongNode.stderr, /requires Node\.js >=22\.19; running 22\.18\.0/);

  const missing = run(['pi'], { ...baseEnv, PATH: path.join(temp, 'missing-bin') });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /could not find the 'pi' executable/);

  const failed = run(['pi'], { ...baseEnv, GOLEM_FAKE_PI_EXIT: '17' });
  assert.equal(failed.status, 17, failed.stderr);
  await proveForwardedSignal('SIGTERM');
  await proveForwardedSignal('SIGHUP');

  fs.rmSync(path.join(state, 'renders', 'pi'), { recursive: true, force: true });
  fs.rmSync(capture);
  const missingRender = run(['pi']);
  assert.equal(missingRender.status, 1, missingRender.stderr);
  assert.match(`${missingRender.stdout}\n${missingRender.stderr}`, /render is missing .*run golem sync --target pi/);
  assert.equal(fs.existsSync(capture), false, 'missing render fails before Pi launch');

  console.log('Pi CLI journey passed: native profile/session/provider/extension behavior with the Golem bridge, render guard, diagnostics, and exit/signal propagation');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
