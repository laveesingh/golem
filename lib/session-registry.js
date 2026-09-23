// Shared durable project/session registry upserts for lifecycle adapters.
//
// The registries remain compatibility views beside session-facts.json, but
// dashboard project discovery still depends on projects.json. Keep this
// contract aligned with substrate/hooks/session-register.sh: a hook-created
// project is additive, and a manual entry's user-facing metadata always wins.

import fs from 'node:fs';
import path from 'node:path';
import { projectsJsonPath, sessionsJsonPath } from './golem-home.js';
import { projectIdFor, resolveProjectRoot } from './project-id.js';
import { withRegistryLock } from './session-facts.js';

const REGISTRY_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function readRegistry(file, key) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed[key])) throw new Error(`invalid ${key} registry schema at ${file}`);
    return { version: parsed.version ?? REGISTRY_VERSION, [key]: parsed[key] };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: REGISTRY_VERSION, [key]: [] };
    throw error;
  }
}

function writeRegistry(file, registry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function upsertProject({ id, root, observedAt = nowIso(), file = projectsJsonPath() }) {
  return withRegistryLock(file, () => {
    const registry = readRegistry(file, 'projects');
    const index = registry.projects.findIndex((project) => project?.path === root || project?.id === id);
    if (index >= 0) {
      registry.projects[index] = { ...registry.projects[index], last_seen: observedAt };
    } else {
      registry.projects.push({
        id,
        name: path.basename(root),
        path: root,
        kind: 'auto',
        registered_by: 'hook',
        first_seen: observedAt,
        last_seen: observedAt,
      });
    }
    writeRegistry(file, registry);
    return registry.projects[index >= 0 ? index : registry.projects.length - 1];
  });
}

function upsertSession({ sessionId, id, root, harness, model, name, observedAt, file }) {
  return withRegistryLock(file, () => {
    const registry = readRegistry(file, 'sessions');
    const index = registry.sessions.findIndex((session) => session?.session_id === sessionId);
    const previous = index >= 0 ? registry.sessions[index] : null;
    const session = {
      ...(previous ?? {}),
      session_id: sessionId,
      project_id: id,
      project_path: root,
      harness,
      name: name ?? previous?.name ?? null,
      model: model ?? previous?.model ?? null,
      ...(previous ? {} : { boot_time: observedAt }),
      last_seen_at: observedAt,
      // A live registration must clear any prior retirement so resume/clear
      // succession can re-surface the same logical id without a zombie twin.
      ended_at: null,
      status: previous?.status === 'dead' || previous?.status === 'superseded' ? 'active' : (previous?.status ?? 'active'),
    };
    if (index >= 0) registry.sessions[index] = session;
    else registry.sessions.push(session);
    writeRegistry(file, registry);
    return session;
  });
}

/**
 * Mark one or more sessions.json rows as ended. Used when a harness retires a
 * prior conversation id succession and dispose.
 * Returns the list of session_ids that were newly marked.
 */
export function markSessionsEnded(sessionIds, {
  endedAt = nowIso(),
  status = 'superseded',
  sessionsFile = sessionsJsonPath(),
} = {}) {
  const ids = new Set((Array.isArray(sessionIds) ? sessionIds : [sessionIds]).filter(Boolean));
  if (!ids.size) return [];
  return withRegistryLock(sessionsFile, () => {
    const registry = readRegistry(sessionsFile, 'sessions');
    const marked = [];
    registry.sessions = registry.sessions.map((session) => {
      if (!ids.has(session?.session_id) || session.ended_at) return session;
      marked.push(session.session_id);
      return { ...session, status, ended_at: endedAt };
    });
    if (marked.length) writeRegistry(sessionsFile, registry);
    return marked;
  });
}

/**
 * End prior non-CC registry rows for the same project root, keeping `keepSessionId`.
 * Skips ids listed in `protectSessionIds` (e.g. other live managed canonicals).
 */
export function supersedePriorSessions({
  projectPath,
  keepSessionId,
  protectSessionIds = [],
  endedAt = nowIso(),
  sessionsFile = sessionsJsonPath(),
} = {}) {
  if (!projectPath || !keepSessionId) return [];
  const protect = new Set([keepSessionId, ...protectSessionIds].filter(Boolean));
  return withRegistryLock(sessionsFile, () => {
    const registry = readRegistry(sessionsFile, 'sessions');
    const marked = [];
    registry.sessions = registry.sessions.map((session) => {
      if (!session?.harness || session?.harness === 'claudecode') return session;
      if (session.ended_at) return session;
      if (protect.has(session.session_id)) return session;
      if (session.project_path !== projectPath) return session;
      marked.push(session.session_id);
      return { ...session, status: 'superseded', ended_at: endedAt };
    });
    if (marked.length) writeRegistry(sessionsFile, registry);
    return marked;
  });
}

/**
 * Additively register one lifecycle session and its resolved project root.
 *
 * Callers should keep this best-effort: lifecycle hooks must never block a
 * native harness merely because its local registry cannot be updated.
 */
export async function upsertSessionRegistration({
  sessionId,
  cwd,
  harness,
  model = null,
  name = null,
  observedAt = nowIso(),
  projectsFile = projectsJsonPath(),
  sessionsFile = sessionsJsonPath(),
} = {}) {
  if (!sessionId || !cwd || !harness) throw new Error('sessionId, cwd, and harness are required');
  const root = await resolveProjectRoot(cwd);
  const id = projectIdFor(root);
  const project = upsertProject({ id, root, observedAt, file: projectsFile });
  const session = upsertSession({ sessionId, id, root, harness, model, name, observedAt, file: sessionsFile });
  return { project, session, project_id: id, project_path: root };
}
