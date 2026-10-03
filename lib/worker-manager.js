// herdr host for managed agents (GOL-370): `golem spawn|list|peek|attach|kill`
// and the dashboard terminal preview + interrupt drive herdr panes inside the
// project's herdr session. The tmux host is gone; rows created before the
// cutover (tmux_* fields, no herdr_* fields) keep the legacy handling of
// G14 — they are never touched with herdr and refuse with the exact tmux
// command a human would run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardJsonPath, projectsJsonPath } from './golem-home.js';
import os from 'node:os';
import { resolveGolemDashboardBaseUrl } from './golem-client.js';
import { getRole } from './session-role.ts';
import { isGolemDevChannelPrompt } from './claude-channel.js';
import { resolveRoleExecution } from './role-preset.js';
import { projectIdFor, resolveProjectRoot } from './project-id.js';
import { markSessionFactsEnded, readSessionFacts } from './session-facts.js';
import { markSessionsEnded } from './session-registry.js';
import { herdrStateFor } from './team-herdr.js';
import { findTeam } from './team-registry.js';
import {
  ensureProjectAssociation, readManagementSnapshot, beforeNativeCall, recordNativeResult,
  commitAdmission, settleAdmission, reserveWorkspaceProvisioning, effectiveTeamForSession,
  projectManagementSnapshot, projectWorkerMembership, reallocateAdmissionRuntime,
} from './management-registry.js';
import {
  AGENTS_WORKSPACE_LABEL,
  SESSION_SCOPED_ENV,
  agentAttach,
  agentList,
  agentGet,
  agentRename,
  ensureSession,
  herdrSessionForProject,
  paneClose,
  paneList,
  paneProcessInfo,
  paneRead,
  paneRun,
  paneSendKeys,
  tabClose,
  tabCreate,
  workspaceCreate,
  workspaceClose,
  workspaceList,
} from './herdr-driver.js';
import {
  processIdsInGroup,
  captureProcessGroup,
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
import { managementRosterSnapshot } from './management-capabilities.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
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

/** The session a launch nonce belongs to (GOL-382 R5): the Pi adapter writes
 *  GOLEM_PI_LAUNCH_NONCE into observations.launch_nonce of its session fact. */
function sessionIdForNonce(nonce) {
  if (!nonce) return null;
  try {
    return readSessionFacts().find((fact) => fact?.observations?.launch_nonce === nonce)?.canonical_id ?? null;
  } catch {
    return null;
  }
}

/** Wait until the spawned agent is dispatchable. Binding is exact (GOL-382
 *  R5): by the launch nonce for Pi, by the pre-chosen session id for Claude.
 *  Names repeat across teams, so a name never binds a session. */
export async function waitForWorkerRegistration({
  projectId,
  name,
  nonce = null,
  sessionId = null,
  timeoutMs = numberEnv('GOLEM_WORKER_READY_TIMEOUT_MS', DEFAULT_READY_TIMEOUT_MS),
  pollMs = numberEnv('GOLEM_WORKER_POLL_MS', DEFAULT_POLL_MS),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  do {
    try {
      const rows = await dispatchable(projectId);
      if (process.env.GOL370_DEBUG_POLL) console.log(`[poll] rows=${JSON.stringify(rows.map((r) => [r.name, r.harness, r.session_id]))}`);
      const expected = sessionId ?? sessionIdForNonce(nonce);
      const match = rows.find((row) => row?.session_id && (
        (expected && row.session_id === expected) || (nonce && row.launch_nonce === nonce)
      ));
      if (match) return match;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  const suffix = lastError ? `; last dashboard error: ${lastError.message}` : '';
  // Name what the wait was for, so a stuck launch is diagnosable. Test
  // registration files are listed only when a test sets that directory.
  const waitedFor = sessionId ? `session ${sessionId}` : `launch nonce ${nonce}`;
  const detail = { dashboard_url: dashboardBaseUrl() };
  if (process.env.GOLEM_TEST_REGISTRATION_DIR) {
    try { detail.registration_files = fs.readdirSync(process.env.GOLEM_TEST_REGISTRATION_DIR); } catch (error) { detail.registration_files = `error: ${error.message}`; }
  }
  throw new Error(`worker ${name} did not become dispatchable within ${timeoutMs}ms (waited for ${waitedFor}; attach to its pane to see why)${suffix}; ${JSON.stringify(detail)}`);
}

/**
 * Wait until herdr detects the agent running on a pane (GOL-379). herdr
 * promotes the Pi process to an agent a beat after `pane run` starts it;
 * renaming before that has nothing to name. Throws past the bound so the
 * spawn failure path (row failed, tab closed) runs instead of leaving a
 * worker whose stored agent name herdr never heard.
 */
/** Answer Claude's dev-channel prompt for a Claude agent golem started
 *  (GOL-382 R11, human decision 1a). Presses Enter on option 1 only when the
 *  pane shows exactly golem's own channel; returns false when no such prompt
 *  shows before the timeout (the launch then proceeds and may still register). */
export async function confirmGolemDevChannel({
  session,
  paneId,
  timeoutMs = numberEnv('GOLEM_CLAUDE_PROMPT_TIMEOUT_MS', 30_000),
  pollMs = numberEnv('GOLEM_HERDR_AGENT_POLL_MS', DEFAULT_POLL_MS),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    let text = '';
    try { text = paneRead({ session, paneId, lines: 60 }); } catch { text = ''; }
    if (isGolemDevChannelPrompt(text)) {
      paneSendKeys({ session, paneId, keys: ['enter'] });
      return true;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return false;
}

export async function waitForHerdrAgent({
  session,
  paneId,
  timeoutMs = numberEnv('GOLEM_HERDR_AGENT_TIMEOUT_MS', DEFAULT_READY_TIMEOUT_MS),
  pollMs = numberEnv('GOLEM_HERDR_AGENT_POLL_MS', DEFAULT_POLL_MS),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  do {
    try {
      return agentGet({ session, target: paneId });
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(`herdr agent on pane ${paneId} was not detected within ${timeoutMs}ms; rename to the worker name never ran${lastError ? `; last herdr error: ${lastError.message}` : ''}`);
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

/** `herdr pane run` types the command into the pane shell and does not pass
 *  this process's env, so launch env rides on the command (GOL-382 R5). */
function withEnv(command, env = {}) {
  // The pane shell may carry the identity of the session that started the
  // herdr server; clear it so the agent starts as its own session (GOL-382).
  const unsets = SESSION_SCOPED_ENV.flatMap((key) => ['-u', key]);
  const pairs = Object.entries(env).filter(([, value]) => value != null && value !== '').map(([key, value]) => `${key}=${value}`);
  return ['env', ...unsets, ...pairs, ...command];
}

/** The golem CLI arguments that start one managed agent (GOL-382 R11). Pi
 *  resolves its own preset from --role/--profile; Claude gets its model and
 *  effort from the resolved preset and its session id up front, so golem
 *  binds it exactly. */
function launcherArgs(role, name, profile, preset, sessionId) {
  if (preset?.harness === 'claude') {
    return [
      'claude',
      ...(preset.model ? ['--model', preset.model] : []),
      '--',
      '--session-id', sessionId,
      '--name', name,
      ...(preset.thinking ? ['--effort', preset.thinking] : []),
    ];
  }
  return ['pi', '--role', role, '--name', name, ...(profile ? ['--profile', profile] : [])];
}

function launcherCommand(role, name, profile = null, env = {}, { preset = null, sessionId = null } = {}) {
  const configured = process.env.GOLEM_WORKER_CLI || process.env.GOLEM_BIN;
  const args = launcherArgs(role, name, profile, preset, sessionId);
  if (configured) {
    const executable = existingLauncher(configured);
    if (!executable) {
      throw new Error(`worker launcher ${configured} does not point to an existing executable path; set GOLEM_WORKER_CLI or GOLEM_BIN to an existing absolute path`);
    }
    const script = ['.js', '.mjs', '.cjs'].includes(path.extname(executable).toLowerCase());
    return withEnv(script ? [process.execPath, executable, ...args] : [executable, ...args], env);
  }
  const executable = checkoutCli();
  if (!executable) {
    throw new Error('worker launcher checkout CLI is unavailable; set GOLEM_WORKER_CLI or GOLEM_BIN to an existing executable path');
  }
  return withEnv([process.execPath, executable, ...args], env);
}

// Canonical snapshot seam; never a raw file or worker-cache lookup.
function findTeamRow(teamId) { return findTeam(teamId); }

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
 * Spawn one worker through the locked registry → herdr → dispatchable flow
 * (GOL-370 G5). `profile` (GOL-251 D8) is the explicit model-profile override;
 * the stored `preset` records the RESOLVED exec.
 */
export async function spawnWorker({ role, name = null, project = null, teamId = null, nativeSession = null, cwd = process.cwd(), profile = null } = {}, {
  native = { ensureSession, workspaceList, workspaceCreate, workspaceClose, tabCreate, tabClose, paneRun, paneList, paneProcessInfo, agentList, agentRename, agentGet },
  resolveProject = projectFromInput, resolveExecution = resolveRoleExecution,
  registration = waitForWorkerRegistration, detected = waitForHerdrAgent,
  assign = assignRole, barrier = async () => {},
} = {}) {
  const roleRecord = getRole(role);
  if (!roleRecord) throw new Error(`unknown role: ${role}`);
  const team = typeof teamId === 'string' && teamId.trim() ? teamId.trim() : null;
  const profileOverride = typeof profile === 'string' && profile.trim() ? profile.trim() : null;
  const execOverrides = profileOverride ? { profile: profileOverride } : {};
  const projectInfo = await resolveProject(project, cwd);
  const association = ensureProjectAssociation(projectInfo.projectId, nativeSession ? { session: nativeSession } : {});
  // Inventory is outside the short lock. Failure is unknown, not empty; only
  // a confirmed stopped/new session can skip the native collision inventory.
  let names = [];
  try { names = native.agentList(association.session).map(a => a.name ?? a.agent_name).filter(Boolean); }
  catch (error) {
    if (!/server_not_running|no herdr server|session.*not found/.test(error.message)) throw error;
  }
  let worker = claimWorker({ role: roleRecord.name, projectId: projectInfo.projectId,
    projectRoot: projectInfo.projectRoot, cwd: projectInfo.projectRoot, name,
    preset: resolveExecution(roleRecord.name, execOverrides), teamId: team, nativeNames: names });
  const operationId = worker.operation_id;
  const session = worker.herdr_session;
  const call = async (fn, resource) => {
    beforeNativeCall(operationId);
    const result = await fn();
    const recorded = recordNativeResult(operationId, resource?.(result));
    if (!recorded.valid) throw new Error(`launch fenced after native result: operation ${operationId}`);
    return result;
  };
  try {
    worker = updateWorker(worker.worker_id, { preset: resolveExecution(roleRecord.name, { ...execOverrides, name: worker.name }) });
    await barrier('before-native', worker);
    await call(() => native.ensureSession(session), result => ({ type: 'session', session, created: result.started }));
    const parent = readManagementSnapshot().mappings.projects[projectInfo.projectId];
    const teamRow = team ? findTeamRow(team) : null;
    let workspaceId = team ? teamRow?.herdr_workspace_id : parent.agents_workspace_id;
    const workspaces = native.workspaceList(session);
    if (!workspaceId || !workspaces.some(w => w.workspace_id === workspaceId)) {
      reserveWorkspaceProvisioning(operationId);
      const workspace = await call(() => native.workspaceCreate({ session, label: teamRow?.label ?? AGENTS_WORKSPACE_LABEL, cwd: projectInfo.projectRoot }),
        value => ({ type: 'workspace', session, workspace_id: value?.workspace_id, created: true }));
      workspaceId = workspace?.workspace_id;
      if (!workspaceId) throw new Error(`workspace result missing exact ID: operation ${operationId}`);
    }
    const created = await call(() => native.tabCreate({ session, workspaceId, label: worker.name, cwd: projectInfo.projectRoot }), value => ({
      type: 'tab', session, workspace_id: workspaceId, tab_id: value.tab?.tab_id ?? value.pane?.tab_id, pane_id: value.pane?.pane_id, created: true }));
    worker = readWorkers().find(w => w.worker_id === worker.worker_id);
    const paneId = created.pane?.pane_id;
    if (!paneId || !worker.herdr_tab_id) throw new Error(`pane result missing exact IDs: operation ${operationId}`);
    try {
      const shellGroup = native.paneProcessInfo({ session, paneId })?.foreground_process_group_id;
      worker = updateWorker(worker.worker_id, { pane_shell_ownership: captureProcessGroup(shellGroup) });
    } catch { /* missing root-shell evidence retains the pane after teardown */ }
    await barrier('after-pane', worker);
    // Collision recheck immediately before launch. A collision is never an
    // instruction to rename an unrelated native runtime.
    const nativeNames = native.agentList(session).map(a => a.name ?? a.agent_name).filter(Boolean);
    if (nativeNames.includes(worker.herdr_agent_name)) worker = reallocateAdmissionRuntime(operationId, nativeNames);
    const claude = worker.preset?.harness === 'claude';
    const claudeSessionId = claude ? crypto.randomUUID() : null;
    await call(() => native.paneRun({ session, paneId, command: launcherCommand(roleRecord.name, worker.name, profileOverride, claude
      ? { GOLEM_ROLE: roleRecord.name, GOLEM_CEO_SESSION_ID: claudeSessionId }
      : { GOLEM_PI_LAUNCH_NONCE: worker.worker_id }, { preset: worker.preset, sessionId: claudeSessionId }) }));
    if (claude) await confirmGolemDevChannel({ session, paneId });
    await detected({ session, paneId });
    // Native detection proves launch reached the foreground. Capture before
    // registration can fail, not the pre-launch shell or a later replacement.
    try {
      const group = native.paneProcessInfo({ session, paneId })?.foreground_process_group_id;
      const ownership = captureProcessGroup(group);
      worker = updateWorker(worker.worker_id, { pid: ownership.pgid,
        pid_birth: ownership.members.find(p => p.pid === ownership.pgid)?.birth ?? null,
        process_ownership: ownership, process_ownership_error: null });
    } catch (error) { worker = updateWorker(worker.worker_id, { process_ownership_error: error.message }); }
    await call(() => native.agentRename({ session, paneId, name: worker.herdr_agent_name }));
    native.agentGet({ session, target: worker.herdr_agent_name });
    const registered = await registration({ projectId: projectInfo.projectId, name: worker.name,
      nonce: claude ? null : worker.worker_id, sessionId: claudeSessionId });
    await barrier('before-commit', worker);
    beforeNativeCall(operationId);
    await assign(registered.session_id, roleRecord.name);
    recordNativeResult(operationId, null);
    worker = commitAdmission(operationId, { sessionId: registered.session_id,
      patch: { registered_at: new Date().toISOString(), channel_url: registered.channel_url ?? null } });
    return workerView(worker, registered);
  } catch (error) {
    markFailed(worker, error);
    const intent = readManagementSnapshot().mappings.intents.find(i => i.operation_id === operationId);
    // A timeout/death in the native-call window without a returned ID is not
    // a clean failure. Keep uncertainty durable; never relaunch by label.
    let uncertain = ['native_call', 'unresolved'].includes(intent.phase);
    try {
      const owned = intent.resources.filter(r => r.created).reverse();
      for (const resource of owned) {
        if (resource.type === 'tab' && resource.tab_id) {
          native.tabClose({ session: resource.session, tabId: resource.tab_id });
          if (native.paneList(resource.session).some(p => p.pane_id === resource.pane_id)) uncertain = true;
        }
        if (resource.type === 'workspace' && resource.workspace_id) {
          // Never close a workspace containing activity not created by this op.
          if (native.paneList(resource.session).some(p => p.workspace_id === resource.workspace_id)) uncertain = true;
          else if (!native.workspaceClose({ session: resource.session, workspaceId: resource.workspace_id })) uncertain = true;
        }
      }
      if (worker.pid && processIdsInGroup(worker.pid).length) uncertain = true;
    } catch { uncertain = true; }
    settleAdmission(operationId, { phase: uncertain ? 'unresolved' : 'cleaned', error: error.message });
    throw error;
  }
}

/** True when another occupied worker row holds the same session id. */
function sessionHeldByOtherLiveWorker(worker) {
  if (!worker?.session_id) return false;
  try {
    const active = activeWorkerStates();
    return readWorkers().some((row) => (
      row.worker_id !== worker.worker_id
      && row.session_id === worker.session_id
      && active.has(String(row.state || '').toLowerCase())
    ));
  } catch {
    return false;
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
 * per request; pass it in via { herdrStates } (pane id → state, plus live
 * name → state) or leave it null.
 */
export function enrichDispatchableRows(rows, { projectId = null, herdrStates = null, native, facts } = {}) {
  const membership = projectManagementSnapshot();
  const workersBySession = new Map(
    membership.workers.workers.map(w => projectWorkerMembership(w, membership)).filter(w => projectId == null || w.project_id === projectId)
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
  return managementRosterSnapshot((Array.isArray(rows) ? rows : []).map((row) => {
    const view = workersBySession.get(row?.session_id);
    const worker = view ? workerView(view, row) : null;
    const team = effectiveTeamForSession(row?.session_id, membership);
    const host = worker == null ? 'external' : (view.herdr_session || view.herdr_workspace_id ? 'herdr' : 'legacy');
    const herdrState = worker == null ? null : herdrStateFor(states, view);
    return {
      ...row,
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
      team_id: team?.team_id ?? null,
      team_label: team?.label ?? null,
      host,
      herdr_state: herdrState,
    };
  }), { snapshot: membership, native, facts });
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
  return managementRosterSnapshot(views.map((view) => {
    const team = view.team_id ? teamsById.get(view.team_id) ?? null : null;
    const host = view.herdr_session || view.herdr_workspace_id ? 'herdr' : 'legacy';
    const herdrState = herdrStateFor(states, view);
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
  }));
}

/**
 * The G9 agent roster: the dispatchable list enriched with worker/team/host
 * fields, plus dead and failed registry rows missing from the roster when
 * includeDead is set. When the dashboard is unreachable the roster half is
 * empty and live registry rows stand in, so the CLI still lists managed
 * agents offline (external sessions need the dashboard by definition).
 */
export async function listAgentRoster({ project = null, projectId: selectedProjectId = null, cwd = process.cwd(), includeDead = false, herdrStates = null } = {}) {
  const projectInfo = selectedProjectId ? { projectId: selectedProjectId } : project == null ? null : await projectFromInput(project, cwd);
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
      .filter((worker) => ENDED_WORKER_STATES.has(String(worker.state || '').toLowerCase())
        && !(worker.session_id && seen.has(worker.session_id)))
      .map((worker) => workerView(worker, null));
    return { roster: enriched, ended: fallbackEnriched(endedViews, projectId, herdrStates), projectId };
  }
  const views = listWorkers({ projectId })
    .filter((worker) => includeDead || LISTED_WORKER_STATES.has(String(worker.state || '').toLowerCase()))
    .map((worker) => workerView(worker, null));
  const live = views.filter((view) => LISTED_WORKER_STATES.has(String(view.state || '').toLowerCase()));
  const ended = views.filter((view) => ENDED_WORKER_STATES.has(String(view.state || '').toLowerCase()));
  const known = readSessionFacts().filter(f => (!projectId || (f.project_id ?? (f.project_path ? projectIdFor(f.project_path) : null)) === projectId)
    && !views.some(w => w.session_id === f.canonical_id) && (includeDead || !f.ended_at && !['dead', 'stopped', 'superseded'].includes(f.status)))
    .map(f => ({ ...f, session_id: f.canonical_id, project_id: f.project_id ?? (f.project_path ? projectIdFor(f.project_path) : null), delivery_ready: false, delivery_reason: 'dashboard readiness unavailable' }));
  return { roster: [...fallbackEnriched(live, projectId, herdrStates), ...managementRosterSnapshot(known)], ended: fallbackEnriched(ended, projectId, herdrStates), projectId };
}

export async function listWorkerViews({ project = null, cwd = process.cwd(), includeDead = false } = {}) {
  const projectInfo = project == null ? null : await projectFromInput(project, cwd);
  const rows = listWorkers({ projectId: projectInfo?.projectId ?? null })
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

export function currentWorkerPane(worker, native = { agentGet }) {
  if (worker.herdr_agent_name) {
    try { return native.agentGet({ session: worker.herdr_session, target: worker.herdr_agent_name })?.pane_id ?? worker.herdr_pane_id; }
    catch { /* A released native label does not invalidate the recorded pane. */ }
  }
  return worker.herdr_pane_id;
}

export async function closeNativeAgentPane({ session, paneId, name = paneId }, native = { paneClose, paneList }) {
  try {
    if (!native.paneClose({ session, paneId })) throw new Error('terminal close was not confirmed');
  } catch (error) {
    if (!/pane_not_found/.test(error.message)) throw new Error(`Could not stop ${name}: ${error.message}`, { cause: error });
  }
  if (native.paneList && native.paneList(session).some(row => row.pane_id === paneId)) {
    throw new Error(`Could not stop ${name}: its terminal is still open. Retry the same agent ID.`);
  }
}

function exactWorker(name, { workerId = null, constraints = {}, ...scope } = {}) {
  const worker = workerId ? readWorkers().find(w => w.worker_id === workerId) ?? null : findWorker(name, scope);
  if (worker) for (const [selector, field] of [['projectId', 'project_id'], ['teamId', 'team_id'], ['session', 'herdr_session']]) {
    if (constraints[selector] != null && constraints[selector] !== worker[field]) {
      const error = new Error(`explicit ${selector} ${constraints[selector]} conflicts with current agent ${worker.session_id ?? worker.worker_id} ${field} ${worker[field] ?? 'none'}`);
      error.code = 'INVALID_MANAGEMENT_SCOPE'; error.exitCode = 2; throw error;
    }
  }
  return worker;
}

/** Peek a pane's terminal output (GOL-370 G11: `pane read`). */
export async function peekWorker(name, { projectId = null, teamId = null, workerId = null, constraints = {}, lines = null } = {}) {
  const worker = exactWorker(name, { projectId, teamId, workerId, constraints });
  if (!worker) throw new Error(`worker not found: ${name}`);
  if (isLegacyRow(worker)) {
    throw new Error(`legacy tmux row — run it manually: ${legacyCommand('peek', worker)}`);
  }
  const paneId = currentWorkerPane(worker);
  if (!paneId) throw new Error(`No terminal is recorded for ${name}.`);
  return paneRead({ session: worker.herdr_session, paneId, lines: lines ?? 100 });
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

export async function peekSessionTerminal(sessionId, { lines = 100, projectId = null,
  native = { agentList, agentGet, paneProcessInfo, paneList, paneRead } } = {}) {
  if (!sessionId) throw new Error('session_id is required');
  const worker = readWorkers().find(w => w.session_id === sessionId);
  const facts = readSessionFacts();
  const fact = facts.find(f => f.canonical_id === sessionId);
  const actualProject = worker?.project_id ?? fact?.project_id ?? (fact?.project_path ? projectIdFor(fact.project_path) : null);
  const base = { ok: false, session_id: sessionId, name: worker?.name ?? fact?.name ?? null, text: null, lines, updated_at: new Date().toISOString() };
  if (projectId && actualProject && projectId !== actualProject) return { ...base, error: 'explicit project conflicts with conversation identity' };
  const row = managementRosterSnapshot([{ session_id: sessionId, project_id: actualProject, name: base.name }], { native, facts })[0];
  const evidence = { capabilities: row.capabilities, placement: row.placement, attach_hint: row.attach_hint };
  if (worker && isLegacyRow(worker)) return { ...base, ...evidence, error: `legacy tmux row — run it manually: ${legacyCommand('peek', worker)}` };
  if (row.capabilities.read.state !== 'available') return { ...base, ...evidence, error: row.capabilities.read.reason };
  try {
    const text = native.paneRead({ session: row.placement.session, paneId: row.placement.pane_id, lines });
    return { ...base, ...evidence, ok: true, text, herdr_session: row.placement.session, herdr_pane_id: row.placement.pane_id };
  } catch (error) { return { ...base, ...evidence, error: error.message }; }
}

/**
 * The herdr target an attach must use (GOL-379): the stored agent name
 * when herdr resolves it, else the stored pane id — `agent attach` accepts
 * either. Throws when the row carries neither, so attach fails loudly
 * instead of handing herdr an empty target.
 */
export function herdrAttachTarget(worker) {
  const name = worker?.herdr_agent_name ?? null;
  if (name) {
    try {
      agentGet({ session: worker.herdr_session, target: name });
      return name;
    } catch {
      // The rename never stuck (or the agent exited): fall through to pane.
    }
  }
  if (worker?.herdr_pane_id) return worker.herdr_pane_id;
  throw new Error(`worker ${worker?.name ?? 'unknown'} has no herdr agent target`);
}

export function attachWorker(name, { projectId = null, teamId = null, workerId = null, constraints = {}, outputToStderr = false } = {}) {
  const worker = exactWorker(name, { projectId, teamId, workerId, constraints });
  if (!worker) throw new Error(`worker not found: ${name}`);
  if (isLegacyRow(worker)) {
    throw new Error(`legacy tmux row — attach it manually: ${legacyCommand('peek', worker).replace('capture-pane -p', 'attach-session')}`);
  }
  return agentAttach({ session: worker.herdr_session, agentTarget: currentWorkerPane(worker), outputToStderr });
}

/** Print the herdr session a nameless attach must target (GOL-370). */
export function namelessAttachHint(projectId) {
  return `herdr --session ${herdrSessionForProject(projectId)}`;
}

/** Stop the uniquely selected native pane. Native hosting owns process teardown;
 * stale launch captures, app leases and caller authority never veto this command. */
export async function killWorker(name, { projectId = null, teamId = null, workerId = null, constraints = {},
  native = { agentGet, paneList, paneClose } } = {}) {
  // teamId scopes the name lookup to one team (GOL-371 team close): two
  // teams in one project can each have a builder1, which an unscoped
  // findWorker would refuse as ambiguous.
  const worker = exactWorker(name, { projectId, teamId, workerId, constraints });
  if (!worker) throw new Error(`worker not found: ${name}`);
  // Dead rows are historical tombstones.
  if (String(worker.state || '').toLowerCase() === 'dead') return workerView(worker, null);

  if (isLegacyRow(worker)) {
    throw new Error(`legacy tmux row — kill it manually: ${legacyCommand('kill', worker)}`);
  }
  const paneId = currentWorkerPane(worker, native);
  if (!worker.herdr_session || !paneId) throw new Error(`Cannot stop ${worker.name}: no terminal is recorded for this agent.`);
  await closeNativeAgentPane({ session: worker.herdr_session, paneId, name: worker.name }, native);
  const paneRetained = false;
  // Do not end a session another live worker row still holds (GOL-382 R5):
  // a stale shared binding must not hide a running agent.
  if (worker.session_id && !sessionHeldByOtherLiveWorker(worker)) {
    try { markSessionFactsEnded([worker.session_id], { status: 'stopped' }); } catch {}
    try { markSessionsEnded([worker.session_id], { status: 'stopped' }); } catch {}
  }
  const dead = updateWorker(worker.worker_id, {
    state: 'dead',
    ended_at: new Date().toISOString(),
    error: null,
    survivors: [],
    pane_retained: paneRetained,
  });
  return { ...workerView(dead, null), pane_retained: paneRetained };
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
  herdrAttachTarget,
  waitForHerdrAgent,
  killWorker,
});