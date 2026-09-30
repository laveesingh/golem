// Advisory policy does not stand in for initialization or actual transport.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-compatibility-'));
process.env.GOLEM_HOME = home;
const compatibility = await import('../lib/runtime-compatibility.js');
const { piCompatibility, SUPPORTED_PI_VERSION } = await import('../lib/pi-compatibility.js');
const { renewEndpointLease, releaseEndpointLeases } = await import('../lib/session-facts.js');
const { readChannels, isChannelDeliveryReady } = await import('../dashboard/server/channels.js');
const { pushBrief } = await import('../dashboard/server/brief.js');
const { TYPED_WORKER_PROTOCOL_VERSION } = await import('../lib/typed-worker-endpoint.js');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server;
try {
  assert.equal(SUPPORTED_PI_VERSION, '0.99.1');
  assert.equal(piCompatibility('0.99.1').status, 'supported');
  for (const version of ['0.85.1', '0.100.0', '1.0.0', null]) assert.equal(piCompatibility(version).status, 'unverified');
  const providers = [
    { CLAUDE_CODE_USE_BEDROCK: '1' }, { CLAUDE_CODE_USE_VERTEX: '1' }, { CLAUDE_CODE_USE_FOUNDRY: '1' },
    { ANTHROPIC_BASE_URL: 'https://secret:credential@example.invalid/private' },
  ];
  for (const env of providers) {
    let attempts = 0;
    const status = compatibility.claudeConsumerStatus({ initialized: true, env });
    assert.equal(status.ready, true); assert.equal(status.initialized, true); assert.equal(status.reason, null);
    assert.equal(status.compatibility.status, 'unverified'); assert.equal(status.compatibility.warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(status), /credential|example\.invalid|ANTHROPIC_BASE_URL/);
    const warnings = await compatibility.submitClaudeChannelNotification({ initialized: true, env, content: 'fixture', meta: { kind: 'brief' },
      notification: async message => { attempts++; assert.equal(message.method, 'notifications/claude/channel'); assert.equal(message.params.content, 'fixture'); } });
    assert.equal(attempts, 1); assert.equal(warnings[0].severity, 'warning');
    await assert.rejects(compatibility.submitClaudeChannelNotification({ initialized: false, env, content: 'fixture', meta: { kind: 'brief' },
      notification: async () => { attempts++; } }), e => e.statusCode === 503 && e.failureStage === 'before_native' && /initialization/.test(e.message));
    assert.equal(attempts, 1, 'provider warning never fabricates initialization');
    const nativeError = Object.assign(new Error('actual native channel rejection'), { code: 'NATIVE_REJECTED', statusCode: 502, failureStage: 'after_native' });
    await assert.rejects(compatibility.submitClaudeChannelNotification({ initialized: true, env,
      notification: async () => { throw nativeError; }, content: 'fixture', meta: { kind: 'brief' } }), e => e === nativeError);
    const wireError = new TypeError('invalid native wire/schema');
    await assert.rejects(compatibility.submitClaudeChannelNotification({ initialized: true, env,
      notification: async message => { if (typeof message.params.content !== 'string') throw wireError; }, content: { invalid: true }, meta: { kind: 'brief' } }), e => e === wireError);
  }
  assert.deepEqual(compatibility.claudeProviderCompatibility({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }).warnings, []);
  const legacy = { consumer_initialized: true, consumer_ready: false, delivery_ready: false, consumer_reason: 'unsupported_custom_base_url' };
  assert.equal(isChannelDeliveryReady(legacy), true);
  assert.equal(isChannelDeliveryReady({ ...legacy, consumer_initialized: false }), false);
  assert.equal(isChannelDeliveryReady({ consumer_ready: false, delivery_ready: false, consumer_reason: legacy.consumer_reason }), false, 'legacy label alone never establishes init');
  assert.equal(isChannelDeliveryReady({ kind: 'typed-worker', delivery_ready: false, compatibility: { status: 'unsupported' } }), false);
  assert.equal(isChannelDeliveryReady({ kind: 'typed-worker', delivery_ready: true, compatibility: { status: 'unsupported' } }), true);

  // Actual dashboard health/forward consumers, isolated owned HTTP endpoint.
  let initialized = true, rejectNative = false, healthMode = 'ok', pushes = 0;
  const sessionId = 'compat-fixture', owner = 'fixture-owner';
  server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/healthz')) {
      res.end(JSON.stringify({ canonical_id: healthMode === 'wrong-id' ? 'wrong' : sessionId, owner_token: owner,
        consumer_initialized: initialized, consumer_ready: false, delivery_ready: false,
        consumer_reason: 'unsupported_custom_base_url', kind: 'typed-worker', protocol_version: TYPED_WORKER_PROTOCOL_VERSION + 1 }));
      return;
    }
    pushes++; for await (const _ of req) { /* consume body */ }
    if (rejectNative) { res.statusCode = 503; res.end(JSON.stringify({ ok: false, error: 'old process native 503 refusal', failure_stage: 'before_native', retryable: true })); }
    else { res.statusCode = 202; res.end(JSON.stringify({ ok: true, kind: 'brief' })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  renewEndpointLease({ canonical_id: sessionId, owner_token: owner, host: '127.0.0.1', port, pid: process.pid, kind: 'claude-channel', ...legacy });
  const channels = await readChannels();
  assert.equal(channels.length, 1); assert.equal(channels[0].consumer_initialized, true); assert.equal(isChannelDeliveryReady(channels[0]), true);
  assert.equal(JSON.stringify(channels).includes(owner), false, 'advisory fields do not leak owner credentials');
  const forwarded = await pushBrief('fixture normal push', sessionId);
  assert.equal(forwarded.ok, true); assert.equal(forwarded.status, 202); assert.equal(pushes, 1);
  assert.ok(forwarded.compatibility_warnings.some(w => w.legacy_metadata));
  rejectNative = true;
  const nativeFailure = await pushBrief('fixture normal push', sessionId);
  assert.equal(nativeFailure.ok, false); assert.equal(nativeFailure.status, 503); assert.equal(pushes, 2);
  assert.equal(nativeFailure.error, 'old process native 503 refusal'); assert.equal(nativeFailure.failure_stage, 'before_native');
  initialized = false;
  const notInitialized = await pushBrief('fixture normal push', sessionId);
  assert.equal(notInitialized.ok, false); assert.equal(notInitialized.status, 503); assert.equal(pushes, 2, 'independent init failure still prevents submission');
  healthMode = 'wrong-id'; assert.deepEqual(await readChannels(), [], 'owner/session health validation is still strict');
  healthMode = 'ok'; releaseEndpointLeases(owner);
  renewEndpointLease({ canonical_id: sessionId, owner_token: owner, host: '127.0.0.1', port, pid: process.pid, kind: 'typed-worker', delivery_ready: true });
  assert.deepEqual(await readChannels(), [], 'typed protocol mismatch is a real failure, not downgraded policy');
  releaseEndpointLeases(owner);
  server.close(); await once(server, 'close'); server = null;
  const unreachable = await pushBrief('fixture normal push', sessionId);
  assert.equal(unreachable.ok, false); assert.match(unreachable.error, /no channel registered/);

  // Disposable mirror sensitivity: reintroducing a version-label veto must
  // fail the emission regression; no active source/runtime rewriting.
  const mirror = path.join(home, 'mirror'); fs.mkdirSync(path.join(mirror, 'dashboard', 'server'), { recursive: true });
  fs.mkdirSync(path.join(mirror, 'lib'));
  for (const name of ['runtime-compatibility.js', 'pi-compatibility.js', 'session-facts.js', 'golem-home.js']) fs.copyFileSync(path.join(repo, 'lib', name), path.join(mirror, 'lib', name));
  const runtimePath = path.join(mirror, 'dashboard', 'server', 'notification-schedule-runtime.js');
  const source = fs.readFileSync(path.join(repo, 'dashboard', 'server', 'notification-schedule-runtime.js'), 'utf8');
  fs.writeFileSync(runtimePath, source);
  fs.writeFileSync(path.join(mirror, 'probe.mjs'), `import assert from 'node:assert/strict';
import { createNotificationScheduleRuntime } from './dashboard/server/notification-schedule-runtime.js';
let emitted=0, blocked=0;
const runtime=createNotificationScheduleRuntime({readFacts:()=>[{canonical_id:'target',compatibility:{status:'unsupported',pi_version:'0.100.0'}}],tracker:{schedules:{reconcile(){},pendingBatch(){return[]},due(){return[{id:'schedule',target_session_id:'target'}]},emit(){emitted++;return{}},block(){blocked++}}}});
runtime.prepare({sessions:[{session_id:'target',alive:true}]}); assert.equal(emitted,1);assert.equal(blocked,0);
`);
  const probeArgs = [path.join(mirror, 'probe.mjs')];
  const good = spawnSync(process.execPath, probeArgs, { encoding: 'utf8', env: { ...process.env, GOLEM_HOME: path.join(home, 'mirror-state') } });
  assert.equal(good.status, 0, good.stderr);
  const insertion = "        if (target?.delivery_mode === 'pull-only')";
  assert.ok(source.includes(insertion));
  fs.writeFileSync(runtimePath, source.replace(insertion, "        if (fact?.compatibility?.status === 'unsupported') return 'policy veto';\n" + insertion));
  const bad = spawnSync(process.execPath, probeArgs, { encoding: 'utf8', env: { ...process.env, GOLEM_HOME: path.join(home, 'mirror-state') } });
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /0 !== 1/);
  console.log('runtime compatibility passed: baseline/nonbaseline, four provider warnings/init/native errors, legacy health/forward, actual protocol/endpoint failures, policy-veto mutation sensitivity');
} finally {
  releaseEndpointLeases('fixture-owner');
  if (server) { server.closeAllConnections(); server.close(); }
  fs.rmSync(home, { recursive: true, force: true });
}
