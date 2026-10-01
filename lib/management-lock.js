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
function contention(message, file) { return Object.assign(new Error(message), { code: 'MANAGEMENT_LOCK_BUSY', acquisition_file: file }); }
function attemptManagementLock(fn, { file, probe }) {
  if (held.has(file)) throw new Error('management lock rejects reentrant transactions');
  const owner = ownerIncarnation();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const acquire = () => fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  // EVERY acquisition uses the existing exclusive guard. Otherwise an owner
  // can release while a dead-owner probe runs and an unguarded successor can
  // be installed (and then unlinked by that stale probe).
  const guard = `${file}.reclaim`;
  let fd;
  try { fd=fs.openSync(guard,'wx',0o600); } catch(error) {
    if(error.code!=='EEXIST') throw error;
    throw contention(`management lock busy; reclamation uncertain: ${guard}`,file);
  }
  try {
    fs.writeFileSync(fd,JSON.stringify(owner));
    try { acquire(); } catch(error) {
      if(error.code!=='EEXIST') throw error;
      const previous=readOwner(file);
      if(!ownerEnded(previous,probe)) throw contention(`management lock busy: owner ${previous?.pid ?? 'unknown'}`,file);
      const current=readOwner(file);
      if(current && (current.token!==previous.token || current.pid!==previous.pid || current.birth!==previous.birth || current.incarnation!==previous.incarnation)) {
        throw contention('management lock owner changed during reclamation',file);
      }
      if(current) {
        try { fs.unlinkSync(file); } catch(error) { if(error.code!=='ENOENT') throw error; }
      }
      // wx is the final absence/successor revalidation, including release
      // during the probe/unlink window. Never overwrite or unlink a successor.
      try { acquire(); } catch(error) {
        if(error.code!=='EEXIST') throw error;
        throw contention('management lock successor appeared during reclamation',file);
      }
    }
  } finally { fs.closeSync(fd);fs.unlinkSync(guard); }
  held.set(file, owner);
  try { return synchronous(fn); } finally {
    held.delete(file);
    if (readOwner(file)?.token === owner.token) fs.unlinkSync(file);
  }
}
export function withManagementLock(fn, { file = managementLockPath(), probe = processBirth, timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + Math.min(5000, Math.max(0, timeoutMs));
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  do {
    try { return attemptManagementLock(fn, { file, probe }); }
    catch (error) {
      // Retry acquisition contention only: never replay a callback and never
      // wait with a management lock held. Live owners still cannot be stolen.
      if (error.code !== 'MANAGEMENT_LOCK_BUSY' || error.acquisition_file !== file || Date.now() >= deadline) throw error;
      Atomics.wait(waiter, 0, 0, Math.min(20, Math.max(1, deadline - Date.now())));
    }
  } while (true);
}
