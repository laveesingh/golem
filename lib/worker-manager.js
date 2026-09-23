// herdr host for managed agents (GOL-370): `golem spawn|list|peek|attach|kill`
// and the dashboard terminal preview + interrupt drive herdr panes inside the
// project's herdr session. The tmux host is gone; rows created before the
// cutover (tmux_* fields, no herdr_* fields) keep the legacy handling of
// G14 — they are never touched with herdr and refuse with the exact tmux
// command a human would run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardJsonPath, projectsJsonPath, teamsJsonPath } from './golem-home.js';
import os from 'node:os';
import { resolveGolemDashboardBaseUrl } from './golem-client.js';
import { getRole } from './session-role.js';
import { resolveRoleExecution } from './role-preset.js';
import { projectIdFor, resolveProjectRoot } from './project-id.js';
import { markSessionFactsEnded } from './session-facts.js';
import { markSessionsEnded } from './session-registry.js';
import { createTeamWorkspace } from './team-herdr.js';
import { herdrAgentNameFor, setTeamWorkspace } from './team-registry.js';
import {
  AGENTS_WORKSPACE_LABEL,
  agentAttach,
  agentRename,
  ensureSession,
  paneClose,
  paneList,
  paneProcessInfo,
  paneRead,
  paneRun,
  paneSendKeys,
  resolveSession,
  tabClose,
  tabCreate,
  workspaceEnsure,
} from './herdr-driver.js';
import {
  processIdsInGroup,
  processGroupMatches,
  terminateProcessGroup,
} from './process-group.js';
import {
  activeWorkerStates,
  claimWorker,
  findWorker,
  listWorkers,
  readWorkers,
  updateWorker,
} from './worker-registry.js';
import { listTeams } from './team-registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const temp = process.env.GOL370_TEST_TEMP ?? path.join(os.tmpdir(), 'gol370-debug-temp');
const DEFAULT_CLI = path.resolve(HERE, '..', 'cli', 'golem.js');
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_MS = 250;
const LISTED_WORKER_STATES = new Set(['spawning', 'live', 'failed']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  timeoutMs = numberEnv('GOLEM_WORKER_READY_TIMEOUT_MS', DEFAULT_READY_TIMEOUT_MS),
  pollMs = numberEnv('GOLEM_WORKER_POLL_MS', DEFAULT_POLL_MS),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  do {
    try {
      const rows = await dispatchable(projectId);
      if (process.env.GOL370_DEBUG_POLL) console.log(`[poll] rows=${JSON.stringify(rows.map((r) => [r.name, r.harness, r.session_id]))}`);
      const match = rows.find((row) => row?.harness === 'pi' && row?.name === name && row?.session_id);
      if (match) return match;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  const suffix = lastError ? `; last dashboard error: ${lastError.message}` : '';
  let lastRows = 'unavailable';
  try {
    lastRows = JSON.stringify({
      registration_files: fs.readdirSync(process.env.GOLEM_TEST_REGISTRATION_DIR ?? path.join(temp, 'registrations')),
      dashboard_url: dashboardBaseUrl(),
    });
  } catch (error) { lastRows = `error: ${error.message}`; }
  throw new Error(`worker ${name} did not become dispatchable within ${timeoutMs}ms${suffix}; last rows: ${lastRows}`);
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

function launcherCommand(role, name, profile = null) {
  const configured = process.env.GOLEM_WORKER_CLI || process.env.GOLEM_BIN;
  const args = ['pi', '--role', role, '--name', name];
  if (profile) args.push('--profile', profile);
  if (configured) {
    const executable = existingLauncher(configured);
    if (!executable) {
      throw new Error(`worker launcher ${configured} does not point to an existing executable path; set GOLEM_WORKER_CLI or GOLEM_BIN to an existing absolute path`);
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

/**
 * The herdr session a project's agents share (GOL-370 G2): the project's
 * display name, lowercased and clamped to herdr's `[a-z0-9_-]` alphabet.
 * `GOLEM_HERDR_SESSION` wins for test isolation; a name collision between two
 * known projects falls back to the project id.
 */
function findTeamRow(teamId) {
  try {
    return JSON.parse(fs.readFileSync(teamsJsonPath(), 'utf8')).teams
      ?.find((row) => row.team_id === teamId) ?? null;
  } catch {
    return null;
  }
}

export function herdrSessionForProject(projectId) {
  const override = process.env.GOLEM_HERDR_SESSION;
  if (override) return override;
  const id = String(projectId ?? '').trim();
  if (!id) throw new Error('project id is required to derive a herdr session');
  const known = readKnownProjects();
  const own = known.find((project) => project.project_id === id || project.id === id);
  const derived = String(own?.name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  if (derived) {
    const collision = known.some((project) => (
      project.project_id !== id
      && String(project?.name ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') === derived
    ));
    if (!collision) return derived;
  }
  return id;
}

function isLegacyRow(worker) {
  return !!worker?.tmux_session && !worker?.herdr_session && !worker?.herdr_pane_id;
}

function legacyCommand(kind, worker) {
  if (kind === 'kill') return `tmux -L ${worker.tmux_socket ?? 'golem'} kill-session -t ${worker.tmux_session}`;
  return `tmux -L ${worker.tmux_socket ?? 'golem'} capture-pane -p -t ${worker.tmux_session}`;
}

function markFailed(worker, error) {
  try {
    return updateWorker(worker.worker_id, {
      state: 'failed',
      error: String(error?.message ?? error),
    });
  } catch {
    return worker;
  }
}

/**
 * Ensure the project's herdr session and its one `agents` workspace exist
 * (GOL-363 G3, Task 1). Returns { session, workspace } with the workspace row
 * the spawn must store on the worker row.
 */
export async function ensureProjectWorkspace({ projectId, projectRoot } = {}) {
  const session = herdrSessionForProject(projectId);
  await ensureSession(session);
  const workspace = workspaceEnsure({ session, label: AGENTS_WORKSPACE_LABEL, cwd: projectRoot });
  return { session, workspace };
}

/**
 * Spawn one worker through the locked registry → herdr → dispatchable flow
 * (GOL-370 G5). `profile` (GOL-251 D8) is the explicit model-profile override;
 * the stored `preset` records the RESOLVED exec.
 */
export async function spawnWorker({ role, name = null, project = null, teamId = null, cwd = process.cwd(), profile = null } = {}) {
  const roleRecord = getRole(role);
  if (!roleRecord) throw new Error(`unknown role: ${role}`);
  const team = typeof teamId === 'string' && teamId.trim() ? teamId.trim() : null;
  const profileOverride = typeof profile === 'string' && profile.trim() ? profile.trim() : null;
  const execOverrides = profileOverride ? { profile: profileOverride } : {};
  const projectInfo = await projectFromInput(project, cwd);
  const initialPreset = resolveRoleExecution(roleRecord.name, execOverrides);
  const claimed = claimWorker({
    role: roleRecord.name,
    projectId: projectInfo.projectId,
    projectRoot: projectInfo.projectRoot,
    cwd: projectInfo.projectRoot,
    name,
    preset: initialPreset,
    teamId: team,
  });
  let worker = claimed;
  try {
    worker = updateWorker(claimed.worker_id, {
      preset: resolveRoleExecution(roleRecord.name, { ...execOverrides, name: claimed.name }),
      herdr_session: herdrSessionForProject(projectInfo.projectId),
    });
    const { session, workspace } = await ensureProjectWorkspace(projectInfo);
    worker = updateWorker(worker.worker_id, { herdr_session: session, herdr_workspace_id: workspace.workspace_id ?? null });
    // With a team, spawn into the team's herdr workspace and use the team
    // agent name (GOL-372 scope, herdrAgentNameFor).
    let herdrAgentName = worker.name;
    let workspaceId = workspace.workspace_id ?? null;
    if (team) {
      const teamRow = findTeamRow(team);
      const slug = teamRow?.slug ?? team;
      herdrAgentName = herdrAgentNameFor(slug, worker.name);
      const teamWorkspaceId = teamRow?.herdr_workspace_id ?? null;
      if (teamWorkspaceId) {
        workspaceId = teamWorkspaceId;
      } else {
        workspaceId = createTeamWorkspace(session, teamRow?.label ?? slug);
        setTeamWorkspace(team, workspaceId);
      }
    }
    const { pane } = tabCreate({
      session,
      workspaceId,
      label: worker.name,
      cwd: projectInfo.projectRoot,
    });
    const paneId = pane?.pane_id ?? null;
    worker = updateWorker(worker.worker_id, {
      herdr_tab_id: pane?.tab_id ?? null,
      herdr_pane_id: paneId,
      herdr_agent_name: herdrAgentName,
    });
    paneRun({ session, paneId, command: launcherCommand(roleRecord.name, worker.name, profileOverride) });
    try {
      agentRename({ session, paneId, name: herdrAgentName });
    } catch {
      // herdr promotes the pane to an agent when the Pi process registers; a
      // rename before that is best-effort — the agent name is stored on the row.
    }
    worker = updateWorker(worker.worker_id, { herdr_agent_name: herdrAgentName });
    const registered = await waitForWorkerRegistration({
      projectId: projectInfo.projectId,
      name: worker.name,
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
    if (process.env.GOLEM_PROBE_KEEP_TAB !== '1') {
      try {
        if (worker.herdr_tab_id) {
          tabClose({ session: herdrSessionForProject(projectInfo.projectId), tabId: worker.herdr_tab_id });
        }
      } catch { /* close best-effort */ }
    }
    throw error;
  }
}

function herdrPaneAlive(worker) {
  try {
    return paneList(herdrSession(worker)).some((pane) => pane.pane_id === worker.herdr_pane_id);
  } catch {
    return true; // "no herdr pane" never by itself means dead (GOL-370 G14).
  }
}

function reconcileHerdrWorker(worker) {
  if (worker.herdr_pane_id && herdrPaneAlive(worker)) return worker;
  // "No herdr pane" never by itself means dead: fall back to the recorded
  // process group. An empty recorded group is the only herdr death signal.
  if (worker.pid) {
    try {
      if (processIdsInGroup(worker.pid).length === 0) {
        return markHerdrDead(worker);
      }
    } catch { /* ps unavailable — keep the row */ }
  }
  return worker;
}

function markHerdrDead(worker) {
  try {
    const dead = updateWorker(worker.worker_id, {
      state: 'dead',
      ended_at: new Date().toISOString(),
    });
    if (worker.session_id) {
      try { markSessionFactsEnded([worker.session_id], { status: 'stopped' }); } catch {}
      try { markSessionsEnded([worker.session_id], { status: 'stopped' }); } catch {}
    }
    return dead;
  } catch {
    return worker;
  }
}

function reconcileWorker(worker) {
  if (!['spawning', 'live', 'failed'].includes(String(worker.state || '').toLowerCase())) return worker;
  // Legacy rows (G14): reconcile by the recorded pid group only — no tmux
  // needed — and mark dead only when the group is empty.
  if (isLegacyRow(worker)) {
    if (worker.pid) {
      try {
        if (processIdsInGroup(worker.pid).length === 0) return markHerdrDead(worker);
        return worker;
      } catch {
        return worker;
      }
    }
    return worker;
  }
  if (!worker.herdr_session && !worker.herdr_pane_id) return worker;
  return reconcileHerdrWorker(worker);
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
    attach_hint: `golem agent attach ${worker.name}`,
  };
}

/**
 * Add worker identity to an already-built dispatchable roster. The dashboard
 * owns the roster query, so this helper deliberately accepts rows instead of
 * calling /api/sessions/dispatchable and recursing through the server route.
 *
 * G9 team fields ride along additively: team_id, team_label, host and
 * herdr_state. host is herdr for herdr-placed rows, legacy for managed rows
 * that predate the cutover, and external for roster rows with no worker
 * record. herdr_state comes from one agent-list fetch per project session
 * per request; pass it in via { herdrStates } (name → state) or leave it
 * null.
 */
export function enrichDispatchableRows(rows, { projectId = null, herdrStates = null } = {}) {
  const workersBySession = new Map(
    listWorkers({ projectId })
      .map(reconcileWorker)
      .filter((worker) => worker.session_id)
      .map((worker) => [worker.session_id, worker]),
  );
  let teamsById = new Map();
  try {
    teamsById = new Map(listTeams({ projectId }).map((team) => [team.team_id, team]));
  } catch {
    teamsById = new Map();
  }
  const states = herdrStates instanceof Map ? herdrStates : new Map();
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const view = workersBySession.get(row?.session_id);
    const worker = view ? workerView(view, row) : null;
    const team = worker?.team_id ? teamsById.get(worker.team_id) ?? null : null;
    const host = worker == null ? 'external' : (view.herdr_session || view.herdr_workspace_id ? 'herdr' : 'legacy');
    const herdrState = worker == null ? null : (states.get(view.herdr_agent_name ?? view.name) ?? null);
    return {
      ...row,
      // Enriched rows come from the dispatchable roster: a matched worker
      // is delivery-ready by definition (mirrors fallbackEnriched).
      delivery_ready: worker != null,
      worker: worker ? {
        session_id: worker.session_id,
        name: worker.name,
        role: worker.role,
        model: worker.model,
        herdr_session: worker.herdr_session ?? null,
        herdr_pane_id: worker.herdr_pane_id ?? null,
        state: worker.state,
        attach_hint: worker.attach_hint,
        team_id: worker.team_id ?? null,
        team_label: team?.label ?? null,
        host,
        herdr_state: herdrState,
      } : null,
      worker_name: worker?.name ?? null,
      worker_role: worker?.role ?? null,
      worker_model: worker?.model ?? null,
      worker_tmux_session: worker?.tmux_session ?? null,
      worker_state: worker?.state ?? null,
      worker_attach_hint: worker?.attach_hint ?? null,
      team_id: worker?.team_id ?? null,
      team_label: team?.label ?? null,
      host,
      herdr_state: herdrState,
    };
  });
}

const ENDED_WORKER_STATES = new Set(['dead', 'failed']);

/** Enriched-shaped rows from registry views (offline fallback + ended rows). */
function fallbackEnriched(views, projectId, herdrStates) {
  let teamsById = new Map();
  try {
    teamsById = new Map(listTeams({ projectId }).map((team) => [team.team_id, team]));
  } catch {
    teamsById = new Map();
  }
  const states = herdrStates instanceof Map ? herdrStates : new Map();
  return views.map((view) => {
    const team = view.team_id ? teamsById.get(view.team_id) ?? null : null;
    const host = view.herdr_session || view.herdr_workspace_id ? 'herdr' : 'legacy';
    const herdrState = states.get(view.herdr_agent_name ?? view.name) ?? null;
    return {
      session_id: view.session_id ?? null,
      name: view.name,
      label: view.name,
      status: view.status ?? view.state,
      role: view.role,
      harness: view.harness ?? 'pi',
      project_id: view.project_id ?? null,
      model: view.model ?? null,
      provider: view.provider ?? null,
      delivery_ready: view.dispatchable ?? false,
      delivery_reason: null,
      idle_seconds: view.idle_seconds ?? null,
      worker: {
        session_id: view.session_id,
        name: view.name,
        role: view.role,
        model: view.model,
        tmux_session: view.tmux_session,
        state: view.state,
        attach_hint: view.attach_hint,
        team_id: view.team_id ?? null,
        team_label: team?.label ?? null,
        host,
        herdr_state: herdrState,
      },
      worker_name: view.name,
      worker_role: view.role,
      worker_model: view.model ?? null,
      worker_tmux_session: view.tmux_session ?? null,
      worker_state: view.state ?? null,
      worker_attach_hint: view.attach_hint ?? null,
      team_id: view.team_id ?? null,
      team_label: team?.label ?? null,
      host,
      herdr_state: herdrState,
    };
  });
}

/**
 * The G9 agent roster: the dispatchable list enriched with worker/team/host
 * fields, plus dead and failed registry rows missing from the roster when
 * includeDead is set. When the dashboard is unreachable the roster half is
 * empty and live registry rows stand in, so the CLI still lists managed
 * agents offline (external sessions need the dashboard by definition).
 */
export async function listAgentRoster({ project = null, cwd = process.cwd(), includeDead = false, herdrStates = null } = {}) {
  const projectInfo = project == null ? null : await projectFromInput(project, cwd);
  const projectId = projectInfo?.projectId ?? null;
  let roster = [];
  let rosterOk = false;
  try {
    roster = projectInfo ? await dispatchable(projectInfo.projectId) : await requestJson('/api/sessions/dispatchable', {
      timeoutMs: numberEnv('GOLEM_WORKER_REQUEST_TIMEOUT_MS', 1500),
    });
    if (!Array.isArray(roster)) roster = [];
    rosterOk = true;
  } catch {
    roster = [];
    rosterOk = false;
  }
  if (rosterOk) {
    const enriched = enrichDispatchableRows(roster, { projectId, herdrStates });
    if (!includeDead) return { roster: enriched, ended: [], projectId };
    const seen = new Set(enriched.map((row) => row.session_id).filter(Boolean));
    const endedViews = listWorkers({ projectId })
      .map(reconcileWorker)
      .filter((worker) => ENDED_WORKER_STATES.has(String(worker.state || '').toLowerCase())
        && !(worker.session_id && seen.has(worker.session_id)))
      .map((worker) => workerView(worker, null));
    return { roster: enriched, ended: fallbackEnriched(endedViews, projectId, herdrStates), projectId };
  }
  const views = listWorkers({ projectId })
    .map(reconcileWorker)
    .filter((worker) => includeDead || LISTED_WORKER_STATES.has(String(worker.state || '').toLowerCase()))
    .map((worker) => workerView(worker, null));
  const live = views.filter((view) => LISTED_WORKER_STATES.has(String(view.state || '').toLowerCase()));
  const ended = views.filter((view) => ENDED_WORKER_STATES.has(String(view.state || '').toLowerCase()));
  return { roster: fallbackEnriched(live, projectId, herdrStates), ended: fallbackEnriched(ended, projectId, herdrStates), projectId };
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

/** Peek a pane's terminal output (GOL-370 G11: `pane read`). */
export async function peekWorker(name, { projectId = null, teamId = null, lines = null } = {}) {
  const worker = findWorker(name, { projectId, teamId });
  if (!worker) throw new Error(`worker not found: ${name}`);
  if (isLegacyRow(worker)) {
    throw new Error(`legacy tmux row — run it manually: ${legacyCommand('peek', worker)}`);
  }
  if (!worker.herdr_pane_id) throw new Error(`worker ${name} has no herdr pane`);
  return paneRead({ session: worker.herdr_session, paneId: worker.herdr_pane_id, lines });
}

export function sendWorkerKeys(name, keys, { projectId = null } = {}) {
  const worker = findWorker(name, { projectId });
  if (!worker) throw new Error(`worker not found: ${name}`);
  if (isLegacyRow(worker)) {
    throw new Error(`legacy tmux row — run it manually: ${legacyCommand('peek', worker)}`);
  }
  if (!worker.herdr_pane_id) throw new Error(`worker ${name} has no herdr pane`);
  return paneSendKeys({ session: worker.herdr_session, paneId: worker.herdr_pane_id, keys });
}

export async function peekSessionTerminal(sessionId, { lines = 100, projectId = null } = {}) {
  if (!sessionId) throw new Error('session_id is required');
  const workers = readWorkers();
  const worker = workers.find((w) => w.session_id === sessionId || w.name === sessionId || w.herdr_agent_name === sessionId);
  if (worker) {
    if (isLegacyRow(worker)) {
      return {
        ok: false,
        session_id: worker.session_id || sessionId,
        name: worker.name,
        error: `legacy tmux row — run it manually: ${legacyCommand('peek', worker)}`,
        text: null,
        lines,
        updated_at: new Date().toISOString(),
      };
    }
    try {
      const text = paneRead({ session: worker.herdr_session, paneId: worker.herdr_pane_id, lines });
      return {
        ok: true,
        session_id: worker.session_id || sessionId,
        name: worker.name,
        herdr_session: worker.herdr_session,
        herdr_pane_id: worker.herdr_pane_id,
        lines,
        text,
        attach_hint: `golem agent attach ${worker.name}${worker.project_id ? ` --project ${worker.project_id}` : ''}`,
        updated_at: new Date().toISOString(),
      };
    } catch (err) {
      return {
        ok: false,
        session_id: worker.session_id || sessionId,
        name: worker.name,
        error: String(err?.message ?? err),
        text: null,
        lines,
        updated_at: new Date().toISOString(),
      };
    }
  }

  // GOL-370: there is no second host to fall back to — an unknown session has
  // no herdr pane. The response shape is unchanged.
  return {
    ok: false,
    session_id: sessionId,
    name: null,
    error: 'No active herdr pane found for this agent session',
    text: null,
    lines,
    updated_at: new Date().toISOString(),
  };
}

export function attachWorker(name, { projectId = null, teamId = null } = {}) {
  const worker = findWorker(name, { projectId, teamId });
  if (!worker) throw new Error(`worker not found: ${name}`);
  if (isLegacyRow(worker)) {
    throw new Error(`legacy tmux row — attach it manually: ${legacyCommand('peek', worker).replace('capture-pane -p', 'attach-session')}`);
  }
  if (!worker.herdr_agent_name) throw new Error(`worker ${name} has no herdr agent name`);
  return agentAttach({ session: worker.herdr_session, agentTarget: worker.herdr_agent_name });
}

/** Print the herdr session a nameless attach must target (GOL-370). */
export function namelessAttachHint(projectId) {
  return `herdr --session ${herdrSessionForProject(projectId)}`;
}

/** Kill a worker: herdr pane close with a verified process group, or a legacy refusal. */
export async function killWorker(name, { projectId = null, teamId = null } = {}) {
  // teamId scopes the name lookup to one team (GOL-371 team close): two
  // teams in one project can each have a builder1, which an unscoped
  // findWorker would refuse as ambiguous.
  const worker = findWorker(name, { projectId, teamId });
  if (!worker) throw new Error(`worker not found: ${name}`);
  // Dead rows are historical tombstones.
  if (String(worker.state || '').toLowerCase() === 'dead') return workerView(worker, null);

  if (isLegacyRow(worker)) {
    throw new Error(`legacy tmux row — kill it manually: ${legacyCommand('kill', worker)}`);
  }
  // A row without a herdr pane is not dead by itself (G14). Its recorded pid
  // group is torn down with the identity guard; a group that no longer
  // matches the worker's launch identity is left alone and the row still dies.
  let group = null;
  if (worker.herdr_pane_id) {
    let processInfo = null;
    try {
      processInfo = paneProcessInfo({ session: worker.herdr_session, paneId: worker.herdr_pane_id });
    } catch (error) {
      throw new Error(`herdr pane process-info failed for ${worker.name}: ${error.message}`);
    }
    group = processInfo?.foreground_process_group_id ?? null;
    if (group && processGroupMatches(group, { name: worker.name })) {
      // pane close must leave no survivors (GOL-364); terminate the recorded
      // group only as an identity-guarded fallback for survivors.
      paneClose({ session: worker.herdr_session, paneId: worker.herdr_pane_id });
    }
  } else if (worker.pid) {
    group = worker.pid;
  }
  let survivors = [];
  if (group) {
    survivors = await terminateProcessGroup(group, { identity: { name: worker.name } });
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
  }
  const dead = updateWorker(worker.worker_id, {
    state: 'dead',
    ended_at: new Date().toISOString(),
    error: null,
    survivors: [],
  });
  return workerView(dead, null);
}

export const workerManager = Object.freeze({
  resolveWorkerProject,
  waitForWorkerRegistration,
  spawnWorker,
  listWorkerViews,
  listAgentRoster,
  enrichDispatchableRows,
  peekWorker,
  attachWorker,
  killWorker,
});