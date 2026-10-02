// Shared read-only roster/control projection. Delivery stays a separate fact.
import { projectManagementSnapshot, effectiveTeamForSession } from './management-registry.js';
import { readSessionFacts } from './session-facts.js';
import { projectIdFor } from './project-id.js';
import { nativeConversationMatches } from './worker-control.js';
import * as driver from './herdr-driver.js';
const cap = (state, reason, recovery = null) => ({ state, reason, recovery });
export function managementRosterSnapshot(rows, { snapshot = projectManagementSnapshot(), facts = readSessionFacts(), native = driver } = {}) {
  const inventories = new Map();
  const panesBySession = new Map();
  const paneExists = (session, paneId) => {
    if (!panesBySession.has(session)) {
      try { const panes = native.paneList(session); if (!Array.isArray(panes)) throw new Error('invalid pane inventory'); panesBySession.set(session, panes); }
      catch { panesBySession.set(session, null); }
    }
    return panesBySession.get(session)?.some(p => p.pane_id === paneId) ?? false;
  };
  const inventory = session => {
    if (!inventories.has(session)) {
      try { const actors = native.agentList(session); if (!Array.isArray(actors)) throw new Error('invalid native agent inventory'); inventories.set(session, { actors }); }
      catch (error) { inventories.set(session, { actors: [], error: error.message }); }
    }
    return inventories.get(session);
  };
  return rows.map(row => {
    const fact = facts.find(f => f.canonical_id === row.session_id);
    const claims = snapshot.workers.workers.filter(w => w.session_id === row.session_id);
    const activeClaims = claims.filter(w => ['live', 'spawning', 'failed'].includes(w.state));
    const ambiguous = activeClaims.length > 1;
    const worker = activeClaims.length === 1 ? activeClaims[0] : claims[0];
    const team = effectiveTeamForSession(row.session_id, snapshot);
    const project = row.project_id ?? worker?.project_id ?? fact?.project_id ?? (fact?.project_path ? projectIdFor(fact.project_path) : null);
    const session = worker?.herdr_session ?? row.herdr_session ?? snapshot.mappings.projects[project]?.session ?? null;
    const legacy = worker?.tmux_session && !worker.herdr_session;
    const evidence = session ? inventory(session) : { actors: [], error: null };
    const exact = fact ? evidence.actors.filter(a => nativeConversationMatches(fact, a)) : [];
    let actor = worker ? evidence.actors.find(a => a.pane_id === worker.herdr_pane_id) ?? null : exact.length === 1 ? exact[0] : null;
    let placement = worker?.herdr_pane_id ? { session: worker.herdr_session, workspace_id: worker.herdr_workspace_id, tab_id: worker.herdr_tab_id, pane_id: worker.herdr_pane_id }
      : actor ? { session, workspace_id: actor.workspace_id, tab_id: actor.tab_id, pane_id: actor.pane_id } : null;
    const outside = !worker && !placement && !evidence.error && exact.length === 0;
    const unsupported = cap('unsupported', legacy ? 'legacy tmux runtime requires manual controls' : 'no integrated native placement for this external runtime', 'inspect native integration or use the runtime directly');
    const missing = cap('unavailable', evidence.error ? `native inventory unavailable: ${evidence.error}` : 'exact native identity/placement unavailable', 'restore native evidence; inspect/adopt the exact resource');
    if (actor?.pane_id) placement = { session, workspace_id: actor.workspace_id, tab_id: actor.tab_id, pane_id: actor.pane_id };
    const terminal = worker?.state === 'dead';
    const mapped = placement?.session && placement?.pane_id;
    const read = legacy || outside ? unsupported : terminal ? cap('unavailable', 'This agent has stopped.') : mapped ? cap('available', 'Selected terminal; native command reports runtime errors.') : missing;
    const stop = terminal ? cap('available', 'Already stopped; no-op.') : legacy || outside ? unsupported : mapped ? cap('available', 'Close the selected agent terminal; no authority or process-identity check.') : missing;
    const capabilities = { inspect: cap('available', 'known immutable conversation identity'), read, attach: read, stop,
      adopt: legacy || outside ? unsupported : fact && actor && nativeConversationMatches(fact, actor) ? cap('available', 'One matching native terminal; explicit team required.') : cap('unavailable', 'Choose the agent terminal with --pane and --team.'),
      rename: !legacy && (worker || mapped) ? cap('available', 'Rename the selected agent and terminal.') : unsupported,
      move: !legacy && !terminal && mapped ? cap('available', 'Move the selected terminal.') : missing };
    if (ambiguous) for (const operation of ['read', 'attach', 'stop', 'adopt', 'rename', 'move']) capabilities[operation] = cap('unavailable', 'ambiguous active runtime claims for this conversation', 'inspect exact competing worker IDs');
    return { ...row, ...(ambiguous ? { control_candidates: activeClaims.map(w => w.worker_id) } : {}), project_id: project, team_id: team?.team_id ?? null, team_label: team?.label ?? null,
      host: worker ? legacy ? 'legacy' : 'herdr' : 'external', placement,
      capabilities, control_provenance: { membership: 'canonical-team', placement: worker ? 'recorded-worker' : actor ? 'exact-native-conversation' : 'unavailable' },
      attach_hint: capabilities.attach.state === 'available' ? `golem agent attach ${row.session_id}` : null };
  });
}
