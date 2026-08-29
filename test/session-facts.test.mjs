#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.GOLEM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-session-facts-'));
const {
  readEndpointLeases, readSessionFacts, releaseEndpointLeases,
  renewEndpointLease, upsertSessionFact,
} = await import('../lib/session-facts.js');
const { SUPPORTED_PI_VERSION } = await import('../lib/pi-compatibility.js');

const first = upsertSessionFact({ canonical_id: 'canonical-1', harness: 'claudecode', locator: { raw_session_id: 'run-1' }, continuation_key: 'resume-1', name: 'Original', status: 'idle', revision: 1 }, { now: 1000 });
assert.equal(first.name, 'Original');
const stale = upsertSessionFact({ canonical_id: 'canonical-1', harness: 'claudecode', locator: { raw_session_id: 'wrong-old-run' }, name: 'Stale rename', status: 'busy', revision: 0, observed_at: new Date(500).toISOString() });
assert.equal(stale.name, 'Original', 'older mutable observation cannot overwrite the fact');
const renamed = upsertSessionFact({ canonical_id: 'canonical-1', harness: 'claudecode', locator: { raw_session_id: 'run-2' }, continuation_key: 'invented-change', name: 'Renamed', status: 'busy', revision: 2 }, { now: 2000 });
assert.equal(renamed.canonical_id, 'canonical-1');
assert.equal(renamed.continuation_key, 'resume-1', 'continuation ownership is immutable');
assert.equal(renamed.locator.raw_session_id, 'run-2', 'resumed raw id is only a locator');
assert.equal(readSessionFacts().length, 1);

renewEndpointLease({ canonical_id: 'canonical-1', owner_token: 'owner-1', host: '127.0.0.1', port: 1234 }, { now: 1000, ttlMs: 100 });
assert.equal(readEndpointLeases({ now: 1050 }).length, 1);
assert.equal(readEndpointLeases({ now: 1101 }).length, 0, 'expired lease is not live');
renewEndpointLease({ canonical_id: 'canonical-1', owner_token: 'owner-1', host: '127.0.0.1', port: 1234 }, { now: 2000, ttlMs: 100 });
releaseEndpointLeases('owner-1');
assert.equal(readEndpointLeases({ now: 2001 }).length, 0);

for (const file of ['session-facts.json', 'endpoint-leases.json']) {
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(process.env.GOLEM_HOME, file), 'utf8')), `${file} remains atomic JSON`);
}

const corruptFacts = path.join(process.env.GOLEM_HOME, 'corrupt-facts.json');
fs.writeFileSync(corruptFacts, '{"version":1,"facts":[');
const corruptBytes = fs.readFileSync(corruptFacts);
assert.throws(() => upsertSessionFact({ canonical_id: 'must-not-write', harness: 'opencode', locator: { raw_session_id: 'raw' } }, { file: corruptFacts }), /cannot read facts registry/);
assert.deepEqual(fs.readFileSync(corruptFacts), corruptBytes, 'malformed registry is preserved byte-for-byte');

const projected = upsertSessionFact({ canonical_id: 'unprobed', harness: 'opencode', locator: { raw_session_id: 'unprobed' }, project_path: process.cwd(), status: 'idle' });
renewEndpointLease({ canonical_id: projected.canonical_id, owner_token: 'unprobed-owner', host: '127.0.0.1', port: 9 });
const { readNativeSessions } = await import('../dashboard/server/native-sessions.js');
const unprobed = (await readNativeSessions(() => true)).find((row) => row.session_id === projected.canonical_id);
assert.equal(unprobed?.alive, false, 'valid but unprobed lease never makes projection alive');
assert.equal(unprobed?.endpoint_health, 'unverified', 'lease validity is distinct from verified endpoint health');

// GOL-109: a heartbeat re-assert proves the endpoint process is alive, not the
// session — an unchanged row must not re-stamp observed_at/revision, or idle
// agent cards read "seen 12s ago" forever and resort every 30s.
const hbInput = (observedAt) => ({ canonical_id: 'hb-cc', harness: 'claudecode', locator: { raw_session_id: 'hb-cc-run' }, continuation_key: 'hb-cc', name: 'golem-hb', observed_at: observedAt });
const hbFirst = upsertSessionFact(hbInput(new Date(5000).toISOString()), { reassert: true });
const hbRepeat = upsertSessionFact(hbInput(new Date(90_000).toISOString()), { reassert: true });
assert.equal(hbRepeat.observed_at, hbFirst.observed_at, 'unchanged heartbeat re-assert must not forge activity');
assert.equal(hbRepeat.revision, hbFirst.revision, 'unchanged heartbeat re-assert must not bump revision');
const hbRenamed = upsertSessionFact({ ...hbInput(new Date(120_000).toISOString()), name: 'golem-hb-renamed' }, { reassert: true });
assert.equal(hbRenamed.name, 'golem-hb-renamed', 'a material change still writes under reassert');
assert.ok(Number(hbRenamed.revision) > Number(hbFirst.revision), 'a material change advances the revision');
assert.equal(hbRenamed.observed_at, new Date(120_000).toISOString(), 'a material change refreshes observed_at');
// The production sequence: a hook writes status, then the heartbeat re-asserts
// WITHOUT a status key (the channel has nothing to say). The absent key must
// inherit the stored status instead of counting as a material change per tick.
const hbHook = upsertSessionFact({ ...hbInput(new Date(150_000).toISOString()), name: 'golem-hb-renamed', status: 'idle' });
const hbAfterHook = upsertSessionFact({ ...hbInput(new Date(180_000).toISOString()), name: 'golem-hb-renamed' }, { reassert: true });
assert.equal(hbAfterHook.status, 'idle', 'heartbeat without a status key inherits the hook-written status');
assert.equal(hbAfterHook.observed_at, hbHook.observed_at, 'status inheritance is not a material change');
const hbStatusFlip = upsertSessionFact({ ...hbInput(new Date(210_000).toISOString()), name: 'golem-hb-renamed', status: 'busy' }, { reassert: true });
assert.equal(hbStatusFlip.status, 'busy', 'a real status flip under reassert still writes');
assert.equal(hbStatusFlip.observed_at, new Date(210_000).toISOString(), 'a real status flip refreshes observed_at');

// GOL-109 reader side: with heartbeat re-stamps gone, a live opencode session's
// fact legitimately ages past the recency window. A verified authenticated
// endpoint alone keeps it alive, and projection recency is the max of fact
// activity and hook-driven registry recency — in BOTH directions.
const recencyNow = Date.now();
const staleFactAt = recencyNow - 20 * 60_000;
const freshRegistryAt = recencyNow - 60_000;
const freshFactAt = recencyNow - 2 * 60_000;
const staleRegistryAt = recencyNow - 25 * 60_000;
upsertSessionFact({ canonical_id: 'oc-recency', harness: 'opencode', locator: { raw_session_id: 'oc-recency' }, continuation_key: 'oc-recency', project_path: process.cwd(), name: 'oc-recency', status: 'idle', observed_at: new Date(staleFactAt).toISOString() });
upsertSessionFact({ canonical_id: 'oc-recency2', harness: 'opencode', locator: { raw_session_id: 'oc-recency2' }, continuation_key: 'oc-recency2', project_path: process.cwd(), name: 'oc-recency2', status: 'idle', observed_at: new Date(freshFactAt).toISOString() });
// Wholesale write of the shared registry fixture — keep every row this block
// needs in this single write; the earlier scenarios above do not read it.
fs.writeFileSync(path.join(process.env.GOLEM_HOME, 'sessions.json'), JSON.stringify({
  sessions: [
    { session_id: 'oc-recency', harness: 'opencode', project_path: process.cwd(), name: 'oc-recency', status: 'idle', boot_time: new Date(recencyNow - 3_600_000).toISOString(), last_seen_at: new Date(freshRegistryAt).toISOString() },
    { session_id: 'oc-recency2', harness: 'opencode', project_path: process.cwd(), name: 'oc-recency2', status: 'idle', boot_time: new Date(recencyNow - 3_600_000).toISOString(), last_seen_at: new Date(staleRegistryAt).toISOString() },
  ],
}, null, 2));
const recencyRows = await readNativeSessions(() => true, [
  { session_id: 'oc-recency', endpoint_health: 'healthy' },
  { session_id: 'oc-recency2', endpoint_health: 'healthy' },
]);
const ocRow = recencyRows.find((row) => row.session_id === 'oc-recency');
assert.equal(ocRow?.alive, true, 'verified healthy endpoint keeps an idle opencode session alive past the fact recency window');
assert.equal(ocRow?.updated_at, freshRegistryAt, 'registry recency wins when the fact is older');
const ocRow2 = recencyRows.find((row) => row.session_id === 'oc-recency2');
assert.equal(ocRow2?.updated_at, freshFactAt, 'fact recency wins when the registry is older');

// GOL-129: a verified typed-worker lease is endpoint liveness, not activity.
// It keeps a quiet Pi visible without forging a newer observed_at, while the
// fact remains the authority for provider/model/continuation/trust metadata.
upsertSessionFact({
  canonical_id: 'pi-stale-live', continuation_key: 'pi-continuation', harness: 'pi',
  locator: { raw_session_id: 'pi-stale-live', session_file: '/tmp/pi-session.jsonl' },
  project_path: process.cwd(), name: 'Pi stale live', status: 'active',
  provider: 'ollama', model: 'deepseek-v4-flash:0731-cloud',
  delivery: { mode: 'typed-worker', push: true, ready: true },
  capabilities: { typed_worker: true }, trust: 'host-full-trust',
  observations: { adapter_state: 'active', delivery_state: 'accepted', pi_version: SUPPORTED_PI_VERSION, extension_version: '5.6.14' },
  observed_at: new Date(staleFactAt).toISOString(),
});
const piBusy = (await readNativeSessions(() => true, [{
  session_id: 'pi-stale-live', endpoint_health: 'healthy', kind: 'typed-worker', delivery_ready: true,
}])).find((row) => row.session_id === 'pi-stale-live');
assert.equal(piBusy?.alive, true, 'healthy typed Pi lease keeps a quiet worker visible past fact recency');
assert.equal(piBusy?.updated_at, staleFactAt, 'lease liveness does not forge Pi activity recency');
assert.equal(piBusy?.status, 'busy', 'Pi active fact projects the canonical busy state');
assert.equal(piBusy?.endpoint_health, 'healthy', 'busy Pi worker has healthy endpoint');
assert.equal(piBusy?.provider, 'ollama');
assert.equal(piBusy?.model, 'deepseek-v4-flash:0731-cloud');
assert.equal(piBusy?.continuation_key, 'pi-continuation');
assert.equal(piBusy?.delivery_mode, 'typed-worker');
assert.equal(piBusy?.delivery_state, 'accepted');
assert.equal(piBusy?.trust, 'host-full-trust');
assert.deepEqual(piBusy?.compatibility, { status: 'supported', pi_version: SUPPORTED_PI_VERSION, supported_pi_version: SUPPORTED_PI_VERSION, node_requirement: '>=22.19' });

upsertSessionFact({
  canonical_id: 'pi-idle-live', continuation_key: 'pi-continuation-idle', harness: 'pi',
  locator: { raw_session_id: 'pi-idle-live', session_file: '/tmp/pi-idle.jsonl' },
  project_path: process.cwd(), name: 'Pi idle live', status: 'idle',
  provider: 'ollama', model: 'deepseek-v4-flash:0731-cloud',
  delivery: { mode: 'typed-worker', push: true, ready: true },
  capabilities: { typed_worker: true }, trust: 'host-full-trust',
  observations: { adapter_state: 'idle', delivery_state: 'settled', pi_version: SUPPORTED_PI_VERSION, extension_version: '5.6.14' },
  observed_at: new Date(staleFactAt).toISOString(),
});
const piIdle = (await readNativeSessions(() => true, [{
  session_id: 'pi-idle-live', endpoint_health: 'healthy', kind: 'typed-worker', delivery_ready: true,
}])).find((row) => row.session_id === 'pi-idle-live');
assert.equal(piIdle?.status, 'idle', 'Pi idle fact projects the canonical idle state');
assert.equal(piIdle?.endpoint_health, 'healthy', 'idle Pi worker has healthy endpoint');

upsertSessionFact({
  canonical_id: 'pi-terminal-fact', continuation_key: 'pi-terminal-fact', harness: 'pi',
  locator: { raw_session_id: 'pi-terminal-fact', session_file: '/tmp/pi-terminal.jsonl' },
  project_path: process.cwd(), name: 'Pi terminal fact', status: 'stopped',
  ended_at: new Date().toISOString(), observed_at: new Date().toISOString(),
});
assert.equal((await readNativeSessions(() => true, [])).some((row) => row.session_id === 'pi-terminal-fact'), false, 'fact-only terminal Pi worker is absent from the native-session projection');

// GOL-109 merge overlay: the CLI row's updated_at is fabricated (= startedAt;
// `claude agents --json` emits no updatedAt), so overlaying it must never
// regress the golem registry's hook-driven recency — the shape that occurs in
// production for every live Claude Code session.
const { mergeSources, factPresentationField } = await import('../dashboard/server/native-sessions.js');
const startedAt = recencyNow - 6 * 3_600_000;
const cliShaped = { session_id: 'cc-live', pid: 4242, cwd: process.cwd(), name: 'cc-live', status: 'idle', waiting_for: null, model: null, started_at: startedAt, updated_at: startedAt, kind: 'interactive', source: 'native', _from: 'cli' };
const golemShaped = { session_id: 'cc-live', pid: 999, cwd: process.cwd(), name: 'cc-live', status: 'idle', waiting_for: null, started_at: startedAt, updated_at: freshRegistryAt, kind: null, harness: 'claudecode', model: null, role: null, role_updated_at: null, role_updated_by: null, ended_at: null, source: 'native', _from: 'golem' };
const mergedCc = mergeSources([cliShaped], [], [golemShaped]).find((row) => row.session_id === 'cc-live');
assert.equal(mergedCc?.updated_at, freshRegistryAt, 'CLI overlay must not regress hook-driven registry recency');

// GOL-109: a frozen CC fact status (written once at SessionStart, never
// maintained afterwards) must not shadow the live CLI/registry status —
// that froze every CC card on "idle" and broke the when_idle dispatch gate.
// Harnesses whose shim/supervisor maintains fact.status stay fact-first.
assert.equal(factPresentationField('claudecode', 'idle', 'busy'), 'busy', 'live CC status wins over a frozen fact status');
assert.equal(factPresentationField('claudecode', 'idle', null), 'idle', 'CC fact status fills only when no live source exists');
assert.equal(factPresentationField('opencode', 'busy', 'idle'), 'busy', 'opencode fact status leads');
assert.equal(factPresentationField('codex', 'active', null), 'active', 'codex fact status leads');

console.log('canonical session facts + endpoint leases journey passed (36 assertions)');
