// agent-resolve — T2 identifiers and T3 scope for `golem agent` (GOL-363).
//
// Pure functions over worker/team rows. Every verb takes an exact session
// id; read, attach and stop also take a name that must be unique in the
// caller's team, then in the project. An ambiguous name fails and lists the
// candidates. Cross-team use stays allowed (D2): the team only sets the
// name preference and the list default, never a refusal.

import { activeWorkerStates } from './worker-registry.js';
import { resolveListTeam } from './team-context.js';

const ACTIVE = activeWorkerStates();

function occupied(row) {
  return ACTIVE.has(String(row?.state || '').toLowerCase());
}

export function callerTeamId({ callerSessionId = null, teams = [], projectId = null, workerRow = null } = {}) {
  const team = resolveListTeam({ projectId, callerSessionId, teams, workerRow });
  return team?.team_id ?? null;
}

function candidateLabel(row, teams) {
  const slug = (Array.isArray(teams) ? teams : []).find((team) => team?.team_id === row?.team_id)?.slug;
  return `${row?.session_id ?? '(no session)'}${row?.name ? ` name ${row.name}` : ''}${slug ? ` [${slug}]` : ''}`;
}

function ambiguous(ref, rows, teams) {
  const candidates = rows.map((row) => candidateLabel(row, teams)).join(', ');
  return new Error(`agent name is ambiguous: ${ref} (${rows.length} agents): ${candidates}; pass an exact session id`);
}

/**
 * Resolve one agent ref to a worker row. An exact session id wins anywhere
 * in scope; otherwise the name must be unique in the caller's team first,
 * then in the project.
 */
export function resolveAgentRef(ref, { workers = [], teams = [], projectId = null, callerTeam = null } = {}) {
  const key = String(ref ?? '').trim();
  if (!key) throw new Error('agent reference is required');
  const inScope = (Array.isArray(workers) ? workers : []).filter((row) => (
    projectId == null || row?.project_id === projectId
  ));
  const bySession = inScope.filter((row) => row?.session_id === key);
  if (bySession.length === 1) return bySession[0];
  if (bySession.length > 1) throw ambiguous(key, bySession, teams);
  const named = inScope.filter((row) => row?.name === key && occupied(row));
  if (!named.length) {
    const retired = inScope.find((row) => row?.name === key);
    if (retired) throw new Error(`agent is retired: ${key} (state ${retired.state ?? 'unknown'})`);
    throw new Error(`agent not found: ${key}`);
  }
  if (callerTeam) {
    const inTeam = named.filter((row) => row?.team_id === callerTeam);
    if (inTeam.length === 1) return inTeam[0];
    if (inTeam.length > 1) throw ambiguous(key, inTeam, teams);
  }
  if (named.length === 1) return named[0];
  throw ambiguous(key, named, teams);
}

/**
 * Resolve the list scope (T3): --scope team|project|all. The default is the
 * caller's team, or the project for a caller with no team. An explicit
 * --scope team without a team falls back to the project.
 */
export function resolveAgentScope({ scope = null, projectId = null, callerSessionId = null, teams = [], workerRow = null } = {}) {
  const mode = scope == null || String(scope).trim() === '' ? 'default' : String(scope).trim();
  if (!['default', 'team', 'project', 'all'].includes(mode)) {
    throw new Error(`invalid scope: ${scope} (expected team|project|all)`);
  }
  if (mode === 'all') return { projectId: null, teamId: null };
  if (mode === 'project') return { projectId, teamId: null };
  const team = resolveListTeam({ projectId, callerSessionId, teams, workerRow });
  return { projectId, teamId: team?.team_id ?? null };
}
