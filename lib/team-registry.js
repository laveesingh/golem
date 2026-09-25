// team-registry — durable store for teams (GOL-363 G4, G7; GOL-382 R4).
//
// One row per team: team_id, label, slug, project_id, owner_session_id (null
// when created from an unbound shell), member_session_ids (sessions that
// joined; managed workers belong through team_id on their worker row instead),
// herdr_session, herdr_workspace_id
// (null until the workspace exists), created_at/updated_at/closed_at. There
// is deliberately no spec reference field (D1).
//
// Same lock and atomic writer pattern as lib/worker-registry.js: every read
// and write goes through withRegistryLock on teams.json, resolved through
// teamsJsonPath() so tests can redirect it with a temp GOLEM_HOME.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { teamsJsonPath } from './golem-home.js';
import { withRegistryLock } from './session-facts.js';

export const TEAMS_REGISTRY_VERSION = 1;

function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function readRegistry(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== TEAMS_REGISTRY_VERSION || !Array.isArray(parsed.teams)) {
      throw new Error(`invalid teams registry schema at ${file}`);
    }
    return { version: TEAMS_REGISTRY_VERSION, teams: parsed.teams.map(normalizeRow) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: TEAMS_REGISTRY_VERSION, teams: [] };
    throw new Error(`cannot read teams registry at ${file}: ${error.message}`, { cause: error });
  }
}

function sessionIdOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** GOL-382 R4: rows written before owners and members carry lead_session_id;
 *  read them as the owner and write the new shape back. */
function normalizeRow(row) {
  if (!row || typeof row !== 'object') return row;
  const { lead_session_id: legacyLead, ...rest } = row;
  const owner = sessionIdOrNull(rest.owner_session_id) ?? sessionIdOrNull(legacyLead);
  const members = Array.isArray(rest.member_session_ids)
    ? [...new Set(rest.member_session_ids.map(sessionIdOrNull).filter((id) => id && id !== owner))]
    : [];
  return { ...rest, owner_session_id: owner, member_session_ids: members };
}

/** True when sessionId is the owner or a joined member of the team row. */
export function teamHasSession(team, sessionId) {
  const id = sessionIdOrNull(sessionId);
  if (!id || !team) return false;
  return team.owner_session_id === id || (Array.isArray(team.member_session_ids) && team.member_session_ids.includes(id));
}

/** A session is in at most one open team: take it out of every other one. */
function leaveOtherOpenTeams(teams, sessionId, keepTeamId, timestamp) {
  for (const row of teams) {
    if (!isOpen(row) || row.team_id === keepTeamId || !teamHasSession(row, sessionId)) continue;
    if (row.owner_session_id === sessionId) row.owner_session_id = null;
    row.member_session_ids = (row.member_session_ids ?? []).filter((id) => id !== sessionId);
    row.updated_at = timestamp;
  }
}

function writeRegistry(file, registry) {
  // GOL-382 R4: keep lead_session_id as a mirror of the owner for one release,
  // so a dashboard still running the old code keeps reading the owner.
  registry = { ...registry, teams: registry.teams.map((row) => ({ ...row, lead_session_id: row.owner_session_id ?? null })) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Derive the team slug from its label: lowercase [a-z][a-z0-9-]. */
export function slugifyTeamLabel(label) {
  if (typeof label !== 'string' || !label.trim()) throw new Error('team label is required');
  const slug = label.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-{2,}/g, '-');
  if (!/^[a-z][a-z0-9-]*$/.test(slug) || slug.length > 64) {
    throw new Error(`team label ${JSON.stringify(label)} does not produce a valid slug ([a-z][a-z0-9-], at most 64 characters)`);
  }
  return slug;
}

function isOpen(row) {
  return row?.closed_at == null;
}

function scoped(row, projectId) {
  return projectId == null || row.project_id === projectId;
}

function findIndex(teams, teamId) {
  return teams.findIndex((row) => row.team_id === teamId);
}

/**
 * The herdr agent name for a worker: <slug>-<name>, cut to herdr's 32-char
 * [a-z][a-z0-9_-] rule (G4). Sanitized (never throws on odd worker names):
 * lowercase, anything outside the rule becomes '-', then cut to 32. The slug
 * prefix guarantees the result starts with a letter.
 */
export function herdrAgentNameFor(slug, name) {
  if (typeof slug !== 'string' || !/^[a-z][a-z0-9-]*$/.test(slug)) throw new Error('team slug is required');
  if (typeof name !== 'string' || !name.trim()) throw new Error('worker name is required');
  return `${slug}-${name}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
}

export function readTeams({ file = teamsJsonPath(), projectId = null } = {}) {
  return withRegistryLock(file, () => readRegistry(file).teams
    .filter((row) => scoped(row, projectId))
    .map((row) => clone(row)));
}

export function withTeamsRegistryLock(fn, { file = teamsJsonPath() } = {}) {
  return withRegistryLock(file, () => fn({ file, registry: readRegistry(file) }));
}

/** Create the team row. The herdr workspace is created by the caller (cli/team.js) through the team-herdr seam. */
export function createTeam({
  label,
  projectId,
  ownerSessionId = null,
  herdrSession,
  herdrWorkspaceId = null,
  file = teamsJsonPath(),
  now = Date.now(),
} = {}) {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('team project_id is required');
  if (typeof herdrSession !== 'string' || !herdrSession.trim()) throw new Error('team herdr_session is required');
  const slug = slugifyTeamLabel(label);
  return withRegistryLock(file, () => {
    const registry = readRegistry(file);
    const taken = registry.teams.find((row) => (
      isOpen(row) && row.project_id === projectId.trim() && row.slug === slug
    ));
    if (taken) throw new Error(`team slug already exists: ${slug} (project ${projectId.trim()})`);
    const timestamp = iso(now);
    const owner = sessionIdOrNull(ownerSessionId);
    const team = {
      team_id: crypto.randomUUID(),
      label: label.trim(),
      slug,
      project_id: projectId.trim(),
      owner_session_id: owner,
      member_session_ids: [],
      herdr_session: herdrSession.trim(),
      herdr_workspace_id: herdrWorkspaceId ?? null,
      created_at: timestamp,
      updated_at: timestamp,
      closed_at: null,
    };
    if (owner) leaveOtherOpenTeams(registry.teams, owner, team.team_id, timestamp);
    registry.teams.push(team);
    writeRegistry(file, registry);
    return clone(team);
  });
}

/**
 * Find one team by team_id or slug (slug lookup stays inside one project).
 * An open row wins over a closed row with the same slug; two open rows with
 * the same slug refuse rather than pick one.
 */
export function findTeam(ref, { projectId = null, file = teamsJsonPath() } = {}) {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('team reference is required');
  const key = ref.trim();
  const rows = withRegistryLock(file, () => readRegistry(file).teams
    .filter((row) => scoped(row, projectId))
    .map((row) => clone(row)));
  const byId = rows.filter((row) => row.team_id === key);
  if (byId.length) return byId[0];
  const bySlug = rows.filter((row) => row.slug === key);
  if (!bySlug.length) return null;
  const open = bySlug.filter(isOpen);
  if (open.length === 1) return open[0];
  if (open.length > 1) {
    throw new Error(`team slug is ambiguous: ${key}; pass the team_id`);
  }
  return bySlug[bySlug.length - 1];
}

export function listTeams({ projectId = null, includeClosed = true, file = teamsJsonPath() } = {}) {
  return withRegistryLock(file, () => readRegistry(file).teams
    .filter((row) => scoped(row, projectId) && (includeClosed || isOpen(row)))
    .map((row) => clone(row)));
}

/**
 * Put sessionId in one team (GOL-382 R4): as a member, or as the owner with
 * owner=true. The previous owner stays as a member. The session leaves every
 * other open team first, so a session is in at most one open team.
 */
export function joinTeam(teamId, sessionId, { owner = false, file = teamsJsonPath(), now = Date.now() } = {}) {
  if (typeof teamId !== 'string' || !teamId.trim()) throw new Error('team_id is required');
  const id = sessionIdOrNull(sessionId);
  if (!id) throw new Error('session_id is required');
  return withRegistryLock(file, () => {
    const registry = readRegistry(file);
    const index = findIndex(registry.teams, teamId.trim());
    if (index < 0) throw new Error(`team not found: ${teamId}`);
    const team = registry.teams[index];
    if (team.closed_at != null) throw new Error(`team is closed: ${team.slug ?? teamId}`);
    const timestamp = iso(now);
    leaveOtherOpenTeams(registry.teams, id, team.team_id, timestamp);
    if (owner) {
      const previous = team.owner_session_id;
      team.owner_session_id = id;
      team.member_session_ids = team.member_session_ids.filter((member) => member !== id);
      if (previous && previous !== id && !team.member_session_ids.includes(previous)) team.member_session_ids.push(previous);
    } else if (team.owner_session_id !== id && !team.member_session_ids.includes(id)) {
      team.member_session_ids.push(id);
    }
    team.updated_at = timestamp;
    writeRegistry(file, registry);
    return clone(team);
  });
}

/** Record the workspace id once the seam creates it. */
export function setTeamWorkspace(teamId, workspaceId, { file = teamsJsonPath(), now = Date.now() } = {}) {
  if (typeof teamId !== 'string' || !teamId.trim()) throw new Error('team_id is required');
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new Error('workspace id is required');
  return withRegistryLock(file, () => {
    const registry = readRegistry(file);
    const index = findIndex(registry.teams, teamId.trim());
    if (index < 0) throw new Error(`team not found: ${teamId}`);
    registry.teams[index].herdr_workspace_id = workspaceId.trim();
    registry.teams[index].updated_at = iso(now);
    writeRegistry(file, registry);
    return clone(registry.teams[index]);
  });
}

/** Close the team row. Idempotent: closing a closed team returns it unchanged. */
export function closeTeam(teamId, { file = teamsJsonPath(), now = Date.now() } = {}) {
  if (typeof teamId !== 'string' || !teamId.trim()) throw new Error('team_id is required');
  return withRegistryLock(file, () => {
    const registry = readRegistry(file);
    const index = findIndex(registry.teams, teamId.trim());
    if (index < 0) throw new Error(`team not found: ${teamId}`);
    const team = registry.teams[index];
    if (team.closed_at == null) {
      const timestamp = iso(now);
      team.closed_at = timestamp;
      team.updated_at = timestamp;
      writeRegistry(file, registry);
    }
    return clone(team);
  });
}

export function teamIsOpen(team) {
  return isOpen(team);
}
