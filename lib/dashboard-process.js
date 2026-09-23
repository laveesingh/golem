// Dashboard server process control, shared by the golem CLI and one-off
// maintenance scripts (GOL-367). Extracted from cli/golem.js so a script can
// stop/restart the dashboard without owning CLI argument handling.
//
// Every helper keys off the resolved golem home: stopDashboard only ever stops
// server processes whose GOLEM_HOME matches this process's golemHome(), so a
// script pointed at a temp home cannot touch the shared dashboard.
import { openSync, closeSync, readFileSync, mkdirSync, readlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, relative, resolve } from 'node:path';
import { dashboardJsonPath, golemHome } from './golem-home.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD_DIR = join(REPO_ROOT, 'dashboard');
const DEFAULT_DASHBOARD_PORT = 7420;

function log(line) {
  console.log(line);
}

function err(line) {
  console.error(line);
}

export function dashboardUrl() {
  if (process.env.GOLEM_DASHBOARD_URL) return process.env.GOLEM_DASHBOARD_URL.replace(/\/$/, '');
  const port = process.env.PORT || String(DEFAULT_DASHBOARD_PORT);
  return port === String(DEFAULT_DASHBOARD_PORT)
    ? 'http://dashboard.golem.localhost:7420'
    : `http://127.0.0.1:${port}`;
}

function healthUrl() {
  return `${dashboardUrl()}/api/health`;
}

async function httpGetJson(url, timeoutMs = 1500) {
  const urlObj = new URL(url);
  const mod = urlObj.protocol === 'https:' ? await import('node:https') : await import('node:http');
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(body ? JSON.parse(body) : null);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

export async function probeDashboard() {
  try {
    return { ok: true, data: await httpGetJson(healthUrl()) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isProcessAlive(pid) {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

export function dashboardLogPath() {
  const dir = join(golemHome(), 'logs');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(dir, `dashboard-${stamp}.log`);
}

export function tailFile(file, maxLines = 20) {
  try {
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

/** Best-effort pid of the currently-running dashboard, from its self-registered dashboard.json. */
export async function readDashboardPid() {
  try {
    const doc = JSON.parse(readFileSync(dashboardJsonPath(), 'utf8'));
    return typeof doc?.pid === 'number' ? doc.pid : null;
  } catch {
    return null;
  }
}

function processCommandTokens(command) {
  return String(command).trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? [];
}

function processWorkingDirectory(pid) {
  if (process.platform === 'linux') {
    try { return resolve(readlinkSync(`/proc/${pid}/cwd`)); } catch {}
  }
  const result = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const line = String(result.stdout).split('\n').find((entry) => entry.startsWith('n'));
  return line ? resolve(line.slice(1)) : null;
}

function isDashboardServerCommand(pid, command) {
  const tokens = processCommandTokens(command);
  const serverEntry = resolve(DASHBOARD_DIR, 'server', 'index.js');
  const pathSep = process.platform === 'win32' ? '\\' : '/';
  const relativeEntry = relative(REPO_ROOT, serverEntry).split(pathSep).join('/');
  const scriptIndex = tokens.findIndex((token) => {
    if (token === serverEntry) return true;
    return token === relativeEntry && processWorkingDirectory(pid) === REPO_ROOT;
  });
  if (scriptIndex < 0) return false;
  return tokens.slice(0, scriptIndex).some((token) => ['node', 'nodejs'].includes(basename(token)));
}

function processEnvironment(pid) {
  const result = spawnSync(process.env.GOLEM_PS_BIN || 'ps', ['eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return '';
  return String(result.stdout);
}

function processEnvironmentValue(pid, key) {
  const match = processEnvironment(pid).match(new RegExp(`(?:^|\\s)${key}=([^\\s]*)`));
  return match?.[1] ?? null;
}

function belongsToCurrentDashboardHome(pid) {
  const configuredHome = processEnvironmentValue(pid, 'GOLEM_HOME');
  const processHome = configuredHome || (() => {
    const home = processEnvironmentValue(pid, 'HOME');
    return home ? join(home, '.golem') : null;
  })();
  return processHome != null && resolve(processHome) === resolve(golemHome());
}

function pathSep() {
  return process.platform === 'win32' ? '\\' : '/';
}

function dashboardServerProcesses() {
  const ps = spawnSync(process.env.GOLEM_PS_BIN || 'ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  if (ps.error || ps.status !== 0) {
    throw new Error(`cannot inspect dashboard processes: ${ps.error?.message || String(ps.stderr || '').trim() || `ps exited ${ps.status}`}`);
  }
  const rows = [];
  for (const line of String(ps.stdout).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!pid || pid === process.pid || !isDashboardServerCommand(pid, match[2]) || !belongsToCurrentDashboardHome(pid)) continue;
    rows.push({ pid, command: match[2].trim() });
  }
  return rows;
}

export async function stopDashboardProcess(pid) {
  if (!isProcessAlive(pid)) return false;
  log(`  stopping dashboard pid=${pid}...`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isProcessAlive(pid)) await sleep(200);
  if (isProcessAlive(pid)) {
    log(`  pid=${pid} still alive after 3s; sending SIGKILL`);
    process.kill(pid, 'SIGKILL');
    await sleep(500);
  }
  return !isProcessAlive(pid);
}

/** Stop every exact dashboard server process, with the recorded pid first when present. */
export async function stopDashboard() {
  const recordedPid = await readDashboardPid();
  const processes = dashboardServerProcesses();
  processes.sort((left, right) => Number(right.pid === recordedPid) - Number(left.pid === recordedPid));
  const stopped = [];
  for (const processInfo of processes) {
    if (await stopDashboardProcess(processInfo.pid)) stopped.push(processInfo);
  }
  return stopped;
}

/** Start the dashboard detached (survives this process exiting) and wait for it to answer /api/health. */
export async function startDashboardDetached(args = [], { onError = (message) => err(message) } = {}) {
  const serverEntry = resolve(DASHBOARD_DIR, 'server', 'index.js');
  const publicFlag = args.includes('--public');
  const passthru = args.filter((a) => a !== '--public');
  const env = { ...process.env };
  const portFlag = args.findIndex((arg) => arg === '--port' || arg.startsWith('--port='));
  if (portFlag >= 0) {
    const raw = args[portFlag] === '--port' ? args[portFlag + 1] : args[portFlag].slice('--port='.length);
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`--port requires an integer from 1 to 65535 (received ${raw ?? '(missing)'})`);
    }
    env.PORT = String(port);
  }
  if (publicFlag) env.HOST = '0.0.0.0';
  const logFile = dashboardLogPath();
  const outFd = openSync(logFile, 'a');
  const errFd = openSync(logFile, 'a');
  let exitInfo = null;
  const child = spawn(process.execPath, [serverEntry, ...passthru], {
    cwd: REPO_ROOT,
    stdio: ['ignore', outFd, errFd],
    detached: true,
    env,
  });
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
  });
  child.on('error', (e) => {
    exitInfo = { error: e.message };
  });
  child.unref();
  closeSync(outFd);
  closeSync(errFd);
  const deadline = Date.now() + Number(process.env.GOLEM_DASHBOARD_STARTUP_TIMEOUT_MS || 20000);
  while (Date.now() < deadline) {
    const probe = await probeDashboard();
    if (probe.ok) return { ok: true, logFile, pid: child.pid };
    if (exitInfo) break;
    await sleep(300);
  }
  return { ok: false, logFile, pid: child.pid, exit: exitInfo, tail: tailFile(logFile) };
}

/** True when a dashboard server process for the current golem home is alive. */
export function dashboardRunning() {
  try {
    return dashboardServerProcesses().length > 0;
  } catch {
    return false;
  }
}
