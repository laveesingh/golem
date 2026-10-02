// Agent operations preserve conversation identity, membership and control handle.
import crypto from 'node:crypto';
import { renameWorkerControl, acknowledgeWorkerDisplay, completeWorkerMove, adoptWorkerControl, updateWorker } from './worker-registry.js';
import { allocateNativeHandle } from './management-registry.js';
import { nativeConversationMatches } from './worker-control.js';
import { currentWorkerPane } from './worker-manager.js';
import * as driver from './herdr-driver.js';
import { managementRosterSnapshot } from './management-capabilities.js';
import { upsertSessionFact } from './session-facts.js';
function nativeAgentTarget(query, native) {
  const target = query.evidence.agents.find(a => a.id === query.resolution.target?.id || a.session_id === query.resolution.target?.session_id);
  const row = managementRosterSnapshot([target], { snapshot: query.evidence.snapshot, facts: query.evidence.sources.facts.value ?? [], native })[0];
  if (!row.placement?.session || !row.placement?.pane_id) throw new Error(`No terminal was found for ${target?.name ?? target?.session_id}.`);
  return row;
}
const unavailable = reason => ({ state: 'unavailable', reason, recovery: 'inspect exact native identity/placement and retry with supported evidence' });
export function managedAgentRow(query) {
  return query.evidence.workers.find(w => w.worker_id === query.resolution.target?.worker_id) ?? null;
}
export function inspectManagedAgent(query, { native = driver } = {}) {
  const target = query.evidence.agents.find(a => a.id === query.resolution.target?.id || a.session_id === query.resolution.target?.session_id);
  const worker = managedAgentRow(query);
  const fact = query.evidence.sources.facts.value?.find(f => f.canonical_id === target?.session_id) ?? null;
  return { ...target, worker, fact, placement: worker ? { session: worker.herdr_session, workspace_id: worker.herdr_workspace_id, tab_id: worker.herdr_tab_id, pane_id: worker.herdr_pane_id } : query.resolution.placement,
    logical_name: worker?.name ?? target?.name ?? null, native_handle: worker?.herdr_agent_name ?? null,
    pending_native_label: worker?.pending_native_label ?? null,
    capabilities: managementRosterSnapshot([target], { snapshot: query.evidence.snapshot, facts: query.evidence.sources.facts.value ?? [], native })[0].capabilities };
}
export function renameManagedAgent(query, name, { native = driver } = {}) {
  const worker = managedAgentRow(query);
  if (!worker) {
    const row = nativeAgentTarget(query, native);
    native.paneLabel({ session: row.placement.session, paneId: row.placement.pane_id, label: name });
    const fact = query.evidence.sources.facts.value?.find(f => f.canonical_id === row.session_id);
    if (fact) upsertSessionFact({ ...fact, name });
    return { ok: true, session_id: row.session_id, name, placement: row.placement, display_updated: true };
  }
  const renamed = renameWorkerControl(worker.worker_id, name);
  const current = renamed.worker;
  if (!current.pending_native_label) return { ok: true, ...current, logical_changed: false, display_updated: false, noop: true };
  try {
    if (!native.paneLabel({ session: current.herdr_session, paneId: currentWorkerPane(current, native), label: current.pending_native_label })) throw new Error('Terminal label update was not confirmed.');
    const updated = acknowledgeWorkerDisplay(current.worker_id, current);
    if (!updated) return { ok: false, ...current, logical_changed: renamed.changed, display_updated: true, error: 'native label result superseded; inspect/retry current name' };
    return { ok: true, ...updated, logical_changed: renamed.changed, display_updated: true, noop: false };
  } catch (error) { return { ok: false, ...current, logical_changed: renamed.changed, display_updated: false, error: error.message }; }
}
export function moveManagedAgent(query, workspaceId, { native = driver, session = null } = {}) {
  const worker = managedAgentRow(query);
  if (!worker) {
    const row = nativeAgentTarget(query, native);
    const moved = native.paneMove({ session: row.placement.session, paneId: row.placement.pane_id, workspaceId });
    return { ok: true, session_id: row.session_id, placement: { session: row.placement.session, ...moved } };
  }
  if (session && session !== worker.herdr_session) return { ok: false, capability: { state: 'unsupported', reason: 'cross-server move is not supported' }, error: 'cross-server move unsupported; no kill/relaunch performed' };
  const paneId = currentWorkerPane(worker, native);
  if (worker.pending_native_move) {
    const current = native.agentGet({ session: worker.herdr_session, target: paneId });
    if (current?.workspace_id === worker.pending_native_move.workspace_id && current.pane_id && current.tab_id) {
      const repaired = completeWorkerMove(worker.worker_id, current, worker);
      return { ok: repaired.ok, ...repaired.worker, operation_id: worker.pending_native_move.operation_id, recovered_move: true, noop: true };
    }
    return { ok: false, ...worker, capability: unavailable('native move is unresolved; inspect exact returned/current placement before retry'), operation_id: worker.pending_native_move.operation_id, error: 'native move unresolved; no duplicate move issued' };
  }
  const rows = native.workspaceList(worker.herdr_session);
  if (!rows.some(w => w.workspace_id === workspaceId)) return { ok: false, capability: unavailable('destination workspace absent'), error: 'destination workspace absent; no creation performed' };
  if (worker.herdr_workspace_id === workspaceId) return { ok: true, ...worker, noop: true };
  const moveIntent = { operation_id: crypto.randomUUID(), workspace_id: workspaceId, pane_id: paneId };
  updateWorker(worker.worker_id, { pending_native_move: moveIntent });
  try {
    const moved = native.paneMove({ session: worker.herdr_session, paneId, workspaceId });
    if (!moved?.pane_id || !moved?.workspace_id || !moved?.tab_id) throw new Error('native move omitted exact returned IDs; inspect before retry');
    const completed = completeWorkerMove(worker.worker_id, moved, worker);
    if (!completed.ok) return { ok: false, ...completed.worker, error: 'native move result superseded; exact returned resource recorded for inspection' };
    return { ok: moved.workspace_id === workspaceId, ...completed.worker, operation_id: moveIntent.operation_id, noop: false, closed_source_workspace_id: moved.closed_source_workspace_id ?? null, closed_source_tab_id: moved.closed_source_tab_id ?? null,
      ...(moved.workspace_id !== workspaceId ? { error: 'native move landed in a different workspace; actual returned placement recorded' } : {}), previous_placement: { pane_id: worker.herdr_pane_id, tab_id: worker.herdr_tab_id, workspace_id: worker.herdr_workspace_id } };
  } catch (error) { return { ok: false, ...worker, operation_id: moveIntent.operation_id, pending_native_move: moveIntent, error: error.message }; }
}
export function adoptManagedAgent(query, { native = driver, paneId = null } = {}) {
  const sid = query.resolution.target?.session_id ?? query.resolution.target?.id;
  const fact = query.evidence.sources.facts.value?.find(f => f.canonical_id === sid);
  const session = query.resolution.session;
  if (!fact || !session) return { ok: false, capability: unavailable('registered locator/native session missing'), error: 'exact registered native identity/session unavailable for adoption' };
  let candidates;
  try { candidates = paneId ? [native.agentGet({ session, target: paneId })] : native.agentList(session).filter(a => nativeConversationMatches(fact, a)); }
  catch (error) { return { ok: false, capability: unavailable(error.message), error: error.message }; }
  if (candidates.length !== 1 || (!paneId && !nativeConversationMatches(fact, candidates[0]))) return { ok: false, capability: unavailable('native identity absent/ambiguous/mismatched'), error: 'native conversation identity unavailable or ambiguous; supply a matching exact --pane' };
  const agent = candidates[0];
  // Native selection pins the pane. Adoption does not require process leases.
  const identity = { pgid: null, members: [] };
  const existing = managedAgentRow(query);
  let runtimeId = crypto.randomUUID();
  let handle = existing?.herdr_agent_name ?? agent.name ?? allocateNativeHandle(runtimeId);
  if (!existing && !agent.name) {
    const used = new Set([...native.agentList(session).map(a => a.name).filter(Boolean), ...query.evidence.workers.filter(w => w.herdr_session === session).map(w => w.herdr_agent_name)]);
    while (used.has(handle)) { runtimeId = crypto.randomUUID(); handle = allocateNativeHandle(runtimeId); }
  }
  const result = adoptWorkerControl({ agent: { ...fact, session_id: sid, name: fact.name ?? agent.name ?? sid }, teamId: query.resolution.team_id, session, pane: agent, identity, nativeHandle: handle, runtimeId });
  if ((!agent.name && !result.noop) || result.worker.pending_native_handle) {
    try { if (agent.name !== handle && !native.agentRename({ session, paneId: agent.pane_id, name: handle })) throw new Error('native handle registration unconfirmed');
      updateWorker(result.worker.worker_id, { pending_native_handle: null }); }
    catch (error) { updateWorker(result.worker.worker_id, { pending_native_handle: handle }); return { ok: false, ...result.worker, adopted: true, error: error.message, pending_native_handle: handle }; }
  }
  return { ok: true, ...result.worker, pending_native_handle: null, adopted: !result.noop, noop: result.noop };
}
