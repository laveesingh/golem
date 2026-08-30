import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dashboardJsonPath, golemHome, projectsJsonPath } from './golem-home.js';
import { resolveGolemDashboardBaseUrl } from './golem-client.js';
import { getRole } from './session-role.js';
import { resolveRoleExecution } from './role-preset.js';
import { projectIdFor, resolveProjectRoot } from './project-id.js';
import { markSessionFactsEnded, retireEndpointLeasesForCanonical } from './session-facts.js';
import { markSessionsEnded } from './session-registry.js';
import {
  attachServer,
  capturePane,
  attachSession,
  killSession,
  newSession,
  panePid,
  hasSession,
  processGroupMatches,
  processIdsInGroup,
  resolveSocket,
  sendKeys,
  socketForProject,
  terminateProcessGroup,
} from './tmux-driver.js';
import {
  activeWorkerStates,
  claimWorker,
  findWorker,
  listWorkers,
  readWorkers,
  updateWorker,
} from './worker-registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI = path.resolve(HERE, '..', 'cli', 'golem.js');
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_MS = 250;
const LISTED_WORKER_STATES = new Set(['spawning', 'live', 'failed']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Locate pi's on-disk session file for a golem canonical session id.
 *
 * pi stores sessions at ~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<id>.jsonl
 * and only materializes the file after the first turn — a worker that never
 * took a turn has nothing to resume. Returns the absolute path or null.
 */
function findPiSessionFile(sessionId, { home = null } = {}) {
  if (!sessionId) return null;
  try {
    const sessionsRoot = home ?? path.join(os.homedir(), '.pi', 'agent', 'sessions');
    if (!fs.existsSync(sessionsRoot)) return null;
    for (const dir of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(sessionsRoot, dir.name);
      for (const file of fs.readdirSync(dirPath)) {
        if (file.includes(sessionId) && file.endsWith('.jsonl')) return path.join(dirPath, file);
      }
    }
  } catch {}
  return null;
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function dashboardBaseUrl() {
  if (process.env.GOLEM_DASHBOARD_URL) return process.env.GOLEM_DASHBOARD_URL.replace(/\/+$/, '');
  return resolveGolemDashboardBaseUrl({ dashboardFile: dashboardJsonPath() });
}

async function requestJson(pathname, { method = 'GET', body, timeoutMs = 1500 } = {}) {
  const url = new URL(pathname, `${dashboardBaseUrl()}/`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { 'X-Sender': 'cli', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!response.ok) {
      const detail = typeof parsed === 'object' && parsed?.error ? parsed.error : String(parsed || response.statusText);
      throw new Error(`dashboard ${method} ${pathname} → ${response.status} ${detail}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function readKnownProjects() {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectsJsonPath(), 'utf8'));
    return Array.isArray(parsed?.projects) ? parsed.projects : [];
  } catch {
    return [];
  }
}

async function projectFromInput(input, baseCwd = process.cwd()) {
  if (input == null || input === '') {
    const root = await resolveProjectRoot(baseCwd);
    return { projectRoot: root, projectId: projectIdFor(root) };
  }

  const value = String(input).trim();
  const known = readKnownProjects().find((project) => {
    if (project?.project_id === value || project?.id === value || project?.name === value) return true;
    if (!project?.path) return false;
    try { return projectIdFor(path.resolve(project.path)) === value; } catch { return false; }
  });
  const candidate = known?.path || value;
  try {
    const root = await resolveProjectRoot(path.resolve(baseCwd, candidate));
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
    return { projectRoot: root, projectId: projectIdFor(root) };
  } catch {
    throw new Error(`project not found or is not a directory: ${value}`);
  }
}

export async function resolveWorkerProject(input, { cwd = process.cwd() } = {}) {
  return projectFromInput(input, cwd);
}

async function dispatchable(projectId) {
  const query = `?project=${encodeURIComponent(projectId)}`;
  const rows = await requestJson(`/api/sessions/dispatchable${query}`, {
    timeoutMs: numberEnv('GOLEM_WORKER_REQUEST_TIMEOUT_MS', 1500),
  });
  if (!Array.isArray(rows)) throw new Error('dashboard dispatchable response was not an array');
  return rows.filter((row) => row?.project_id === projectId);
}

export async function waitForWorkerRegistration({
  projectId,
  name,
  harness = null,
  timeoutMs = numberEnv('GOLEM_WORKER_READY_TIMEOUT_MS', DEFAULT_READY_TIMEOUT_MS),
  pollMs = numberEnv('GOLEM_WORKER_POLL_MS', DEFAULT_POLL_MS),
} = {}) {
  // Polls are cheap now: state.refreshNativeSessions dedupes concurrent
  // refreshes and serves a 1s-fresh result, so the dispatchable endpoint no
  // longer re-spawns the `claude agents --json` probe per poll.
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  do {
    try {
      const rows = await requestJson(`/api/sessions/dispatchable?project=${encodeURIComponent(projectId)}`, {
        timeoutMs: 3_000,
      });
      if (!Array.isArray(rows)) throw new Error('dashboard dispatchable response was not an array');
      const match = rows.find((row) => (!harness || row?.harness === harness || (harness === 'pi' && (!row?.harness || row?.harness === 'pi')) || (harness === 'hermes' && row?.harness === 'hermes')) && row?.name === name && row?.session_id);
      if (match) return match;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  const suffix = lastError ? `; last dashboard error: ${lastError.message}` : '';
  throw new Error(`worker ${name} did not become dispatchable within ${timeoutMs}ms${suffix}`);
}

async function assignRole(sessionId, role) {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/role`, {
    method: 'POST',
    body: { role },
    timeoutMs: numberEnv('GOLEM_WORKER_REQUEST_TIMEOUT_MS', 1500),
  });
}

function existingLauncher(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = path.resolve(value.trim());
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return null;
    const script = ['.js', '.mjs', '.cjs'].includes(path.extname(candidate).toLowerCase());
    if (!script) fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function checkoutCli() {
  const candidates = [DEFAULT_CLI];
  let dir = path.resolve(process.cwd());
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(path.join(dir, 'cli', 'golem.js'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const invoked = typeof process.argv[1] === 'string' ? path.resolve(process.argv[1]) : null;
  if (invoked && path.basename(invoked) === 'golem.js') candidates.push(invoked);
  return candidates.map(existingLauncher).find(Boolean) || null;
}

function launcherCommand(role, name, profile = null, harness = 'pi', sessionId = null, resumeSessionId = null) {
  const configured = process.env.GOLEM_WORKER_CLI || process.env.GOLEM_BIN;
  const subcmd = harness === 'hermes' ? 'hermes' : 'pi';
  const args = [subcmd, '--role', role, '--name', name];
  // A launcher-owned canonical session id keeps the spawned harness, its fact
  // row, its worker row, and its channel registration on ONE identity without
  // waiting for the harness's own first-turn hook.
  if (sessionId) args.push('--session-id', sessionId);
  // Pi model switches restart the worker on the new profile while resuming
  // the prior conversation so in-flight context survives the switch.
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  // An explicit profile override is forwarded so the child `golem pi` resolves
  // the same way the parent just did (D8). No profile → the child resolves the
  // role's default model profile / leftover exec itself, identically.
  if (profile) args.push('--profile', profile);
  if (configured) {
    const executable = existingLauncher(configured);
    if (!executable) {
      throw new Error(`worker launcher ${configured} does not point to an existing executable path; set GOLEM_WORKER_CLI or GOLEM_BIN to an absolute path`);
    }
    const script = ['.js', '.mjs', '.cjs'].includes(path.extname(executable).toLowerCase());
    return script ? [process.execPath, executable, ...args] : [executable, ...args];
  }
  const executable = checkoutCli();
  if (!executable) {
    throw new Error('worker launcher checkout CLI is unavailable; set GOLEM_WORKER_CLI or GOLEM_BIN to an existing executable path');
  }
  return [process.execPath, executable, ...args];
}

/** The socket a worker's tmux session lives on: GOLEM_TMUX_SOCKET wins, then the row's stored tmux_socket, then the legacy shared 'golem' server for rows that predate per-project sockets. */
function workerSocket(worker) {
  return resolveSocket(worker?.tmux_socket ?? null);
}

function markFailed(worker, error) {
  try {
    return updateWorker(worker.worker_id, {
      state: 'failed',
      ended_at: new Date().toISOString(),
      error: String(error?.message ?? error),
    });
  } catch {
    return worker;
  }
}

/** Spawn one worker through the locked registry → tmux → dispatchable flow.
 *
 * `profile` (GOL-251 D8): explicit model-profile override. The worker's stored
 * `preset` records the RESOLVED exec (profile > role default > exec) so
 * `golem list` shows what actually runs, not the role default.
 */
export async function spawnWorker({ role, name = null, project = null, cwd = process.cwd(), profile = null, resumeSessionId = null } = {}) {
  const roleRecord = getRole(role);
  if (!roleRecord) throw new Error(`unknown role: ${role}`);
  const profileOverride = typeof profile === 'string' && profile.trim() ? profile.trim() : null;
  const execOverrides = profileOverride ? { profile: profileOverride } : {};
  const projectInfo = await projectFromInput(project, cwd);
  // Reconcile dead/stale workers first so dead names are freed for re-spawn
  reconcileAllWorkers(projectInfo.projectId);
  if (name) {
    try {
      const existing = findWorker(name, { projectId: projectInfo.projectId });
      if (existing && (existing.state === 'failed' || existing.state === 'spawning')) {
        await killWorker(name, { projectId: projectInfo.projectId });
      }
    } catch {}
  }
  // Resolve through T1. The explicit worker name wins over a role's optional
  // name preset so the tmux identity and Pi display name stay identical.
  const initialPreset = resolveRoleExecution(roleRecord.name, execOverrides);
  const claimed = claimWorker({
    role: roleRecord.name,
    projectId: projectInfo.projectId,
    projectRoot: projectInfo.projectRoot,
    cwd: projectInfo.projectRoot,
    name,
    preset: initialPreset,
  });
  let worker = claimed;
  try {
    worker = updateWorker(claimed.worker_id, {
      // The claimed name is the explicit Pi session name, even when the role
      // preset had its own optional name field.
      preset: resolveRoleExecution(roleRecord.name, { ...execOverrides, name: claimed.name }),
    });
    if (hasSession(worker.tmux_session, { socket: workerSocket(worker) })) {
      throw new Error(`tmux session already exists: ${worker.tmux_session}`);
    }
    // Claim is durable before this call. The command is exec'd inside tmux so
    // pane_pid is the golem pi pid and, by contract, also its process group id.
    // A launcher-owned canonical session id keeps the spawned harness, its fact
    // row, its worker row, and its channel registration on ONE identity without
    // waiting for the harness's own first-turn hook.
    const canonicalSessionId = worker.preset?.harness === 'hermes' ? crypto.randomUUID() : null;
    // Pi workers can carry their conversation across a model switch via the
    // harness's own `--resume`; hermes restarts fresh (its resume ids are
    // harness-internal and not the golem canonical id).
    const resumeId = worker.preset?.harness === 'pi' ? resumeSessionId : null;
    newSession({
      name: worker.tmux_session,
      cwd: projectInfo.projectRoot,
      command: launcherCommand(roleRecord.name, worker.name, profileOverride, worker.preset?.harness || 'pi', canonicalSessionId, resumeId),
      width: 200,
      height: 50,
      socket: workerSocket(worker),
    });
    const pid = panePid(worker.tmux_session, { socket: workerSocket(worker) });
    worker = updateWorker(worker.worker_id, { pid });
    // A resumed pi session replays its stored transcript at boot, which can
    // take materially longer than a fresh boot (a 1.5k-line history rendered
    // before the extension registers). Give it a wider readiness window.
    const readyTimeoutMs = resumeId
      ? Math.max(45_000, numberEnv('GOLEM_WORKER_READY_TIMEOUT_MS', DEFAULT_READY_TIMEOUT_MS))
      : numberEnv('GOLEM_WORKER_READY_TIMEOUT_MS', DEFAULT_READY_TIMEOUT_MS);
    const registered = await waitForWorkerRegistration({
      projectId: projectInfo.projectId,
      name: worker.name,
      harness: worker.preset?.harness || 'pi',
      timeoutMs: readyTimeoutMs,
    });
    await assignRole(registered.session_id, roleRecord.name);
    worker = updateWorker(worker.worker_id, {
      session_id: registered.session_id,
      state: 'live',
      error: null,
      registered_at: new Date().toISOString(),
      channel_url: registered.channel_url ?? null,
    });
    return workerView(worker, registered);
  } catch (error) {
    markFailed(worker, error);
    throw error;
  }
}

export function reconcileAllWorkers(projectId = null) {
  try {
    const workers = listWorkers({ projectId });
    for (const w of workers) reconcileWorker(w);
  } catch {}
}

/** Switch a golem-managed worker onto a different model profile.
 *
 * The universal mechanism is a controlled restart: the harness's model is
 * resolved at launch time from `--profile`, so switching means terminate the
 * current tmux process group and relaunch with the new profile under the SAME
 * role + name. Pi workers additionally attempt to resume their prior
 * conversation (`golem pi --resume <session>` → pi `--session <id>`) so
 * in-flight context survives the switch; if the harness has no stored session
 * for that id (e.g. the worker never took a turn), the switch falls back to a
 * fresh spawn instead of failing. Hermes workers restart fresh (its resume ids
 * are harness-internal).
 */
export async function switchWorkerModel(name, { projectId = null, profile = null, resume = true } = {}) {
  if (typeof profile !== 'string' || !profile.trim()) throw new Error('profile is required to switch models');
  const worker = findWorker(name, { projectId });
  if (!worker) throw new Error(`worker not found: ${name}`);
  const harness = String(worker.preset?.harness || 'pi').toLowerCase();
  if (!['pi', 'hermes'].includes(harness)) {
    throw new Error(`model switching requires a golem-managed worker (pi or hermes); worker ${name} runs ${harness}`);
  }
  const projectId2 = worker.project_id ?? projectId;
  const oldSessionId = worker.session_id ?? null;
  await killWorker(worker.name, { projectId: projectId2 });
  const spawnOpts = {
    role: worker.role,
    name: worker.name,
    project: projectId2,
    profile: profile.trim(),
  };
  if (harness === 'pi' && resume && oldSessionId) {
    // Resume is only possible when pi actually persisted the session — the
    // file materializes after the first turn. Without it, fall through to a
    // fresh spawn immediately instead of burning the readiness window.
    const sessionFile = findPiSessionFile(oldSessionId);
    if (sessionFile) {
      try {
        const resumed = await spawnWorker({ ...spawnOpts, resumeSessionId: sessionFile });
        return { ...resumed, resumed: true };
      } catch {
        // Resume boot failed (slow transcript replay, harness refusal) — a
        // fresh spawn on the new profile is strictly better than surfacing it.
      }
    }
  }
  const fresh = await spawnWorker(spawnOpts);
  return { ...fresh, resumed: false };
}

function reconcileWorker(worker) {
  if (!['spawning', 'live', 'failed'].includes(String(worker.state || '').toLowerCase())) return worker;
  let alive = false;
  try {
    alive = worker.pid ? processIdsInGroup(worker.pid).length > 0 : hasSession(worker.tmux_session, { socket: workerSocket(worker) });
  } catch {
    alive = true;
  }
  if (alive) return worker;
  try {
    const dead = updateWorker(worker.worker_id, {
      state: 'dead',
      ended_at: new Date().toISOString(),
    });
    if (worker.session_id) {
      try { markSessionFactsEnded([worker.session_id], { status: 'stopped' }); } catch {}
      try { markSessionsEnded([worker.session_id], { status: 'stopped' }); } catch {}
      try { retireEndpointLeasesForCanonical([worker.session_id]); } catch {}
    }
    return dead;
  } catch {
    return worker;
  }
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function idleSeconds(worker, roster = null) {
  const started = timestampMs(roster?.status === 'idle' ? (roster.updated_at ?? worker.spawned_at) : worker.spawned_at);
  return started == null ? null : Math.max(0, Math.floor((Date.now() - started) / 1000));
}

function workerView(worker, roster = null) {
  const idle = idleSeconds(worker, roster);
  return {
    ...worker,
    model: worker.preset?.model ?? null,
    provider: worker.preset?.provider ?? null,
    harness: worker.preset?.harness ?? 'pi',
    status: worker.state === 'live' ? (roster?.status ?? worker.state) : worker.state,
    dispatchable: worker.state === 'live' && !!roster,
    idle_seconds: idle,
    attach_hint: `golem attach ${worker.name}`,
  };
}

/**
 * Add worker identity to an already-built dispatchable roster. The dashboard
 * owns the roster query, so this helper deliberately accepts rows instead of
 * calling /api/sessions/dispatchable and recursing through the server route.
 */
export function enrichDispatchableRows(rows, { projectId = null } = {}) {
  const workersBySession = new Map(
    listWorkers({ projectId })
      .map(reconcileWorker)
      .filter((worker) => worker.session_id)
      .map((worker) => [worker.session_id, worker]),
  );
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const view = workersBySession.get(row?.session_id);
    const worker = view ? workerView(view, row) : null;
    return {
      ...row,
      worker: worker ? {
        session_id: worker.session_id,
        name: worker.name,
        role: worker.role,
        model: worker.model,
        tmux_session: worker.tmux_session,
        state: worker.state,
        attach_hint: worker.attach_hint,
      } : null,
      worker_name: worker?.name ?? null,
      worker_role: worker?.role ?? null,
      worker_model: worker?.model ?? null,
      worker_tmux_session: worker?.tmux_session ?? null,
      worker_state: worker?.state ?? null,
      worker_attach_hint: worker?.attach_hint ?? null,
    };
  });
}

export async function listWorkerViews({ project = null, cwd = process.cwd(), includeDead = false } = {}) {
  const projectInfo = project == null ? null : await projectFromInput(project, cwd);
  const rows = listWorkers({ projectId: projectInfo?.projectId ?? null })
    .map(reconcileWorker)
    .filter((worker) => includeDead || LISTED_WORKER_STATES.has(String(worker.state || '').toLowerCase()));
  let roster = [];
  try {
    roster = projectInfo ? await dispatchable(projectInfo.projectId) : await requestJson('/api/sessions/dispatchable', {
      timeoutMs: numberEnv('GOLEM_WORKER_REQUEST_TIMEOUT_MS', 1500),
    });
    if (!Array.isArray(roster)) roster = [];
  } catch {
    roster = [];
  }
  const bySession = new Map(roster.filter((row) => row?.session_id).map((row) => [row.session_id, row]));
  return rows.map((worker) => workerView(worker, bySession.get(worker.session_id) ?? null));
}

export async function peekWorker(name, { projectId = null, lines = null } = {}) {
  const worker = findWorker(name, { projectId });
  if (!worker) throw new Error(`worker not found: ${name}`);
  return capturePane(worker.tmux_session, lines, { socket: workerSocket(worker) });
}

export function sendWorkerKeys(name, keys, { projectId = null } = {}) {
  const worker = findWorker(name, { projectId });
  if (!worker) throw new Error(`worker not found: ${name}`);
  return sendKeys(worker.tmux_session, keys, { socket: workerSocket(worker) });
}

export async function peekSessionTerminal(sessionId, { lines = 100, projectId = null, sessionName = null } = {}) {
  if (!sessionId) throw new Error('session_id is required');
  const workers = readWorkers();
  const worker = workers.find((w) => w.session_id === sessionId)
    || workers.find((w) => w.name === sessionId && (!projectId || w.project_id === projectId))
    || (sessionName ? workers.find((w) => w.name === sessionName && (!projectId || w.project_id === projectId)) : null);

  if (worker) {
    try {
      const text = capturePane(worker.tmux_session, lines, { socket: workerSocket(worker) });
      return {
        ok: true,
        session_id: worker.session_id || sessionId,
        name: worker.name,
        tmux_session: worker.tmux_session,
        socket: workerSocket(worker),
        lines,
        text,
        output: text,
        attach_hint: `golem attach ${worker.name}${worker.project_id ? ` --project ${worker.project_id}` : ''}`,
        updated_at: new Date().toISOString(),
      };
    } catch (err) {
      // If capturing on stored worker socket fails, try fallback sockets below
    }
  }

  // Fallback: check candidate sockets (project socket, stored socket, 'golem', default) for candidate names
  const candidateNames = [sessionId, sessionName, worker?.name, worker?.tmux_session].filter(Boolean);
  const candidateSockets = [
    projectId ? socketForProject(projectId) : null,
    worker?.tmux_socket ? resolveSocket(worker.tmux_socket) : null,
    'golem',
    null,
  ].filter((v, i, a) => a.indexOf(v) === i);

  for (const socket of candidateSockets) {
    for (const name of candidateNames) {
      try {
        if (socket !== undefined && hasSession(name, { socket })) {
          const text = capturePane(name, lines, { socket });
          return {
            ok: true,
            session_id: sessionId,
            name: name,
            tmux_session: name,
            socket: resolveSocket(socket),
            lines,
            text,
            output: text,
            attach_hint: `golem attach ${name}${projectId ? ` --project ${projectId}` : ''}`,
            updated_at: new Date().toISOString(),
          };
        }
      } catch {}
    }
  }

  return {
    ok: false,
    session_id: sessionId,
    name: worker?.name || sessionName || null,
    error: 'No active tmux terminal found for this agent session',
    text: null,
    lines,
    updated_at: new Date().toISOString(),
  };
}

export function attachWorker(name, { projectId = null } = {}) {
  const worker = findWorker(name, { projectId });
  if (!worker) throw new Error(`worker not found: ${name}`);
  return attachSession(worker.tmux_session, { socket: workerSocket(worker) });
}

/** Attach the caller's terminal to the project's whole worker swarm (its tmux server tree). */
export function attachSwarm(projectId) {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('project id is required to attach a swarm');
  return attachServer(swarmSocketFor(projectId.trim()));
}

/**
 * Resolve the tmux socket a project's swarm attach must target. During the
 * mixed era the project's occupied rows decide it: legacy rows (no stored
 * socket) live on the shared 'golem' server, new rows on their per-project
 * server. All occupied rows on one socket → that socket; nothing occupied →
 * the derived per-project socket (a fresh swarm); more than one socket →
 * refuse and list which socket holds which workers, so the human chooses.
 */
export function swarmSocketFor(projectId) {
  const id = String(projectId ?? '').trim();
  if (!id) throw new Error('project id is required to resolve a swarm socket');
  const activeStates = activeWorkerStates();
  const occupiedRows = listWorkers({ projectId: id })
    .filter((row) => activeStates.has(String(row.state || '').toLowerCase()));
  if (!occupiedRows.length) return resolveSocket(socketForProject(id));
  const bySocket = new Map();
  for (const row of occupiedRows) {
    const rowSocketName = workerSocket(row);
    if (!bySocket.has(rowSocketName)) bySocket.set(rowSocketName, []);
    bySocket.get(rowSocketName).push(row.name);
  }
  if (bySocket.size > 1) {
    const breakdown = [...bySocket.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rowSocketName, names]) => `${rowSocketName} → ${names.sort().join(', ')}`)
      .join('; ');
    throw new Error(`project ${id} workers span more than one tmux socket; attach one directly with tmux -L <socket> attach — ${breakdown}`);
  }
  return bySocket.keys().next().value;
}

export async function killWorker(name, { projectId = null } = {}) {
  const worker = findWorker(name, { projectId });
  if (!worker) throw new Error(`worker not found: ${name}`);
  // Dead rows are historical tombstones. Killing one must not touch a stale
  // tmux session or a recycled pid, even if the name is reused in old state.
  if (String(worker.state || '').toLowerCase() === 'dead') return workerView(worker, null);

  let tmuxError = null;
  try {
    killSession(worker.tmux_session, { socket: workerSocket(worker) });
  } catch (error) {
    tmuxError = error;
  }
  let survivors = [];
  if (worker.pid) {
    survivors = await terminateProcessGroup(worker.pid, {
      identity: { name: worker.name },
    });
  }
  if (survivors.length) {
    try {
      updateWorker(worker.worker_id, {
        state: 'failed',
        error: `teardown left process-group survivors: ${survivors.join(', ')}`,
      });
    } catch {}
    throw new Error(`worker teardown left process-group survivors: ${survivors.join(', ')}`);
  }
  if (worker.session_id) {
    try { markSessionFactsEnded([worker.session_id], { status: 'stopped' }); } catch {}
    try { markSessionsEnded([worker.session_id], { status: 'stopped' }); } catch {}
    try { retireEndpointLeasesForCanonical([worker.session_id]); } catch {}
  }
  const dead = updateWorker(worker.worker_id, {
    state: 'dead',
    ended_at: new Date().toISOString(),
    error: tmuxError ? tmuxError.message : null,
    survivors: [],
  });
  if (tmuxError) throw tmuxError;
  return workerView(dead, null);
}

export const workerManager = Object.freeze({
  resolveWorkerProject,
  waitForWorkerRegistration,
  spawnWorker,
  switchWorkerModel,
  listWorkerViews,
  enrichDispatchableRows,
  peekWorker,
  attachWorker,
  attachSwarm,
  swarmSocketFor,
  killWorker,
});
