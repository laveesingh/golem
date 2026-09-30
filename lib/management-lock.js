// Short synchronous management critical sections only. Lock order:
// management -> mappings -> teams -> workers. Native calls and waits belong
// outside this helper. A live owner is never evicted because of lock age.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { managementLockPath } from './golem-home.js';

const held = new Map();
const incarnationToken = crypto.randomUUID();
export function processBirth(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 });
  if (result.error || ![0, 1].includes(result.status)) throw new Error('management lock process identity unavailable');
  const birth = result.stdout?.trim();
  if (result.status === 0 && !birth) throw new Error('management lock process identity indeterminate');
  return birth || null;
}
export function ownerIncarnation() {
  const birth = processBirth(process.pid);
  if (!birth) throw new Error('management lock cannot establish owner incarnation');
  return { pid: process.pid, birth, token: crypto.randomUUID(), incarnation: incarnationToken };
}
export function ownerEnded(owner, probe = processBirth) {
  if (!owner?.pid || !owner?.birth || !owner?.token) return false;
  if (owner.pid === process.pid && owner.incarnation && owner.incarnation !== incarnationToken) return true;
  const current = probe(owner.pid);
  return current == null || current !== owner.birth;
}
function readOwner(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function synchronous(fn) {
  if (fn?.constructor?.name === 'AsyncFunction') throw new Error('management lock rejects async/thenable callbacks');
  const value = fn();
  if (value && typeof value.then === 'function') throw new Error('management lock rejects async/thenable callbacks');
  return value;
}
export function managementLockHeld(file = managementLockPath()) { return held.has(file); }
export function currentIncarnationToken() { return incarnationToken; }
export function withManagementLock(fn, { file = managementLockPath(), probe = processBirth } = {}) {
  if (held.has(file)) throw new Error('management lock rejects reentrant transactions');
  const owner = ownerIncarnation();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const acquire = () => fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  try { acquire(); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A separate exclusive reclamation guard prevents two dead-owner probes
    // from unlinking a newly acquired successor lock (ABA). An interrupted
    // guard fails closed; it is not an age-based permission to steal.
    const guard = `${file}.reclaim`;
    let fd;
    try { fd = fs.openSync(guard, 'wx', 0o600); } catch {
      throw new Error(`management lock busy; reclamation uncertain: ${guard}`);
    }
    try {
      fs.writeFileSync(fd, JSON.stringify(owner));
      const previous = readOwner(file);
      if (!ownerEnded(previous, probe)) throw new Error(`management lock busy: owner ${previous?.pid ?? 'unknown'}`);
      fs.unlinkSync(file);
      acquire();
    } finally { fs.closeSync(fd); fs.unlinkSync(guard); }
  }
  held.set(file, owner);
  try { return synchronous(fn); } finally {
    held.delete(file);
    if (readOwner(file)?.token === owner.token) fs.unlinkSync(file);
  }
}
