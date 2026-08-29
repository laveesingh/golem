import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(HERE, 'golem-tmux.conf');

/** The shared socket every worker used before per-project servers. Rows without a stored `tmux_socket` still live here. */
export const LEGACY_SOCKET = 'golem';

/** One tmux server per project swarm: `golem-<project_id>`. */
export function socketForProject(projectId) {
  const value = String(projectId ?? '').trim();
  if (!value) throw new Error('project id is required to derive a tmux socket');
  return `golem-${value}`;
}

/**
 * Resolve the socket a tmux call must use. Precedence: the GOLEM_TMUX_SOCKET
 * override (test isolation wins over everything), then the caller's stored or
 * explicit socket, then the legacy shared server.
 */
export function resolveSocket(socket) {
  const override = process.env.GOLEM_TMUX_SOCKET;
  if (override) return override;
  const value = String(socket ?? '').trim();
  return value || LEGACY_SOCKET;
}

function tmuxBinary() {
  return process.env.GOLEM_TMUX_BIN || 'tmux';
}

function tmuxConfig() {
  return process.env.GOLEM_TMUX_CONFIG || DEFAULT_CONFIG;
}

function globalArgs(socket) {
  return ['-L', resolveSocket(socket), '-f', tmuxConfig()];
}

function formatFailure(result, args) {
  const detail = String(result.stderr || result.stdout || '').trim();
  return `tmux ${args.join(' ')} failed${detail ? `: ${detail}` : ` (exit ${result.status ?? 'unknown'})`}`;
}

function runTmux(args, { allowFailure = false, socket = null } = {}) {
  const result = spawnSync(tmuxBinary(), [...globalArgs(socket), ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    if (allowFailure && result.error.code === 'ENOENT') return result;
    throw new Error(`could not run tmux: ${result.error.message}`, { cause: result.error });
  }
  if (!allowFailure && result.status !== 0) throw new Error(formatFailure(result, args));
  return result;
}

function requireName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('tmux session name is required');
  return name.trim();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Create one detached, fixed-size worker pty on the given project socket. */
export function newSession({ name, cwd, command, width = 200, height = 50, socket = null } = {}) {
  const session = requireName(name);
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('tmux session cwd is required');
  if (!Array.isArray(command) || command.length === 0) throw new Error('tmux session command is required');
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error('tmux session dimensions must be positive integers');
  }
  const commandText = `exec ${command.map(shellQuote).join(' ')}`;
  runTmux([
    'new-session', '-d', '-s', session,
    '-x', String(width), '-y', String(height),
    '-c', cwd,
    commandText,
  ], { socket });
  return { name: session, cwd, width, height, socket: resolveSocket(socket) };
}

/** Return the pane's process id. The launcher is exec'd so this is its pgid. */
export function panePid(name, { socket = null } = {}) {
  const session = requireName(name);
  const result = runTmux(['display-message', '-p', '-t', session, '#{pane_pid}'], { socket });
  const pid = Number.parseInt(String(result.stdout).trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`tmux did not report a valid pane pid for ${session}`);
  return pid;
}

export function listSessions({ socket = null } = {}) {
  const result = runTmux([
    'list-sessions',
    '-F',
    '#{session_name}\t#{session_id}\t#{session_windows}\t#{session_created}',
  ], { allowFailure: true, socket });
  if (result.error || result.status !== 0) return [];
  return String(result.stdout || '').split('\n').filter(Boolean).map((line) => {
    const [name, id, windows, created] = line.split('\t');
    return {
      name,
      id: id || null,
      windows: Number.isFinite(Number(windows)) ? Number(windows) : null,
      created_at: created ? new Date(Number(created) * 1000).toISOString() : null,
    };
  });
}

export function hasSession(name, { socket = null } = {}) {
  const session = requireName(name);
  return listSessions({ socket }).some((row) => row.name === session);
}

/** Capture scrollback without attaching or sending input to the worker. */
export function capturePane(name, lines = null, { socket = null } = {}) {
  const session = requireName(name);
  const args = ['capture-pane', '-p', '-t', session];
  if (lines != null) {
    if (!Number.isInteger(lines) || lines < 1) throw new Error('peek lines must be a positive integer');
    args.push('-S', `-${lines}`);
  }
  return runTmux(args, { socket }).stdout;
}

/** Send keystrokes to a tmux session pane. */
export function sendKeys(name, keys, { socket = null } = {}) {
  const session = requireName(name);
  const keyList = Array.isArray(keys) ? keys : [keys];
  const args = ['send-keys', '-t', session, ...keyList];
  return runTmux(args, { socket }).stdout;
}

/** Attach the caller's terminal to a worker's real tmux TUI. */
export function attachSession(name, { socket = null } = {}) {
  const session = requireName(name);
  const result = spawnSync(tmuxBinary(), [...globalArgs(socket), 'attach-session', '-t', session], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw new Error(`could not attach tmux session ${session}: ${result.error.message}`, { cause: result.error });
  return result.status ?? 1;
}

/** Attach the caller's terminal to a whole tmux server (its session tree). */
export function attachServer(socket) {
  const resolved = resolveSocket(socket);
  const result = spawnSync(tmuxBinary(), [...globalArgs(resolved), 'attach-session'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw new Error(`could not attach tmux server ${resolved}: ${result.error.message}`, { cause: result.error });
  return result.status ?? 1;
}

/** Stop the tmux session. Missing sessions are already stopped. */
export function killSession(name, { socket = null } = {}) {
  const session = requireName(name);
  const result = runTmux(['kill-session', '-t', session], { allowFailure: true, socket });
  if (result.error?.code === 'ENOENT') throw new Error(`could not run tmux: ${result.error.message}`, { cause: result.error });
  if (result.status === 0) return true;
  const detail = String(result.stderr || '').toLowerCase();
  if (/no server running|session not found|can't find session|unknown session|no such file or directory/.test(detail)) return false;
  throw new Error(formatFailure(result, ['kill-session', '-t', session]));
}

function processTable() {
  const result = spawnSync(process.env.GOLEM_PS_BIN || 'ps', ['-axo', 'pid=,pgid=,command='], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`could not inspect processes: ${result.error?.message || String(result.stderr || '').trim() || `ps exited ${result.status}`}`);
  }
  return String(result.stdout || '').split('\n').map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)(?:\s+(.*))?$/);
    return match ? { pid: Number(match[1]), pgid: Number(match[2]), command: (match[3] || '').trim() } : null;
  }).filter(Boolean);
}

export function processGroupProcesses(pgid) {
  const group = Number(pgid);
  if (!Number.isInteger(group) || group <= 0) return [];
  return processTable().filter((row) => row.pgid === group);
}

export function processIdsInGroup(pgid) {
  return processGroupProcesses(pgid).map((row) => row.pid);
}

function commandArgPattern(flag, value) {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)--${flag}(?:=|\\s+)["']?${escaped}["']?(?=\\s|$)`);
}

/**
 * Re-identify a live process group before signalling it. A pgid is reusable,
 * so the recorded number alone is never an ownership proof. Worker launches
 * carry both the Pi executable and the exact --name argument in their command
 * lines; an unrelated recycled group must not match this predicate.
 */
export function processGroupMatches(pgid, { name } = {}) {
  if (typeof name !== 'string' || !name.trim()) return false;
  const rows = processGroupProcesses(pgid);
  if (!rows.length) return false;
  const nameArg = commandArgPattern('name', name.trim());
  return rows.some(({ command }) => (
    /(?:^|[\/\s])pi(?:\s|$)/.test(command) && nameArg.test(command)
  ));
}

export function signalProcessGroup(pgid, signal) {
  const group = Number(pgid);
  if (!Number.isInteger(group) || group <= 1) return false;
  try {
    process.kill(-group, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

export async function terminateProcessGroup(pgid, {
  termGraceMs = 500,
  killGraceMs = 1000,
  pollMs = 25,
  identity = null,
} = {}) {
  const verifiedSurvivors = () => {
    const survivors = processIdsInGroup(pgid);
    // An empty group is already stopped. A non-empty group must be matched
    // against the worker launch identity before either signal is sent: pgids
    // are recycled by the OS and cannot identify ownership by themselves.
    if (survivors.length && (!identity || !processGroupMatches(pgid, identity))) return [];
    return survivors;
  };
  const waitUntilEmpty = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let survivors = verifiedSurvivors();
    while (survivors.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      survivors = verifiedSurvivors();
    }
    return survivors;
  };

  let survivors = verifiedSurvivors();
  if (!survivors.length) return [];
  // Keep the teardown sequence explicit even when tmux already reaped the
  // pane: the required order is kill-session, TERM the recorded group, then
  // KILL any survivors, followed by a fresh ps verification.
  signalProcessGroup(pgid, 'SIGTERM');
  survivors = await waitUntilEmpty(termGraceMs);
  survivors = survivors.length ? verifiedSurvivors() : survivors;
  if (survivors.length) {
    // Re-identify again before KILL. The original group may have disappeared
    // and the numeric pgid may already belong to a different process group.
    signalProcessGroup(pgid, 'SIGKILL');
    survivors = await waitUntilEmpty(killGraceMs);
  }
  return survivors;
}

export const tmuxDriver = Object.freeze({
  LEGACY_SOCKET,
  socketForProject,
  resolveSocket,
  newSession,
  panePid,
  listSessions,
  hasSession,
  capturePane,
  attachSession,
  attachServer,
  killSession,
  processGroupProcesses,
  processIdsInGroup,
  processGroupMatches,
  signalProcessGroup,
  terminateProcessGroup,
});
