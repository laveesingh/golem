#!/usr/bin/env node
// Isolated real child group: no harness, daemon or live registry resources.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { captureProcessGroup, processGroupMatches, terminateProcessGroup } from '../lib/process-group.js';
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
const exited = once(child, 'exit');
const alive = () => { try { process.kill(child.pid, 0); return true; } catch { return false; } };
try {
  const current = captureProcessGroup(child.pid);
  assert.equal(processGroupMatches(child.pid, current), true);
  // A stored old incarnation with the same numeric PID/group cannot own the
  // live replacement. This deterministically exercises PID reuse without
  // relying on the kernel to recycle a PID during the test.
  const old = { ...current, members: current.members.map(row => ({ ...row, birth: 'old-ended-incarnation' })) };
  assert.equal(processGroupMatches(child.pid, old), false);
  await assert.rejects(terminateProcessGroup(child.pid, { identity: old }), /incarnation changed.*untouched/);
  assert.equal(alive(), true, 'replacement must survive');
  await assert.rejects(terminateProcessGroup(child.pid, { identity: { name: 'same-logical-name' } }), /captured incarnation evidence required/);
  assert.equal(alive(), true, 'names alone confer no ownership');
  await assert.rejects(terminateProcessGroup(child.pid, { identity: current, probe: () => { throw new Error('birth probe failed'); } }), /birth probe failed/);
  assert.equal(alive(), true, 'failed probe must not signal or report empty');
  await assert.rejects(terminateProcessGroup(child.pid, { identity: current, beforeSignal: () => { throw new Error('canonical membership transferred'); } }), /membership transferred/);
  assert.equal(alive(), true, 'late canonical revalidation failure must not signal');
  const survivors = await terminateProcessGroup(child.pid, { identity: current });
  assert.deepEqual(survivors, []); await exited; assert.equal(alive(), false);
  console.log('management process passed: exact captured incarnation, replacement survives, missing/name-only/probe-failed evidence refuses, confirmed real teardown');
} finally {
  if (alive()) { process.kill(-child.pid, 'SIGKILL'); await exited; }
  console.log('management process cleanup passed: owned child exited');
}
