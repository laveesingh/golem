// team-context — resolve the caller's team for spawn and list (GOL-363 G8).
//
// Pure functions over team/worker rows: the CLI loads the rows through the
// registries, then resolves here. Order for spawn: --team → the open team the
// caller owns or joined (GOL-382 R4) → the team on the caller's own worker row
// (by session_id) → refuse. List uses the same order but falls back to
// project scope instead of refusing.

import { teamHasSession } from './team-registry.js';

export const NO_TEAM_MESSAGE = 'no team: pass --team or run golem team join <team>';

function openTeamsIn(teams, projectId) {
  return (Array.isArray(teams) ? teams : []).filter((row) => (
    row?.closed_at == null && (projectId == null || row.project_id === projectId)
  ));
}

function findOpenTeam(teams, teamId) {
  return (Array.isArray(teams) ? teams : []).find((row) => (
    row?.team_id === teamId && row?.closed_at == null
  )) ?? null;
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
    const owned = workerRow?.team_id ? findOpenTeam(open, workerRow.team_id) : null;
    if (owned) return owned;
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
