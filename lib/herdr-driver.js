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
import { mappedSessionForProject } from './management-registry.js';
import { systemClock } from './clock.ts';
import { tryRecordScenarioProjection } from './scenario-recorder.ts';

export const HERDR_SUPPORTED_VERSION = '0.9.1';
export const AGENTS_WORKSPACE_LABEL = 'agents';

export function herdrBinary() {
  return process.env.GOLEM_HERDR_BIN || 'herdr';
}

/** Read an exact durable association (or bounded read-only v1 projection).
 * Allocation is a real management mutation, never a label-derived read. */
export function herdrSessionForProject(projectId) {
  const id = String(projectId ?? '').trim();
  if (!id) throw new Error('project id is required to resolve a herdr session');
  const session = mappedSessionForProject(id);
  if (!session) throw new Error(`project ${id} has no runtime association; run golem session start --project ${id}`);
  return session;
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
  tryRecordScenarioProjection({ boundary: 'herdr', direction: 'in', operation: 'herdr-command', fields: { argv: fullArgs } });
  const result = spawnSync(herdrBinary(), fullArgs, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
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
export async function ensureSession(session, { startupTimeoutMs = 20_000, pollMs = 500, clock = systemClock } = {}) {
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
  const deadline = clock.now() + startupTimeoutMs;
  while (clock.now() < deadline) {
    if (serverReady(resolved)) return { session: resolved, started: true };
    await sleep(pollMs);
  }
  throw new Error(`herdr server ${resolved} did not become ready within ${startupTimeoutMs}ms (log: ${logFile})`);
}


/** List the session's workspaces. */
export function workspaceList(session) {
  const payload = envelope(runHerdr(['workspace', 'list'], { session }), ['workspace', 'list']);
  if (!Array.isArray(payload?.workspaces)) throw new Error('herdr workspace inventory unavailable: invalid payload');
  return payload.workspaces;
}

/** Create a new owned workspace. Never adopt an arbitrary same-label row. */
export function workspaceCreate({ session, label, cwd = null } = {}) {
  if (typeof label !== 'string' || !label.trim()) throw new Error('workspace label is required');
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
  if (!workspaceList(session).some(row => row.workspace_id === workspaceId)) return true;
  runHerdr(['workspace', 'close', workspaceId], { allowFailure: true, session });
  return !workspaceList(session).some(row => row.workspace_id === workspaceId);
}

export function workspaceFocus({ session, workspaceId } = {}) {
  if (!workspaceId) throw new Error('workspace id is required');
  const args = ['workspace', 'focus', workspaceId];
  envelope(runHerdr(args, { session }), args);
  return true;
}
export function workspaceRename({ session, workspaceId, label } = {}) {
  if (!workspaceId || !label?.trim()) throw new Error('workspace id and label are required');
  const args = ['workspace', 'rename', workspaceId, label.trim()];
  envelope(runHerdr(args, { session }), args);
  return true;
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

export function paneLabel({ session, paneId, label } = {}) {
  if (!paneId || !label?.trim()) throw new Error('pane id and label required');
  const args = ['pane', 'rename', paneId, label.trim()];
  envelope(runHerdr(args, { session }), args); return true;
}
export function paneMove({ session, paneId, workspaceId } = {}) {
  if (!paneId || !workspaceId) throw new Error('pane and workspace IDs required');
  const args = ['pane', 'move', paneId, '--workspace', workspaceId, '--new-tab', '--no-focus'];
  const payload = envelope(runHerdr(args, { session }), args);
  const pane = payload?.move_result?.pane;
  if (!pane?.pane_id || !pane?.tab_id || !pane?.workspace_id) throw new Error('native move returned no exact placement IDs; inspect native resource before retry');
  return { ...pane, closed_source_workspace_id: payload.move_result.closed_workspace_id ?? null, closed_source_tab_id: payload.move_result.closed_tab_id ?? null };
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

/** Actual invoking pane, including moved-pane aliases. This intentionally
 * bypasses resolveSession/GOLEM_HERDR_SESSION and never queries UI focus. */
export function paneCurrentInherited({ env = process.env, timeoutMs = 2000 } = {}) {
  if (env.HERDR_ENV !== '1' || !env.HERDR_SESSION || !env.HERDR_PANE_ID) throw new Error('inherited herdr caller session/pane context is missing');
  const childEnv = { ...env };
  delete childEnv.GOLEM_HERDR_SESSION;
  const args = ['pane', 'current', '--current'];
  const result = spawnSync(env.GOLEM_HERDR_BIN || herdrBinary(), args, { env: childEnv, encoding: 'utf8', windowsHide: true, timeout: Math.min(5000, timeoutMs) });
  if (result.error) throw new Error(`inherited herdr caller query failed: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new Error(formatFailure(result, args));
  const payload = envelope(result, args);
  const pane = payload?.pane;
  if (!pane?.pane_id || !pane?.workspace_id) throw new Error('inherited herdr caller query returned invalid pane IDs');
  if (payload.session && payload.session !== env.HERDR_SESSION) throw new Error('inherited herdr caller query returned a conflicting session');
  return { session: env.HERDR_SESSION, socket_path: env.HERDR_SOCKET_PATH ?? null,
    pane_id: pane.pane_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id ?? null, focused: pane.focused ?? null };
}

/** List panes in the session. */
export function paneList(session) {
  const payload = envelope(runHerdr(['pane', 'list'], { session }), ['pane', 'list']);
  if (!Array.isArray(payload?.panes)) throw new Error('herdr pane inventory unavailable: invalid payload');
  return payload.panes;
}

/** List agents in the session. Returns the raw agent rows (may be empty). */
export function agentList(session) {
  const payload = envelope(runHerdr(['agent', 'list'], { session }), ['agent', 'list']);
  if (!Array.isArray(payload?.agents)) throw new Error('herdr agent inventory unavailable: invalid payload');
  return payload.agents;
}

/** Attach the caller's terminal to a herdr agent (terminal inherited). */
export function agentAttach({ session, agentTarget, outputToStderr = false } = {}) {
  const resolved = resolveSession(session);
  if (!agentTarget) throw new Error('agent target is required to attach');
  const result = spawnSync(herdrBinary(), ['--session', resolved, 'agent', 'attach', agentTarget], {
    stdio: outputToStderr ? ['inherit', 2, 'inherit'] : 'inherit',
    windowsHide: true,
  });
  if (result.error) throw new Error(`could not attach herdr agent ${agentTarget}: ${result.error.message}`, { cause: result.error });
  return result.status ?? 1;
}

/**
 * Global herdr session list (not scoped by --session): herdr's own rows,
 * `{ name, running, default, session_dir, socket_path }`.
 */
export function sessionList() {
  const args = ['session', 'list', '--json'];
  const result = spawnSync(herdrBinary(), args, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (result.error) throw new Error(`could not run herdr: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new Error(formatFailure(result, args));
  const parsed = JSON.parse(String(result.stdout || '{}'));
  return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
}

/** Attach the caller's terminal to a herdr session (terminal inherited). */
export function sessionAttach(session, { outputToStderr = false } = {}) {
  const name = String(session ?? '').trim();
  if (!name) throw new Error('herdr session is required to attach');
  const result = spawnSync(herdrBinary(), ['--session', name], { stdio: outputToStderr ? ['inherit', 2, 'inherit'] : 'inherit', windowsHide: true });
  if (result.error) throw new Error(`could not attach herdr session ${name}: ${result.error.message}`, { cause: result.error });
  return result.status ?? 1;
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
  workspaceCreate,
  tabCreate,
  tabClose,
  paneRun,
  paneLabel,
  paneMove,
  paneRead,
  paneSendKeys,
  paneProcessInfo,
  paneClose,
  workspaceClose,
  workspaceFocus,
  workspaceRename,
  paneList,
  paneCurrentInherited,
  agentList,
  agentGet,
  agentRename,
  agentAttach,
  sessionList,
  sessionAttach,
  sessionStop,
  sessionDelete,
  herdrVersion,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
