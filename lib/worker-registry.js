import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { workersJsonPath } from './golem-home.js';
import { withRegistryLock } from './session-facts.js';
export const WORKERS_REGISTRY_VERSION = 1;
export const WORKER_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_STATES = new Set(['spawning', 'live', 'failed']);

function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function readRegistry(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== WORKERS_REGISTRY_VERSION || !Array.isArray(parsed.workers)) {
      throw new Error(`invalid workers registry schema at ${file}`);
    }
    return { version: WORKERS_REGISTRY_VERSION, workers: parsed.workers };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: WORKERS_REGISTRY_VERSION, workers: [] };
    throw new Error(`cannot read workers registry at ${file}: ${error.message}`, { cause: error });
  }
}

function writeRegistry(file, registry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function timestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function pruneExpiredTombstones(registry, now = Date.now()) {
  const cutoff = now - WORKER_TOMBSTONE_TTL_MS;
  const before = registry.workers.length;
  registry.workers = registry.workers.filter((row) => {
    const endedAt = timestampMs(row?.ended_at);
    const dead = String(row?.state || '').toLowerCase() === 'dead';
    return !(dead && endedAt != null && endedAt < cutoff);
  });
  return registry.workers.length !== before;
}

// Reads can expire history, but the mutation stays under the same registry lock
// and atomic writer used by worker creation and updates. There is no second
// writer for workers.json.
function readRegistryForRead(file, now = Date.now()) {
  return withRegistryLock(file, () => {
    const registry = readRegistry(file);
    if (pruneExpiredTombstones(registry, now)) writeRegistry(file, registry);
    return registry;
  });
}

function normalizeName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('worker name is required');
  const value = name.trim();
  if (value.length > 80 || /[\r\n]/.test(value)) throw new Error('worker name must be 1-80 characters without newlines');
  return value;
}

function scoped(row, projectId) {
  return projectId == null || row.project_id === projectId;
}

function occupied(row) {
  return ACTIVE_STATES.has(String(row?.state || '').toLowerCase());
}

function nextName(role, projectId, workers, teamId = null) {
  for (let index = 1; ; index += 1) {
    const candidate = `${role}${index}`;
    if (!nameCollides(candidate, projectId, workers, teamId)) return candidate;
  }
}

/**
 * GOL-370: name uniqueness is per project across hosts (an occupied row
 * holding the candidate in the same project is a collision, whatever host it
 * runs on). GOL-363 G4: team rows are scoped to the team instead — two teams
 * in one project can each have a builder1, so only an occupied row with the
 * same team_id collides.
 */
function nameCollides(candidate, projectId, workers, teamId = null) {
  if (teamId != null) {
    return workers.some((row) => (
      row.name === candidate
      && occupied(row)
      && row.team_id === teamId
    ));
  }
  return workers.some((row) => (row.name === candidate && occupied(row) && row.project_id === projectId));
}

function findIndex(workers, workerId) {
  return workers.findIndex((row) => row.worker_id === workerId);
}

export function readWorkers({ file = workersJsonPath(), now = Date.now() } = {}) {
  return readRegistryForRead(file, now).workers.map((row) => clone(row));
}

export function withWorkersRegistryLock(fn, { file = workersJsonPath() } = {}) {
  return withRegistryLock(file, () => fn({ file, registry: readRegistry(file) }));
}

/** Claim the name and persist the spawning record before herdr is touched. */
export function claimWorker({
  role,
  projectId,
  projectRoot = null,
  cwd = projectRoot,
  name = null,
  preset,
  teamId = null,
  file = workersJsonPath(),
  now = Date.now(),
} = {}) {
  if (typeof role !== 'string' || !role.trim()) throw new Error('worker role is required');
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('worker project_id is required');
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) throw new Error('worker preset is required');
  const team = typeof teamId === 'string' && teamId.trim() ? teamId.trim() : null;
  return withRegistryLock(file, () => {
    const registry = readRegistry(file);
    const workerName = name == null ? nextName(role.trim(), projectId, registry.workers, team) : normalizeName(name);
    const collision = team != null
      ? registry.workers.find((row) => row.name === workerName && occupied(row) && row.team_id === team)
      : registry.workers.find((row) => row.name === workerName && occupied(row) && row.project_id === projectId.trim());
    if (collision) {
      const where = team != null ? `team ${team}` : `project ${collision.project_id ?? 'unknown'}`;
      throw new Error(`worker name already exists: ${workerName} (${where})`);
    }
    const timestamp = iso(now);
    const herdrSession = process.env.GOLEM_HERDR_SESSION || null;
    const worker = {
      worker_id: crypto.randomUUID(),
      session_id: null,
      name: workerName,
      role: role.trim(),
      project_id: projectId.trim(),
      team_id: team,
      project_root: projectRoot,
      cwd: cwd || projectRoot,
      // GOL-370 G7: herdr placement. Legacy rows keep their tmux_* fields;
      // new rows never write them.
      herdr_session: herdrSession,
      herdr_workspace_id: null,
      herdr_tab_id: null,
      herdr_pane_id: null,
      herdr_agent_name: workerName,
      tmux_session: null,
      tmux_socket: null,
      pid: null,
      preset: clone(preset),
      state: 'spawning',
      spawned_at: timestamp,
      updated_at: timestamp,
      ended_at: null,
      error: null,
    };
    registry.workers.push(worker);
    writeRegistry(file, registry);
    return clone(worker);
  });
}

export function updateWorker(workerId, patch = {}, { file = workersJsonPath(), now = Date.now() } = {}) {
  if (typeof workerId !== 'string' || !workerId.trim()) throw new Error('worker_id is required');
  return withRegistryLock(file, () => {
    const registry = readRegistry(file);
    const index = findIndex(registry.workers, workerId);
    if (index < 0) throw new Error(`worker not found: ${workerId}`);
    const current = registry.workers[index];
    const next = {
      ...current,
      ...patch,
      worker_id: current.worker_id,
      updated_at: iso(now),
    };
    registry.workers[index] = next;
    writeRegistry(file, registry);
    return clone(next);
  });
}

export function findWorker(name, { projectId = null, teamId = null, file = workersJsonPath(), now = Date.now() } = {}) {
  const workerName = normalizeName(name);
  const team = typeof teamId === 'string' && teamId.trim() ? teamId.trim() : null;
  const rows = readRegistryForRead(file, now).workers.filter((row) => (
    row.name === workerName && scoped(row, projectId) && (team == null || row.team_id === team)
  ));
  const active = rows.filter(occupied);
  if (active.length > 1) {
    // Claim-time rules prevent two occupied rows sharing name + project, but
    // no lookup path may silently pick one if the registry ever holds them
    // anyway — --project cannot disambiguate within one project.
    const counts = new Map();
    for (const row of active) {
      const key = row.project_id ?? '';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const duplicated = [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
    if (projectId != null || duplicated.length) {
      throw new Error(`worker name is ambiguous within one project: ${workerName} (${duplicated.join(', ') || projectId}); refusing to pick one`);
    }
    throw new Error(`worker name is ambiguous: ${workerName}; pass --project`);
  }
  // A dead record is retained as history, but a reused name must resolve to
  // the current active row rather than the oldest tombstone.
  const row = active[0] || rows[rows.length - 1];
  return row ? clone(row) : null;
}

export function listWorkers({ projectId = null, teamId = null, file = workersJsonPath(), now = Date.now() } = {}) {
  const team = typeof teamId === 'string' && teamId.trim() ? teamId.trim() : null;
  return readRegistryForRead(file, now).workers
    .filter((row) => scoped(row, projectId) && (team == null || row.team_id === team))
    .map((row) => clone(row));
}

export function activeWorkerStates() {
  return new Set(ACTIVE_STATES);
}

/**
 * Find the worker row owned by one session id (GOL-363 G8): the caller's own
 * agent row, used to resolve the caller's team when the caller is not a
 * team lead. Prefers an occupied row when the registry holds history.
 */
export function findWorkerBySession(sessionId, { projectId = null, file = workersJsonPath(), now = Date.now() } = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('session_id is required');
  const key = sessionId.trim();
  const rows = readRegistryForRead(file, now).workers.filter((row) => row.session_id === key && scoped(row, projectId));
  if (!rows.length) return null;
  return clone(rows.find(occupied) ?? rows[rows.length - 1]);
}
