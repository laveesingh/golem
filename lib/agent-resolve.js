// Bounded row-only adapter for existing programmatic consumers. The CLI and
// all resolution behavior use the shared pure resolver; no parallel algorithm.
import { resolveManagement, requireManagementResolution } from './management-resolve.js';
import { teamRowEvidence } from './team-context.js';
export function callerTeamId(input = {}) {
  return requireManagementResolution(resolveManagement({ operation: 'agent list', kind: 'agent' }, teamRowEvidence(input))).team_id;
}
export function resolveAgentRef(ref, { workers = [], teams = [], projectId = null, callerTeam = null } = {}) {
  const callerId = callerTeam ? 'row-adapter-caller' : null;
  const projected = teams.map(t => t.team_id === callerTeam ? { ...t, member_session_ids: [...(t.member_session_ids ?? []), callerId] } : t);
  const evidence = teamRowEvidence({ projectId, callerSessionId: callerId, teams: projected, workers });
  const result = requireManagementResolution(resolveManagement({ operation: 'agent read', kind: 'agent', target: ref }, evidence));
  return workers.find(w => w.worker_id === result.target.worker_id) ?? workers.find(w => w.session_id === result.target.session_id);
}
export function resolveAgentScope({ scope = null, ...input } = {}) {
  if (scope && !['team', 'project', 'all'].includes(scope)) throw new Error(`invalid scope: ${scope} (expected team|project|all)`);
  const result = requireManagementResolution(resolveManagement({ operation: 'agent list', kind: 'agent', scope }, teamRowEvidence(input)));
  return { projectId: result.project_id, teamId: result.team_id };
}
