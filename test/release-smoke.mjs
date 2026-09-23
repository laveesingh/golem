import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'golem-release-'));
const packDir = path.join(temp, 'pack');
const installDir = path.join(temp, 'install');
const home = path.join(temp, 'home');
const xdg = path.join(temp, 'xdg');
const sourcePiProfile = path.join(home, '.pi', 'agent');
const sourcePiSessions = path.join(home, '.pi', 'sessions');
const env = {
  ...process.env,
  HOME: home,
  GOLEM_HOME: path.join(temp, 'state'),
  XDG_CONFIG_HOME: xdg,
  PI_CODING_AGENT_DIR: sourcePiProfile,
  PI_CODING_AGENT_SESSION_DIR: sourcePiSessions,
  PORT: '17421',
  GOLEM_DASHBOARD_URL: 'http://127.0.0.1:17421',
};
const scopedRollbackPath = '$(npm root -g)/@laveesingh/golem';

function run(file, args, cwd = temp) {
  return execFileSync(file, args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
}

function runResult(file, args, cwd = temp, extraEnv = {}) {
  try {
    return { status: 0, stdout: execFileSync(file, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: 'pipe' }), stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

try {
  run('mkdir', ['-p', packDir, installDir, home, xdg]);
  const tarballName = run('npm', ['pack', '--pack-destination', packDir], repo).trim().split('\n').at(-1);
  const tarball = path.join(packDir, tarballName);
  run('npm', ['init', '-y'], installDir);
  run('npm', ['install', '--no-audit', '--no-fund', tarball], installDir);

  const installedRequire = createRequire(path.join(installDir, 'package.json'));
  const packageRoot = path.resolve(path.dirname(installedRequire.resolve('@laveesingh/golem')), '..');
  assert.notEqual(packageRoot, repo, 'CLI must resolve from the installed tarball');
  const installedPackage = JSON.parse(readFileSync(path.join(packageRoot, 'package.json')));
  assert.equal(installedPackage.name, '@laveesingh/golem');
  assert.equal(installedPackage.publishConfig?.access, 'public');
  assert.ok(readFileSync(path.join(packageRoot, 'substrate', 'README.md'), 'utf8').includes(scopedRollbackPath));
  const cli = path.join(packageRoot, 'cli', 'golem.js');
  run(process.execPath, [cli, 'help'], installDir);
  run(process.execPath, [cli, 'sync', '--target', 'cc'], installDir);
  run(process.execPath, [cli, 'sync', '--target', 'cc-marketplace'], installDir);
  run(process.execPath, [cli, 'sync', '--target', 'pi'], installDir);

  const renderedChannel = path.join(env.GOLEM_HOME, 'renders', 'cc-plugin', 'mcp', 'channel');
  assert.ok(readFileSync(path.join(env.GOLEM_HOME, 'renders', 'cc-plugin', 'README.md'), 'utf8').includes(scopedRollbackPath));
  const channelRequire = createRequire(path.join(renderedChannel, 'index.js'));
  const sdk = channelRequire.resolve('@modelcontextprotocol/sdk/server/index.js');
  assert.ok(realpathSync(sdk).startsWith(realpathSync(renderedChannel)), 'rendered channel SDK must be self-contained');
  assert.equal(JSON.parse(readFileSync(path.join(env.GOLEM_HOME, 'renders', 'cc-plugin', '.claude-plugin', 'plugin.json'))).name, 'golem');
  const piRoot = path.join(env.GOLEM_HOME, 'renders', 'pi');
  assert.equal(JSON.parse(readFileSync(path.join(piRoot, 'capabilities.json'))).tier, 'A');
  const sourceModels = `${JSON.stringify({ providers: {
    openai: {
      modelOverrides: {
        'gpt-5.6-terra': { contextWindow: 1050000 },
      },
    },
    unrelated: { baseUrl: 'http://127.0.0.1:9999/v1', api: 'openai-completions', models: [{ id: 'must-not-copy' }] },
  } }, null, 2)}\n`;
  mkdirSync(sourcePiProfile, { recursive: true });
  writeFileSync(path.join(sourcePiProfile, 'models.json'), sourceModels, { mode: 0o600 });
  const fakeBin = path.join(temp, 'bin');
  const piCapture = path.join(temp, 'installed-pi.json');
  mkdirSync(fakeBin, { recursive: true });
writeFileSync(path.join(fakeBin, 'pi'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.length === 3 && process.argv[2] === '--version') { console.log(process.env.GOLEM_FAKE_PI_VERSION || '0.80.10'); process.exit(0); }
fs.writeFileSync(process.env.GOLEM_PI_RELEASE_CAPTURE, JSON.stringify({ args: process.argv.slice(2), profile: process.env.PI_CODING_AGENT_DIR, sessions: process.env.PI_CODING_AGENT_SESSION_DIR }));
`, { mode: 0o700 });
  env.PATH = `${fakeBin}:${env.PATH}`;
  env.GOLEM_PI_RELEASE_CAPTURE = piCapture;
  run(process.execPath, [cli, 'pi', '--provider', 'ollama', '--model', 'deepseek-v4-flash:0731-cloud', '--', '--print'], installDir);
  const launchedPi = JSON.parse(readFileSync(piCapture, 'utf8'));
  assert.deepEqual(launchedPi.args, ['--extension', path.join(piRoot, 'golem.ts'), '--provider', 'ollama', '--model', 'deepseek-v4-flash:0731-cloud', '--print']);
  assert.equal(realpathSync(launchedPi.args[1]), realpathSync(path.join(piRoot, 'golem.ts')));
  assert.equal(launchedPi.profile, sourcePiProfile);
  assert.equal(launchedPi.sessions, sourcePiSessions);
  assert.equal(readFileSync(path.join(sourcePiProfile, 'models.json'), 'utf8'), sourceModels, 'installed Pi launch leaves the canonical profile untouched');
  assert.equal(existsSync(path.join(env.GOLEM_HOME, 'pi-agent')), false, 'installed launcher does not create a managed Pi profile');
  assert.equal(existsSync(path.join(env.GOLEM_HOME, 'pi-sessions')), false, 'installed launcher does not create a managed Pi session directory');
  const unsupported = runResult(process.execPath, [cli, 'pi'], installDir, { GOLEM_FAKE_PI_VERSION: '0.80.9' });
  assert.equal(unsupported.status, 1, unsupported.stderr);
  assert.match(unsupported.stderr, /supports Pi 0\.80\.10; found 0\.80\.9/);
  assert.equal(readFileSync(path.join(sourcePiProfile, 'models.json'), 'utf8'), sourceModels, 'unsupported installed Pi never mutates the canonical profile');
  console.log(`release smoke passed: ${tarballName}`);
  console.log(`installed root: ${packageRoot}`);
  console.log(`rendered channel SDK: ${sdk}`);
  console.log('isolated port: 17421');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
