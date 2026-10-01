// Session controls own native effects outside short management transactions.
// Logical definitions survive stop; closed/partial outcomes require evidence.
import {
  readManagementSnapshot, projectManagementSnapshot, mappedSessionForProject,
  admitSessionStart, beforeNativeCall, recordNativeResult, commitAdmission,
  settleAdmission, adoptProjectAssociation, beginManagementClose,
  waitForManagementLaunches, finishManagementClose, reconcileStoppedSession,
} from './management-registry.js';
import { markSessionFactsEnded } from './session-facts.js';
import { markSessionsEnded } from './session-registry.js';

export function inspectManagedSession(session, { inventory = [], snapshot = projectManagementSnapshot() } = {}) {
  const parent = Object.values(snapshot.mappings.projects).find(p => p.session === session) ?? snapshot.mappings.session_states?.[session] ?? null;
  const native = inventory?.find(row => row.name === session) ?? null;
  const teams = snapshot.teams.teams.filter(t => t.herdr_session === session);
  const intents = snapshot.mappings.intents.filter(i => i.session === session && !['ready', 'cleaned', 'cancelled', 'failed', 'reconciled'].includes(i.phase));
  return { session, project_id: parent?.project_id ?? null, native_running: inventory == null ? null : native?.running ?? false,
    native_registered: inventory == null ? null : !!native, lifecycle: parent?.lifecycle ?? 'unowned', generation: parent?.generation ?? null,
    association: parent, teams, pending_operations: intents,
    import_facts: Object.values(snapshot.plan?.projects ?? {}).filter(p => p.project_id === parent?.project_id || teams.some(t => t.project_id === p.project_id)),
    capabilities: {
      inspect: { state: 'available', reason: 'read-only exact session evidence' },
      start: { state: parent && parent.lifecycle !== 'closing' && inventory != null ? 'available' : 'unavailable', reason: inventory == null ? 'native inventory unavailable' : parent?.lifecycle === 'closing' ? `closing operation ${parent.close_operation_id}` : parent ? 'recorded project association' : 'unowned native session; adopt explicitly' },
      attach: { state: native ? 'available' : 'unavailable', reason: inventory == null ? 'native inventory unavailable' : native ? 'exact native registration' : 'native registration absent; start explicitly' },
      stop: { state: native || parent ? 'available' : 'unavailable', reason: 'physical stop retains definitions; no conversation resume promise' },
    } };
}
export async function startManagedSession(projectId, { session = null, inventory = [], native } = {}) {
  const snapshot = projectManagementSnapshot();
  const known = mappedSessionForProject(projectId, snapshot);
  const hint = session ?? process.env.GOLEM_HERDR_SESSION ?? null;
  if (hint && known && hint !== known) throw new Error(`project ${projectId} owns ${known}, not ${hint}`);
  if (!known && hint && inventory.some(row => row.name === hint)) throw Object.assign(new Error(`unowned native session ${hint}; use golem session adopt ${hint} --project ${projectId}`), { exitCode: 2 });
  const prior = snapshot.mappings.projects[projectId];
  if (prior?.lifecycle === 'closed' && inventory.some(row => row.name === prior.session)) throw Object.assign(new Error(`closed session handle ${prior.session} was registered again; explicit adoption is required`), { exitCode: 2 });
  const intent = admitSessionStart(projectId, { session: hint, nativeNames: inventory.map(row => row.name) });
  const result = { session: intent.session, operation_id: intent.operation_id, project_id: projectId, started: false, noop: false };
  try {
    beforeNativeCall(intent.operation_id);
    const nativeResult = await native.ensureSession(intent.session);
    const recorded = recordNativeResult(intent.operation_id, { type: 'session', session: nativeResult?.session ?? null, created: !!nativeResult?.started });
    if (recorded.phase === 'unresolved') return { ...result, ok: false, lifecycle: 'unresolved', error: recorded.error };
    if (nativeResult?.session && nativeResult.session !== intent.session) {
      settleAdmission(intent.operation_id, { phase: 'unresolved', error: 'native returned a conflicting exact handle; do not adopt/stop it by guesswork' });
      return { ...result, ok: false, lifecycle: 'unresolved', error: 'native session result conflicts with reserved handle' };
    }
    if (!recorded.valid) {
      // Closing owns the physical container. Record the exact late result and
      // reconcile this startup, never stop resources another launch may own.
      settleAdmission(intent.operation_id, { phase: 'reconciled', error: 'startup result fenced by closing generation' });
      return { ...result, ok: false, lifecycle: 'closing', native_started: !!nativeResult?.started, error: 'startup result fenced; closing operation owns reconciliation' };
    }
    commitAdmission(intent.operation_id);
    return { ...result, ok: true, lifecycle: 'open', started: !!nativeResult?.started, noop: !nativeResult?.started };
  } catch (error) {
    const current = readManagementSnapshot().mappings.intents.find(i => i.operation_id === intent.operation_id);
    const uncertain = ['native_call', 'unresolved'].includes(current?.phase);
    settleAdmission(intent.operation_id, { phase: uncertain ? 'unresolved' : 'failed', error: error.message });
    return { ...result, ok: false, lifecycle: uncertain ? 'unresolved' : 'failed', error: error.message };
  }
}
export function adoptManagedSession(projectId, session, { inventory = [] } = {}) {
  if (!inventory.some(row => row.name === session)) throw Object.assign(new Error(`native session not found: ${session}`), { exitCode: 2 });
  const snapshot = readManagementSnapshot();
  const before = snapshot.mappings.projects[projectId];
  const uncertain = snapshot.mappings.intents.some(i => i.kind === 'session-start' && i.project_id === projectId && i.session === session && i.phase === 'unresolved');
  if (before?.session === session && before.source === 'explicit-adoption' && before.lifecycle === 'open' && !uncertain) return { ok: true, session, project_id: projectId, adopted: false, noop: true };
  const association = adoptProjectAssociation(projectId, session);
  return { ok: true, session, project_id: projectId, adopted: true, noop: false, association };
}
export async function stopManagedSession(session, { close = false, inventory = [], native, workers, sleep = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = 30000 } = {}) {
  const snapshot = projectManagementSnapshot();
  const before = Object.values(snapshot.mappings.projects).find(p => p.session === session) ?? snapshot.mappings.session_states?.[session];
  const nativeRow = inventory.find(row => row.name === session);
  if (!nativeRow && before?.lifecycle === 'closed') return { ok: true, session, lifecycle: 'closed', noop: true, stopped: [], targets: [], teams_closed: [], native_deleted: true };
  const admitted = beginManagementClose({ session });
  const base = { ok: false, session, operation_id: admitted.close_operation_id, lifecycle: 'closing', stopped: [], targets: [], teams_closed: [], native_stopped: false, native_deleted: false };
  const flight = await waitForManagementLaunches({ session }, { timeoutMs });
  if (!flight.completed) return { ...base, pending_operation_ids: flight.pending.map(i => i.operation_id), error: 'pending native launches remain unresolved; inspect exact operation IDs' };
  let panes = [];
  if (nativeRow?.running && native.paneList) {
    try { panes = native.paneList(session); } catch (error) { return { ...base, error: `native inventory unavailable: ${error.message}` }; }
  }
  const active = workers.listWorkers().filter(row => row.herdr_session === session && ['spawning', 'live', 'failed'].includes(row.state));
  const managed = new Set(active.map(row => row.herdr_pane_id).filter(Boolean));
  base.external_panes = panes.filter(p => !managed.has(p.pane_id)).map(p => p.pane_id);
  for (const row of active) {
    try {
      await workers.killWorker(row.name, { projectId: row.project_id, teamId: row.team_id ?? null, workerId: row.worker_id });
      base.stopped.push(row.name); base.targets.push({ id: row.session_id ?? row.worker_id ?? row.name, name: row.name, status: 'completed' });
    } catch (error) { base.targets.push({ id: row.session_id ?? row.worker_id ?? row.name, name: row.name, status: 'failed', error: error.message }); }
  }
  const failed = base.targets.filter(t => t.status === 'failed');
  if (failed.length) return { ...base, error: `session ${session} left open; agents failed to stop: ${failed.map(t => `${t.name}: ${t.error}`).join('; ')}` };
  try {
    if (nativeRow?.running && !native.sessionStop(session)) return { ...base, error: 'native session stop failed' };
    const deadline = Date.now() + Math.min(30000, Math.max(0, timeoutMs));
    let current;
    do {
      current = native.sessionList().find(row => row.name === session);
      if (!current?.running) break;
      if (Date.now() >= deadline) return { ...base, error: 'native session stop not confirmed by inventory' };
      await sleep(50);
    } while (true);
    base.native_stopped = true;
    if (close) {
      let deleted = !current;
      for (let attempt = 0; attempt < 20 && !deleted; attempt++) {
        const submitted = native.sessionDelete(session);
        deleted = submitted && !native.sessionList().some(row => row.name === session);
        if (!deleted) await sleep(250);
      }
      if (!deleted) return { ...base, error: 'native session stopped but deletion not confirmed', lifecycle: 'closing' };
      base.native_deleted = true;
      base.teams_closed = snapshot.teams.teams.filter(t => t.herdr_session === session && t.closed_at == null).map(t => t.slug);
    }
    const endedIds = reconcileStoppedSession(session, { closed: close });
    if (endedIds.length) { markSessionFactsEnded(endedIds, { status: 'stopped' }); markSessionsEnded(endedIds, { status: 'stopped' }); }
    const parent = finishManagementClose({ session }, { stopped: !close });
    return { ...base, ok: true, lifecycle: parent.lifecycle, noop: !nativeRow?.running && base.stopped.length === 0 };
  } catch (error) { return { ...base, error: error.message }; }
}
