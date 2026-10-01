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
  assert.equal(nativeConversationMatches(fact, { agent_session: { kind: 'id', value: fact.locator.raw_session_id } }), true);
  const replacementInfo = { foreground_process_group_id: child.pid, foreground_processes: [{ pid: child.pid, argv0: 'pi', argv: ['pi', '--session', path.join(temp, 'conversation-B.jsonl')] }] };
  const staleA = workerProcessEvidence({ ...worker, process_ownership: old }, { facts: [fact], native: { agentGet: () => agent, paneProcessInfo: () => replacementInfo } });
  assert.equal(staleA.state, 'unavailable', 'stale A metadata must not bind the current B process incarnation');
  assert.equal(alive(), true, 'replacement B survives the stale-A refusal');
  assert.equal(workerProcessEvidence(worker, { facts: [fact], native: { agentGet: () => agent, paneProcessInfo: () => replacementInfo } }).state, 'unavailable', 'even a surviving captured ancestor cannot authorize contradictory B arguments');
  const wrapperAndB = { ...replacementInfo, foreground_processes: [{ pid: child.pid, argv0: 'node', argv: ['node', 'golem.js', 'pi', '--session', fact.locator.session_file] }, ...replacementInfo.foreground_processes] };
  assert.equal(workerProcessEvidence({ ...worker, process_ownership: old }, { facts: [fact], native: { agentGet: () => agent, paneProcessInfo: () => wrapperAndB } }).state, 'unavailable', 'wrapper A arguments cannot bind the Pi B process');
  updateWorker(worker.worker_id, { process_ownership: old });
  await assert.rejects(killWorker(worker.name, { workerId: worker.worker_id, native: { ...native, agentGet: () => agent, paneProcessInfo: () => replacementInfo }, evidenceOptions: { facts: [fact] } }), /refusing to stop/);
  assert.equal(alive(), true); assert.equal(closes, 0);
  const recovered = workerProcessEvidence({ ...worker, process_ownership: old }, { facts: [fact], native: {
    agentGet: () => agent, paneProcessInfo: ({ paneId }) => { assert.equal(paneId, 'moved-pane'); return { foreground_process_group_id: child.pid, foreground_processes: [{ pid: child.pid, argv0: 'pi', argv: ['pi', '--session', fact.locator.session_file] }] }; },
  } });
  let bindingReads = 0;
  const racedBinding = workerProcessEvidence({ ...worker, process_ownership: old }, { facts: [fact], native: { agentGet: () => agent,
    paneProcessInfo: () => ++bindingReads === 1 ? { ...replacementInfo, foreground_processes: [{ pid: child.pid, argv0: 'pi', argv: ['pi', '--session', fact.locator.session_file] }] } : replacementInfo } });
  assert.equal(racedBinding.state, 'unavailable', 'A to B change during incarnation binding must refuse');
  assert.equal(alive(), true);
  const cachedOnly = workerProcessEvidence({ ...worker, process_ownership: old }, { facts: [fact], native: { agentGet: () => agent, paneProcessInfo: () => ({ foreground_process_group_id: child.pid, foreground_processes: [{ pid: child.pid, argv0: 'zsh' }] }) } });
  assert.equal(cachedOnly.state, 'unavailable', 'cached native metadata alone cannot adopt a shell as a restarted agent');
  const lease = { canonical_id: fact.canonical_id, harness: 'pi', kind: 'typed-worker', owner_token: 'actual-runtime-owner', pid: child.pid, process_birth: identity.members.find(p => p.pid === child.pid).birth, expires_at: new Date(Date.now()+60000).toISOString() };
  const opaqueArgvNative = { agentGet: () => agent, paneProcessInfo: () => ({ foreground_process_group_id: child.pid, foreground_processes: [{ pid: child.pid, argv0: 'pi' }] }) };
  assert.equal(workerProcessEvidence({ ...worker, process_ownership: old }, { facts: [fact], native: opaqueArgvNative, leases: [lease], refreshLeases: () => [lease] }).state, 'available', 'actual canonical endpoint PID/birth binds a Pi whose title hides argv');
  assert.equal(workerProcessEvidence({ ...worker, process_ownership: old }, { facts: [fact], native: opaqueArgvNative, leases: [{ ...lease, process_birth: 'ended-incarnation' }], refreshLeases: () => [lease] }).state, 'unavailable', 'old lease birth never owns a replacement');
  assert.equal(workerProcessEvidence({ ...worker, process_ownership: old }, { facts: [fact], native: opaqueArgvNative, leases: [lease], refreshLeases: () => [] }).state, 'unavailable', 'lease released during binding never authorizes control');
  assert.equal(workerProcessEvidence({ ...worker, process_ownership: old }, { facts: [fact], native: opaqueArgvNative, leases: [lease, { ...lease, owner_token: 'other-live-owner', process_birth: null }], refreshLeases: () => [lease] }).state, 'unavailable', 'ambiguous live owner is not filtered away by missing birth');
  assert.equal(workerProcessEvidence({ ...worker, process_ownership: old }, { facts: [fact], native: opaqueArgvNative, leases: [{ ...lease, kind: 'claude-channel' }], refreshLeases: () => [lease] }).state, 'unavailable', 'MCP sidecar lease is never application ownership');
  assert.equal(workerProcessEvidence({ ...worker, process_ownership: old }, { facts: [fact], native: opaqueArgvNative, leases: [{ ...lease, expires_at: new Date(0).toISOString() }], refreshLeases: () => [lease] }).state, 'unavailable', 'expired lease never owns the current app');
  let leaseReads = 0;
  const leaseThenB = { ...opaqueArgvNative, paneProcessInfo: () => ++leaseReads === 1 ? opaqueArgvNative.paneProcessInfo() : replacementInfo };
  assert.equal(workerProcessEvidence({ ...worker, process_ownership: old }, { facts: [fact], native: leaseThenB, leases: [lease], refreshLeases: () => [lease] }).state, 'unavailable', 'live lease cannot override conflicting B arguments at second bracket');
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
