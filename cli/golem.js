#!/usr/bin/env node
// golem — minimal Node CLI for the v4 harness.
//
// v3 subcommands removed:
//   install, cleanup, reinstall, project, dispatch, ack
//   The old session commands are replaced by session list/notify.
//
// Surviving subcommands:
//   dashboard    Start the admin dashboard (node dashboard/server/index.js).
//   dashboard:restart
//                Stop and restart the admin dashboard detached.
//   claude / cc  Open Claude Code as a Golem channel consumer, optionally via Ollama.
//   pi           Open native Pi with Golem's rendered bridge extension.
//   spawn/list/attach/peek/kill
//                Manage detached Pi workers in the Golem tmux namespace.
//   doctor       Sanity-check the environment.
//   status       Dashboard health + canonical URL.
//   help         Show this message.

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { golemHome, legacyConfigDir, migratedHomeDir, trackerDbPath, renderDirFor, projectsJsonPath, sessionsJsonPath } from '../lib/golem-home.js';
import { projectIdFor } from '../lib/project-id.js';
import { SESSION_ROLES, pushRoleBriefDirect, setSessionRole } from '../lib/session-role.js';
import { updateProjectLsp } from '../lib/lsp.js';
import * as compiler from '../lib/compiler/engine.js';
import { lintSubstrate } from '../lib/compiler/lint.js';
import * as ccAdapter from '../lib/compiler/adapters/cc.js';
import * as piAdapter from '../lib/compiler/adapters/pi.js';
import { isHarnessEnabled, loadConfig, saveConfig } from '../lib/golem-config.js';
import { MIN_PI_NODE, SUPPORTED_PI_VERSION, piNodeSupported } from '../lib/pi-compatibility.js';
import { resolveRolePreset } from '../lib/role-preset.js';
import { getProfile, listProfileNames } from '../lib/model-profiles.js';
import {
  attachSwarm,
  attachWorker,
  killWorker,
  listWorkerViews,
  peekWorker,
  resolveWorkerProject,
  spawnWorker,
} from '../lib/worker-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GOLEM_ROOT = resolve(__dirname, '..');
const DASHBOARD_DIR = resolve(GOLEM_ROOT, 'dashboard');
const DEFAULT_DASHBOARD_PORT = 7420;
function dashboardUrl() {
  if (process.env.GOLEM_DASHBOARD_URL) return process.env.GOLEM_DASHBOARD_URL.replace(/\/$/, '');
  const port = process.env.PORT || String(DEFAULT_DASHBOARD_PORT);
  return port === String(DEFAULT_DASHBOARD_PORT)
    ? 'http://dashboard.golem.localhost:7420'
    : `http://127.0.0.1:${port}`;
}

function dashboardPortFromArgs(args) {
  const index = args.findIndex((arg) => arg === '--port' || arg.startsWith('--port='));
  if (index < 0) return null;
  const raw = args[index] === '--port' ? args[index + 1] : args[index].slice('--port='.length);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port requires an integer from 1 to 65535 (received ${raw ?? '(missing)'})`);
  }
  return port;
}

function applyDashboardPort(args, env) {
  const port = dashboardPortFromArgs(args);
  if (port != null) env.PORT = String(port);
  return port;
}

function healthUrl() {
  return `${dashboardUrl()}/api/health`;
}

const removed = new Set([
  'install',
  'cleanup',
  'reinstall',
  'project',
  'dispatch',
  'ack',
]);

function log(line) {
  console.log(line);
}

function err(line) {
  console.error(line);
}

function fatal(code, message) {
  err(message);
  process.exit(code);
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

async function probeDashboard() {
  try {
    return { ok: true, data: await httpGetJson(healthUrl()) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function hasCommand(name) {
  // Using `command -v` is the most portable way on POSIX shells.
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function cmdStatus(args) {
  const wantJson = args.includes('--json');
  const probe = await probeDashboard();

  if (wantJson) {
    log(JSON.stringify({
      dashboard_url: probe.ok ? dashboardUrl() : null,
      dashboard_healthy: probe.ok,
      dashboard: probe.data ?? null,
      error: probe.ok ? null : probe.error,
    }, null, 2));
    return;
  }

  log('');
  log('Dashboard');
  if (probe.ok) {
    const pc = probe.data?.project_count ?? '?';
    log(`  OK running on ${dashboardUrl()} (${pc} projects)`);
  } else {
    log(`  not reachable (${probe.error})`);
    log(`  start it with: golem dashboard`);
  }
}

function publicSupervisorRecord(record) {
  if (!record) return null;
  const { owner_token: _ownerToken, ...health } = record.health ?? {};
  return { ...record, health };
}

function readSessionsRegistryObject(file = sessionsJsonPath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.sessions) ? parsed : { version: 1, sessions: [] };
  } catch {
    return { version: 1, sessions: [] };
  }
}

function writeSessionsRegistryObject(file, reg) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  renameSync(tmp, file);
}

function withFileLock(lockPath, fn) {
  try { mkdirSync(dirname(lockPath), { recursive: true }); } catch { /* ignore */ }
  for (let i = 0; i < 50; i++) {
    try {
      mkdirSync(lockPath);
      try { return fn(); }
      finally { try { rmdirSync(lockPath); } catch { /* ignore */ } }
    } catch (e) {
      if (e?.code === 'EEXIST') {
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs > 5000) rmdirSync(lockPath);
        } catch { /* ignore */ }
        const wait = Date.now() + 20;
        while (Date.now() < wait) { /* brief spin */ }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`failed to acquire ${lockPath}`);
}

function rowTime(row, keys) {
  for (const key of keys) {
    const t = Date.parse(row?.[key] || '');
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function isLiveSessionRow(row) {
  return !row?.ended_at;
}

function rowFreshness(row, alive) {
  return alive
    ? rowTime(row, ['updated_at', 'last_seen_at', 'boot_time', 'started_at'])
    : rowTime(row, ['ended_at', 'updated_at', 'last_seen_at', 'boot_time', 'started_at']);
}

function sessionLabel(row) {
  return `${row.session_id || '(no session_id)'}${row.model ? ` (model=${row.model})` : ''}`;
}

function keptSessionLabel(row, reason) {
  return `${row.session_id || '(no session_id)'} (${reason}${row.model ? `, model=${row.model}` : ''})`;
}

function sessionProjectScope(row) {
  return row?.project_path || row?.project_id || row?.cwd || '';
}


function sessionsDedupPlan(sessions) {
  // Scope by project so same role name in different projects never collapses.
  const groups = new Map();
  sessions.forEach((row, index) => {
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    if (!name) return;
    const key = `${sessionProjectScope(row)}\0${name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, index });
  });

  const plans = [];
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    const name = key.split('\0').slice(1).join('\0') || key;
    const live = rows.filter(({ row }) => isLiveSessionRow(row));
    const candidates = live.length ? live : rows;
    const keep = candidates
      .slice()
      .sort((a, b) => rowFreshness(b.row, live.length > 0) - rowFreshness(a.row, live.length > 0))[0];
    const mark = rows.filter((entry) => entry.index !== keep.index && !entry.row.ended_at);
    plans.push({ kind: 'named', name, keep, mark, liveKept: live.length > 0 });
  }
  return plans;
}

function printSessionsDedupPlan(plans, apply) {
  if (!plans.length) {
    log(`golem sessions dedup: no project-scoped named duplicates found (${apply ? 'applied' : 'dry-run'})`);
    return;
  }
  log(`golem sessions dedup ${apply ? '--apply' : '(dry-run; pass --apply to write)'}`);
  for (const plan of plans) {
    const reason = plan.liveKept ? 'freshest live' : 'freshest ended';
    const scope = sessionProjectScope(plan.keep.row) || '(no project)';
    log(`name ${plan.name} @ ${scope}: would keep ${keptSessionLabel(plan.keep.row, reason)}`);
    if (plan.mark.length) {
      log(`name ${plan.name} @ ${scope}: would mark ended: ${plan.mark.map(({ row }) => sessionLabel(row)).join(', ')}`);
    } else {
      log(`name ${plan.name} @ ${scope}: no un-ended duplicates to mark`);
    }
  }
}

async function cmdSessions(args) {
  const sub = args[0];
  if (!sub || sub === '-h' || sub === '--help') {
    log(`Usage: golem sessions dedup [--apply]

Commands:
  dedup          Dry-run named-session duplicate cleanup.

Options:
  --apply        Write the cleanup. Without --apply, prints the plan only.
  -h, --help     Show help.`);
    return;
  }
  if (sub !== 'dedup') fatal(2, `Unknown sessions command: ${sub}\n\nRun \`golem sessions --help\`.`);
  const rest = args.slice(1);
  if (rest.includes('-h') || rest.includes('--help')) {
    log(`Usage: golem sessions dedup [--apply]

Dry-run by default. Groups rows in ~/.golem/sessions.json by non-empty name
within the same project path, keeps the freshest live row, and with --apply
marks other un-ended rows ended_at=<now>. Also marks stale/terminal unnamed rows.`);
    return;
  }
  const unknown = rest.filter((a) => a !== '--apply');
  if (unknown.length) fatal(2, `unknown sessions dedup option: ${unknown[0]}`);

  const apply = rest.includes('--apply');
  const file = sessionsJsonPath();
  const run = () => {
    const reg = readSessionsRegistryObject(file);
    const plans = [...sessionsDedupPlan(reg.sessions)];
    printSessionsDedupPlan(plans, apply);
    if (!apply) return;
    const now = new Date().toISOString();
    let changed = false;
    for (const plan of plans) {
      for (const { index } of plan.mark) {
        if (reg.sessions[index]?.ended_at) continue;
        reg.sessions[index] = { ...reg.sessions[index], status: 'superseded', ended_at: now };
        changed = true;
      }
    }
    if (changed) writeSessionsRegistryObject(file, reg);
    log(changed ? `applied: marked duplicate/stale sessions ended_at=${now}` : 'applied: no changes');
  };
  if (apply) withFileLock(`${file}.lock`, run);
  else run();
}

function resolveSessionArg(value, sessions) {
  if (!value) return null;
  const exact = sessions.find((s) => s.session_id === value || s.name === value);
  if (exact) return exact;
  const pref = sessions.filter((s) => typeof s.session_id === 'string' && s.session_id.startsWith(value));
  if (pref.length === 1) return pref[0];
  if (pref.length > 1) {
    throw new Error(`ambiguous session prefix "${value}" (${pref.length} matches)`);
  }
  throw new Error(`session not found: ${value}`);
}

function liveSessionLines(sessions) {
  return sessions
    .slice()
    .sort((a, b) => String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')))
    .map((s) => `  ${s.session_id}${s.name ? `  ${s.name}` : ''}${s.project_path ? `  ${s.project_path}` : ''}`);
}

async function cmdRole(args) {
  const roleArg = args[0];
  if (roleArg === 'list' || roleArg === '--list') {
    log(SESSION_ROLES.join('\n'));
    return;
  }
  if (!roleArg || roleArg === '-h' || roleArg === '--help') {
    log(`Usage: golem role <${SESSION_ROLES.join('|')}|clear> [--session <id-or-name>]\n       golem role list`);
    return;
  }
  const role = roleArg === 'clear' ? null : roleArg;
  if (role != null && !SESSION_ROLES.includes(role)) {
    fatal(2, `invalid role: ${roleArg} (expected ${SESSION_ROLES.join('|')} or clear)`);
  }
  let sessionOpt = null;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--session') {
      sessionOpt = args[++i];
      if (!sessionOpt) fatal(2, '--session requires a value');
    } else if (a.startsWith('--session=')) {
      sessionOpt = a.slice('--session='.length);
    } else {
      fatal(2, `unknown role option: ${a}`);
    }
  }
  const sessions = readSessionsRegistry();
  let target;
  try {
    if (sessionOpt) {
      target = resolveSessionArg(sessionOpt, sessions);
    } else if (process.env.CLAUDE_CODE_SESSION_ID) {
      target = resolveSessionArg(process.env.CLAUDE_CODE_SESSION_ID, sessions);
    } else {
      const lines = liveSessionLines(sessions);
      fatal(2, `--session is required when CLAUDE_CODE_SESSION_ID is unset.${lines.length ? `\n\nKnown sessions:\n${lines.join('\n')}` : ''}`);
    }
  } catch (e) {
    fatal(2, e.message);
  }
  const updated = setSessionRole(target.session_id, role, { by: 'human:cli' });
  const activation = role ? await pushRoleBriefDirect(updated.session_id, role, updated) : null;
  log(JSON.stringify({
    ok: true,
    session_id: updated.session_id,
    name: updated.name ?? null,
    role: updated.role,
    role_updated_at: updated.role_updated_at,
    role_updated_by: updated.role_updated_by,
    activation,
  }, null, 2));
}

function workerProjectHelp() {
  return '[--project <path-or-project-id>]';
}

const WORKER_TABLE_COLUMNS = [
  { key: 'name', label: 'NAME', max: 24 },
  { key: 'project_id', label: 'PROJECT', max: 20 },
  { key: 'role', label: 'ROLE', max: 18 },
  { key: 'state', label: 'STATE', max: 10 },
  { key: 'model', label: 'MODEL', max: 30 },
  { key: 'status', label: 'STATUS', max: 12 },
  { key: 'idle', label: 'IDLE', max: 10 },
  { key: 'attach_hint', label: 'ATTACH HINT', max: 32 },
];

function formatIdle(value) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return '-';
  let seconds = Math.max(0, Math.floor(Number(value)));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainingMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function workerTableValue(worker, key) {
  if (key === 'idle') return formatIdle(worker?.idle_seconds);
  if (key === 'attach_hint' && String(worker?.state || '').toLowerCase() === 'dead') return 'unavailable (dead)';
  const value = worker?.[key];
  if (value == null || value === '') return '-';
  return String(value).replace(/\s+/g, ' ');
}

function fitTableCell(value, width) {
  const text = String(value);
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, Math.max(1, width - 1))}…`;
}

function formatWorkerTable(workers) {
  const rows = Array.isArray(workers) ? workers : [workers];
  if (!rows.length) return 'No workers.';
  const values = rows.map((worker) => WORKER_TABLE_COLUMNS.map((column) => workerTableValue(worker, column.key)));
  const widths = WORKER_TABLE_COLUMNS.map((column, index) => Math.min(
    column.max,
    Math.max(column.label.length, ...values.map((row) => row[index].length)),
  ));
  const header = WORKER_TABLE_COLUMNS.map((column, index) => fitTableCell(column.label, widths[index])).join('  ');
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  const body = values.map((row) => row.map((value, index) => fitTableCell(value, widths[index])).join('  '));
  return [header, divider, ...body].join('\n');
}

function emitWorkerOutput(value, { json = false } = {}) {
  if (json) {
    // Keep the pre-table JSON representation byte-compatible for machine users.
    log(JSON.stringify(value, null, 2));
    return;
  }
  log(formatWorkerTable(value));
}

async function cmdSpawn(args) {
  if (!args.length || args[0] === '-h' || args[0] === '--help') {
    log(`Usage: golem spawn <role> [--name <name>] [--profile <name>] ${workerProjectHelp()} [--json]

Create one Pi worker in a detached tmux pty. The worker is registered and
role-assigned before this command returns. A failed readiness wait leaves the
worker's tmux session available for peek/inspection. With --profile, the named
model profile overrides the role's default (resolution: --profile > role
default > role exec).`);
    return;
  }
  const role = args[0];
  const wantJson = args.includes('--json');
  let name = null;
  let project = null;
  let profile = null;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      continue;
    }
    if (arg === '--name') {
      name = args[++index] ?? null;
      if (!name || name.startsWith('-')) fatal(2, 'golem spawn --name requires a value');
    } else if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length);
    } else if (arg === '--profile') {
      profile = args[++index] ?? null;
      if (!profile || profile.startsWith('-')) fatal(2, 'golem spawn --profile requires a value');
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length);
      if (!profile) fatal(2, 'golem spawn --profile requires a value');
    } else if (arg === '--project') {
      project = args[++index] ?? null;
      if (!project || project.startsWith('-')) fatal(2, 'golem spawn --project requires a value');
    } else if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length);
    } else {
      fatal(2, `unknown spawn option: ${arg}`);
    }
  }
  try {
    const worker = await spawnWorker({ role, name, project, profile });
    emitWorkerOutput(worker, { json: wantJson });
  } catch (error) {
    fatal(1, `golem spawn: ${error.message}`);
  }
}

async function cmdListWorkers(args) {
  if (args.includes('-h') || args.includes('--help')) {
    log(`Usage: golem list ${workerProjectHelp()} [--all] [--all-projects] [--json]

List live, spawning, and failed Golem workers as a table. Dead rows are
hidden by default; --all includes retained dead rows. Use --json for the
machine-readable worker-record shape.

Without --project this lists workers for the CURRENT project — resolved
from the working directory by walking up to the nearest .git or CLAUDE.md
(the same rule as hook routing). Pass --all-projects to list every
project's workers. The PROJECT column shows which project each belongs to.`);
    return;
  }
  const wantJson = args.includes('--json');
  const includeDead = args.includes('--all');
  const allProjects = args.includes('--all-projects');
  let project = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json' || arg === '--all' || arg === '--all-projects') {
      continue;
    }
    if (arg === '--project') {
      project = args[++index] ?? null;
      if (!project || project.startsWith('-')) fatal(2, 'golem list --project requires a value');
    } else if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length);
    } else {
      fatal(2, `unknown list option: ${arg}`);
    }
  }
  try {
    emitWorkerOutput(await listWorkerViews({ project: allProjects ? null : (project ?? '.'), includeDead }), { json: wantJson });
  } catch (error) {
    fatal(1, `golem list: ${error.message}`);
  }
}

async function cmdAttachWorker(args) {
  if (!args.length || args[0] === '-h' || args[0] === '--help') {
    log(`Usage: golem attach [<name>] ${workerProjectHelp()}

Attach the current terminal to a worker's real tmux TUI. Without a name,
attach the project's whole swarm — its dedicated tmux server tree.`);
    return;
  }
  let name = null;
  let project = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--project') {
      project = args[++index] ?? null;
      if (!project || project.startsWith('-')) fatal(2, 'golem attach --project requires a value');
    } else if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length);
    } else if (name == null && !arg.startsWith('-')) {
      name = arg;
    } else {
      fatal(2, `unknown attach option: ${arg}`);
    }
  }
  try {
    if (name == null) {
      // No worker named: attach the project's whole swarm (its tmux server).
      const { projectId } = await resolveWorkerProject(project);
      const status = attachSwarm(projectId);
      if (status) process.exitCode = status;
      return;
    }
    const { projectId } = await resolveWorkerProject(project);
    const status = attachWorker(name, { projectId });
    if (status) process.exitCode = status;
  } catch (error) {
    fatal(1, `golem attach: ${error.message}`);
  }
}

async function cmdPeekWorker(args) {
  if (!args.length || args[0] === '-h' || args[0] === '--help') {
    log(`Usage: golem peek <name> [--lines <N>] ${workerProjectHelp()}

Capture worker scrollback without attaching or sending input.`);
    return;
  }
  const name = args[0];
  let lines = null;
  let project = null;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--lines') {
      lines = Number(args[++index]);
      if (!Number.isInteger(lines) || lines < 1) fatal(2, 'golem peek --lines requires a positive integer');
    } else if (arg.startsWith('--lines=')) {
      lines = Number(arg.slice('--lines='.length));
      if (!Number.isInteger(lines) || lines < 1) fatal(2, 'golem peek --lines requires a positive integer');
    } else if (arg === '--project') {
      project = args[++index] ?? null;
      if (!project || project.startsWith('-')) fatal(2, 'golem peek --project requires a value');
    } else if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length);
    } else {
      fatal(2, `unknown peek option: ${arg}`);
    }
  }
  try {
    const { projectId } = await resolveWorkerProject(project);
    process.stdout.write(await peekWorker(name, { projectId, lines }));
  } catch (error) {
    fatal(1, `golem peek: ${error.message}`);
  }
}

async function cmdKillWorker(args) {
  if (!args.length || args[0] === '-h' || args[0] === '--help') {
    log(`Usage: golem kill <name> ${workerProjectHelp()} [--json]

Kill one worker: tmux kill-session, TERM the recorded process group, KILL
survivors, verify the group is empty, then mark the worker dead.`);
    return;
  }
  const name = args[0];
  const wantJson = args.includes('--json');
  let project = null;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      continue;
    }
    if (arg === '--project') {
      project = args[++index] ?? null;
      if (!project || project.startsWith('-')) fatal(2, 'golem kill --project requires a value');
    } else if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length);
    } else {
      fatal(2, `unknown kill option: ${arg}`);
    }
  }
  try {
    const { projectId } = await resolveWorkerProject(project);
    emitWorkerOutput(await killWorker(name, { projectId }), { json: wantJson });
  } catch (error) {
    const code = /refusing to kill|ambiguous|not found/i.test(error.message) ? 2 : 1;
    fatal(code, `golem kill: ${error.message}`);
  }
}

async function cmdDashboard(args) {
  const serverEntry = resolve(DASHBOARD_DIR, 'server', 'index.js');
  if (!existsSync(serverEntry)) {
    fatal(1, `dashboard server entry missing: ${serverEntry}`);
  }
  if (!existsSync(resolve(GOLEM_ROOT, 'node_modules'))) {
    fatal(1, 'root deps missing — npm install (from the repo root)');
  }

  const publicFlag = args.includes('--public');
  const env = { ...process.env };
  try {
    applyDashboardPort(args, env);
  } catch (error) {
    fatal(2, `golem dashboard: ${error.message}`);
  }
  if (publicFlag) {
    env.HOST = '0.0.0.0';
    err('WARNING --public: dashboard binding 0.0.0.0 — reachable on your LAN with NO auth.');
    err('WARNING anyone on this network can drive sessions via /api/brief.');
  }

  const passthru = args.filter((a) => a !== '--public');
  const proc = spawn(process.execPath, [serverEntry, ...passthru], {
    cwd: GOLEM_ROOT,
    stdio: 'inherit',
    env,
  });
  proc.on('error', (e) => fatal(1, `failed to start dashboard: ${e.message}`));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isProcessAlive(pid) {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

function dashboardLogPath() {
  const dir = join(golemHome(), 'logs');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(dir, `dashboard-${stamp}.log`);
}

function tailFile(file, maxLines = 20) {
  try {
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

/** Best-effort pid of the currently-running dashboard, from its self-registered dashboard.json. */
async function readDashboardPid() {
  try {
    const doc = JSON.parse(await readFile(join(golemHome(), 'dashboard.json'), 'utf8'));
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
  const relativeEntry = relative(GOLEM_ROOT, serverEntry).split(pathSep()).join('/');
  const scriptIndex = tokens.findIndex((token) => {
    if (token === serverEntry) return true;
    return token === relativeEntry && processWorkingDirectory(pid) === GOLEM_ROOT;
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

async function stopDashboardProcess(pid) {
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
async function stopDashboard() {
  const recordedPid = await readDashboardPid();
  const processes = dashboardServerProcesses();
  processes.sort((left, right) => Number(right.pid === recordedPid) - Number(left.pid === recordedPid));
  const stopped = [];
  for (const processInfo of processes) {
    if (await stopDashboardProcess(processInfo.pid)) stopped.push(processInfo);
  }
  return stopped;
}

/** Start the dashboard detached (survives this CLI process exiting) and wait for it to answer /api/health. */
async function startDashboardDetached(args = []) {
  const serverEntry = resolve(DASHBOARD_DIR, 'server', 'index.js');
  const publicFlag = args.includes('--public');
  const passthru = args.filter((a) => a !== '--public');
  const env = { ...process.env };
  try {
    applyDashboardPort(args, env);
  } catch (error) {
    fatal(2, `golem dashboard:restart: ${error.message}`);
  }
  if (publicFlag) env.HOST = '0.0.0.0';
  const logFile = dashboardLogPath();
  const outFd = openSync(logFile, 'a');
  const errFd = openSync(logFile, 'a');
  let exitInfo = null;
  const child = spawn(process.execPath, [serverEntry, ...passthru], {
    cwd: GOLEM_ROOT,
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

async function cmdDashboardRestart(args) {
  if (!existsSync(resolve(DASHBOARD_DIR, 'server', 'index.js'))) {
    fatal(1, `dashboard server entry missing: ${resolve(DASHBOARD_DIR, 'server', 'index.js')}`);
  }
  if (!existsSync(resolve(GOLEM_ROOT, 'node_modules'))) {
    fatal(1, 'root deps missing — npm install (from the repo root)');
  }

  try {
    applyDashboardPort(args, process.env);
  } catch (error) {
    fatal(2, `golem dashboard:restart: ${error.message}`);
  }
  log('Restarting dashboard...');
  const stopped = await stopDashboard();
  log(stopped.length ? `  OK dashboard stopped (${stopped.map(({ pid }) => `pid=${pid}`).join(', ')})` : '  dashboard was not running');
  log('  starting dashboard detached...');
  const started = await startDashboardDetached(args);
  log(`  log: ${started.logFile}`);
  if (!started.ok) {
    const exit = started.exit
      ? started.exit.error
        ? `; child error: ${started.exit.error}`
        : `; child exit code=${started.exit.code ?? 'null'} signal=${started.exit.signal ?? 'null'}`
      : '';
    const tail = started.tail ? `\n\nLast log lines:\n${started.tail}` : '';
    fatal(1, `  FAIL dashboard did not come back up within startup window${exit}. Log: ${started.logFile}${tail}`);
  }
  log(`  OK dashboard responding on ${dashboardUrl()} (pid=${started.pid})`);
}

async function cmdMigrateHome(args) {
  const src = legacyConfigDir();
  const dest = migratedHomeDir();

  let srcStat = null;
  try { srcStat = lstatSync(src); } catch { /* doesn't exist */ }

  if (srcStat && srcStat.isSymbolicLink()) {
    fatal(1, `already migrated: ${src} is a symlink -> ${readlinkSync(src)}`);
  }
  if (!srcStat) {
    fatal(1, `nothing to migrate: ${src} does not exist`);
  }
  if (existsSync(dest)) {
    fatal(1, `${dest} already exists — refusing to overwrite. Resolve manually before retrying.`);
  }

  log('');
  log('golem migrate-home');
  log(`  source: ${src}`);
  log(`  dest:   ${dest}`);

  // 1. Backup tarball (parent-relative tar so the archive contains a
  //    relocatable `golem/` entry, not an absolute-path member).
  const home = homedir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(home, `golem-config-backup-${stamp}.tar.gz`);
  const rel = src.startsWith(home + '/') ? src.slice(home.length + 1) : src;
  log(`  backing up to ${backupPath} ...`);
  const tarResult = spawnSync('tar', ['-czf', backupPath, '-C', home, rel], { stdio: 'inherit' });
  if (tarResult.status !== 0) {
    fatal(1, `backup failed (tar exit ${tarResult.status}) — aborting before touching ${src}`);
  }
  if (!existsSync(backupPath)) {
    fatal(1, `backup tarball missing after tar reported success — aborting: ${backupPath}`);
  }
  log(`  OK backup written: ${backupPath}`);

  // 2. Stop the dashboard (open SQLite handle on tracker.db inside src).
  const stopped = await stopDashboard();
  log(stopped.length ? `  OK dashboard stopped (${stopped.map(({ pid }) => `pid=${pid}`).join(', ')})` : '  dashboard was not running');

  // 3 + 4. Move, then symlink the old path to the new one.
  try {
    renameSync(src, dest);
    symlinkSync(dest, src);
  } catch (e) {
    fatal(1, `move/symlink failed: ${e.message}. Backup is intact at ${backupPath} — restore with: tar -xzf ${backupPath} -C ${home}`);
  }
  log(`  OK moved ${src} -> ${dest}`);
  log(`  OK symlinked ${src} -> ${dest}`);

  // 5. Restart the dashboard.
  log('  restarting dashboard...');
  const up = await startDashboardDetached();
  log(`  log: ${up.logFile}`);
  if (up.ok) {
    log('  OK dashboard responding');
  } else {
    const exit = up.exit
      ? up.exit.error
        ? `; child error: ${up.exit.error}`
        : `; child exit code=${up.exit.code ?? 'null'} signal=${up.exit.signal ?? 'null'}`
      : '';
    err(`  FAIL dashboard did not come back up within startup window${exit}. Log: ${up.logFile}`);
    if (up.tail) err(`\nLast log lines:\n${up.tail}`);
  }

  log('');
  log('Rollback (one operation): ');
  log(`  rm "${src}" && mv "${dest}" "${src}" && golem dashboard`);
  log(`  (or restore from backup: tar -xzf ${backupPath} -C ${home})`);
}

const ADAPTERS = { cc: ccAdapter, pi: piAdapter };
const KNOWN_TARGETS = ['cc', 'cc-marketplace', 'pi'];


function readPackageVersion() {
  return JSON.parse(readFileSync(resolve(GOLEM_ROOT, 'package.json'), 'utf8')).version;
}

function substrateRoot() {
  return process.env.GOLEM_SUBSTRATE_ROOT ? resolve(process.env.GOLEM_SUBSTRATE_ROOT) : resolve(GOLEM_ROOT, 'substrate');
}

function optionValue(args, name) {
  const idx = args.indexOf(name);
  return idx === -1 ? null : args[idx + 1];
}

function normalizeTarget(target) {
  if (target === 'claudecode') return 'cc';
  if (KNOWN_TARGETS.includes(target)) return target;
  fatal(2, `Unknown sync target/harness: ${target} (known: ${KNOWN_TARGETS.join(', ')}, claudecode)`);
}

function planForTarget(target) {
  const root = substrateRoot();
  if (target === 'cc-marketplace') {
    return ccAdapter.buildMarketplacePlan({ substrateRoot: root });
  }
  const adapter = ADAPTERS[target];
  if (!adapter) fatal(2, `Unknown sync target: ${target} (known: ${KNOWN_TARGETS.join(', ')})`);
  return adapter.buildPlan({ substrateRoot: root, repoRoot: GOLEM_ROOT, packageVersion: readPackageVersion() });
}

// Targets whose adapter renders a golem-owned block into a global instructions
// file the human also owns (~/.claude/CLAUDE.md). This
const INSTRUCTION_ADAPTERS = { cc: ccAdapter };

/** Instruction render plan for a target, or an empty plan when it has none.
 * The lock target is namespaced per harness because instructions land outside
 * the bundle's out dir and must not share its lockfile section. */
function instructionPlanFor(target) {
  const adapter = INSTRUCTION_ADAPTERS[target];
  if (!adapter) return { items: [], outDir: null, lockTarget: null };
  return {
    items: adapter.buildInstructionPlan({ substrateRoot: substrateRoot() }),
    outDir: adapter.instructionOutDir(),
    lockTarget: `${target}-instructions`,
  };
}

function knownProjects() {
  try {
    const doc = JSON.parse(readFileSync(projectsJsonPath(), 'utf8'));
    return (doc.projects ?? []).filter((p) => p?.path && existsSync(p.path));
  } catch {
    return [];
  }
}

function printDrift({ clean, drifted, orphaned }) {
  if (clean) {
    log('  OK clean — no drift');
    return;
  }
  if (drifted.length) {
    log('');
    log('  drifted:');
    for (const d of drifted) log(`    ${d.reason.padEnd(9)} ${d.key}`);
  }
  if (orphaned.length) {
    log('');
    log('  orphaned (source removed, output would be pruned):');
    for (const o of orphaned) log(`    orphan    ${o.key}`);
  }
}

function printTamper({ tampered, forceHint = '--force' }) {
  if (!tampered.length) return;
  log('');
  err(`  TAMPER — refused to overwrite; re-run with ${forceHint} to replace the managed region:`);
  for (const t of tampered) {
    const region = t.block ? ' (golem:instructions block)' : '';
    const why = t.reason ? ` — ${t.reason}` : '';
    err(`    ${t.outputRelPath}${region}${why}`);
  }
}

function warnVisibleGeneratedFiles({ projectRoot, outDir, items, result }) {
  const byKey = new Map(items.map((item) => [item.key, item.outputRelPath]));
  const relPaths = [];
  for (const key of new Set([...(result.written ?? []), ...(result.unchanged ?? [])])) {
    const relOut = byKey.get(key);
    if (!relOut) continue;
    relPaths.push(pathRelative(projectRoot, join(outDir, relOut)));
  }
  if (!relPaths.length) return;
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...relPaths], { cwd: projectRoot, encoding: 'utf8' });
  if (status.status !== 0) return;
  const visible = status.stdout.split('\0')
    .filter(Boolean)
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3));
  if (!visible.length) return;
  err('');
  err('  WARNING project render has generated files that are untracked and not gitignored:');
  for (const rel of visible) err(`    ${rel}`);
  err('  Add an ignore rule or intentionally track them before using project-scoped artifacts in this repo.');
}

function pathRelative(from, to) {
  const rel = relative(from, to);
  return rel || '.';
}

async function cmdSync(args) {
  const checkOnly = args.includes('--check');
  const all = args.includes('--all');
  const force = args.includes('--force');
  const explicitTarget = optionValue(args, '--target') || optionValue(args, '--harness');
  const target = normalizeTarget(explicitTarget || 'cc');
  const projectArg = optionValue(args, '--project');

  if (checkOnly && (all || (!explicitTarget && !projectArg && !optionValue(args, '--out') && args.filter((a) => a !== '--check').length === 0))) {
    return cmdSyncCheckAll();
  }

  if (projectArg) {
    if (target === 'cc-marketplace') fatal(2, '--project is not valid with cc-marketplace');
    return cmdSyncProject({ target, projectRoot: resolve(projectArg), checkOnly, force });
  }

  const customOut = optionValue(args, '--out');
  const outDir = customOut ? resolve(customOut) : renderDirFor(target);

  const items = planForTarget(target);
  // A custom --out means "render the bundle over there" (e.g. ./plugin for the
  // committed round-trip). Instructions always belong to the real harness home,
  // so they are deliberately skipped in that mode rather than misfiled.
  const { items: instructionItems, outDir: instructionOutDir, lockTarget: instructionLockTarget } =
    customOut ? { items: [], outDir: null, lockTarget: null } : instructionPlanFor(target);

  if (checkOnly) {
    const main = compiler.checkDrift({ target, outDir, items });
    const instr = instructionItems.length
      ? compiler.checkDrift({ target: instructionLockTarget, outDir: instructionOutDir, items: instructionItems })
      : { clean: true, drifted: [], orphaned: [] };
    const clean = main.clean && instr.clean;
    log('');
    log(`golem sync --check --target ${target}`);
    log(`  out: ${outDir}`);
    if (instructionItems.length) log(`  instructions out: ${instructionOutDir}`);
    printDrift({ clean, drifted: [...main.drifted, ...instr.drifted], orphaned: [...main.orphaned, ...instr.orphaned] });
    if (!clean) process.exit(1);
    return;
  }

  const main = compiler.render({
    target,
    outDir,
    items,
    packageVersion: readPackageVersion(),
    force,
  });
  const instr = instructionItems.length
    ? compiler.render({ target: instructionLockTarget, outDir: instructionOutDir, items: instructionItems, packageVersion: readPackageVersion(), force })
    : { written: [], unchanged: [], tampered: [], pruned: [] };
  if (target === 'cc') {
    ccAdapter.syncMcpChannelDeps({ repoRoot: GOLEM_ROOT, outDir });
  }
  if (target === 'cc-marketplace') {
    ccAdapter.ensureMarketplacePluginLink({ ccPluginDir: renderDirFor('cc'), marketplaceOutDir: outDir });
  }

  log('');
  log(`golem sync --target ${target}`);
  log(`  out: ${outDir}`);
  if (instructionItems.length) log(`  instructions out: ${instructionOutDir}`);
  const written = [...main.written, ...instr.written];
  const unchanged = [...main.unchanged, ...instr.unchanged];
  const tampered = [...main.tampered, ...instr.tampered];
  const pruned = [...main.pruned, ...instr.pruned];
  log(`  written: ${written.length}, unchanged: ${unchanged.length}, pruned: ${pruned.length}, tampered: ${tampered.length}`);
  if (tampered.length) {
    printTamper({ tampered });
    process.exit(1);
  }
  if (pruned.length) {
    log('');
    log('  pruned (source removed):');
    for (const p of pruned) log(`    ${p.outputRelPath}`);
  }
}

async function cmdSyncProject({ target, projectRoot, checkOnly, force }) {
  const root = substrateRoot();
  const packageVersion = readPackageVersion();
  const projectId = projectIdFor(projectRoot);
  log('');
  log(`golem sync --target ${target}${checkOnly ? ' --check' : ''} --project ${projectRoot}`);
  log(`  project_id: ${projectId}`);

  const outDir = projectRoot;
  const items = ccAdapter.buildProjectPlan({ substrateRoot: root, repoRoot: GOLEM_ROOT, packageVersion });
  if (checkOnly) {
    const res = compiler.checkDrift({ target: 'cc', outDir, items, projectId });
    log(`  out: ${outDir}`);
    printDrift(res);
    if (!res.clean) process.exit(1);
    return;
  }
  const res = compiler.render({ target: 'cc', outDir, items, packageVersion, force, projectId });
  log(`  out: ${outDir}`);
  log(`  written: ${res.written.length}, unchanged: ${res.unchanged.length}, pruned: ${res.pruned.length}, tampered: ${res.tampered.length}`);
  warnVisibleGeneratedFiles({ projectRoot, outDir, items, result: res });
  if (res.tampered.length) {
    log('');
    err('  TAMPER — refused to overwrite (hand-edited outside sync); re-run with --force:');
    for (const t of res.tampered) err(`    ${t.outputRelPath}`);
    process.exit(1);
  }
}

async function cmdSyncCheckAll({ quiet = false } = {}) {
  let drift = false;
  const say = quiet ? () => {} : log;
  if (!quiet) log('');
  say('golem sync --check --all');

  // Source lint runs once, before any render-drift check: word caps, resolving
  // `§` and `golem:` references, and one owner per fingerprinted rule.
  const lint = lintSubstrate({ substrateRoot: substrateRoot() });
  if (!quiet) log('');
  say(`substrate lint: ${lint.files} files, ${lint.total} words`);
  if (!quiet) {
    if (lint.clean) log('  clean');
    for (const f of lint.findings) err(`  ${f.check}: ${f.file} — ${f.detail}`);
  }
  drift = drift || !lint.clean;

  const ccOut = renderDirFor('cc');
  const cc = compiler.checkDrift({ target: 'cc', outDir: ccOut, items: planForTarget('cc') });
  const ccInstrOut = ccAdapter.instructionOutDir();
  const ccInstr = compiler.checkDrift({ target: 'cc-instructions', outDir: ccInstrOut, items: ccAdapter.buildInstructionPlan({ substrateRoot: substrateRoot() }) });
  if (!quiet) log('');
  say(`global cc: ${ccOut}`);
  say(`  instructions out: ${ccInstrOut}`);
  if (!quiet) printDrift({ clean: cc.clean && ccInstr.clean, drifted: [...cc.drifted, ...ccInstr.drifted], orphaned: [...cc.orphaned, ...ccInstr.orphaned] });
  drift = drift || !cc.clean || !ccInstr.clean;

  const marketplaceOut = renderDirFor('cc-marketplace');
  const marketplace = compiler.checkDrift({ target: 'cc-marketplace', outDir: marketplaceOut, items: planForTarget('cc-marketplace') });
  if (!quiet) log('');
  say(`global cc-marketplace: ${marketplaceOut}`);
  if (!quiet) printDrift(marketplace);
  drift = drift || !marketplace.clean;

  const piOut = renderDirFor('pi');
  const pi = compiler.checkDrift({ target: 'pi', outDir: piOut, items: planForTarget('pi') });
  if (!quiet) log('');
  say(`global pi: ${piOut}`);
  if (!quiet) printDrift(pi);
  drift = drift || !pi.clean;

  for (const p of knownProjects()) {
    const projectId = p.id || projectIdFor(p.path);
    const ccProj = compiler.checkDrift({ target: 'cc', outDir: p.path, items: ccAdapter.buildProjectPlan({ substrateRoot: substrateRoot() }), projectId });
    if (!quiet) log('');
    say(`project cc ${projectId}: ${p.path}`);
    if (!quiet) printDrift(ccProj);
    drift = drift || !ccProj.clean;
  }

  if (drift && !quiet) process.exit(1);
  return !drift;
}



function indent(text, pad) {
  return String(text || '').split('\n').map((l) => pad + l).join('\n');
}

async function cmdDoctor() {
  let failures = 0;
  function ok(label) { log(`  OK ${label}`); }
  function fail(label) { err(`  FAIL ${label}`); failures += 1; }
  function skip(label) { log(`  · ${label}`); }

  log('');
  log('golem doctor');

  log('');
  log('Tooling');
  (await hasCommand('node')) ? ok('node on PATH') : fail('node on PATH');
  (await hasCommand('npm')) ? ok('npm on PATH') : fail('npm on PATH');

  // The Claude plugin is installed from the workspace render; a stale install
  // means every Claude session runs old skills and hooks (GOL-303 C9).
  try {
    const installed = JSON.parse(readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const entry = installed?.plugins?.['golem@golem-workspace']?.[0];
    const want = readPackageVersion();
    if (!entry) skip('claude plugin golem@golem-workspace not installed');
    else if (entry.version === want) ok(`claude plugin golem@golem-workspace ${entry.version} matches package.json`);
    else fail(`claude plugin golem@golem-workspace is ${entry.version}, package.json is ${want} — golem sync --target cc && claude plugin update golem@golem-workspace`);
  } catch (e) {
    skip(`claude plugin parity not checked — ${e.message}`);
  }

  log('');
  log('Dashboard');
  existsSync(DASHBOARD_DIR) ? ok(`dashboard dir exists (${DASHBOARD_DIR})`) : fail('dashboard dir exists');
  existsSync(resolve(GOLEM_ROOT, 'node_modules')) ? ok('root node_modules') : fail('root node_modules — npm install (from the repo root)');
  try {
    await import('better-sqlite3');
    ok('better-sqlite3 loads from root node_modules');
  } catch (e) {
    fail(`better-sqlite3 failed to load — ${e.message}`);
  }

  log('');
  log('Workspace (~/.golem)');
  const legacy = legacyConfigDir();
  const migrated = migratedHomeDir();
  const legacyStat = existsSync(legacy) ? lstatSync(legacy) : null;
  if (existsSync(migrated)) {
    ok(`~/.golem exists (${migrated})`);
    if (legacyStat && legacyStat.isSymbolicLink()) {
      ok(`${legacy} is a compat symlink -> ${readlinkSync(legacy)}`);
    } else if (legacyStat && legacyStat.isDirectory()) {
      fail(`split-brain: ~/.golem exists AND ${legacy} is still a real directory (not a symlink) — a migration was interrupted or something recreated the old dir`);
    } else {
      skip(`${legacy} does not exist — nothing points at it`);
    }
  } else {
    skip(`not yet migrated — run \`golem migrate-home\` to move off ${legacy}`);
  }
  const dbPath = trackerDbPath();
  existsSync(dbPath) ? ok(`tracker DB readable (${dbPath})`) : fail(`tracker DB missing at ${dbPath}`);

  log('');
  log('Substrate sync');
  try {
    const clean = await cmdSyncCheckAll({ quiet: true });
    clean ? ok('sync --check --all clean') : fail('sync --check --all drifted — run `golem sync --check --all`');
  } catch (e) {
    fail(`could not run sync --check --all — ${e.message}`);
  }


  log('');
  log('LSP capability');
  try {
    const projects = knownProjects();
    if (!projects.length) {
      skip('no registered projects to check');
    }
    for (const p of projects) {
      try {
        const { projectId, lsp } = await updateProjectLsp(p.path);
        const label = p.name || projectId;
        if (lsp.available) ok(`${label}: ${lsp.servers.join(', ')}`);
        else skip(`${label}: none detected`);
      } catch (e) {
        skip(`${p.name || p.id || p.path}: could not check LSP — ${e.message}`);
      }
    }
  } catch (e) {
    skip(`could not record LSP capability — ${e.message}`);
  }

  log('');
  log('Worktrees');
  try {
    const projects = knownProjects();
    let worktreeProjects = 0;
    let staleCount = 0;
    for (const p of projects) {
      const wtDir = resolve(p.path, '.worktrees');
      if (!existsSync(wtDir)) continue;
      worktreeProjects++;
      let entries;
      try { entries = readdirSync(wtDir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const wtPath = resolve(wtDir, e.name);
        const gitFile = resolve(wtPath, '.git');
        if (!existsSync(gitFile)) continue;
        // Check staleness: >7 days old
        let stale = false;
        let reason = '';
        try {
          const st = statSync(wtPath);
          const ageDays = (Date.now() - st.mtimeMs) / (1000 * 60 * 60 * 24);
          if (ageDays > 7) { stale = true; reason = `idle ${Math.round(ageDays)}d`; }
        } catch { /* can't stat */ }
        // Check if branch is fully merged into main
        if (!stale) {
          try {
            const gitdirContent = readFileSync(gitFile, 'utf8');
            const m = gitdirContent.match(/^gitdir:\s*(.+)$/m);
            if (m) {
              const branchPath = m[1].trim();
              const branchName = basename(branchPath);
              const r = spawnSync('git', ['branch', '--list', '--merged', 'main', branchName], { cwd: p.path, encoding: 'utf8', timeout: 3000 });
              if (r.status === 0 && r.stdout.trim()) { stale = true; reason = 'merged into main'; }
            }
          } catch { /* can't check merge status */ }
        }
        if (stale) {
          staleCount++;
          log(`  ⚠ ${p.name || p.id}: .worktrees/${e.name} — ${reason}`);
        }
      }
    }
    if (staleCount === 0) {
      worktreeProjects > 0 ? ok(`no stale worktrees (${worktreeProjects} project(s) with .worktrees/)`) : skip('no .worktrees/ dirs found');
    } else {
      skip(`${staleCount} stale worktree(s) found — review and \`git worktree remove\` when done`);
    }
  } catch (e) {
    skip(`could not check worktrees — ${e.message}`);
  }

  log('');
  log('Dashboard server reachability');
  const probe = await probeDashboard();
  if (probe.ok) {
    const pc = probe.data?.project_count ?? '?';
    ok(`dashboard responding on ${dashboardUrl()} (${pc} projects)`);
  } else {
    skip(`dashboard not reachable (${probe.error}) — run \`golem dashboard\` to start`);
  }

  log('');
  if (failures === 0) {
    ok('all critical checks passed');
  } else {
    fail(`${failures} critical check(s) failed`);
    process.exit(1);
  }
}

function cmdHelp() {
  log(`golem — minimal Node CLI for the v4 harness.

Usage:
  npx golem <command> [args]
  node cli/golem.js <command> [args]

Run:
  dashboard [--public] [--port P] [npm-start-args…]
                       Start the admin dashboard on ${dashboardUrl()}.
                       --port is an explicit alternate port; --public binds
                       0.0.0.0 (LAN-reachable, no auth).
  dashboard:restart [--public] [--port P] [npm-start-args…]
                       Stop every matching dashboard process and restart detached.
  claude|cc [--backend native|ollama] [--model <id>] [-- <claude args...>]
                       Open Claude Code with Golem's development channel loaded;
                       optionally launch through Ollama with an explicit model.
  pi [--role <role>] [--profile <name>] [--provider <id> --model <id>] [--resume <session-id>] [-- <pi args...>]
                       Open native Pi with the canonical Golem bridge extension;
                       --role applies a validated role preset and --profile
                       selects a reusable model config; Pi keeps its own
                       profile, providers, and sessions.
  spawn <role> [--name X] [--profile <name>] [--project P] [--json]
                       Spawn one named Pi worker in detached tmux.
  list [--project P] [--all] [--json]
                       List worker records as a table; --all includes dead rows.
  attach <name>       Attach to a worker's real tmux TUI.
  peek <name> [--lines N]
                       Read worker scrollback without attaching.
  kill <name> [--json] Kill one worker and verify its process group is empty.
                       --json preserves the machine-readable worker records.
  role <role|clear> [--session <id-or-name>]
                         Set or clear a session role (${SESSION_ROLES.join(', ')}).
  ticket <operation> [args] [flags]
                       Flat agent authoring family over the tracker REST API:
                       list, get, create, update, replace-body, get-outline,
                       get-block, patch-blocks, add-comment, reply-comment,
                       update-comment. Mutations bind the trusted Pi/Claude CLI
                       session context (--human for unbound human shells);
                       --json is the stable contract: stdout carries
                       only result JSON, diagnostics go to stderr. See
                       golem ticket --help.
  session list|notify [--help]
                         Discover sessions or send idempotent notifications.
  schedule list|inspect|cancel [--help]
                         Manage durable delayed and recurring notifications.
  message inspect <id> [--content] [--json]
                         Inspect delivery without claiming task completion.
  sessions dedup [--apply]
                         Dry-run named-session duplicate cleanup; --apply marks
                         stale duplicate rows ended_at under sessions.json.lock.
  migrate-home         One-time move of ~/.config/golem -> ~/.golem (ADR-4).
                       Backs up first, stops the dashboard, moves, symlinks
                       the old path to the new one, restarts. Explicit only —
                       never runs automatically. Rollback is one command
                       (printed on completion).
  sync [--check] [--all] [--target cc|cc-marketplace|pi] [--out <dir>]
       [--force] [--project <root>]
                        Render substrate/ sources into a harness bundle
                        (default target: cc, default out: ~/.golem/renders/
                        cc-plugin/). --check reports drift without writing
                        (exit 0 clean, 1 drifted). --force overwrites a
                        hand-edited (tampered) output; without it, sync warns
                        and refuses that one file.
                        --project switches to project-scoped artifacts only,
                        rendering into the project root's harness-local dirs and
                        recording the lockfile under projects.<project_id>.
                         With --check --all, or only --check and no target/project args, reports
                        global renders plus all known project render sections.
                       Root instructions render as a marked block into
                       ~/.claude/CLAUDE.md. Text outside the markers is yours
                       and is never rewritten. Skipped when --out is given,
                       since the bundle is going elsewhere.

Inspect:
  doctor               Sanity-check the environment.
  status [--json]    Dashboard health + canonical URL.
  help                 Show this message.

Removed in v4 (no longer supported):
  install, cleanup, reinstall, session, project, dispatch, ack

Environment:
  GOLEM_ROOT           Workspace anchor (default: repo containing cli/golem.js).

Install:
  npm link             Symlinks ./cli/golem.js as a global \`golem\` command.
  npx golem <cmd>      Run without installing, from the repo root.
`);
}

function cmdRemoved(name) {
  fatal(2, `Error: \`${name}\` is a v3 subcommand that has been removed in golem v4.\n\nRun \`golem help\` for the surviving commands.`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'help';
  const rest = args.slice(1);

  if (removed.has(cmd)) {
    cmdRemoved(cmd);
    return;
  }

  switch (cmd) {
    case 'help':
    case '-h':
    case '--help':
      cmdHelp();
      break;
    case 'status':
      await cmdStatus(rest);
      break;
    case 'dashboard':
      await cmdDashboard(rest);
      break;
    case 'dashboard:restart':
      await cmdDashboardRestart(rest);
      break;
    case 'claude':
    case 'cc':
      await cmdClaude(rest);
      break;
    case 'pi':
      await cmdPi(rest);
      break;
    case 'spawn':
      await cmdSpawn(rest);
      break;
    case 'list':
      await cmdListWorkers(rest);
      break;
    case 'attach':
      await cmdAttachWorker(rest);
      break;
    case 'peek':
      await cmdPeekWorker(rest);
      break;
    case 'kill':
      await cmdKillWorker(rest);
      break;
    case 'role':
      await cmdRole(rest);
      break;
    case 'session':
    case 'schedule':
    case 'message': {
      const { runCollaboration } = await import('./collaboration.js');
      process.exitCode = await runCollaboration(cmd, rest);
      break;
    }
    case 'ticket': {
      const { runTicket } = await import('./ticket.js');
      process.exitCode = await runTicket(rest);
      break;
    }
    case 'sessions':
      await cmdSessions(rest);
      break;
    case 'migrate-home':
      await cmdMigrateHome(rest);
      break;
    case 'sync':
      await cmdSync(rest);
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    default:
      fatal(2, `Unknown command: ${cmd}\n\nRun \`golem help\` for available commands.`);
  }
}

main().catch((e) => fatal(1, e.stack || e.message));
