// Process groups are teardown handles, never identities. Ownership comes from
// captured OS process incarnations, not executable/provider/logical names.
import { spawnSync } from 'node:child_process';
import { processBirth } from './management-lock.js';
function processTable() {
  const result = spawnSync(process.env.GOLEM_PS_BIN || 'ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8', windowsHide: true, timeout: 2000 });
  if (result.error || result.status !== 0) throw new Error(`could not inspect processes: ${result.error?.message || String(result.stderr || '').trim() || `ps exited ${result.status}`}`);
  return String(result.stdout || '').split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)(?:\s+(.*))?$/);
    return match ? { pid: Number(match[1]), pgid: Number(match[2]), command: (match[3] || '').trim() } : null;
  }).filter(Boolean);
}
export function processGroupProcesses(pgid) {
  const group = Number(pgid);
  if (!Number.isInteger(group) || group <= 1) return [];
  return processTable().filter(row => row.pgid === group);
}
export function processIdsInGroup(pgid) { return processGroupProcesses(pgid).map(row => row.pid); }
export function captureProcessGroup(pgid, { probe = processBirth } = {}) {
  const group = Number(pgid);
  if (!Number.isInteger(group) || group <= 1) throw new Error('process group identity unavailable: invalid group');
  const rows = processGroupProcesses(group);
  if (!rows.length) throw new Error('process group identity unavailable: no living incarnation to capture');
  const members = rows.map(row => {
    const birth = probe(row.pid);
    if (!birth) throw new Error(`process incarnation unavailable during capture: ${row.pid}`);
    return { pid: row.pid, birth };
  });
  return { pgid: group, members, captured_at: new Date().toISOString() };
}
function requireIdentity(pgid, identity) {
  if (identity?.pgid !== Number(pgid) || !Array.isArray(identity.members) || !identity.members.length || identity.members.some(row => !Number.isInteger(row.pid) || row.pid <= 1 || !row.birth)) throw new Error('process ownership unavailable: captured incarnation evidence required');
}
export function processGroupMatches(pgid, identity, { probe = processBirth } = {}) {
  requireIdentity(pgid, identity);
  const rows = processGroupProcesses(pgid);
  return identity.members.some(member => rows.some(row => row.pid === member.pid) && probe(member.pid) === member.birth);
}
export function processGroupExactMatches(pgid, identity, { probe = processBirth } = {}) {
  requireIdentity(pgid, identity);
  const rows = processGroupProcesses(pgid);
  return rows.length === identity.members.length && rows.every(row => identity.members.some(member => member.pid === row.pid && probe(row.pid) === member.birth));
}
export function processHasDescendants(pid) {
  const result = spawnSync(process.env.GOLEM_PS_BIN || 'ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 });
  if (result.error || result.status !== 0) throw new Error('could not inspect process descendants');
  const rows = result.stdout.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)$/)).filter(Boolean);
  return rows.some(row => Number(row[2]) === Number(pid));
}
export function signalProcessGroup(pgid, signal) {
  const group = Number(pgid);
  if (!Number.isInteger(group) || group <= 1) return false;
  try { process.kill(-group, signal); return true; } catch (error) { if (error?.code === 'ESRCH') return false; throw error; }
}
export async function terminateProcessGroup(pgid, { termGraceMs = 500, killGraceMs = 1000, pollMs = 25, identity = null, probe = processBirth, beforeSignal = () => {} } = {}) {
  requireIdentity(pgid, identity);
  const verifiedSurvivors = () => {
    const survivors = processIdsInGroup(pgid);
    if (!survivors.length) {
      // A changed group is not proof an original process ended.
      if (identity.members.some(member => probe(member.pid) === member.birth)) throw new Error('recorded process incarnation remains outside its group; inspect exact process recovery');
      return [];
    }
    if (!processGroupMatches(pgid, identity, { probe })) {
      // The last owned process can exit between the table read and birth
      // checks. Reprobe absence rather than misclassifying normal exit as reuse.
      const remaining = processIdsInGroup(pgid);
      if (!remaining.length && !identity.members.some(member => probe(member.pid) === member.birth)) return [];
      throw new Error('process group incarnation changed; replacement left untouched');
    }
    return survivors;
  };
  const waitUntilEmpty = async timeoutMs => {
    const deadline = Date.now() + timeoutMs;
    let survivors = verifiedSurvivors();
    while (survivors.length && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, pollMs)); survivors = verifiedSurvivors(); }
    return survivors;
  };
  let survivors = verifiedSurvivors();
  if (!survivors.length) return [];
  // Recheck immediately before either signal; a polling failure is not empty.
  verifiedSurvivors(); beforeSignal(); signalProcessGroup(pgid, 'SIGTERM');
  survivors = await waitUntilEmpty(termGraceMs);
  if (survivors.length) { verifiedSurvivors(); beforeSignal(); signalProcessGroup(pgid, 'SIGKILL'); survivors = await waitUntilEmpty(killGraceMs); }
  return survivors;
}
export const processGroup = Object.freeze({ processGroupProcesses, processIdsInGroup, captureProcessGroup, processGroupMatches, processGroupExactMatches, signalProcessGroup, terminateProcessGroup });
