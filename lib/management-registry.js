// Durable management associations and admission. This service owns all
// membership writes. Reads are pure v1 projections until each project imports.
// Writes serialize under management, then commit mappings -> canonical teams
// -> derived workers. A failed cache write cannot change effective membership.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { herdrMappingsJsonPath, teamsJsonPath, workersJsonPath } from './golem-home.js';
import { withManagementLock, ownerIncarnation, ownerEnded, processBirth } from './management-lock.js';

export const MAPPINGS_VERSION = 1;
export const TEAMS_VERSION = 2;
export const MAX_MANAGEMENT_INTENTS = 256;
const terminal = new Set(['ready', 'cancelled', 'cleaned', 'failed', 'reconciled']);
const active = row => ['spawning', 'live', 'failed'].includes(row?.state);
export const copy = value => JSON.parse(JSON.stringify(value));
const timestamp = () => new Date().toISOString();
export function managementFiles({ mappings = herdrMappingsJsonPath(), teams = teamsJsonPath(), workers = workersJsonPath() } = {}) {
  return { mappings, teams, workers };
}
export function atomicManagementWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
function read(file, empty) {
  try { return { bytes: fs.readFileSync(file, 'utf8') }; } catch (e) {
    if (e.code === 'ENOENT') return { bytes: null, value: copy(empty) };
    throw e;
  }
}
export function normalizeTeam(row) {
  const owner = row.owner_session_id ?? row.lead_session_id ?? null;
  const { lead_session_id, ...rest } = row;
  return { ...rest, owner_session_id: owner,
    member_session_ids: [...new Set(row.member_session_ids ?? [])].filter(id => id && id !== owner),
    generation: row.generation ?? 0, lifecycle: row.lifecycle ?? (row.closed_at ? 'closed' : 'open') };
}
export function readManagementSnapshot({ files = managementFiles() } = {}) {
  const defaults = { mappings: { version: 1, revision: 0, projects: {}, intents: [] },
    teams: { version: 1, revision: 0, imports: {}, teams: [] }, workers: { version: 1, workers: [] } };
  const bytes = {}, result = { files };
  for (const kind of Object.keys(defaults)) {
    const raw = read(files[kind], defaults[kind]);
    bytes[kind] = raw.bytes;
    result[kind] = raw.value ?? JSON.parse(raw.bytes);
  }
  if (result.mappings.version !== 1 || !result.mappings.projects || !Array.isArray(result.mappings.intents)) throw new Error('invalid herdr mappings schema');
  if (![1, 2].includes(result.teams.version) || !Array.isArray(result.teams.teams)) throw new Error('invalid teams registry schema');
  if (result.workers.version !== 1 || !Array.isArray(result.workers.workers)) throw new Error('invalid workers registry schema');
  result.teams = { revision: 0, imports: {}, ...result.teams, teams: result.teams.teams.map(normalizeTeam) };
  result.bytes = bytes;
  return result;
}
const open = team => team.closed_at == null;
const has = (team, id) => team.owner_session_id === id || team.member_session_ids.includes(id);
function conflict(kind, projectId, facts, command) { return { kind, project_id: projectId, facts, corrective_command: command }; }

/** Only stored exact handles are candidates. No project labels/native calls. */
export function planManagementImport(snapshot = readManagementSnapshot()) {
  const { mappings, teams, workers } = snapshot;
  const ids = new Set([...Object.keys(mappings.projects), ...teams.teams.map(t => t.project_id), ...workers.workers.map(w => w.project_id)].filter(Boolean));
  const claims = new Map();
  for (const id of ids) {
    const handles = new Set([mappings.projects[id]?.session, ...teams.teams.filter(t => t.project_id === id).map(t => t.herdr_session),
      ...workers.workers.filter(w => w.project_id === id).map(w => w.herdr_session)].filter(Boolean));
    claims.set(id, handles);
  }
  const projects = {};
  for (const id of ids) {
    const marker = teams.imports[id];
    const handles = [...claims.get(id)];
    const competing = handles.flatMap(session => [...claims].filter(([other, set]) => other !== id && set.has(session)).map(([project_id]) => ({ project_id, session })));
    const conflicts = [];
    const explicit = mappings.projects[id]?.source === 'explicit-adoption';
    const selected = mappings.projects[id]?.session;
    if (explicit && handles.some(session => session !== selected)) conflicts.push(conflict('placement', id, { selected, handles }, `golem session inspect ${selected}`));
    if (!explicit && (handles.length > 1 || competing.length)) conflicts.push(conflict('session-association', id, { handles, competing }, `golem session adopt <exact-session> --project ${id}`));
    const placement = [...teams.teams.filter(t => t.project_id === id), ...workers.workers.filter(w => w.project_id === id)];
    if (!handles.length && placement.some(row => row.herdr_workspace_id || row.herdr_pane_id || row.herdr_tab_id)) {
      conflicts.push(conflict('missing-session-handle', id, placement, `golem session adopt <exact-session> --project ${id}`));
    }
    const memberships = new Map();
    for (const team of teams.teams.filter(t => open(t) && t.project_id === id)) {
      for (const sid of [team.owner_session_id, ...team.member_session_ids].filter(Boolean)) {
        if (!memberships.has(sid)) memberships.set(sid, new Set());
        memberships.get(sid).add(team.team_id);
      }
    }
    // A completed marker is the authority boundary, even if cache refresh died.
    if (marker?.membership !== 'complete') for (const worker of workers.workers.filter(w => w.project_id === id && active(w) && w.session_id && w.team_id)) {
      if (Object.hasOwn(marker?.resolved_sessions ?? {}, worker.session_id)) continue;
      const team = teams.teams.find(t => t.team_id === worker.team_id && open(t) && t.project_id === id);
      if (!team) { conflicts.push(conflict('worker-membership', id, worker, `golem team leave --agent ${worker.session_id}`)); continue; }
      if (!memberships.has(worker.session_id)) memberships.set(worker.session_id, new Set());
      memberships.get(worker.session_id).add(worker.team_id);
    }
    for (const [sid, targets] of memberships) if (targets.size > 1) conflicts.push(conflict('membership', id, { session_id: sid, team_ids: [...targets] }, `golem team join <exact-team-id> --agent ${sid}`));
    const membershipConflicts = conflicts.filter(c => ['membership', 'worker-membership'].includes(c.kind));
    projects[id] = { project_id: id, session: explicit ? selected : (handles.length === 1 && !competing.length ? handles[0] : null),
      association: conflicts.some(c => ['session-association', 'missing-session-handle'].includes(c.kind)) ? 'conflicted' : (handles.length ? 'complete' : 'empty'),
      membership: membershipConflicts.length ? 'conflicted' : 'complete', conflicts,
      provisioning: workers.workers.filter(w => w.project_id === id && w.state === 'spawning' && !w.operation_id)
        .map(w => ({ worker_id: w.worker_id, session: w.herdr_session ?? null, team_id: w.team_id ?? null, phase: 'unresolved', reason: 'legacy creator has no captured admission' })),
      memberships: [...memberships].filter(([, targets]) => targets.size === 1).map(([session_id, targets]) => ({ session_id, team_id: [...targets][0] })) };
  }
  // One open team per conversation also applies across project boundaries.
  const conversationClaims = new Map();
  for (const project of Object.values(projects)) for (const rel of project.memberships) {
    const claims = conversationClaims.get(rel.session_id) ?? [];
    claims.push({ project_id: project.project_id, team_id: rel.team_id });
    conversationClaims.set(rel.session_id, claims);
  }
  for (const [session_id, claims] of conversationClaims) if (claims.length > 1) for (const claim of claims) {
    const project = projects[claim.project_id];
    project.conflicts.push(conflict('membership', claim.project_id, { session_id, claims }, `golem team join ${claim.team_id} --agent ${session_id}`));
    project.membership = 'conflicted';
    project.memberships = project.memberships.filter(rel => rel.session_id !== session_id);
  }
  // Preserve contradictory placement and attach exact resource IDs to it.
  const workspaceClaims = new Map();
  for (const team of teams.teams.filter(open)) if (team.herdr_workspace_id) {
    const key = JSON.stringify([team.herdr_session, team.herdr_workspace_id]);
    const previous = workspaceClaims.get(key);
    if (previous) for (const target of [previous, team]) projects[target.project_id].conflicts.push(conflict('workspace-association', target.project_id,
      { team_ids: [previous.team_id, team.team_id], session: team.herdr_session, workspace_id: team.herdr_workspace_id },
      `golem team adopt <label> --workspace ${team.herdr_workspace_id} --project ${target.project_id} --session ${team.herdr_session}`));
    workspaceClaims.set(key, team);
  }
  return { projects };
}
export function projectManagementSnapshot(snapshot = readManagementSnapshot()) {
  const plan = planManagementImport(snapshot);
  const projected = copy(snapshot);
  for (const project of Object.values(plan.projects)) {
    if (snapshot.teams.imports[project.project_id]?.membership === 'complete') continue;
    for (const rel of project.memberships) {
      const team = projected.teams.teams.find(t => t.team_id === rel.team_id);
      if (!has(team, rel.session_id)) team.member_session_ids.push(rel.session_id);
    }
  }
  projected.plan = plan;
  return projected;
}
export function effectiveTeamForSession(sessionId, snapshot = projectManagementSnapshot()) {
  if (!sessionId) return null;
  const plan = snapshot.plan ?? planManagementImport(snapshot);
  if (Object.values(plan.projects).some(p => p.conflicts.some(c => c.kind === 'membership' && c.facts.session_id === sessionId))) return null;
  const matches = snapshot.teams.teams.filter(t => open(t) && has(t, sessionId));
  if (matches.length > 1) return null;
  return matches[0] ?? null;
}
export function projectWorkerMembership(worker, snapshot) {
  if (!worker.session_id) return { ...worker, pending_team_id: worker.team_id ?? null };
  return { ...worker, team_id: effectiveTeamForSession(worker.session_id, snapshot)?.team_id ?? null };
}
function backup(snapshot) {
  const directory = path.join(path.dirname(snapshot.files.mappings), 'management-backup-v2');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manifestFile = path.join(directory, 'manifest.json');
  if (fs.existsSync(manifestFile)) return;
  // Immutable blobs allow a killed backup writer to resume without overwriting
  // the original bytes. The manifest is published before any schema write.
  const manifest = { version: 1, created_at: timestamp(), files: {} };
  for (const kind of ['mappings', 'teams', 'workers']) {
    const blob = path.join(directory, `${kind}.snapshot`);
    const bytes = snapshot.bytes[kind];
    const record = JSON.stringify({ bytes });
    try { fs.writeFileSync(blob, record, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const original = JSON.parse(fs.readFileSync(blob, 'utf8')).bytes;
    manifest.files[kind] = { path: snapshot.files[kind], snapshot: path.basename(blob), present: original != null,
      sha256: original == null ? null : crypto.createHash('sha256').update(original).digest('hex'),
      schema_version: original == null ? null : JSON.parse(original).version };
  }
  atomicManagementWrite(manifestFile, manifest);
}
function importMetadata(state) {
  const plan = planManagementImport(state);
  for (const project of Object.values(plan.projects)) {
    const id = project.project_id;
    if (project.session && !state.mappings.projects[id]) state.mappings.projects[id] = { project_id: id, session: project.session, generation: 0, lifecycle: 'open', source: 'exact-import' };
    if (state.teams.imports[id]?.membership !== 'complete' && project.membership === 'complete') {
      for (const rel of project.memberships) {
        const team = state.teams.teams.find(t => t.team_id === rel.team_id);
        if (!has(team, rel.session_id)) team.member_session_ids.push(rel.session_id);
      }
    }
    state.teams.imports[id] = { ...state.teams.imports[id], membership: project.membership, association: project.association, conflicts: project.conflicts };
  }
  // Pre-contract creators that never registered have no safe relaunch
  // identity. Preserve their exact placement and make uncertainty durable.
  for (const worker of state.workers.workers.filter(w => w.state === 'spawning' && !w.operation_id)) {
    let intent = state.mappings.intents.find(i => i.kind === 'legacy-provisioning' && i.worker_id === worker.worker_id);
    if (!intent) {
      pruneIntents(state);
      intent = { operation_id: crypto.randomUUID(), kind: 'legacy-provisioning', project_id: worker.project_id,
        team_id: worker.team_id ?? null, session: worker.herdr_session ?? null, worker_id: worker.worker_id,
        phase: 'unresolved', owner: null, resources: [], cancellation_requested: false, created_at: timestamp(),
        error: 'legacy creator has no captured admission; inspect exact placement, never relaunch by label' };
      state.mappings.intents.push(intent);
    }
    worker.operation_id = intent.operation_id;
  }
  state.teams.version = 2;
}
function membershipClaims(registry) {
  const claims = new Map();
  for (const team of registry.teams.filter(open)) for (const id of [team.owner_session_id, ...team.member_session_ids].filter(Boolean)) {
    const targets = claims.get(id) ?? []; targets.push(team.team_id); claims.set(id, targets);
  }
  return claims;
}
function validateMembershipChanges(state, original) {
  state.teams.teams = state.teams.teams.map(normalizeTeam);
  const previous = membershipClaims(original);
  for (const [id, targets] of membershipClaims(state.teams)) if (targets.length > 1
    && JSON.stringify([...targets].sort()) !== JSON.stringify([...(previous.get(id) ?? [])].sort())) {
    throw new Error(`canonical membership conflict for ${id}: ${targets.join(', ')}; use targeted team join`);
  }
}
function reconcileWorkerCache(state) {
  const projected = { ...state, plan: planManagementImport(state) };
  for (const worker of state.workers.workers) if (worker.session_id && state.teams.imports[worker.project_id]?.membership === 'complete') {
    worker.team_id = effectiveTeamForSession(worker.session_id, projected)?.team_id ?? null;
  }
}
export function withManagementTransaction(fn, { files = managementFiles(), afterCanonicalCommit = null, mappingsLast = false } = {}) {
  if (fn?.constructor?.name === 'AsyncFunction') throw new Error('management transaction rejects async callbacks');
  return withManagementLock(() => {
    const state = readManagementSnapshot({ files });
    backup(state);
    const originalTeams = copy(state.teams);
    importMetadata(state);
    const value = fn(state);
    if (value && typeof value.then === 'function') throw new Error('management transaction rejects thenable callbacks');
    validateMembershipChanges(state, originalTeams);
    reconcileWorkerCache(state);
    for (const kind of mappingsLast ? ['teams', 'workers', 'mappings'] : ['mappings', 'teams', 'workers']) {
      if (JSON.stringify(state[kind]) === JSON.stringify(state.bytes[kind] == null ? null : JSON.parse(state.bytes[kind]))) continue;
      if (kind !== 'workers') state[kind].revision = (state[kind].revision ?? 0) + 1;
      atomicManagementWrite(files[kind], state[kind]);
      if (kind === 'teams') afterCanonicalCommit?.(state);
    }
    return copy(value ?? null);
  }, { file: path.join(path.dirname(files.mappings), 'management.lock') });
}
export function mutateTeams(fn, { file = teamsJsonPath(), ...options } = {}) {
  return withManagementTransaction(state => fn(state.teams, state), { ...options, files: managementFiles({ teams: file }) });
}
export function mappedSessionForProject(projectId, snapshot = projectManagementSnapshot()) {
  const plan = snapshot.plan ?? planManagementImport(snapshot);
  const project = plan.projects[projectId];
  if (project?.association === 'conflicted') throw new Error(`project ${projectId} has conflicting exact session associations: ${JSON.stringify(project.conflicts)}`);
  return snapshot.mappings.projects[projectId]?.session ?? project?.session ?? null;
}
export function allocateNativeHandle(runtimeId = crypto.randomUUID()) {
  return `g-${crypto.createHash('sha256').update(runtimeId).digest('hex').slice(0, 28)}`;
}
export function ensureProjectAssociationIn(state, projectId, { session = process.env.GOLEM_HERDR_SESSION || null } = {}) {
  const known = mappedSessionForProject(projectId, { ...state, plan: planManagementImport(state) });
  if (known) {
    if (session && session !== known) throw new Error(`project ${projectId} owns ${known}, not ${session}`);
    return state.mappings.projects[projectId];
  }
  const used = new Set(Object.values(state.mappings.projects).map(p => p.session));
  if (session && used.has(session)) throw new Error(`native session ${session} already owned by another project`);
  while (!session || used.has(session)) session = allocateNativeHandle();
  state.mappings.projects[projectId] = { project_id: projectId, session, generation: 0, lifecycle: 'open', source: 'reserved' };
  return state.mappings.projects[projectId];
}
export function ensureProjectAssociation(projectId, options = {}) {
  return withManagementTransaction(state => ensureProjectAssociationIn(state, projectId, options), options);
}
/** Native existence/identity is verified by the operation adapter before this
 * exact choice. Metadata repair never starts, moves or stops resources. */
export function adoptProjectAssociation(projectId, session, options = {}) {
  if (!projectId || !session) throw new Error('exact project/session required for adoption');
  return withManagementTransaction(state => {
    const foreign = Object.values(state.mappings.projects).find(p => p.project_id !== projectId && p.session === session);
    if (foreign) throw new Error(`native session ${session} owned by project ${foreign.project_id}; association not stolen`);
    const previous = state.mappings.projects[projectId];
    state.mappings.projects[projectId] = { ...previous, project_id: projectId, session, source: 'explicit-adoption',
      generation: (previous?.generation ?? 0) + 1, lifecycle: 'open' };
    return state.mappings.projects[projectId];
  }, options);
}
export function transferMembershipIn(state, teamId, sessionId, { owner = false } = {}) {
  const team = state.teams.teams.find(t => t.team_id === teamId);
  if (!team) throw new Error(`team not found: ${teamId}`);
  if (team.lifecycle !== 'open') throw new Error(`team is ${team.lifecycle}: ${team.slug}`);
  for (const row of state.teams.teams.filter(open)) {
    if (row.team_id === teamId) continue;
    if (row.owner_session_id === sessionId) row.owner_session_id = null;
    row.member_session_ids = row.member_session_ids.filter(id => id !== sessionId);
  }
  if (owner) {
    const previous = team.owner_session_id;
    team.owner_session_id = sessionId;
    team.member_session_ids = team.member_session_ids.filter(id => id !== sessionId);
    if (previous && previous !== sessionId && !team.member_session_ids.includes(previous)) team.member_session_ids.push(previous);
  } else if (!has(team, sessionId)) team.member_session_ids.push(sessionId);
  // An explicit target repairs only this conversation's conflicting relation.
  for (const marker of Object.values(state.teams.imports)) {
    marker.conflicts = (marker.conflicts ?? []).filter(c => c.facts?.session_id !== sessionId);
    marker.resolved_sessions ??= {};
    marker.resolved_sessions[sessionId] = teamId;
  }
  team.updated_at = timestamp();
  return team;
}
function pruneIntents(state) {
  const pending = state.mappings.intents.filter(i => !terminal.has(i.phase));
  const history = state.mappings.intents.filter(i => terminal.has(i.phase)).slice(-64);
  state.mappings.intents = [...history, ...pending];
  if (state.mappings.intents.length >= MAX_MANAGEMENT_INTENTS) throw new Error('management intent limit reached; resolve pending operation IDs before admission');
}
export function newAdmissionIn(state, { kind = 'worker', projectId, teamId = null, workerId = null, nativeHandle = null } = {}) {
  pruneIntents(state);
  const parent = ensureProjectAssociationIn(state, projectId);
  const team = teamId ? state.teams.teams.find(t => t.team_id === teamId && t.project_id === projectId) : null;
  if (teamId && !team) throw new Error(`team not found in project ${projectId}: ${teamId}`);
  const physical = state.mappings.session_states?.[parent.session];
  if (parent.lifecycle !== 'open' || (team && team.lifecycle !== 'open') || (physical && physical.lifecycle !== 'open')) throw new Error(`management target is ${physical?.lifecycle ?? team?.lifecycle ?? parent.lifecycle}; launch refused (${teamId ?? parent.session}); close operation ${physical?.close_operation_id ?? team?.close_operation_id ?? parent.close_operation_id ?? 'unknown'}`);
  if (team && team.herdr_session !== parent.session) throw new Error(`team ${teamId} placement conflicts with project session ${parent.session}`);
  const intent = { operation_id: crypto.randomUUID(), kind, project_id: projectId, team_id: teamId, worker_id: workerId,
    session: parent.session, native_handle: nativeHandle, parent_generation: parent.generation, team_generation: team?.generation ?? null,
    phase: 'admitted', owner: ownerIncarnation(), cancellation_requested: false, resources: [], created_at: timestamp() };
  state.mappings.intents.push(intent);
  return intent;
}
export function admitProvisioning(input, options) { return withManagementTransaction(state => newAdmissionIn(state, input), options); }
export function reallocateAdmissionRuntime(id, nativeNames = [], options) {
  return withManagementTransaction(state => {
    const intent = intentIn(state, id);
    if (!validAdmission(state, intent)) throw new Error(`runtime reallocation fenced: ${id}`);
    const worker = state.workers.workers.find(w => w.worker_id === intent.worker_id);
    if (!worker || worker.session_id || worker.pid) throw new Error('cannot reallocate an already launched runtime');
    let runtimeId, handle;
    for (let attempt = 0; attempt < 100; attempt++) {
      runtimeId = crypto.randomUUID(); handle = allocateNativeHandle(runtimeId);
      if (nativeNames.includes(handle) || state.workers.workers.some(w => w.herdr_session === intent.session && w.herdr_agent_name === handle)
        || state.mappings.intents.some(i => i.session === intent.session && i.native_handle === handle)) continue;
      worker.worker_id = runtimeId; worker.herdr_agent_name = handle;
      intent.worker_id = runtimeId; intent.native_handle = handle;
      return worker;
    }
    throw new Error('native runtime collision limit reached');
  }, options);
}
function validAdmission(state, intent) {
  const parent = state.mappings.projects[intent.project_id];
  const team = intent.team_id ? state.teams.teams.find(t => t.team_id === intent.team_id) : null;
  return intent.owner?.pid === process.pid && intent.owner.birth === processBirth(process.pid) && !intent.cancellation_requested && (!state.mappings.session_states?.[intent.session] || state.mappings.session_states[intent.session].lifecycle === 'open') && parent?.lifecycle === 'open' && parent.generation === intent.parent_generation
    && (!intent.team_id || (team?.lifecycle === 'open' && team.generation === intent.team_generation));
}
function intentIn(state, id) {
  const intent = state.mappings.intents.find(i => i.operation_id === id);
  if (!intent) throw new Error(`management operation not found: ${id}`);
  return intent;
}
export function beforeNativeCall(id, options) {
  return withManagementTransaction(state => {
    const intent = intentIn(state, id);
    if (terminal.has(intent.phase) || intent.phase === 'unresolved' || !validAdmission(state, intent)) {
      if (intent.phase === 'admitted') intent.phase = 'cancelled';
      throw new Error(`launch fenced: operation ${id} (${intent.phase})`);
    }
    intent.phase = 'native_call';
    return intent;
  }, options);
}
export function reserveWorkspaceProvisioning(id, options) {
  return withManagementTransaction(state => {
    const intent = intentIn(state, id);
    if (!validAdmission(state, intent)) throw new Error(`workspace provisioning fenced: ${id}`);
    const competing = state.mappings.intents.find(i => i !== intent && !terminal.has(i.phase)
      && i.session === intent.session && i.team_id === intent.team_id && i.provisioning_workspace);
    if (competing) throw new Error(`workspace provisioning pending: operation ${competing.operation_id}; retry or inspect exact resources`);
    intent.provisioning_workspace = true;
    return intent;
  }, options);
}
export function recordNativeResult(id, resource, options) {
  return withManagementTransaction(state => {
    const intent = intentIn(state, id);
    if (resource) intent.resources.push(copy(resource));
    const valid = validAdmission(state, intent);
    const worker = state.workers.workers.find(w => w.worker_id === intent.worker_id);
    if (resource?.type === 'tab' && worker) Object.assign(worker, {
      herdr_workspace_id: resource.workspace_id, herdr_tab_id: resource.tab_id, herdr_pane_id: resource.pane_id });
    if (resource?.type === 'workspace') {
      intent.provisioning_workspace = false;
      if (valid) {
        const parent = intent.team_id ? state.teams.teams.find(t => t.team_id === intent.team_id) : state.mappings.projects[intent.project_id];
        if (intent.team_id) parent.herdr_workspace_id = resource.workspace_id;
        else parent.agents_workspace_id = resource.workspace_id;
      }
    }
    const missingId = (resource?.type === 'workspace' && !resource.workspace_id)
      || (resource?.type === 'tab' && (!resource.tab_id || !resource.pane_id));
    intent.phase = missingId ? 'unresolved' : (valid ? 'provisioned' : 'cleanup_required');
    if (missingId) intent.error = 'native result omitted exact IDs; inspect/recover this operation without relaunch';
    return { ...intent, valid: valid && !missingId };
  }, options);
}
export function commitAdmission(id, { sessionId = null, patch = {} } = {}, options) {
  return withManagementTransaction(state => {
    const intent = intentIn(state, id);
    if (!validAdmission(state, intent) || terminal.has(intent.phase) || intent.phase === 'unresolved') throw new Error(`launch commit fenced: operation ${id} (${intent.phase})`);
    const worker = state.workers.workers.find(w => w.worker_id === intent.worker_id);
    if (worker) {
      if (!sessionId) throw new Error('registered conversation session ID is required');
      if (intent.team_id) transferMembershipIn(state, intent.team_id, sessionId);
      Object.assign(worker, patch, { session_id: sessionId, state: 'live', error: null, updated_at: timestamp() });
    }
    intent.phase = 'ready';
    return worker ?? intent;
  }, { ...options, mappingsLast: true });
}
export function settleAdmission(id, { phase = 'cleaned', error = null } = {}, options) {
  return withManagementTransaction(state => {
    const intent = intentIn(state, id);
    intent.phase = phase; intent.error = error;
    if (['cleaned', 'cancelled'].includes(phase)) {
      const worker = state.workers.workers.find(w => w.worker_id === intent.worker_id);
      if (worker) Object.assign(worker, { state: 'dead', ended_at: timestamp() });
    }
    return intent;
  }, options);
}
function recoverIntents(state, probe) {
  for (const intent of state.mappings.intents.filter(i => !terminal.has(i.phase))) {
    if (!ownerEnded(intent.owner, probe)) continue;
    if (intent.phase === 'admitted') {
      intent.phase = 'cancelled';
      const worker = state.workers.workers.find(w => w.worker_id === intent.worker_id);
      if (worker) Object.assign(worker, { state: 'dead', ended_at: timestamp(), error: 'creator ended before native launch' });
    }
    else if (intent.phase !== 'unresolved') { intent.phase = 'unresolved'; intent.error = 'creator ended; inspect exact resources; never automatically relaunch'; }
  }
}
export function recoverManagementIntents(options = {}) {
  return withManagementTransaction(state => { recoverIntents(state, options.probe); return state.mappings.intents; }, options);
}
function matching(intent, { teamId, session }) { return teamId ? intent.team_id === teamId : intent.session === session; }
function closeParent(state, target) {
  if (target.teamId) return state.teams.teams.find(t => t.team_id === target.teamId);
  const association = Object.values(state.mappings.projects).find(p => p.session === target.session);
  if (association) return association;
  // Exact physical close is not implicit adoption of a contradictory project.
  state.mappings.session_states ??= {};
  state.mappings.session_states[target.session] ??= { session: target.session, lifecycle: 'open', generation: 0 };
  return state.mappings.session_states[target.session];
}
export function beginManagementClose(target, options = {}) {
  return withManagementTransaction(state => {
    recoverIntents(state, options.probe);
    const parent = closeParent(state, target);
    if (!parent) throw new Error(`management close target not found: ${target.teamId ?? target.session}`);
    if (parent.lifecycle === 'open') { parent.lifecycle = 'closing'; parent.generation += 1; parent.close_operation_id = crypto.randomUUID(); }
    for (const intent of state.mappings.intents.filter(i => matching(i, target) && !terminal.has(i.phase))) {
      intent.cancellation_requested = true;
      if (intent.phase === 'admitted') {
        intent.phase = 'cancelled';
        const worker = state.workers.workers.find(w => w.worker_id === intent.worker_id);
        if (worker) Object.assign(worker, { state: 'dead', ended_at: timestamp(), error: 'cancelled before native launch' });
      }
    }
    return { ...parent, pending: state.mappings.intents.filter(i => matching(i, target) && !terminal.has(i.phase)) };
  }, options);
}
export function pendingManagementLaunches(target, options = {}) {
  return readManagementSnapshot(options).mappings.intents.filter(i => matching(i, target) && !terminal.has(i.phase));
}
export async function waitForManagementLaunches(target, { timeoutMs = 30000, pollMs = 50, ...options } = {}) {
  const deadline = Date.now() + Math.min(30000, Math.max(0, timeoutMs));
  let pending;
  do {
    recoverManagementIntents(options);
    pending = pendingManagementLaunches(target, options);
    if (!pending.length || pending.some(i => i.phase === 'unresolved')) break;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
  } while (true);
  return { completed: pending.length === 0, pending, lifecycle: pending.length ? 'closing' : 'settled' };
}
export function finishManagementClose(target, { stopped = false, ...options } = {}) {
  return withManagementTransaction(state => {
    const pending = state.mappings.intents.filter(i => matching(i, target) && !terminal.has(i.phase));
    if (pending.length) throw new Error(`management close partial; unresolved operation IDs: ${pending.map(i => i.operation_id).join(', ')}`);
    const parent = closeParent(state, target);
    if (!parent) throw new Error('management close target not found');
    parent.lifecycle = stopped ? 'stopped' : 'closed';
    if (target.teamId) parent.closed_at ??= timestamp();
    return parent;
  }, options);
}
