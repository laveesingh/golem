import crypto from 'node:crypto';
import { workersJsonPath } from './golem-home.js';
import {
  readManagementSnapshot, projectManagementSnapshot, projectWorkerMembership,
  withManagementTransaction, managementFiles, newAdmissionIn, allocateNativeHandle,
  commitAdmission, transferMembershipIn,
} from './management-registry.js';
export const WORKERS_REGISTRY_VERSION = 1;
export const WORKER_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_STATES = new Set(['spawning', 'live', 'failed']);
const occupied = row => ACTIVE_STATES.has(row.state);
const copy = value => JSON.parse(JSON.stringify(value));
export function normalizeName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('worker name is required');
  const value = name.trim();
  if (value.length > 80 || /[\r\n]/.test(value)) throw new Error('worker name must be 1-80 characters without newlines');
  return value;
}
function options(file) { return { files: managementFiles({ workers: file }) }; }
export function readWorkersSnapshot({ file = workersJsonPath() } = {}) {
  const state = projectManagementSnapshot(readManagementSnapshot(options(file)));
  return { version: 1, workers: state.workers.workers.map(w => projectWorkerMembership(w, state)) };
}
// Read paths no longer prune tombstones or acquire/write locks. Maintenance is
// an explicit mutation, never an evidence collection side effect.
export function readWorkers(args = {}) { return readWorkersSnapshot(args).workers.map(copy); }
export function pruneWorkerTombstones({ file = workersJsonPath(), now = Date.now() } = {}) {
  return withManagementTransaction(state => {
    state.workers.workers = state.workers.workers.filter(row => !(row.state === 'dead' && Date.parse(row.ended_at) < now - WORKER_TOMBSTONE_TTL_MS));
    return state.workers.workers;
  }, options(file));
}
export function claimWorker({ role, projectId, projectRoot = null, cwd = projectRoot, name = null, preset,
  teamId = null, file = workersJsonPath(), now = Date.now(), nativeNames = [], runtimeId = () => crypto.randomUUID() } = {}) {
  if (typeof role !== 'string' || !role.trim()) throw new Error('worker role is required');
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('worker project_id is required');
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) throw new Error('worker preset is required');
  const team = typeof teamId === 'string' && teamId.trim() ? teamId.trim() : null;
  return withManagementTransaction(state => {
    const projected = state.workers.workers.map(w => projectWorkerMembership(w, state));
    const collision = candidate => projected.find(w => w.name === candidate && occupied(w) && (team ? w.team_id === team : w.project_id === projectId));
    let workerName = name == null ? null : normalizeName(name);
    if (workerName == null) for (let index = 1; !workerName; index++) if (!collision(`${role}${index}`)) workerName = `${role}${index}`;
    if (collision(workerName)) throw new Error(`worker name already exists: ${workerName} (${team ? `team ${team}` : `project ${projectId}`})`);
    let workerId, handle, admission;
    const used = new Set(nativeNames);
    // Reservation uniqueness is scoped to the exact native container, not label.
    for (let attempt = 0; attempt < 100; attempt++) {
      workerId = runtimeId(); handle = allocateNativeHandle(workerId);
      if (state.workers.workers.some(w => w.worker_id === workerId) || used.has(handle)) continue;
      admission = newAdmissionIn(state, { projectId, teamId: team, workerId, nativeHandle: handle });
      if (state.workers.workers.some(w => w.herdr_session === admission.session && w.herdr_agent_name === handle)
        || state.mappings.intents.some(i => i !== admission && i.session === admission.session && i.native_handle === handle)) {
        state.mappings.intents.pop(); admission = null; continue;
      }
      break;
    }
    if (!admission) throw new Error('native runtime handle collision limit reached');
    const time = new Date(now).toISOString();
    const worker = { worker_id: workerId, operation_id: admission.operation_id, session_id: null, name: workerName, role: role.trim(), project_id: projectId,
      team_id: team, project_root: projectRoot, cwd: cwd || projectRoot, herdr_session: admission.session,
      herdr_workspace_id: null, herdr_tab_id: null, herdr_pane_id: null, herdr_agent_name: handle,
      tmux_session: null, tmux_socket: null, pid: null, preset: copy(preset), state: 'spawning',
      spawned_at: time, updated_at: time, ended_at: null, error: null };
    state.workers.workers.push(worker);
    return worker;
  }, options(file));
}
export function updateWorker(workerId, patch = {}, { file = workersJsonPath(), now = Date.now() } = {}) {
  if (!workerId) throw new Error('worker_id is required');
  const raw = readManagementSnapshot(options(file)).workers.workers.find(w => w.worker_id === workerId);
  if (!raw) throw new Error(`worker not found: ${workerId}`);
  if (patch.state === 'live' && raw.state === 'spawning' && raw.operation_id) return commitAdmission(raw.operation_id,
    { sessionId: patch.session_id ?? raw.session_id, patch }, options(file));
  return withManagementTransaction(state => {
    const row = state.workers.workers.find(w => w.worker_id === workerId);
    if (!row) throw new Error(`worker not found: ${workerId}`);
    if (row.session_id && Object.hasOwn(patch, 'team_id') && patch.team_id !== projectWorkerMembership(row, state).team_id) throw new Error('registered membership must change through canonical team service');
    if (patch.session_id && patch.session_id !== row.session_id && row.team_id) transferMembershipIn(state, row.team_id, patch.session_id);
    Object.assign(row, patch, { worker_id: workerId, updated_at: new Date(now).toISOString() });
    return projectWorkerMembership(row, state);
  }, options(file));
}
export function findWorker(name, { projectId = null, teamId = null, file = workersJsonPath() } = {}) {
  const key = normalizeName(name);
  const rows = listWorkers({ projectId, teamId, file }).filter(w => w.name === key);
  const live = rows.filter(occupied);
  if (live.length > 1) throw new Error(`worker name is ambiguous${projectId ? ' within one project' : ''}: ${key}; pass --project and --team`);
  return copy(live[0] ?? rows.at(-1) ?? null);
}
export function listWorkers({ projectId = null, teamId = null, file = workersJsonPath() } = {}) {
  return readWorkers({ file }).filter(w => (projectId == null || w.project_id === projectId) && (teamId == null || w.team_id === teamId));
}
export function renameWorkerControl(workerId, name, { file = workersJsonPath() } = {}) {
  const desired = normalizeName(name);
  return withManagementTransaction(state => {
    const row = state.workers.workers.find(w => w.worker_id === workerId);
    if (!row) throw new Error(`worker not found: ${workerId}`);
    const team = projectWorkerMembership(row, state).team_id;
    const conflict = state.workers.workers.map(w => projectWorkerMembership(w, state)).find(w => w.worker_id !== workerId && occupied(w) && w.name === desired && (team ? w.team_id === team : w.project_id === row.project_id));
    if (conflict) throw Object.assign(new Error(`worker name already exists: ${desired}`), { exitCode: 2 });
    const changed = row.name !== desired;
    if (changed) { row.name = desired; row.pending_native_label = desired; row.updated_at = new Date().toISOString(); }
    return { worker: projectWorkerMembership(row, state), changed };
  }, options(file));
}
export function acknowledgeWorkerDisplay(workerId, expected, { file = workersJsonPath() } = {}) {
  return withManagementTransaction(state => {
    const row = state.workers.workers.find(w => w.worker_id === workerId);
    if (!row || row.pending_native_label !== expected.pending_native_label || row.herdr_pane_id !== expected.herdr_pane_id || row.herdr_session !== expected.herdr_session) return null;
    row.pending_native_label = null;
    return projectWorkerMembership(row, state);
  }, options(file));
}
export function completeWorkerMove(workerId, pane, expected, { file = workersJsonPath() } = {}) {
  return withManagementTransaction(state => {
    const row = state.workers.workers.find(w => w.worker_id === workerId);
    if (!row) throw new Error('worker disappeared after native move');
    if (row.herdr_session !== expected.herdr_session || row.herdr_pane_id !== expected.herdr_pane_id || row.session_id !== expected.session_id) {
      row.unresolved_native_moves = [...(row.unresolved_native_moves ?? []).slice(-7), { session: expected.herdr_session, ...pane }];
      return { ok: false, worker: projectWorkerMembership(row, state) };
    }
    row.last_native_move = { operation_id: row.pending_native_move?.operation_id ?? null, ...pane };
    Object.assign(row, { herdr_pane_id: pane.pane_id, herdr_tab_id: pane.tab_id, herdr_workspace_id: pane.workspace_id, pending_native_move: null });
    return { ok: true, worker: projectWorkerMembership(row, state) };
  }, options(file));
}
export function adoptWorkerControl({ agent, teamId, session, pane, identity, nativeHandle, runtimeId = crypto.randomUUID(), file = workersJsonPath() } = {}) {
  return withManagementTransaction(state => {
    const team = state.teams.teams.find(t => t.team_id === teamId);
    const parent = state.mappings.projects[team?.project_id];
    if (!team || team.lifecycle !== 'open' || parent?.lifecycle !== 'open' || parent.session !== session || team.herdr_session !== session) throw Object.assign(new Error('adoption requires compatible open team/project/native ownership'), { exitCode: 2 });
    const rows = state.workers.workers.map(w => projectWorkerMembership(w, state));
    const existing = rows.find(w => occupied(w) && w.session_id === agent.session_id);
    if (existing) {
      if (existing.herdr_session !== session || existing.herdr_pane_id !== pane.pane_id) throw Object.assign(new Error('conversation already has a different active managed placement'), { exitCode: 2 });
      transferMembershipIn(state, teamId, agent.session_id);
      return { worker: projectWorkerMembership(existing, state), noop: true };
    }
    const name = normalizeName(agent.name ?? agent.session_id);
    if (rows.some(w => occupied(w) && w.name === name && w.team_id === teamId)) throw Object.assign(new Error(`worker name already exists: ${name}`), { exitCode: 2 });
    if (rows.some(w => occupied(w) && w.herdr_session === session && w.herdr_pane_id === pane.pane_id)) throw Object.assign(new Error('native pane already owned by a different managed conversation'), { exitCode: 2 });
    const now = new Date().toISOString();
    const row = { worker_id: runtimeId, session_id: agent.session_id, name, role: agent.role ?? null,
      project_id: team.project_id, team_id: teamId, project_root: agent.project_path ?? null,
      herdr_session: session, herdr_workspace_id: pane.workspace_id, herdr_tab_id: pane.tab_id, herdr_pane_id: pane.pane_id,
      herdr_agent_name: nativeHandle, pid: identity.pgid, process_ownership: identity, control_origin: 'explicit-adoption',
      preset: { harness: agent.harness ?? null, provider: agent.provider ?? null, model: agent.model ?? null },
      state: 'live', spawned_at: now, updated_at: now, ended_at: null, error: null };
    transferMembershipIn(state, teamId, agent.session_id); state.workers.workers.push(row);
    return { worker: projectWorkerMembership(row, state), noop: false };
  }, options(file));
}
export function activeWorkerStates() { return new Set(ACTIVE_STATES); }
export function findWorkerBySession(sessionId, { projectId = null, file = workersJsonPath() } = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('session_id is required');
  const rows = listWorkers({ projectId, file }).filter(w => w.session_id === sessionId.trim());
  return copy(rows.find(occupied) ?? rows.at(-1) ?? null);
}
