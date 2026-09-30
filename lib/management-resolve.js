// Pure scope/target resolution. Explicit selectors constrain; caller logical
// membership precedes actual inherited pane context, then cwd project only.
const active = row => !row.ended_at && !['dead', 'stopped', 'superseded'].includes(row.state ?? row.status);
const open = team => team.closed_at == null;
const idOf = row => row.id ?? row.session_id ?? row.worker_id ?? row.team_id ?? row.session ?? row.name;
const summary = row => ({ id: idOf(row), name: row.name ?? row.label ?? row.slug ?? null, project_id: row.project_id ?? null, team_id: row.team_id ?? null });
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
function unique(rows) { return [...new Map(rows.map(row => [idOf(row), row])).values()]; }
export function resolveManagement(input = {}, evidence = {}) {
  const { operation = 'context', kind = operation.split(' ')[0], target = null, scope = null, requiresTeam = false } = input;
  const selectors = { ...(evidence.selectors ?? {}), ...(input.selectors ?? {}) };
  const sources = evidence.sources ?? {};
  const teams = Array.isArray(evidence.teams) ? evidence.teams : [];
  const agents = Array.isArray(evidence.agents) ? evidence.agents : [];
  const snapshot = evidence.snapshot;
  const inventory = sources.nativeSessions?.status === 'resolved' && Array.isArray(sources.nativeSessions.value) ? sources.nativeSessions.value : [];
  const knownSessions = unique([...inventory.map(row => ({ ...row, id: row.name, session: row.name })),
    ...Object.values(snapshot?.mappings.projects ?? {}).map(row => ({ ...row, id: row.session }))]);
  const result = { ok: true, operation, target_kind: kind, scope: 'project', target: null,
    project_id: null, team_id: null, session: null, placement: null, provenance: {},
    constraints: { ...selectors }, required_capabilities: operation === 'context' || operation.endsWith(' list') ? [] : [operation.split(' ')[1]],
    candidates: [], missing: [], conflicts: [], evidence: Object.fromEntries(Object.entries(sources).map(([key, source]) => [key,
      ['resolved', 'unavailable', 'not-applicable'].includes(source.status) ? { status: source.status, ...(source.reason ? { reason: source.reason } : {}) } : { status: 'unavailable', reason: 'malformed evidence status' }])) };
  const assign = (key, value, origin) => { if (value != null) { result[key] = value; result.provenance[key] = origin; } };
  const conflict = (field, message, facts = {}) => result.conflicts.push({ field, message, ...facts });
  const missing = (field, message, candidates = []) => { result.missing.push({ field, message }); result.candidates.push(...candidates.map(summary)); };
  let project = sources.explicitProject?.status === 'resolved' ? sources.explicitProject.value?.project_id : text(selectors.project);
  if (selectors.project != null && sources.explicitProject?.status === 'unavailable') { conflict('project', sources.explicitProject.reason); project = null; }
  let explicitTeam = null;
  if (selectors.team != null) {
    const key = text(selectors.team);
    let matches = teams.filter(t => t.team_id === key);
    if (!matches.length) matches = teams.filter(t => t.slug === key && open(t) && (!project || t.project_id === project));
    if (matches.length !== 1) missing('team', `unknown or ambiguous team: ${key}; pass --team <exact-team-id>`, matches.length ? matches : teams.filter(t => open(t) && (!project || t.project_id === project)));
    else explicitTeam = matches[0];
    if (explicitTeam && project && explicitTeam.project_id !== project) conflict('project', `explicit project ${project} conflicts with team ${explicitTeam.team_id} in ${explicitTeam.project_id}`);
  }
  const explicitSession = text(selectors.session);
  const nativeProject = session => Object.values(snapshot?.mappings.projects ?? {}).find(p => p.session === session)?.project_id
    ?? Object.values(snapshot?.plan?.projects ?? {}).find(p => p.session === session)?.project_id
    ?? unique(teams.filter(t => t.herdr_session === session).map(t => ({ id: t.project_id }))).map(p => p.id).filter(Boolean).filter((_, i, all) => all.length === 1)[0] ?? null;
  let caller = sources.callerAgent?.status === 'resolved' && sources.callerAgent.value?.sessionId ? { id: sources.callerAgent.value.sessionId,
    project_id: sources.callerAgent.value.projectId, ...agents.find(a => a.session_id === sources.callerAgent.value.sessionId) } : null;
  if (selectors.caller != null) {
    caller = agents.find(a => a.session_id === selectors.caller) ?? null;
    if (!caller) missing('caller', `unknown caller ${selectors.caller}; pass --caller <exact-conversation-id>`, agents);
  }
  const callerTeam = caller?.session_id || caller?.id ? teams.find(t => open(t) && (t.owner_session_id === (caller.session_id ?? caller.id) || t.member_session_ids?.includes(caller.session_id ?? caller.id))) : null;
  const pane = sources.callerPane?.status === 'resolved' && sources.callerPane.value?.session && sources.callerPane.value?.workspace_id ? sources.callerPane.value : null;
  const paneTeams = pane ? teams.filter(t => open(t) && t.herdr_session === pane.session && t.herdr_workspace_id === pane.workspace_id) : [];
  if (paneTeams.length > 1) result.evidence.callerPane = { status: 'unavailable', reason: 'caller workspace has conflicting team associations' };
  const paneTeam = paneTeams.length === 1 ? paneTeams[0] : null;
  let ref = text(target);
  if (ref === 'self') {
    ref = caller?.session_id ?? caller?.id ?? null;
    if (!ref) missing('caller', 'self is unresolved: pass --caller <exact-conversation-id> or a concrete target ID', agents);
  }
  let selected = null, exact = false;
  if (kind === 'session' && ref && explicitSession && ref !== explicitSession) conflict('session', `positional session ${ref} conflicts with --session ${explicitSession}`);
  if (ref && kind === 'agent') {
    const matches = agents.filter(a => a.session_id === ref || a.worker_id === ref || a.id === ref);
    const live = matches.filter(active);
    if (matches.length === 1 || live.length === 1) { selected = live[0] ?? matches[0]; exact = true; }
    else if (matches.length > 1) { exact = true; missing('agent', `agent identity is ambiguous: ${ref}; inspect exact competing runtime IDs`, matches); }
  } else if (ref && kind === 'team') {
    selected = teams.find(t => t.team_id === ref) ?? null; exact = !!selected;
  } else if (ref && kind === 'session') {
    // Native session handles are exact global identities, not project labels.
    selected = knownSessions.find(s => s.session === ref || s.name === ref) ?? null;
    if (!selected && sources.nativeSessions?.status !== 'resolved') selected = { id: ref, session: ref };
    exact = !!selected;
  }
  if (selected && exact) {
    const targetProject = kind === 'session' ? nativeProject(ref) : selected.project_id;
    const targetTeam = kind === 'agent' ? selected.team_id : (kind === 'team' ? selected.team_id : null);
    const targetSession = kind === 'session' ? ref : selected.herdr_session;
    if (project && targetProject && project !== targetProject) conflict('project', `explicit project ${project} conflicts with exact target ${ref} in ${targetProject}`);
    if (explicitTeam && targetTeam !== explicitTeam.team_id) conflict('team', `explicit team ${explicitTeam.team_id} conflicts with exact target ${ref} in team ${targetTeam ?? 'none'}`);
    if (explicitSession && targetSession && explicitSession !== targetSession) conflict('session', `explicit session ${explicitSession} conflicts with exact target ${ref} in ${targetSession}`);
    assign('project_id', targetProject, 'exact-target'); assign('team_id', targetTeam, 'exact-target'); assign('session', targetSession, 'exact-target');
  }
  if (project) assign('project_id', project, 'explicit-project');
  if (explicitTeam) { assign('project_id', explicitTeam.project_id, result.project_id ? result.provenance.project_id : 'explicit-team'); assign('team_id', explicitTeam.team_id, 'explicit-team'); }
  if (explicitSession) {
    const parent = nativeProject(explicitSession);
    if (result.project_id && parent && result.project_id !== parent) conflict('session', `explicit session ${explicitSession} belongs to project ${parent}, not ${result.project_id}`);
    if (explicitTeam && explicitTeam.herdr_session !== explicitSession && kind !== 'agent') conflict('session', `explicit session ${explicitSession} conflicts with team ${explicitTeam.team_id} in ${explicitTeam.herdr_session}`);
    assign('session', explicitSession, 'explicit-session'); if (!result.project_id) assign('project_id', parent, 'explicit-session');
  }
  const global = scope === 'all' || (operation === 'session list' && !scope && !project && !explicitTeam && !explicitSession);
  if (!result.project_id && !global && !exact) {
    const logicalProject = callerTeam?.project_id ?? caller?.project_id;
    if (logicalProject) assign('project_id', logicalProject, selectors.caller ? 'explicit-caller' : 'caller-agent');
    else if (paneTeam?.project_id || (pane && nativeProject(pane.session))) assign('project_id', paneTeam?.project_id ?? nativeProject(pane.session), 'caller-pane');
    else if (sources.cwdProject?.status === 'resolved') assign('project_id', sources.cwdProject.value?.project_id, 'cwd-project');
  }
  if (!result.team_id && !global && !exact && scope !== 'project') {
    const inferred = callerTeam && (!result.project_id || callerTeam.project_id === result.project_id) ? callerTeam
      : (!caller && paneTeam && (!result.project_id || paneTeam.project_id === result.project_id) ? paneTeam : null);
    if (inferred) assign('team_id', inferred.team_id, inferred === callerTeam ? 'caller-agent-membership' : 'caller-pane-workspace');
  }
  if (!result.session && result.project_id) {
    const mapped = snapshot?.mappings.projects?.[result.project_id]?.session ?? snapshot?.plan?.projects?.[result.project_id]?.session;
    if (mapped) assign('session', mapped, 'project-association');
  }
  if (ref && !selected && !exact) {
    let candidates = kind === 'agent' ? agents.filter(a => a.name === ref && active(a)) : kind === 'team' ? teams.filter(t => (t.slug === ref || t.label === ref) && open(t)) : [];
    candidates = candidates.filter(a => !result.project_id || a.project_id === result.project_id);
    if (explicitTeam && kind === 'agent') candidates = candidates.filter(a => a.team_id === explicitTeam.team_id);
    else if (result.team_id && kind === 'agent') {
      const preferred = candidates.filter(a => a.team_id === result.team_id);
      if (preferred.length) candidates = preferred;
    }
    if (explicitSession) candidates = candidates.filter(a => a.herdr_session === explicitSession);
    if (candidates.length === 1) {
      selected = candidates[0]; assign('project_id', selected.project_id, 'target-name');
      assign('team_id', kind === 'team' ? selected.team_id : selected.team_id, 'target-name');
      if (selected.herdr_session) assign('session', selected.herdr_session, 'target-placement');
    } else {
      const retired = kind === 'agent' && agents.some(a => a.name === ref && !active(a) && (!result.project_id || a.project_id === result.project_id));
      const available = kind === 'session' ? knownSessions : kind === 'team' ? teams.filter(t => open(t) && (!result.project_id || t.project_id === result.project_id))
        : agents.filter(a => active(a) && (!result.project_id || a.project_id === result.project_id) && (!explicitTeam || a.team_id === explicitTeam.team_id) && (!explicitSession || a.herdr_session === explicitSession));
      missing(kind, `${kind} ${candidates.length > 1 ? 'name is ambiguous' : retired ? 'is retired' : 'not found'}: ${ref}${candidates.length > 1 ? ` (${candidates.length} ${kind === 'agent' ? 'agents' : 'targets'})` : ''}; pass an exact ${kind === 'session' ? 'native session handle' : `${kind} ID`}`, candidates.length ? candidates : available);
    }
  }
  if (kind === 'team' && !ref && !operation.endsWith(' list') && !operation.endsWith(' create')) {
    if (explicitTeam) selected = explicitTeam;
    else missing('team', 'no team target: pass --team <exact-team-id> or a team operand', teams.filter(t => open(t) && (!result.project_id || t.project_id === result.project_id)));
  }
  if (operation === 'session close' && !ref && !explicitSession) missing('session', 'session close requires an exact target: pass --session <exact-handle>', knownSessions);
  if (kind === 'session' && !ref && operation !== 'session list') {
    if (explicitSession || result.session) selected = knownSessions.find(s => s.session === (explicitSession ?? result.session)) ?? { id: explicitSession ?? result.session, session: explicitSession ?? result.session };
    else missing('session', 'no session: pass --session <exact-handle> or --project <project-id>', knownSessions);
  }
  if (selected && kind === 'team') { assign('team_id', selected.team_id, exact ? 'exact-target' : 'target-name'); if (!result.session) assign('session', selected.herdr_session, 'team-association'); }
  if (requiresTeam && !result.team_id) missing('team', 'no team: pass --team <exact-team-id>; cwd never selects a team', teams.filter(t => open(t) && (!result.project_id || t.project_id === result.project_id)));
  if (!result.project_id && !global && !exact && kind !== 'session') missing('project', 'no project: pass --project <project-id>');
  if (selected) {
    result.target = { ...summary(selected), worker_id: selected.worker_id ?? null, session_id: selected.session_id ?? null,
      slug: selected.slug ?? null, state: selected.state ?? selected.status ?? null, lifecycle: selected.lifecycle ?? null,
      herdr_session: selected.herdr_session ?? selected.session ?? null, herdr_workspace_id: selected.herdr_workspace_id ?? null,
      herdr_pane_id: selected.herdr_pane_id ?? null, herdr_tab_id: selected.herdr_tab_id ?? null };
    result.placement = { session: result.target.herdr_session, workspace_id: result.target.herdr_workspace_id, pane_id: result.target.herdr_pane_id, tab_id: result.target.herdr_tab_id };
  } else if (pane && operation === 'context') result.placement = { ...pane };
  result.scope = global && !project && !explicitTeam && !explicitSession ? 'global' : result.team_id ? 'team' : result.project_id ? 'project' : 'session';
  if (result.scope === 'global') { result.project_id = null; result.team_id = null; result.session = null; result.provenance.scope = 'explicit-global'; }
  const relation = snapshot?.plan?.projects?.[result.project_id];
  result.relations = relation ? { association: relation.association, membership: relation.membership, conflicts: relation.conflicts, provisioning: relation.provisioning } : null;
  if (['agent create', 'team create', 'session start'].includes(operation)) {
    if (relation?.association === 'conflicted') conflict('session', `project ${result.project_id} has conflicting exact runtime associations; use session adopt to choose its exact resource`, { relations: relation.conflicts });
    const mapped = snapshot?.mappings.projects?.[result.project_id]?.session ?? relation?.session;
    if (explicitSession && mapped !== explicitSession) conflict('session', `new placement requires an owned project/session association; ${explicitSession} is not the recorded runtime ${mapped ?? '(none)'}`);
  }
  result.ok = !result.missing.length && !result.conflicts.length;
  result.candidates = unique(result.candidates);
  result.corrected_command = result.missing.some(m => m.field === 'team') ? `golem ${operation} --team <exact-team-id>${result.project_id ? ` --project ${result.project_id}` : ''}`
    : result.missing.some(m => m.field === 'caller') ? `golem ${operation} --caller <exact-conversation-id>` : `golem ${operation} <exact-${kind}-id>`;
  return result;
}
export function managementResolutionError(resolution) {
  const message = [...resolution.conflicts, ...resolution.missing].map(c => c.message).join('; ');
  const candidates = resolution.candidates.length ? `; candidates: ${resolution.candidates.map(c => `${c.id}${c.name ? ` (${c.name})` : ''}`).join(', ')}` : '';
  const error = new Error(`${message}${candidates}; try: ${resolution.corrected_command}`);
  error.code = 'INVALID_MANAGEMENT_SCOPE'; error.exitCode = 2; error.resolution = resolution;
  return error;
}
export function requireManagementResolution(resolution) { if (!resolution.ok) throw managementResolutionError(resolution); return resolution; }
