// team-herdr — the seam between teams and herdr (GOL-363 G1/G3, GOL-371).
//
// Until GOL-370's lib/herdr-driver.js lands on feat/lead-owned-teams, team
// workspace calls go through this small module, which shells out to the
// herdr CLI directly. Every call passes --session <project-session>, and
// tests override the session with GOLEM_HERDR_SESSION so they never touch a
// real one. Once the driver lands, these functions should delegate to it
// (see the GOL-370 coordination comment); the exported shapes stay the same.
//
// Session naming follows G2: the project name from projects.json, lowercased
// and limited to [a-z0-9_-]; when two known projects produce the same name,
// the project id is used instead.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { projectsJsonPath } from './golem-home.js';

export function herdrBin() {
  const override = process.env.GOLEM_HERDR_BIN;
  return typeof override === 'string' && override.trim() ? override.trim() : 'herdr';
}

function readKnownProjects() {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectsJsonPath(), 'utf8'));
    return Array.isArray(parsed?.projects) ? parsed.projects : [];
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

function runHerdr(session, args, { timeoutMs = 15000 } = {}) {
  const output = execFileSync(herdrBin(), ['--session', session, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const trimmed = String(output ?? '').trim();
  if (!trimmed) throw new Error(`herdr produced no output (${args.join(' ')})`);
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`herdr produced non-JSON output (${args.join(' ')})`);
  }
}

function herdrErrorMessage(payload) {
  const message = payload?.error?.message ?? payload?.error?.code;
  return typeof message === 'string' && message ? message : 'unknown herdr error';
}

/** Start the project session server (detached) and wait until workspace list answers. */
export function ensureProjectSession(session, { timeoutMs = 30000, pollMs = 500 } = {}) {
  if (typeof session !== 'string' || !session.trim()) throw new Error('herdr session is required');
  const name = session.trim();
  try {
    runHerdr(name, ['workspace', 'list']);
    return { session: name, started: false };
  } catch {}
  const child = spawn(herdrBin(), ['--session', name, 'server'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      runHerdr(name, ['workspace', 'list']);
      return { session: name, started: true };
    } catch (error) {
      lastError = error;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
  }
  throw new Error(`herdr session did not answer: ${name} (${lastError?.message ?? 'timeout'})`);
}

export function listHerdrWorkspaces(session) {
  const payload = runHerdr(session, ['workspace', 'list']);
  if (payload?.error) throw new Error(`herdr workspace list failed: ${herdrErrorMessage(payload)}`);
  const workspaces = payload?.result?.workspaces;
  if (!Array.isArray(workspaces)) throw new Error('herdr workspace list returned an unexpected shape');
  return workspaces;
}

/** Create the team's workspace, labeled with the team label. Returns the workspace id. */
export function createTeamWorkspace(session, label) {
  if (typeof label !== 'string' || !label.trim()) throw new Error('workspace label is required');
  const payload = runHerdr(session, ['workspace', 'create', '--label', label.trim()]);
  if (payload?.error) throw new Error(`herdr workspace create failed: ${herdrErrorMessage(payload)}`);
  const id = payload?.result?.workspace?.workspace_id;
  if (typeof id !== 'string' || !id) throw new Error('herdr workspace create returned no workspace id');
  return id;
}

/** Close the team's workspace. Missing workspaces are treated as already closed. */
export function closeTeamWorkspace(session, workspaceId) {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new Error('workspace id is required');
  const payload = runHerdr(session, ['workspace', 'close', workspaceId.trim()]);
  if (payload?.error) {
    const code = payload.error?.code;
    if (code === 'workspace_not_found') return false;
    throw new Error(`herdr workspace close failed: ${herdrErrorMessage(payload)}`);
  }
  return true;
}

/** Best-effort herdr agent states for one project session (G9): name → state.
 *  Never throws: when the server, session or driver is unavailable the
 *  caller lists agents with an unknown herdr state instead of failing. */
export function listHerdrAgentStates(session) {
  const states = new Map();
  try {
    if (typeof session !== 'string' || !session.trim()) return states;
    const payload = runHerdr(session.trim(), ['agent', 'list']);
    if (payload?.error) return states;
    const agents = payload?.result?.agents;
    if (!Array.isArray(agents)) return states;
    for (const agent of agents) {
      const name = agent?.name ?? agent?.agent_name;
      if (typeof name === 'string' && name) states.set(name, agent?.state ?? agent?.agent_state ?? null);
    }
  } catch {
    // Best-effort only (see above).
  }
  return states;
}

/** Test cleanup only: stop and delete a throwaway session. Never call without --session scoping. */
export function stopAndDeleteSession(session) {
  if (typeof session !== 'string' || !session.trim()) throw new Error('herdr session is required');
  const name = session.trim();
  if (!/^golem-test-/.test(name)) throw new Error(`refusing to stop a non-throwaway herdr session: ${name}`);
  execFileSync(herdrBin(), ['session', 'stop', name], { encoding: 'utf8', timeout: 15000 });
  execFileSync(herdrBin(), ['session', 'delete', name], { encoding: 'utf8', timeout: 15000 });
}
