#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-worker-control-'));
process.env.GOLEM_HOME = path.join(temp, 'state'); delete process.env.GOLEM_HERDR_SESSION;
const { captureProcessGroup } = await import('../lib/process-group.js');
const { workerProcessEvidence, nativeConversationMatches } = await import('../lib/worker-control.js');
const { claimWorker, updateWorker, readWorkers } = await import('../lib/worker-registry.js');
const { killWorker } = await import('../lib/worker-manager.js');
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
const exited = once(child, 'exit');
const alive = () => { try { process.kill(child.pid, 0); return true; } catch { return false; } };
try {
  const identity = captureProcessGroup(child.pid);
  const claimed = claimWorker({ projectId: 'control-proj-abcdef', role: 'builder', preset: {} });
  const worker = updateWorker(claimed.worker_id, { name: 'renamed-logical-agent', state: 'live', session_id: 'conversation-known', herdr_pane_id: 'old-pane', process_ownership: identity });
  let closes = 0;
  const native = { agentGet: () => { throw new Error('agent_not_found'); },
    paneProcessInfo: () => ({ foreground_process_group_id: alive() ? child.pid : 999991 }), paneClose: () => { closes++; return true; } };
  const options = { native, facts: [] };
  assert.equal(workerProcessEvidence(worker, options).state, 'available', 'owned launch works without executable/name predicate');
  const old = { ...identity, members: identity.members.map(row => ({ ...row, birth: 'old-incarnation' })) };
  updateWorker(worker.worker_id, { process_ownership: old });
  await assert.rejects(killWorker(worker.name, { workerId: worker.worker_id, native, evidenceOptions: { facts: [] } }), /missing or changed captured incarnation/);
  assert.equal(alive(), true); assert.equal(closes, 0);
  assert.equal(workerProcessEvidence({ ...worker, process_ownership: null }, options).state, 'unavailable');
  assert.match(workerProcessEvidence(worker, { ...options, matches: () => { throw new Error('birth unavailable'); } }).reason, /birth unavailable/);
  assert.match(workerProcessEvidence(worker, { ...options, native: { ...native, agentGet: () => { throw new Error('socket probe failed'); } } }).reason, /socket probe failed/);
  const fact = { canonical_id: worker.session_id, locator: { raw_session_id: '12345678-1234-1234-1234-123456789abc', session_file: path.join(temp, 'exact-session.jsonl') } };
  const agent = { agent: 'pi', pane_id: 'moved-pane', agent_session: { kind: 'path', value: fact.locator.session_file } };
  assert.equal(nativeConversationMatches(fact, agent), true);
  assert.equal(nativeConversationMatches(fact, { agent_session: { kind: 'path', value: path.join(temp, 'different.jsonl') } }), false);
  assert.equal(nativeConversationMatches(fact, { agent_session: { kind: 'uuid', value: fact.locator.raw_session_id } }), true);
  const recovered = workerProcessEvidence({ ...worker, process_ownership: old }, { facts: [fact], native: {
    agentGet: () => agent, paneProcessInfo: ({ paneId }) => { assert.equal(paneId, 'moved-pane'); return { foreground_process_group_id: child.pid, foreground_processes: [{ pid: child.pid, argv0: 'pi' }] }; },
  } });
  const cachedOnly = workerProcessEvidence({ ...worker, process_ownership: old }, { facts: [fact], native: { agentGet: () => agent, paneProcessInfo: () => ({ foreground_process_group_id: child.pid, foreground_processes: [{ pid: child.pid, argv0: 'zsh' }] }) } });
  assert.equal(cachedOnly.state, 'unavailable', 'cached native metadata alone cannot adopt a shell as a restarted agent');
  assert.equal(recovered.state, 'available'); assert.equal(recovered.pane_id, 'moved-pane'); assert.equal(recovered.identity.pgid, child.pid);
  assert.match(workerProcessEvidence(worker, { facts: [fact], native: { ...native, agentGet: () => ({ ...agent, agent_session: { kind: 'path', value: '/different-conversation' } }) } }).reason, /does not match/);
  updateWorker(worker.worker_id, { process_ownership: identity });
  const stopped = await killWorker(worker.name, { workerId: worker.worker_id, native, evidenceOptions: { facts: [] } });
  await exited; assert.equal(alive(), false); assert.equal(stopped.state, 'dead'); assert.equal(stopped.pane_retained, true); assert.equal(closes, 0, 'unverified replacement/shell pane must be retained');
  assert.equal(readWorkers().find(w => w.worker_id === worker.worker_id).state, 'dead');
  console.log('worker control passed: renamed launch, exact native path/UUID and moved/manual-restart evidence, replacement/missing/probe-failed refusal, real group teardown with honest retained pane');
} finally {
  if (alive()) { process.kill(-child.pid, 'SIGKILL'); await exited; }
  fs.rmSync(temp, { recursive: true, force: true });
  console.log('worker control cleanup passed: owned child exited before isolated state removal');
}
