// Logical team controls and exact physical workspace effects stay separate.
import { renameTeam, setTeamDisplayPending, acknowledgeTeamDisplay, adoptTeamWorkspace } from './team-registry.js';
export async function teamNativeEvidence(team, native) {
  const pair = { session: team?.herdr_session ?? null, workspace_id: team?.herdr_workspace_id ?? null };
  if (!pair.session || !pair.workspace_id) return { state: 'unavailable', ...pair, reason: 'no recorded workspace', recovery: 'create/adopt an exact native workspace' };
  try {
    const rows = await native.workspaceList(pair.session);
    if (!Array.isArray(rows)) throw new Error('invalid workspace inventory');
    const workspace = rows.find(w => w.workspace_id === pair.workspace_id);
    return { state: workspace ? 'available' : 'unavailable', ...pair, workspace: workspace ?? null,
      reason: workspace ? 'exact native workspace exists' : 'recorded workspace is absent', recovery: workspace ? null : 'inspect native inventory; explicitly create/adopt' };
  } catch (error) { return { state: 'unavailable', ...pair, reason: `native inventory unavailable: ${error.message}`, recovery: 'restore native connection and retry' }; }
}
export async function focusManagedTeam(team, { native, attach = false, json = false } = {}) {
  const capability = await teamNativeEvidence(team, native);
  if (capability.state !== 'available') return { ok: false, team, capability, error: capability.reason };
  try {
    if (!await native.workspaceFocus({ session: team.herdr_session, workspaceId: team.herdr_workspace_id })) throw new Error('native focus unconfirmed');
    if (attach) {
      const status = await native.sessionAttach(team.herdr_session, { outputToStderr: json });
      if (status !== 0) return { ok: false, team, capability, focused: true, attached: false, status, error: 'native UI attach failed after focus' };
    }
    return { ok: true, team, capability, focused: true, ...(attach ? { attached: true } : {}) };
  } catch (error) { return { ok: false, team, capability, error: error.message }; }
}
export async function renameManagedTeam(teamId, label, { native } = {}) {
  const changed = renameTeam(teamId, label);
  const team = changed.team;
  const capability = await teamNativeEvidence(team, native);
  if (!team.pending_native_label && capability.state === 'available' && capability.workspace.label === team.label) return { ok: true, team, noop: true, logical_changed: false, display_updated: false };
  if (!team.pending_native_label) {
    if (!setTeamDisplayPending(teamId, team)) return { ok: false, team, error: 'team placement/label changed; inspect/retry' };
    team.pending_native_label = team.label;
  }
  if (capability.state !== 'available') return { ok: false, team, capability, logical_changed: changed.changed, display_updated: false, error: capability.reason };
  try {
    if (!await native.workspaceRename({ session: team.herdr_session, workspaceId: team.herdr_workspace_id, label: team.pending_native_label })) throw new Error('native display update unconfirmed');
    const acknowledged = acknowledgeTeamDisplay(teamId, { ...team, label: team.pending_native_label });
    return { ok: acknowledged, team: acknowledged ? { ...team, pending_native_label: undefined } : team,
      logical_changed: changed.changed, display_updated: true, noop: false,
      ...(!acknowledged ? { error: 'display result superseded; inspect/retry current team placement/label' } : {}) };
  } catch (error) { return { ok: false, team, logical_changed: changed.changed, display_updated: false, error: error.message }; }
}
export async function adoptManagedTeam(label, { projectId, session, workspaceId, native } = {}) {
  const capability = await teamNativeEvidence({ herdr_session: session, herdr_workspace_id: workspaceId }, native);
  if (capability.state !== 'available') return { ok: false, capability, error: capability.reason };
  const adopted = adoptTeamWorkspace({ label, projectId, herdrSession: session, workspaceId });
  return { ok: true, ...adopted, adopted: !adopted.noop, capability };
}
