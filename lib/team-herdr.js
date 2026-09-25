// team-herdr — the seam between teams and herdr (GOL-363 G1/G3, GOL-371).
// GOL-370: this now delegates to lib/herdr-driver.js; the exported shapes
// stay the same.
//
// Session naming is G2, implemented once in lib/herdr-driver.js
// (herdrSessionForProject) and shared by spawns, teams and doctor.

import {
  agentList,
  paneList,
  ensureSession,
  herdrBinary,
  herdrSessionForProject,
  sessionDelete,
  sessionStop,
  workspaceClose,
  workspaceEnsure,
  workspaceList,
} from './herdr-driver.js';

export function herdrBin() {
  return herdrBinary();
}

/** Project session name per G2. GOLEM_HERDR_SESSION wins (tests). Single
 *  implementation lives in lib/herdr-driver.js; this seam delegates to it. */
export function projectHerdrSession(projectId, { knownProjects = null } = {}) {
  return herdrSessionForProject(projectId, { knownProjects });
}

/** Start the project session server (detached) and wait until workspace list answers. */
export async function ensureProjectSession(session, { timeoutMs = 30000, pollMs = 500 } = {}) {
  if (typeof session !== 'string' || !session.trim()) throw new Error('herdr session is required');
  return ensureSession(session.trim(), { startupTimeoutMs: timeoutMs, pollMs });
}

export async function listHerdrWorkspaces(session) {
  return workspaceList(session);
}

/** Create the team's workspace, labeled with the team label. Returns the workspace id. */
export function createTeamWorkspace(session, label) {
  if (typeof label !== 'string' || !label.trim()) throw new Error('workspace label is required');
  const workspace = workspaceEnsure({ session, label: label.trim() });
  const id = workspace?.workspace_id;
  if (typeof id !== 'string' || !id) throw new Error('herdr workspace create returned no workspace id');
  return id;
}

/** True when the workspace still exists in the session (GOL-382 R4). */
export function teamWorkspaceExists(session, workspaceId) {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) return false;
  return workspaceList(session).some((row) => row?.workspace_id === workspaceId.trim());
}

/** Panes in the workspace that run a detected agent golem does not manage
 *  (GOL-382 R4): for example an owner the human started there by hand.
 *  managedPaneIds are the worker panes golem started. */
export function unmanagedAgentPanes(session, workspaceId, managedPaneIds = []) {
  const managed = new Set(managedPaneIds.filter(Boolean));
  return paneList(session).filter((pane) => (
    pane?.workspace_id === workspaceId && pane?.agent && !managed.has(pane.pane_id)
  ));
}

/** Close the team's workspace. Missing workspaces are treated as already closed. */
export function closeTeamWorkspace(session, workspaceId) {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new Error('workspace id is required');
  return workspaceClose({ session, workspaceId: workspaceId.trim() });
}

/** Best-effort herdr agent states for one project session (G9): pane id →
 *  state plus live name → state (GOL-379). The pane id is the stable key —
 *  an agent row carries it before any rename, while the name exists only
 *  after `agent rename` sticks. Callers look up the pane id first via
 *  herdrStateFor and fall back to the stored name. Never throws: when the
 *  server, session or driver is unavailable the caller lists agents with
 *  an unknown herdr state instead of failing. */
export function listHerdrAgentStates(session) {
  const states = new Map();
  try {
    if (typeof session !== 'string' || !session.trim()) return states;
    const agents = agentList(session.trim());
    if (!Array.isArray(agents)) return states;
    for (const agent of agents) {
      const state = agent?.agent_status ?? agent?.state ?? agent?.agent_state ?? null;
      const paneId = agent?.pane_id;
      if (typeof paneId === 'string' && paneId) states.set(paneId, state);
      const name = agent?.name ?? agent?.agent_name;
      if (typeof name === 'string' && name) states.set(name, state);
    }
  } catch {
    // Best-effort only (see above).
  }
  return states;
}

/**
 * Look up one worker view's herdr state (GOL-379): the stored pane id
 * first — it is always recorded on the row — then the stored agent name.
 */
export function herdrStateFor(states, view) {
  if (!(states instanceof Map) || view == null) return null;
  return states.get(view?.herdr_pane_id) ?? states.get(view?.herdr_agent_name ?? view?.name) ?? null;
}

/** Test cleanup only: stop and delete a throwaway session. Never call without --session scoping. */
export function stopAndDeleteSession(session) {
  if (typeof session !== 'string' || !session.trim()) throw new Error('herdr session is required');
  const name = session.trim();
  if (!/^golem-test-/.test(name)) throw new Error(`refusing to stop a non-throwaway herdr session: ${name}`);
  sessionStop(name);
  sessionDelete(name);
}
