// Process-group identification and teardown, shared by the herdr host and the
// legacy tmux-row handling (GOL-370 G6/G14). Moved out of lib/tmux-driver.js.
//
// A pgid is reusable by the OS and cannot identify ownership by itself: every
// signal path re-identifies the group against the worker's launch identity
// (the Pi executable plus the exact --name argument) before signalling.

import { spawnSync } from 'node:child_process';

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
 * Re-identify a live process group before signalling it. Worker launches
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
    // against the worker launch identity before either signal is sent.
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
  signalProcessGroup(pgid, 'SIGTERM');
  survivors = await waitUntilEmpty(termGraceMs);
  survivors = survivors.length ? verifiedSurvivors() : survivors;
  if (survivors.length) {
    signalProcessGroup(pgid, 'SIGKILL');
    survivors = await waitUntilEmpty(killGraceMs);
  }
  return survivors;
}

export const processGroup = Object.freeze({
  processGroupProcesses,
  processIdsInGroup,
  processGroupMatches,
  signalProcessGroup,
  terminateProcessGroup,
});