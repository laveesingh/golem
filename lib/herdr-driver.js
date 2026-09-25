// herdr driver — GOL-370 (GOL-363 G1/G2). Every managed agent pane runs inside
// one herdr session per project. This module is the only place that knows the
// herdr CLI: argument shapes, JSON envelope parsing, `--session` on every
// call, and the env overrides (`GOLEM_HERDR_SESSION`, `GOLEM_HERDR_BIN`) used
// by tests and multi-home setups.
//
// herdr answers every CLI call with a JSON envelope on stdout:
//   { id, result: { type, ...payload } }   on success
//   { id, error: { code, message } }        on failure
// Calls that cannot answer (server down) print that envelope too, so the
// driver parses stdout and turns `error` envelopes into thrown errors.

import fs from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { projectsJsonPath } from './golem-home.js';

export const HERDR_SUPPORTED_VERSION = '0.9.1';
export const AGENTS_WORKSPACE_LABEL = 'agents';

export function herdrBinary() {
  return process.env.GOLEM_HERDR_BIN || 'herdr';
}

/**
 * The single G2 session name for a project (GOL-363 G2): the project's
 * display name from projects.json, lowercased, with every run of characters
 * outside `[a-z0-9-]` replaced by one `-` and leading/trailing `-` trimmed.
 * An empty result or a collision with another known project falls back to
 * the project id. `GOLEM_HERDR_SESSION` overrides everything (tests).
 */
export function herdrSessionForProject(projectId, { knownProjects = null } = {}) {
  const override = process.env.GOLEM_HERDR_SESSION;
  if (typeof override === 'string' && override.trim()) return override.trim();
  const id = String(projectId ?? '').trim();
  if (!id) throw new Error('project id is required to derive a herdr session');
  const known = knownProjects ?? readKnownProjects();
  const own = known.find((project) => project?.project_id === id || project?.id === id);
  const rawName = typeof own?.name === 'string' && own.name.trim() ? own.name.trim() : id;
  // herdr names follow [a-z][a-z0-9_-]{0,31}: cap the derived session so a
  // long project name still starts a server. Cap before the empty/collision
  // checks so two names sharing a 32-prefix fall back to their ids.
  const derived = rawName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (derived) {
    const collision = known.some((project) => {
      const otherId = project?.project_id ?? project?.id;
      if (otherId === id || otherId == null) return false;
      const otherName = typeof project?.name === 'string' && project.name.trim() ? project.name.trim() : String(otherId);
      return otherName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') === derived;
    });
    if (!collision) return derived;
  }
  return id;
}

function readKnownProjects() {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectsJsonPath(), 'utf8'));
    return Array.isArray(parsed?.projects) ? parsed.projects : [];
  } catch {
    return [];
  }
}

/**
 * Resolve the herdr session a call must use. Precedence: the GOLEM_HERDR_SESSION
 * override (test isolation wins over everything), then the caller's stored
 * session.
 */
export function resolveSession(session) {
  const override = process.env.GOLEM_HERDR_SESSION;
  if (override) return override;
  const value = String(session ?? '').trim();
  if (!value) throw new Error('herdr session is required');
  return value;
}

function formatFailure(result, args) {
  const detail = String(result.stderr || result.stdout || '').trim();
  return `herdr ${args.join(' ')} failed${detail ? `: ${detail}` : ` (exit ${result.status ?? 'unknown'})`}`;
}

function runHerdr(args, { allowFailure = false, session = null, input = null } = {}) {
  const resolved = resolveSession(session);
  const fullArgs = ['--session', resolved, ...args];
  const result = spawnSync(herdrBinary(), fullArgs, {
    encoding: 'utf8',
    windowsHide: true,
    ...(input == null ? {} : { input }),
  });
  if (result.error) {
    if (allowFailure && result.error.code === 'ENOENT') return result;
    throw new Error(`could not run herdr: ${result.error.message}`, { cause: result.error });
  }
  if (!allowFailure && result.status !== 0) throw new Error(formatFailure(result, args));
  return result;
}

/** Parse a herdr JSON envelope. `error` envelopes become thrown errors. */
function envelope(result, args) {
  const text = String(result.stdout || '').trim();
  if (!text) throw new Error(`herdr ${args.join(' ')} produced no output`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`herdr ${args.join(' ')} printed non-JSON output: ${text.slice(0, 200)}`, { cause: error });
  }
  if (parsed?.error) {
    throw new Error(`herdr ${args.join(' ')}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  return parsed?.result ?? parsed;
}

/** Run a herdr command expecting a JSON envelope; returns the `result` payload. */
function herdrJson(args, { allowFailure = false, session = null } = {}) {
  return envelope(runHerdr(args, { allowFailure, session }), args);
}

/** The headless server answers `workspace list` once it is accepting calls. */
export function serverReady(session) {
  try {
    const result = runHerdr(['workspace', 'list'], { allowFailure: true, session });
    if (result.error) return false;
    const payload = envelope(result, ['workspace', 'list']);
    return payload?.type === 'workspace_list';
  } catch {
    return false;
  }
}

/**
 * Ensure the herdr server for `session` is running headless (U6, verified
 * by the lead): `nohup herdr --session <name> server` via the shell, then
 * poll `workspace list` until it answers. An already-running server answers
 * on the first poll and is left untouched.
 */
export async function ensureSession(session, { startupTimeoutMs = 20_000, pollMs = 500 } = {}) {
  const resolved = resolveSession(session);
  if (serverReady(resolved)) return { session: resolved, started: false };
  // Launch through the shell the way a working interactive launch does
  // (GOL-370 unblock): `spawn(detached: true)` calls setsid, giving the
  // server a new session with no controlling terminal, under which it
  // self-terminates ~10s after start. `nohup … &` from a shell keeps the
  // shell's session and stays alive with no client attached.
  const logFile = path.join(os.tmpdir(), `herdr-${resolved.replace(/[^a-zA-Z0-9_-]/g, '_')}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  spawn('/bin/sh', ['-c', 'nohup "$0" --session "$1" server >>"$2" 2>&1 &', herdrBinary(), resolved, logFile], {
    stdio: 'ignore',
    // Every pane inherits the server's env; a server started from inside an
    // agent session must not hand that session's identity to its panes.
    env: withoutSessionScopedEnv(process.env),
  });
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (serverReady(resolved)) return { session: resolved, started: true };
    await sleep(pollMs);
  }
  throw new Error(`herdr server ${resolved} did not become ready within ${startupTimeoutMs}ms (log: ${logFile})`);
}


/** List the session's workspaces. */
export function workspaceList(session) {
  return envelope(runHerdr(['workspace', 'list'], { session }), ['workspace', 'list']).workspaces ?? [];
}

/** Find a workspace by label, or create it. Returns its full row. */
export function workspaceEnsure({ session, label, cwd = null } = {}) {
  if (typeof label !== 'string' || !label.trim()) throw new Error('workspace label is required');
  const existing = workspaceList(session).find((row) => row.label === label);
  if (existing) return existing;
  const args = ['workspace', 'create', '--label', label];
  if (cwd) args.push('--cwd', cwd);
  const payload = envelope(runHerdr(args, { session }), args);
  return payload.workspace ?? payload.root_pane ?? null;
}

/** Create a tab (with its root pane) inside a workspace. */
export function tabCreate({ session, workspaceId, label, cwd = null } = {}) {
  if (!workspaceId) throw new Error('workspace id is required to create a herdr tab');
  const args = ['tab', 'create', '--workspace', workspaceId];
  if (cwd) args.push('--cwd', cwd);
  if (label) args.push('--label', label);
  const payload = envelope(runHerdr(args, { session }), args);
  return { tab: payload.tab ?? null, pane: payload.root_pane ?? null };
}

/** Close a tab by id. Missing tabs are already gone. */
export function workspaceClose({ session, workspaceId } = {}) {
  if (!workspaceId) return false;
  const result = runHerdr(['workspace', 'close', workspaceId], { allowFailure: true, session });
  return result.status === 0;
}

export function tabClose({ session, tabId } = {}) {
  if (!tabId) return false;
  const result = runHerdr(['tab', 'close', tabId], { allowFailure: true, session });
  return result.status === 0;
}

/** Type a command into a pane's shell: `pane run <PANE_ID> <COMMAND>...`. */
/** Env vars that identify the agent session a process runs inside (GOL-382).
 *  A pane that inherits them makes a new Claude a "child session": it writes
 *  no ~/.claude/sessions record, so the dashboard never lists it. */
export const SESSION_SCOPED_ENV = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'GOLEM_CEO_SESSION_ID',
  'GOLEM_SESSION_ID',
  'PI_SESSION_ID',
]);

export function withoutSessionScopedEnv(env = {}) {
  const next = { ...env };
  for (const key of SESSION_SCOPED_ENV) delete next[key];
  return next;
}

export function paneRun({ session, paneId, command } = {}) {
  if (!paneId) throw new Error('pane id is required to run a command');
  if (!Array.isArray(command) || command.length === 0) throw new Error('command is required');
  // `pane run` types the command into the pane's shell and prints nothing —
  // do not run it through the JSON-envelope parser.
  runHerdr(['pane', 'run', paneId, ...command.map(shellQuote)], { session });
  return true;
}

/** Rename the agent a pane carries. */
export function agentRename({ session, paneId, name } = {}) {
  if (!name) throw new Error('agent name is required to rename');
  return envelope(runHerdr(['agent', 'rename', paneId, name], { session }), ['agent', 'rename', paneId]);
}

/**
 * Show one agent by live name or hosting pane id (GOL-379). Resolves to the
 * agent payload (`result.agent`). Throws `agent_not_found` when neither the
 * name nor the pane carries a live agent — the spawn path uses this to wait
 * for herdr to detect the Pi process before renaming, and the attach path
 * uses it to prefer the stored name while falling back to the pane id.
 */
export function agentGet({ session, target } = {}) {
  if (!target) throw new Error('agent target is required to get an agent');
  const payload = envelope(runHerdr(['agent', 'get', target], { session }), ['agent', 'get', target]);
  return payload?.agent ?? payload;
}

/** Read a pane's terminal output (plain text). */
export function paneRead({ session, paneId, lines = null } = {}) {
  if (!paneId) throw new Error('pane id is required to read a pane');
  // `pane read` prints the scrollback as plain text (recent snapshot), not a
  // JSON envelope. `recent` is the bounded scrollback; `--source recent` is the
  // default.
  const result = runHerdr(['pane', 'read', paneId], { allowFailure: false, session });
  const text = String(result.stdout || '');
  if (lines == null) return text;
  if (!Number.isInteger(lines) || lines < 1) throw new Error('peek lines must be a positive integer');
  // Bound the output to the last `lines` terminal lines.
  const bounded = text.split('\n').slice(-lines).join('\n');
  return bounded;
}

/** Send keys into a pane (plain command, no envelope). */
export function paneSendKeys({ session, paneId, keys } = {}) {
  const keyList = Array.isArray(keys) ? keys : [keys];
  runHerdr(['pane', 'send-keys', paneId, ...keyList], { session });
  return true;
}

/** Pane process info: foreground process group id and command lines. */
export function paneProcessInfo({ session, paneId } = {}) {
  const payload = envelope(runHerdr(['pane', 'process-info', '--pane', paneId], { session }), ['pane', 'process-info', paneId]);
  return payload?.process_info ?? null;
}

/** Close a pane. */
export function paneClose({ session, paneId } = {}) {
  if (!paneId) throw new Error('pane id is required to close a pane');
  const result = runHerdr(['pane', 'close', paneId], { session });
  return result.status === 0;
}

/** List panes in the session. */
export function paneList(session) {
  return envelope(runHerdr(['pane', 'list'], { session }), ['pane', 'list']).panes ?? [];
}

/** List agents in the session. Returns the raw agent rows (may be empty). */
export function agentList(session) {
  return envelope(runHerdr(['agent', 'list'], { session }), ['agent', 'list']).agents ?? [];
}

/** Attach the caller's terminal to a herdr agent (terminal inherited). */
export function agentAttach({ session, agentTarget } = {}) {
  const resolved = resolveSession(session);
  if (!agentTarget) throw new Error('agent target is required to attach');
  const result = spawnSync(herdrBinary(), ['--session', resolved, 'agent', 'attach', agentTarget], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw new Error(`could not attach herdr agent ${agentTarget}: ${result.error.message}`, { cause: result.error });
  return result.status ?? 1;
}

/** Global herdr session list (not scoped by --session). */
export function sessionList() {
  const result = runHerdr(['session', 'list'], { allowFailure: true });
  if (result.error || result.status !== 0) return [];
  const text = String(result.stdout || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.sessions)) return parsed.sessions;
    return [];
  } catch {
    // Human table output: one session name per line is the fallback shape.
    return text.split('\n').map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
  }
}

/** Delete a stopped herdr session. */
export function sessionDelete(session) {
  const resolved = resolveSession(session);
  const result = runHerdr(['session', 'delete', resolved], { allowFailure: true, session: resolved });
  if (result.error?.code === 'ENOENT') throw new Error(`could not run herdr: ${result.error.message}`, { cause: result.error });
  return result.status === 0;
}

/** Stop a herdr session server. Missing sessions are already stopped. */
export function sessionStop(session) {
  const resolved = resolveSession(session);
  const result = runHerdr(['session', 'stop', resolved], { allowFailure: true, session: resolved });
  if (result.error?.code === 'ENOENT') throw new Error(`could not run herdr: ${result.error.message}`, { cause: result.error });
  return result.status === 0;
}

/** `herdr --version`, for the doctor check. */
export function herdrVersion() {
  const result = spawnSync(herdrBinary(), ['--version'], { encoding: 'utf8', windowsHide: true });
  if (result.error) return null;
  // `herdr --version` prints `herdr 0.9.1`; the doctor wants the bare number.
  return String(result.stdout || '').trim().replace(/^herdr\s+/i, '') || null;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export const herdrDriver = Object.freeze({
  herdrBinary,
  herdrSessionForProject,
  resolveSession,
  serverReady,
  ensureSession,
  workspaceList,
  workspaceEnsure,
  tabCreate,
  tabClose,
  paneRun,
  paneRead,
  paneSendKeys,
  paneProcessInfo,
  paneClose,
  workspaceClose,
  paneList,
  agentList,
  agentGet,
  agentRename,
  agentAttach,
  sessionList,
  sessionStop,
  sessionDelete,
  herdrVersion,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
