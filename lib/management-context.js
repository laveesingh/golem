// Read-only management evidence. No registry locks, migration, maintenance,
// dashboard startup or native mutation. Discovery errors remain visible facts.
import fs from 'node:fs';
import path from 'node:path';
import { projectsJsonPath, sessionsJsonPath } from './golem-home.js';
import { readSessionFacts } from './session-facts.js';
import { resolveCliSessionContext } from './cli-session-context.js';
import { projectIdFor, resolveProjectRoot } from './project-id.js';
import { readManagementSnapshot, projectManagementSnapshot, projectWorkerMembership, effectiveTeamForSession } from './management-registry.js';
import { paneCurrentInherited } from './herdr-driver.js';

export const resolved = value => ({ status: 'resolved', value });
export const unavailable = error => ({ status: 'unavailable', reason: String(error?.message ?? error) });
export const notApplicable = reason => ({ status: 'not-applicable', reason });
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
function arrayFile(file, key) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(value[key])) throw new Error(`invalid ${key} registry at ${file}`);
    return value[key];
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
async function source(fn) { try { return resolved(await fn()); } catch (e) { return unavailable(e); } }
export async function collectManagementContext({ selectors = {}, cwd = process.cwd(), env = process.env,
  resolveContext = resolveCliSessionContext, nativePaneQuery = paneCurrentInherited,
  readSnapshot = readManagementSnapshot, nativeSessions = null,
  projectForPath = async value => { if (!fs.statSync(value).isDirectory()) throw new Error(`project path is not a directory: ${value}`); const root = await resolveProjectRoot(value); return { project_id: projectIdFor(root), path: root }; },
} = {}) {
  const sources = {};
  sources.registries = await source(() => projectManagementSnapshot(readSnapshot()));
  sources.projects = await source(() => arrayFile(projectsJsonPath(), 'projects'));
  sources.sessions = await source(() => arrayFile(sessionsJsonPath(), 'sessions'));
  sources.facts = await source(() => readSessionFacts());
  sources.callerAgent = await source(() => resolveContext({ env }));
  if (sources.callerAgent.status === 'resolved' && !sources.callerAgent.value) sources.callerAgent = notApplicable('no native agent caller');
  else if (sources.callerAgent.status === 'resolved' && typeof sources.callerAgent.value.sessionId !== 'string') sources.callerAgent = unavailable('caller evidence has no canonical conversation ID');
  const inHerdr = env.HERDR_ENV === '1';
  sources.callerPane = !inHerdr ? notApplicable('not running inside herdr')
    : (!env.HERDR_SESSION || !env.HERDR_PANE_ID ? unavailable('inherited herdr session/pane context is incomplete') : await source(() => nativePaneQuery({ env })));
  sources.cwdProject = await source(() => projectForPath(path.resolve(cwd)));
  sources.explicitProject = selectors.project == null ? notApplicable('no explicit project selector') : await source(async () => {
    const key = String(selectors.project).trim();
    if (!key) throw new Error('--project requires a nonblank value');
    const snapshot = sources.registries.value;
    const ids = new Set([...Object.keys(snapshot?.mappings.projects ?? {}), ...(snapshot?.teams.teams ?? []).map(t => t.project_id), ...(snapshot?.workers.workers ?? []).map(w => w.project_id)]);
    const projects = sources.projects.value ?? [];
    const matches = projects.filter(p => (p.project_id ?? p.id) === key || p.name === key);
    if (matches.length > 1) throw new Error(`project is ambiguous: ${key}; pass exact project ID`);
    if (matches.length) return { project_id: matches[0].project_id ?? matches[0].id, path: matches[0].path ?? null };
    if (ids.has(key) || /^[\w-]+-[a-f0-9]{6}$/.test(key)) return { project_id: key, path: null };
    return projectForPath(path.resolve(cwd, key));
  });
  sources.nativeSessions = nativeSessions == null ? notApplicable('native session inventory not requested') : await source(() => typeof nativeSessions === 'function' ? nativeSessions() : nativeSessions);
  const snapshot = sources.registries.value;
  const teams = snapshot?.teams.teams ?? [];
  const workers = (snapshot?.workers.workers ?? []).map(w => projectWorkerMembership(w, snapshot));
  const agents = new Map();
  for (const row of sources.sessions.value ?? []) agents.set(row.session_id, { ...row, id: row.session_id });
  for (const fact of sources.facts.value ?? []) if (fact.canonical_id) agents.set(fact.canonical_id, { ...agents.get(fact.canonical_id),
    id: fact.canonical_id, session_id: fact.canonical_id, project_id: fact.project_id ?? agents.get(fact.canonical_id)?.project_id,
    state: fact.status, name: agents.get(fact.canonical_id)?.name ?? fact.name ?? null });
  const caller = sources.callerAgent.value;
  if (caller?.sessionId && !agents.has(caller.sessionId)) agents.set(caller.sessionId, { id: caller.sessionId, session_id: caller.sessionId, project_id: caller.projectId });
  for (const team of teams.filter(t => t.closed_at == null)) for (const id of [team.owner_session_id, ...team.member_session_ids].filter(Boolean)) {
    if (!agents.has(id)) agents.set(id, { id, session_id: id, project_id: team.project_id });
  }
  const registered = new Map(agents);
  for (const worker of workers) {
    const id = worker.session_id ?? worker.worker_id;
    const previous = registered.get(worker.session_id);
    if (worker.session_id) agents.delete(worker.session_id);
    // Preserve competing runtime rows so a real live tie is diagnosable.
    agents.set(worker.worker_id, { ...previous, ...worker, id, runtime_project_id: worker.project_id,
      project_id: previous?.project_id ?? worker.project_id });
  }
  for (const agent of agents.values()) if (agent.session_id) {
    agent.team_id = snapshot ? effectiveTeamForSession(agent.session_id, snapshot)?.team_id ?? null : null;
  }
  return freeze({ selectors: { ...selectors }, cwd, sources, snapshot, teams, workers, agents: [...agents.values()] });
}
