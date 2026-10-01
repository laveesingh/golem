// Bounded row-only adapter for pre-resolver programmatic callers and native
// journey fixtures. CLI management uses management-context/resolve directly.
// No worker-cache fallback; all inference delegates to the shared resolver.
import { resolveManagement, requireManagementResolution } from './management-resolve.js';
export const NO_TEAM_MESSAGE = 'no team: pass --team';
export function teamRowEvidence({ projectId = null, callerSessionId = null, teams = [], workers = [] } = {}) {
  return { teams, agents: workers.map(w => ({ ...w, id: w.session_id ?? w.worker_id })),
    sources: { cwdProject: { status: 'resolved', value: { project_id: projectId } },
      callerAgent: callerSessionId ? { status: 'resolved', value: { sessionId: callerSessionId, projectId } } : { status: 'not-applicable', reason: 'no caller' } } };
}
export function resolveCallerTeam({ teamRef = null, ...input } = {}) {
  const evidence = teamRowEvidence(input);
  const resolution = requireManagementResolution(resolveManagement({ operation: 'agent create', kind: 'agent', requiresTeam: true,
    selectors: teamRef ? { team: teamRef } : {} }, evidence));
  return input.teams.find(t => t.team_id === resolution.team_id);
}
export function resolveListTeam({ teamRef = null, ...input } = {}) {
  const evidence = teamRowEvidence(input);
  const resolution = requireManagementResolution(resolveManagement({ operation: 'agent list', kind: 'agent', selectors: teamRef ? { team: teamRef } : {} }, evidence));
  return input.teams.find(t => t.team_id === resolution.team_id) ?? null;
}
