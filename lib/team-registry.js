// Teams v2 is the canonical logical owner/member relation for managed and
// external conversations. Membership never changes role or native placement.
import crypto from 'node:crypto';
import { teamsJsonPath } from './golem-home.js';
import {
  projectManagementSnapshot, mutateTeams, ensureProjectAssociationIn,
  transferMembershipIn, beginManagementClose, finishManagementClose,
  managementFiles, allocateNativeHandle, readManagementSnapshot,
} from './management-registry.js';
export const TEAMS_REGISTRY_VERSION = 2;
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const iso = now => new Date(now ?? Date.now()).toISOString();
const validId = value => typeof value === 'string' && value.trim() ? value.trim() : null;
export function teamHasSession(team, sessionId) {
  return !!sessionId && (team?.owner_session_id === sessionId || team?.member_session_ids?.includes(sessionId));
}
export function slugifyTeamLabel(label) {
  if (typeof label !== 'string' || !label.trim()) throw new Error('team label is required');
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z][a-z0-9-]*$/.test(slug) || slug.length > 64) throw new Error(`team label ${JSON.stringify(label)} does not produce a valid slug ([a-z][a-z0-9-], at most 64 characters)`);
  return slug;
}
// Compatibility export takes a stable runtime ID, never logical labels.
export function herdrAgentNameFor(runtimeId) {
  if (!validId(runtimeId)) throw new Error('runtime ID is required');
  return allocateNativeHandle(runtimeId);
}
export function readTeamsSnapshot({ file = teamsJsonPath() } = {}) {
  return snapshot(file).teams;
}
function snapshot(file) {
  return projectManagementSnapshot(readManagementSnapshot({ files: managementFiles({ teams: file }) }));
}
export function readTeams({ file = teamsJsonPath(), projectId = null } = {}) {
  return snapshot(file).teams.teams.filter(t => projectId == null || t.project_id === projectId).map(copy);
}
export function listTeams({ projectId = null, includeClosed = true, file = teamsJsonPath() } = {}) {
  return readTeams({ file, projectId }).filter(t => includeClosed || t.closed_at == null);
}
export function findTeam(ref, { projectId = null, file = teamsJsonPath() } = {}) {
  const key = validId(ref);
  if (!key) throw new Error('team reference is required');
  const rows = readTeams({ file, projectId });
  const exact = rows.find(t => t.team_id === key);
  if (exact) return exact;
  const names = rows.filter(t => t.slug === key);
  const open = names.filter(t => t.closed_at == null);
  if (open.length > 1) throw new Error(`team slug is ambiguous: ${key}; pass the team_id`);
  return open[0] ?? names.at(-1) ?? null;
}
export function createTeam({ label, projectId, ownerSessionId = null, herdrSession, herdrWorkspaceId = null, file = teamsJsonPath(), now } = {}) {
  if (!validId(projectId)) throw new Error('team project_id is required');
  if (!validId(herdrSession)) throw new Error('team herdr_session is required');
  const slug = slugifyTeamLabel(label);
  return mutateTeams((registry, state) => {
    if (registry.teams.some(t => t.closed_at == null && t.project_id === projectId && t.slug === slug)) throw new Error(`team slug already exists: ${slug} (project ${projectId})`);
    const association = ensureProjectAssociationIn(state, projectId, { session: herdrSession });
    if (association.lifecycle !== 'open') throw new Error(`project runtime is ${association.lifecycle}: ${herdrSession}`);
    if (herdrWorkspaceId && registry.teams.some(t => t.closed_at == null && t.herdr_session === herdrSession && t.herdr_workspace_id === herdrWorkspaceId)) throw new Error(`workspace already owned: ${herdrSession}/${herdrWorkspaceId}`);
    const team = { team_id: crypto.randomUUID(), label: label.trim(), slug, project_id: projectId,
      owner_session_id: null, member_session_ids: [], herdr_session: herdrSession,
      herdr_workspace_id: herdrWorkspaceId, generation: 0, lifecycle: 'open',
      created_at: iso(now), updated_at: iso(now), closed_at: null };
    registry.teams.push(team);
    registry.imports[projectId] ??= { membership: 'complete', association: 'complete', conflicts: [] };
    if (validId(ownerSessionId)) transferMembershipIn(state, team.team_id, ownerSessionId, { owner: true });
    return team;
  }, { file });
}
export function joinTeam(teamId, sessionId, { owner = false, file = teamsJsonPath() } = {}) {
  if (!validId(teamId)) throw new Error('team_id is required');
  if (!validId(sessionId)) throw new Error('session_id is required');
  return mutateTeams((registry, state) => transferMembershipIn(state, teamId, sessionId, { owner }), { file });
}
export function leaveTeam(sessionId, { teamId = null, file = teamsJsonPath() } = {}) {
  if (!validId(sessionId)) throw new Error('session_id is required');
  return mutateTeams(registry => {
    const left = [];
    for (const team of registry.teams) if (team.closed_at == null && (teamId == null || team.team_id === teamId) && teamHasSession(team, sessionId)) {
      if (team.owner_session_id === sessionId) team.owner_session_id = null;
      team.member_session_ids = team.member_session_ids.filter(id => id !== sessionId);
      team.updated_at = iso(); left.push(team.team_id);
    }
    for (const marker of Object.values(registry.imports)) {
      marker.resolved_sessions ??= {};
      marker.resolved_sessions[sessionId] = null;
      marker.conflicts = (marker.conflicts ?? []).filter(c => c.facts?.session_id !== sessionId);
    }
    return { session_id: sessionId, left };
  }, { file });
}
export function setTeamWorkspace(teamId, workspaceId, { file = teamsJsonPath(), now } = {}) {
  if (!validId(teamId)) throw new Error('team_id is required');
  if (!validId(workspaceId)) throw new Error('workspace id is required');
  return mutateTeams((registry, state) => {
    const team = registry.teams.find(t => t.team_id === teamId);
    if (!team) throw new Error(`team not found: ${teamId}`);
    if (team.lifecycle !== 'open') throw new Error(`team is ${team.lifecycle}: ${team.slug}`);
    const session = ensureProjectAssociationIn(state, team.project_id).session;
    if (session !== team.herdr_session) throw new Error(`team placement conflicts: ${teamId}`);
    if (registry.teams.some(t => t.team_id !== teamId && t.closed_at == null && t.herdr_session === session && t.herdr_workspace_id === workspaceId)) throw new Error(`workspace already owned: ${session}/${workspaceId}`);
    team.herdr_workspace_id = workspaceId; team.updated_at = iso(now);
    return team;
  }, { file });
}
export function renameTeam(teamId, label, { file = teamsJsonPath() } = {}) {
  const slug = slugifyTeamLabel(label);
  return mutateTeams(registry => {
    const team = registry.teams.find(t => t.team_id === teamId);
    if (!team) throw new Error(`team not found: ${teamId}`);
    if (team.lifecycle !== 'open') throw new Error(`team is ${team.lifecycle}: ${team.slug}`);
    if (registry.teams.some(t => t.team_id !== teamId && t.closed_at == null && t.project_id === team.project_id && t.slug === slug)) throw new Error(`team slug already exists: ${slug}`);
    const changed = team.label !== label.trim() || team.slug !== slug;
    if (changed) { team.label = label.trim(); team.slug = slug; team.pending_native_label = team.label; team.updated_at = iso(); }
    return { team, changed };
  }, { file });
}
export function setTeamDisplayPending(teamId, expected, { file = teamsJsonPath() } = {}) {
  return mutateTeams(registry => {
    const team = registry.teams.find(t => t.team_id === teamId);
    if (!team || team.lifecycle !== 'open' || team.label !== expected.label || team.herdr_session !== expected.herdr_session || team.herdr_workspace_id !== expected.herdr_workspace_id) return false;
    team.pending_native_label = team.label;
    return true;
  }, { file });
}
export function acknowledgeTeamDisplay(teamId, expected, { file = teamsJsonPath() } = {}) {
  return mutateTeams(registry => {
    const team = registry.teams.find(t => t.team_id === teamId);
    if (!team || team.herdr_session !== expected.herdr_session || team.herdr_workspace_id !== expected.herdr_workspace_id || team.pending_native_label !== expected.label) return false;
    delete team.pending_native_label;
    return true;
  }, { file });
}
export function adoptTeamWorkspace({ label, projectId, herdrSession, workspaceId, file = teamsJsonPath() } = {}) {
  const slug = slugifyTeamLabel(label);
  return mutateTeams((registry, state) => {
    const association = state.mappings.projects[projectId];
    if (!association || association.session !== herdrSession || association.lifecycle !== 'open') throw new Error(`team adoption requires an open owned project/session association; use session adopt/start first`);
    const team = registry.teams.find(t => t.project_id === projectId && t.slug === slug && t.closed_at == null);
    const foreign = registry.teams.find(t => t.team_id !== team?.team_id && t.closed_at == null && t.herdr_session === herdrSession && t.herdr_workspace_id === workspaceId);
    if (foreign) throw new Error(`workspace already owned: ${foreign.team_id}`);
    if (team?.lifecycle === 'closing') throw new Error(`team is closing: ${team.slug}`);
    if (team) {
      const noop = team.herdr_session === herdrSession && team.herdr_workspace_id === workspaceId;
      const previous = { session: team.herdr_session, workspace_id: team.herdr_workspace_id };
      if (!noop) { team.herdr_session = herdrSession; team.herdr_workspace_id = workspaceId; team.updated_at = iso(); }
      return { team, noop, previous_placement: previous };
    }
    const created = { team_id: crypto.randomUUID(), project_id: projectId, label: label.trim(), slug,
      owner_session_id: null, member_session_ids: [], herdr_session: herdrSession, herdr_workspace_id: workspaceId,
      generation: 0, lifecycle: 'open', created_at: iso(), updated_at: iso(), closed_at: null };
    registry.teams.push(created);
    return { team: created, noop: false, previous_placement: null };
  }, { file });
}
export function closeTeam(teamId, { file = teamsJsonPath() } = {}) {
  if (!validId(teamId)) throw new Error('team_id is required');
  const options = { files: managementFiles({ teams: file }) };
  beginManagementClose({ teamId }, options);
  return finishManagementClose({ teamId }, options);
}
export function teamIsOpen(team) { return team?.closed_at == null; }
