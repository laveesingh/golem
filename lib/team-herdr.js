// team-herdr — the seam between teams and herdr (GOL-363 G1/G3, GOL-371).
// GOL-370: this now delegates to lib/herdr-driver.js; the exported shapes
// stay the same.
//
// Session naming follows G2: the project name from projects.json, lowercased
// and limited to [a-z0-9_-]; when two known projects produce the same name,
// the project id is used instead.

import fs from 'node:fs';
import { projectsJsonPath } from './golem-home.js';
import {
  ensureSession,
  herdrBinary,
  sessionDelete,
  sessionStop,
  workspaceClose,
  workspaceEnsure,
  workspaceList,
} from './herdr-driver.js';

export function herdrBin() {
  return herdrBinary();
}

function readKnownProjects() {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectsJsonPath(), 'utf8'));
    return Array.isArray(parsed.projects) ? parsed.projects : [];
  } catch {
    return [];
  }
}

/** Project session name per G2. GOLEM_HERDR_SESSION wins (tests). */
export function projectHerdrSession(projectId, { knownProjects = null } = {}) {
  const override = process.env.GOLEM_HERDR_SESSION;
  if (typeof override === 'string' && override.trim()) return override.trim();
  const id = String(projectId ?? '').trim();
  if (!id) throw new Error('project id is required to resolve the herdr session');
  const known = knownProjects ?? readKnownProjects();
  const self = known.find((project) => project?.project_id === id || project?.id === id);
  const rawName = typeof self?.name === 'string' && self.name.trim() ? self.name.trim() : id;
  const session = rawName.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+/, '') || id;
  const clash = known.some((project) => {
    const otherId = project?.project_id ?? project?.id;
    if (otherId === id || otherId == null) return false;
    const otherName = typeof project?.name === 'string' && project.name.trim() ? project.name.trim() : String(otherId);
    const otherSession = otherName.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+/, '');
    return otherSession === session;
  });
  return clash ? id : session;
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

/** Close the team's workspace. Missing workspaces are treated as already closed. */
export function closeTeamWorkspace(session, workspaceId) {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new Error('workspace id is required');
  return workspaceClose({ session, workspaceId: workspaceId.trim() });
}

/** Test cleanup only: stop and delete a throwaway session. Never call without --session scoping. */
export function stopAndDeleteSession(session) {
  if (typeof session !== 'string' || !session.trim()) throw new Error('herdr session is required');
  const name = session.trim();
  if (!/^golem-test-/.test(name)) throw new Error(`refusing to stop a non-throwaway herdr session: ${name}`);
  sessionStop(name);
  sessionDelete(name);
}
