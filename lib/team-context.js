// team-context — resolve the caller's team for spawn and list (GOL-363 G8).
//
// Pure compatibility resolver over service-projected team rows. Registered
// membership comes only from teams v2 (or its bounded v1 import projection).
// There is no worker-cache precedence or fallback.

import { teamHasSession } from './team-registry.js';

export const NO_TEAM_MESSAGE = 'no team: pass --team or run golem team join <team>';

function openTeamsIn(teams, projectId) {
  return (Array.isArray(teams) ? teams : []).filter((row) => (
    row?.closed_at == null && (projectId == null || row.project_id === projectId)
  ));
}

/**
 * Resolve the team a spawn belongs to. teamRef is an explicit --team value
 * (team_id or slug); callerSessionId is null for an unbound shell.
 * Throws when nothing resolves. workerRow is the caller's own worker row
 * (found by session_id) or null.
 */
export function resolveCallerTeam({ teamRef = null, projectId = null, callerSessionId = null, teams = [], workerRow = null } = {}) {
  const open = openTeamsIn(teams, projectId);
  if (typeof teamRef === 'string' && teamRef.trim()) {
    const key = teamRef.trim();
    const team = open.find((row) => row.team_id === key || row.slug === key);
    if (!team) throw new Error(`unknown team: ${key}`);
    return team;
  }
  const caller = typeof callerSessionId === 'string' && callerSessionId.trim() ? callerSessionId.trim() : null;
  if (caller) {
    const joined = open.find((row) => teamHasSession(row, caller));
    if (joined) return joined;
    // teams is already a read-only v1 projection or canonical v2 snapshot.
    // Worker cache must never resurrect membership after leave/transfer.
  }
  throw new Error(NO_TEAM_MESSAGE);
}

/**
 * Resolve the team a list defaults to: the same order as spawn, but a caller
 * with no team gets project scope (null) instead of a refusal. An unbound
 * shell has no caller, so it always gets project scope.
 */
export function resolveListTeam({ teamRef = null, projectId = null, callerSessionId = null, teams = [], workerRow = null } = {}) {
  try {
    return resolveCallerTeam({ teamRef, projectId, callerSessionId, teams, workerRow });
  } catch {
    return null;
  }
}
