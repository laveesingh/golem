import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = fileURLToPath(new URL('../../', import.meta.url));

export function createSandbox() {
  // Unix test roots are siblings, not nested below a Vitest worker's TMPDIR:
  // uncertain child roots must survive the worker's ordinary afterAll cleanup.
  const base = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const root = fs.mkdtempSync(path.join(base, 'gol458-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  for (const dir of [home, bin, state, path.join(root, 'tmp')])
    fs.mkdirSync(dir);
  // Deliberate allowlist, not a spread of agent/session/credential selectors.
  const env = {
    HOME: home,
    TMPDIR: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    TEMP: path.join(root, 'tmp'),
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: 'en_US.UTF-8',
    GOLEM_HOME: state,
    GOLEM_ROOT: repo,
    GOLEM_PROJECTS_ROOT: path.join(root, 'projects'),
    GOLEM_IDEAS_ROOT: path.join(root, 'ideas'),
    GOLEM_TRACKER_DB: path.join(state, 'tracker.db'),
    GOLEM_ASSETS_DIR: path.join(state, 'assets'),
    GOLEM_USER_SKILLS_ROOT: path.join(root, 'skills'),
    PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'),
    PI_CODING_AGENT_SESSION_DIR: path.join(root, 'pi-sessions'),
    GOLEM_DASHBOARD_URL: 'http://127.0.0.1:1',
    GOLEM_CHANNEL_URL: 'http://127.0.0.1:1',
    GOLEM_CHANNEL_PORT: '0',
    PORT: '0',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    GOLEM_W2_SANDBOX: root,
    GOLEM_W2_NATIVE_LOG: path.join(root, 'native.jsonl'),
    NODE_OPTIONS:
      '--import=' +
      fileURLToPath(new URL('./runtime-guard.mjs', import.meta.url)),
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const name of ['CONFIG', 'DATA', 'STATE', 'CACHE', 'RUNTIME']) {
    env[`XDG_${name}_HOME`] = path.join(root, `xdg-${name.toLowerCase()}`);
  }
  // XDG_RUNTIME_DIR is distinct from the four *_HOME roots.
  env.XDG_RUNTIME_DIR = path.join(root, 'runtime');
  delete env.XDG_RUNTIME_HOME;
  for (const key of [
    'GOLEM_PROJECTS_ROOT',
    'GOLEM_IDEAS_ROOT',
    'GOLEM_ASSETS_DIR',
    'GOLEM_USER_SKILLS_ROOT',
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR',
  ])
    fs.mkdirSync(env[key], { recursive: true });
  fs.writeFileSync(
    env.GIT_CONFIG_GLOBAL,
    '[init]\n  defaultBranch = main\n[user]\n  name = Hermetic Test\n  email = hermetic@example.invalid\n',
  );
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const name of [
    'claude',
    'pi',
    'herdr',
    'cloudflared',
    'security',
    'op',
    'aws',
    'gcloud',
    'curl',
    'wget',
  ]) {
    const source = `#!${process.execPath}
const fs = require('node:fs');
const name = ${JSON.stringify(name)}, args = process.argv.slice(2);
const inventory = (name === 'claude' && args.join(' ') === 'agents --json') || (name === 'herdr' && args.join(' ') === 'session list --json');
fs.appendFileSync(process.env.GOLEM_W2_NATIVE_LOG, JSON.stringify({name,args,inventory})+'\\n');
if (inventory) console.log(JSON.stringify(name === 'claude' ? {agents:[]} : {sessions:[]}));
else { console.error('W2 forbidden native command: '+name+' '+args.join(' ')); process.exitCode = 97; }
`;
    fs.writeFileSync(path.join(bin, name), source, { mode: 0o700 });
  }
  return {
    root,
    env,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
