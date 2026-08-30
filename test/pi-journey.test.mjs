import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectIdFor } from '../lib/project-id.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-pi-native-'));
const handProjectRootPath = path.join(temp, 'fresh-pi-project');
const handProjectCwdPath = path.join(handProjectRootPath, 'nested');
fs.mkdirSync(path.join(handProjectRootPath, '.git'), { recursive: true });
fs.mkdirSync(handProjectCwdPath, { recursive: true });
const handProjectRoot = fs.realpathSync(handProjectRootPath);
const handProjectCwd = fs.realpathSync(handProjectCwdPath);
const handProjectId = projectIdFor(handProjectRoot);
const env = {
  ...process.env,
  HOME: path.join(temp, 'home'),
  GOLEM_HOME: path.join(temp, 'state'),
  XDG_CONFIG_HOME: path.join(temp, 'xdg'),
  PI_OFFLINE: '1',
};
fs.mkdirSync(env.GOLEM_HOME, { recursive: true });
fs.writeFileSync(path.join(env.GOLEM_HOME, 'dashboard.json'), JSON.stringify({ url: 'http://127.0.0.1:1' }));
process.env.GOLEM_HOME = env.GOLEM_HOME;
process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(message);
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function linkPiTui(render) {
  const piCli = fs.realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
  let current = path.dirname(piCli);
  let source = null;
  while (current && current !== path.dirname(current)) {
    const candidate = path.join(current, 'node_modules', '@earendil-works', 'pi-tui');
    if (fs.existsSync(candidate)) {
      source = candidate;
      break;
    }
    current = path.dirname(current);
  }
  if (!source) throw new Error(`Could not find @earendil-works/pi-tui starting from ${piCli}`);
  const scope = path.join(render, 'node_modules', '@earendil-works');
  fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(source, path.join(scope, 'pi-tui'), 'dir');
}

function createHarness(extension, sessionId, { reason = 'startup', previousSessionFile, cwd = repo } = {}) {
  const handlers = new Map();
  const tools = new Map();
  const sent = [];
  let idle = true;
  let pending = false;
  let aborted = false;
  let shutdown = false;
  let name = 'pi-native-test';
  let nextPrompt = null;
  let footer;
  let renderRequests = 0;
  let contextUsage = { tokens: 14_000, contextWindow: 1_000_000, percent: 1.4 };
  const models = new Map();
  const entries = [{
    type: 'message',
    message: {
      role: 'assistant',
      usage: {
        input: 2_200_000, output: 30_000, cacheRead: 9_700, cacheWrite: 0,
        cost: { total: 0.066 },
      },
    },
  }];
  const tui = { requestRender() { renderRequests += 1; } };
  const theme = {
    fg(color, text) { return `\x1b[${color === 'accent' ? 36 : color === 'warning' ? 33 : color === 'error' ? 31 : 90}m${text}\x1b[0m`; },
    bold(text) { return `\x1b[1m${text}\x1b[22m`; },
  };
  const footerData = {
    getGitBranch: () => 'main',
    getAvailableProviderCount: () => 2,
    getExtensionStatuses: () => new Map(),
    onBranchChange: () => () => {},
  };
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendUserMessage(text, options) { sent.push(options ? { text, options } : text); },
    async setModel(model) { await sleep(5); ctx.model = model; return true; },
    getThinkingLevel: () => 'medium',
  };
  extension(pi);
  const ctx = {
    cwd,
    mode: 'tui',
    model: { provider: 'ollama', id: 'deepseek-v4-flash:0731-cloud', contextWindow: 1_000_000, reasoning: true },
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    abort: () => { aborted = true; idle = true; },
    shutdown: () => { shutdown = true; },
    getContextUsage: () => contextUsage,
    ui: {
      setFooter(factory) { footer = factory(tui, theme, footerData); },
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => path.join(temp, `${sessionId}.jsonl`),
      getSessionName: () => name,
      getLeafId: () => `leaf-${sent.length}`,
      getEntries: () => entries,
    },
    modelRegistry: {
      find: (provider, model) => models.get(`${provider}/${model}`) ?? null,
    },
  };
  const emit = async (event, payload = {}) => {
    let result;
    if (event === 'agent_start' && !payload.skipBefore) {
      const beforePayload = { prompt: payload.prompt ?? nextPrompt ?? '', systemPrompt: payload.systemPrompt ?? 'Pi base prompt' };
      for (const handler of handlers.get('before_agent_start') || []) {
        const changed = await handler(beforePayload, ctx);
        if (changed?.systemPrompt) beforePayload.systemPrompt = changed.systemPrompt;
        if (changed !== undefined) result = changed;
      }
      nextPrompt = null;
    }
    for (const handler of handlers.get(event) || []) {
      const next = await handler(payload, ctx);
      if (next !== undefined) result = next;
    }
    if (event === 'input' && result?.action !== 'handled') {
      nextPrompt = result?.action === 'transform' ? result.text : payload.text;
    }
    return result;
  };
  return {
    pi, ctx, sent, tools, emit,
    setIdle(value) { idle = value; },
    setPending(value) { pending = value; },
    setName(value) { name = value; },
    setContextUsage(value) { contextUsage = value; },
    addModel(model) { models.set(`${model.provider}/${model.id}`, model); },
    get aborted() { return aborted; },
    get shutdown() { return shutdown; },
    get footer() { return footer; },
    get renderRequests() { return renderRequests; },
    start: () => emit('session_start', { reason, previousSessionFile }),
  };
}

function typedEnvelope(sessionId, id, content, kind = 'brief', attempt = `attempt-${id}`) {
  const now = Date.now();
  return {
    protocol_version: 1,
    envelope_id: id,
    target_session_id: sessionId,
    sender_session_id: 'sender-test',
    kind,
    content,
    attempt_id: attempt,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
  };
}

async function postLease(lease, envelope) {
  return fetch(`http://${lease.host}:${lease.port}/brief`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sender': 'dashboard',
      'x-golem-target-session': lease.canonical_id,
      'x-golem-endpoint-owner': lease.owner_token,
    },
    body: JSON.stringify(envelope),
  });
}

async function main() {
  execFileSync(process.execPath, [path.join(repo, 'cli/golem.js'), 'sync', '--target', 'pi'], { cwd: repo, env });
  const render = path.join(env.GOLEM_HOME, 'renders', 'pi');
  const caps = readJson(path.join(render, 'capabilities.json'));
  assert.equal(caps.tier, 'A', 'the shipped render advertises the proven first-class worker tier');
  assert.equal(caps.push_delivery, true);
  assert.deepEqual(caps.delivery, ['typed-worker', 'next_turn_migration']);
  assert.equal(fs.existsSync(path.join(env.HOME, '.pi')), false, 'sync does not mutate Pi profile');
  assert.match(execFileSync('pi', ['--version'], { env, encoding: 'utf8' }).trim(), /^\d+\.\d+\.\d+/, 'native proof verifies available Pi version');
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).engines.node, '>=22.19', 'root runtime supports stable node:sqlite');
  for (const required of ['pi-native-adapter.js', 'typed-worker-endpoint.js', 'typed-delivery-tombstones.js', 'project-id.js', 'session-registry.js']) {
    assert.ok(fs.existsSync(path.join(render, 'lib', required)), `Pi render ships ${required}`);
  }

  const executable = path.join(render, 'golem.mjs');
  linkPiTui(render);
  fs.copyFileSync(path.join(render, 'golem.ts'), executable);
  const extension = (await import(`${pathToFileURL(executable).href}?t=${Date.now()}`)).default;
  const { PiNativeAdapter } = await import(`${pathToFileURL(path.join(render, 'lib', 'pi-native-adapter.js')).href}?t=${Date.now()}`);
  const { readNativeSessions } = await import(`${pathToFileURL(path.join(repo, 'dashboard/server/native-sessions.js')).href}?t=${Date.now()}`);
  const sessionId = 'pi-native-session';
  const harness = createHarness(extension, sessionId);
  await harness.start();
  const stripAnsi = (value) => value.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '');
  const footerLines = harness.footer.render(140).map(stripAnsi);
  assert.match(footerLines[0], /^[^\/]+\/golem \(main\) • pi-native-test$/, 'footer shortens cwd and follows it with branch and session name');
  assert.doesNotMatch(footerLines[0], /Documents/, 'footer omits the full home-relative path');
  assert.match(footerLines[1], /▏░{9} 1\.4% 14k\/1\.0M/, 'footer renders context as a fractional progress bar with used and total tokens');
  assert.match(footerLines[1], /\(ollama\) deepseek-v4-flash:0731-cloud • medium$/, 'footer retains provider, model, and thinking level');
  for (const width of [80, 90, 100]) {
    const metrics = stripAnsi(harness.footer.render(width)[1]);
    assert.match(metrics, /deepseek-v4-flash:0731-cloud • medium$/, `footer retains model and thinking at ${width} columns`);
    assert.ok(metrics.length <= width, `footer metrics fit ${width} columns`);
  }
  const rendersBeforeRename = harness.renderRequests;
  harness.setName('renamed-worker');
  await harness.emit('session_info_changed', { name: 'renamed-worker' });
  assert.ok(harness.renderRequests > rendersBeforeRename, 'session rename requests a footer rerender');
  assert.match(stripAnsi(harness.footer.render(140)[0]), /• renamed-worker$/, 'footer reads the current session name on rerender');
  assert.ok(harness.footer.render(24).every((line) => stripAnsi(line).length <= 24), 'footer truncates every line to narrow terminal width');
  harness.ctx.cwd = path.join(temp, '软件', 'golem');
  assert.equal(stripAnsi(harness.footer.render(10)[0]), '软件/gole…', 'footer truncation measures CJK path segments in terminal cells');
  harness.ctx.cwd = path.join(temp, 'software', 'go\u0301lem');
  assert.equal(stripAnsi(harness.footer.render(15)[0]), 'software/go\u0301lem…', 'footer truncation keeps combining graphemes intact');
  harness.ctx.cwd = path.join(temp, 'software', '🇺');
  assert.equal(stripAnsi(harness.footer.render(11)[0]), 'software/…', 'footer treats isolated regional indicators as two terminal cells');
  harness.ctx.cwd = path.join(temp, 'software', 'กำ');
  assert.equal(stripAnsi(harness.footer.render(11)[0]), 'software/…', 'footer accounts for Thai spacing vowels within a grapheme');
  harness.ctx.cwd = repo;
  for (const [percent, colorCode] of [[70, 33], [90, 33], [90.1, 31]]) {
    harness.setContextUsage({ tokens: percent * 10_000, contextWindow: 1_000_000, percent });
    assert.match(harness.footer.render(140)[1], new RegExp(`\\x1b\\[${colorCode}m`), `footer applies the expected context color at ${percent}%`);
  }
  harness.setContextUsage({ tokens: 14_000, contextWindow: 1_000_000, percent: 1.4 });
  assert.equal(harness.tools.has('ticket_get'), true, 'shipped Pi extension registers shared tracker tools');
  assert.equal(harness.tools.has('project_context'), true, 'shipped Pi extension registers project context');
  const discovered = await harness.emit('resources_discover', { cwd: repo, reason: 'startup' });
  assert.deepEqual(discovered.skillPaths.map((value) => fs.realpathSync(value)), [fs.realpathSync(path.join(render, 'skills'))]);
  const roleResult = await harness.tools.get('session_role').execute('tool-role', { role: 'builder' }, undefined, undefined, harness.ctx);
  assert.equal(roleResult.details.ok, true, roleResult.content[0].text);
  const prompt = await harness.emit('before_agent_start', { prompt: 'inspect role context', systemPrompt: 'Pi base prompt' });
  const renderedInstructions = fs.readFileSync(path.join(render, 'instructions', 'AGENTS.md'), 'utf8');
  const instructionsTitle = renderedInstructions.split('\n').find((line) => line.trim().length > 0).trim();
  assert.ok(prompt.systemPrompt.includes(instructionsTitle), 'Golem instructions are injected without a Pi profile file');
  assert.match(prompt.systemPrompt, /Role: builder/, 'role truth is read at the safe turn boundary');
  assert.match(prompt.systemPrompt, /Recent commits/, 'bounded shipped L4 context is injected');
  let lease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === sessionId);
  assert.equal(lease.kind, 'typed-worker');
  assert.equal(lease.delivery_ready, true);

  const heartbeatId = 'pi-quiet-heartbeat';
  const heartbeatHarness = createHarness((pi) => new PiNativeAdapter(pi, {
    home: env.GOLEM_HOME, heartbeatIntervalMs: 25,
  }).bind(), heartbeatId);
  await heartbeatHarness.start();
  const heartbeatFactAt = readJson(path.join(env.GOLEM_HOME, 'session-facts.json')).facts.find((row) => row.canonical_id === heartbeatId).observed_at;
  let heartbeatLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === heartbeatId);
  const firstRenewedAt = heartbeatLease.renewed_at;
  heartbeatLease = await waitFor(() => {
    const current = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === heartbeatId);
    return current?.renewed_at > firstRenewedAt ? current : null;
  }, 'quiet Pi lease did not renew on its first heartbeat');
  const secondRenewedAt = heartbeatLease.renewed_at;
  heartbeatLease = await waitFor(() => {
    const current = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === heartbeatId);
    return current?.renewed_at > secondRenewedAt ? current : null;
  }, 'quiet Pi lease did not renew on its second heartbeat');
  assert.equal(readJson(path.join(env.GOLEM_HOME, 'session-facts.json')).facts.find((row) => row.canonical_id === heartbeatId).observed_at, heartbeatFactAt, 'lease heartbeat does not forge quiet Pi activity');
  assert.equal((await readNativeSessions(() => true, [{ ...heartbeatLease, session_id: heartbeatId, endpoint_health: 'healthy' }])).find((row) => row.session_id === heartbeatId)?.alive, true, 'renewed typed lease keeps a quiet Pi worker live');
  await heartbeatHarness.emit('session_shutdown', { reason: 'quit' });

  const reload = createHarness(extension, 'pi-session-reload');
  reload.setName('pi-session-reload');
  await reload.start();
  await reload.emit('session_shutdown', {});
  let reloadFact = readJson(path.join(env.GOLEM_HOME, 'session-facts.json')).facts.find((row) => row.canonical_id === 'pi-session-reload');
  assert.equal(reloadFact.status, 'stopped', 'Pi process shutdown records terminal status');
  assert.ok(reloadFact.ended_at, 'Pi process shutdown records terminal time');
  assert.equal((await readNativeSessions(() => true, [])).some((row) => row.session_id === 'pi-session-reload'), false, 'terminal Pi worker is removed instead of projected as channel-offline');
  const resumedReload = createHarness(extension, 'pi-session-reload', { reason: 'reload' });
  resumedReload.setName('pi-session-reload');
  await resumedReload.start();
  reloadFact = readJson(path.join(env.GOLEM_HOME, 'session-facts.json')).facts.find((row) => row.canonical_id === 'pi-session-reload');
  assert.equal(reloadFact.status, 'idle', 'same-ID Pi reload clears terminal status');
  assert.equal(reloadFact.ended_at, null, 'same-ID Pi reload clears terminal time');
  assert.ok(readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.some((row) => row.canonical_id === 'pi-session-reload'), 'same-ID Pi reload registers a fresh lease');
  await resumedReload.emit('session_shutdown', { reason: 'quit' });

  const legacyRoot = path.join(env.GOLEM_HOME, 'pi-inbox', sessionId);
  fs.mkdirSync(path.join(legacyRoot, 'pending'), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'pending', 'legacy.json'), JSON.stringify({ text: 'legacy already-published work' }));
  const migrated = await harness.emit('input', { source: 'interactive', text: 'human turn' });
  assert.match(migrated.text, /legacy already-published work/);
  harness.setIdle(false);
  await harness.emit('agent_start', {});
  assert.ok(fs.existsSync(path.join(legacyRoot, 'acks', 'legacy.json')), 'migration pickup acknowledges only at observable agent_start');
  harness.setIdle(true);
  await harness.emit('agent_settled', {});

  // Any native input reserves the pre-agent gap before Pi reports itself busy.
  await harness.emit('input', { source: 'interactive', text: 'local turn' });
  const localBusy = await postLease(lease, typedEnvelope(sessionId, 'local-race', 'must not overtake local input'));
  assert.equal(localBusy.status, 409);
  harness.setIdle(false);
  await harness.emit('agent_start', {});
  harness.setIdle(true);
  await harness.emit('agent_settled', {});

  // The first publish reserves synchronously. A second pre-agent publish cannot
  // overtake it while starting preflight owns the slot.
  const firstPromise = postLease(lease, typedEnvelope(sessionId, 'first', 'first native turn'));
  await waitFor(() => harness.sent.length === 1, 'first native sendUserMessage was not invoked');
  const secondBusy = await postLease(lease, typedEnvelope(sessionId, 'second', 'must wait while starting'));
  assert.equal(secondBusy.status, 409);
  assert.equal(harness.sent.length, 1);
  await harness.emit('input', { source: 'extension', text: 'first native turn' });
  harness.setIdle(false);
  await harness.emit('agent_start', {});
  const firstResponse = await firstPromise;
  const firstBody = await firstResponse.json();
  assert.equal(firstBody.accepted, true);
  assert.equal(firstBody.delivery_state, 'accepted');
  assert.equal(firstBody.accepted_attempt_id, 'attempt-first');

  // While Pi is active mid-turn, a subsequent brief is accepted and delivered
  // as a mid-turn steer message.
  const activeSteer = await postLease(lease, typedEnvelope(sessionId, 'second', 'steered mid-turn', 'brief', 'attempt-second-a'));
  assert.equal(activeSteer.status, 200);
  const activeSteerBody = await activeSteer.json();
  assert.equal(activeSteerBody.accepted, true);
  assert.equal(activeSteerBody.delivery_state, 'accepted');
  assert.equal(harness.sent.length, 2);
  assert.deepEqual(harness.sent[1], { text: 'steered mid-turn', options: { deliverAs: 'steer' } });

  harness.setIdle(true);
  await harness.emit('agent_settled', {});
  const deliveriesAfterSettled = readJson(path.join(env.GOLEM_HOME, 'pi-workers', sessionId, 'delivery.json')).inbox.deliveries;
  assert.equal(deliveriesAfterSettled.find((row) => row.envelope_id === 'first')?.lifecycle_state, 'settled');
  assert.equal(deliveriesAfterSettled.find((row) => row.envelope_id === 'second')?.lifecycle_state, 'settled');

  // Terminal duplicate returns the immutable first disposition and never calls
  // Pi twice. Then a new third envelope can start when idle.
  const duplicate = await postLease(lease, typedEnvelope(sessionId, 'first', 'first native turn', 'brief', 'attempt-first-retry'));
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(harness.sent.length, 2);
  const thirdPromise = postLease(lease, typedEnvelope(sessionId, 'third', 'third native turn', 'brief', 'attempt-third-b'));
  await waitFor(() => harness.sent.length === 3, 'third native sendUserMessage was not invoked');
  await harness.emit('input', { source: 'extension', text: 'third native turn' });
  harness.setIdle(false);
  await harness.emit('agent_start', {});
  assert.equal((await (await thirdPromise).json()).accepted, true);

  // Busy interrupt is accepted through the control path, aborts Pi, and makes
  // the accepted work terminal rather than replaying it.
  const interruptPromise = postLease(lease, typedEnvelope(sessionId, 'interrupt-control', 'stop', 'interrupt'));
  await waitFor(() => harness.aborted, 'Pi abort was not requested');
  assert.equal(readJson(path.join(env.GOLEM_HOME, 'pi-workers', sessionId, 'delivery.json')).inbox.deliveries.find((row) => row.envelope_id === 'third').lifecycle_state, 'accepted', 'control does not report terminal before Pi settles');
  harness.setIdle(true);
  await harness.emit('agent_settled', {});
  const interrupt = await interruptPromise;
  assert.equal((await interrupt.json()).accepted, true);
  assert.equal(harness.aborted, true);
  const delivery = readJson(path.join(env.GOLEM_HOME, 'pi-workers', sessionId, 'delivery.json')).inbox.deliveries.find((row) => row.envelope_id === 'third');
  assert.equal(delivery.lifecycle_state, 'interrupted');

  const halt = await postLease(lease, typedEnvelope(sessionId, 'halt-control', 'halt', 'halt'));
  assert.equal((await halt.json()).accepted, true);
  await waitFor(() => harness.shutdown, 'halt did not shut down after its response boundary');
  await harness.emit('session_shutdown', { reason: 'reload' });
  assert.equal(readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.some((row) => row.owner_token === lease.owner_token), false);

  // Reload keeps canonical identity but receives a new endpoint lease. Fork is
  // a distinct canonical worker with previous-session lineage in its fact.
  const resumed = createHarness(extension, sessionId, { reason: 'reload' });
  await resumed.start();
  lease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === sessionId);
  assert.ok(lease && lease.owner_token);
  const forked = createHarness(extension, 'pi-native-fork', { reason: 'fork', previousSessionFile: path.join(temp, `${sessionId}.jsonl`) });
  await forked.start();
  const facts = readJson(path.join(env.GOLEM_HOME, 'session-facts.json')).facts;
  assert.equal(facts.filter((fact) => fact.canonical_id === sessionId).length, 1);
  assert.equal(facts.find((fact) => fact.canonical_id === sessionId).provider, 'ollama');
  assert.equal(facts.find((fact) => fact.canonical_id === sessionId).model, 'deepseek-v4-flash:0731-cloud');
  assert.equal(facts.find((fact) => fact.canonical_id === sessionId).trust, 'host-full-trust');
  assert.equal(facts.find((fact) => fact.canonical_id === 'pi-native-fork').observations.previous_session_file, path.join(temp, `${sessionId}.jsonl`));
  await resumed.emit('session_shutdown', { reason: 'quit' });
  await forked.emit('session_shutdown', { reason: 'quit' });

  // Crash before correlated agent_start releases the exact claim for replay.
  const preCrashId = 'pi-preaccept-crash';
  const preCrash = createHarness(extension, preCrashId);
  await preCrash.start();
  let preCrashLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === preCrashId);
  const preCrashResponse = postLease(preCrashLease, typedEnvelope(preCrashId, 'precrash', 'retry after preaccept crash', 'brief', 'pre-attempt-a'));
  await waitFor(() => preCrash.sent.length === 1, 'pre-crash injection did not start');
  await preCrash.emit('session_shutdown', { reason: 'quit' });
  assert.equal((await preCrashResponse).status, 503);
  const preCrashRestart = createHarness(extension, preCrashId, { reason: 'resume' });
  await preCrashRestart.start();
  preCrashLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === preCrashId);
  const preRetry = postLease(preCrashLease, typedEnvelope(preCrashId, 'precrash', 'retry after preaccept crash', 'brief', 'pre-attempt-b'));
  await waitFor(() => preCrashRestart.sent.length === 1, 'pre-crash retry did not inject');
  await preCrashRestart.emit('input', { source: 'extension', text: 'retry after preaccept crash' });
  preCrashRestart.setIdle(false);
  await preCrashRestart.emit('agent_start', {});
  assert.equal((await (await preRetry).json()).accepted_attempt_id, 'pre-attempt-b');
  preCrashRestart.setIdle(true);
  await preCrashRestart.emit('agent_settled', {});
  await preCrashRestart.emit('session_shutdown', { reason: 'quit' });

  // Crash after acceptance freezes the first attempt as recovery-required. A
  // retry gets that original disposition and never injects a second Pi turn.
  const postCrashId = 'pi-postaccept-crash';
  const postCrash = createHarness(extension, postCrashId);
  await postCrash.start();
  let postCrashLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === postCrashId);
  const postStart = postLease(postCrashLease, typedEnvelope(postCrashId, 'postcrash', 'must not replay after acceptance', 'brief', 'post-attempt-a'));
  await waitFor(() => postCrash.sent.length === 1, 'post-crash injection did not start');
  await postCrash.emit('input', { source: 'extension', text: 'must not replay after acceptance' });
  postCrash.setIdle(false);
  await postCrash.emit('agent_start', {});
  assert.equal((await (await postStart).json()).accepted, true);
  await postCrash.emit('session_shutdown', { reason: 'quit' });
  const postCrashRestart = createHarness(extension, postCrashId, { reason: 'resume' });
  await postCrashRestart.start();
  postCrashLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === postCrashId);
  assert.equal(postCrashLease.delivery_ready, false);
  const postRetry = await postLease(postCrashLease, typedEnvelope(postCrashId, 'postcrash', 'must not replay after acceptance', 'brief', 'post-attempt-b'));
  const postRetryBody = await postRetry.json();
  assert.equal(postRetryBody.delivery_state, 'recovery_required');
  assert.equal(postRetryBody.accepted_attempt_id, 'post-attempt-a');
  assert.equal(postCrashRestart.sent.length, 0);
  await postCrashRestart.emit('session_shutdown', { reason: 'quit' });

  // Pi's generic agent_start has no turn identity. Unrelated input is handled
  // and deferred while typed preflight owns the slot, then replayed after the
  // typed turn settles instead of creating an ambiguous concurrent start.
  const displacedId = 'pi-displaced-typed-input';
  const displaced = createHarness(extension, displacedId);
  await displaced.start();
  const displacedLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === displacedId);
  const displacedStart = postLease(displacedLease, typedEnvelope(displacedId, 'displaced', 'typed input awaiting correlation'));
  await waitFor(() => displaced.sent.length === 1, 'displaced typed input was not injected');
  const displacedInput = await displaced.emit('input', { source: 'rpc', text: 'unrelated native turn' });
  assert.equal(displacedInput.action, 'handled');
  assert.equal(readJson(path.join(env.GOLEM_HOME, 'pi-workers', displacedId, 'delivery.json')).inbox.deliveries.find((row) => row.envelope_id === 'displaced').lifecycle_state, 'claimed');
  await displaced.emit('input', { source: 'extension', text: 'typed input awaiting correlation' });
  displaced.setIdle(false);
  await displaced.emit('agent_start', {});
  const displacedResponse = await displacedStart;
  assert.equal((await displacedResponse.json()).delivery_state, 'accepted');
  displaced.setIdle(true);
  await displaced.emit('agent_settled', {});
  await waitFor(() => displaced.sent.length === 2, 'deferred unrelated input was not replayed after typed settlement');
  await displaced.emit('input', { source: 'extension', text: 'unrelated native turn' });
  displaced.setIdle(false);
  await displaced.emit('agent_start', {});
  displaced.setIdle(true);
  await displaced.emit('agent_settled', {});
  await displaced.emit('session_shutdown', { reason: 'quit' });

  // An earlier async Pi input extension can delay Golem's own input observer
  // after fire-and-forget sendUserMessage. Control in that window must retain
  // the claim until the native start/settlement boundary, never permit replay.
  const preInputId = 'pi-post-send-pre-input-control';
  const preInput = createHarness(extension, preInputId);
  await preInput.start();
  const preInputLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === preInputId);
  const preInputStart = postLease(preInputLease, typedEnvelope(preInputId, 'pre-input', 'delayed by earlier input extension'));
  await waitFor(() => preInput.sent.length === 1, 'pre-input typed injection did not begin');
  let preInputControlDone = false;
  const preInputInterrupt = postLease(preInputLease, typedEnvelope(preInputId, 'pre-input-interrupt', 'stop delayed preflight', 'interrupt'))
    .then((response) => { preInputControlDone = true; return response; });
  await waitFor(() => preInput.aborted, 'pre-input control did not request abort');
  assert.equal(readJson(path.join(env.GOLEM_HOME, 'pi-workers', preInputId, 'delivery.json')).inbox.deliveries.find((row) => row.envelope_id === 'pre-input').lifecycle_state, 'claimed');

  // Multiple unrelated inputs are fenced at the input hook; Pi never emits an
  // ambiguous start for either while the typed native preflight owns the slot.
  assert.equal((await preInput.emit('input', { source: 'rpc', text: 'first unrelated turn' })).action, 'handled');
  assert.equal((await preInput.emit('input', { source: 'interactive', text: 'second unrelated turn' })).action, 'handled');
  await sleep(25);
  assert.equal(preInputControlDone, false, 'deferred unrelated inputs cannot complete typed control');
  await preInput.emit('input', { source: 'extension', text: 'delayed by earlier input extension' });
  preInput.setIdle(false);
  await preInput.emit('agent_start', {});
  assert.equal((await (await preInputStart).json()).delivery_state, 'accepted');
  preInput.setIdle(true);
  await preInput.emit('agent_settled', {});
  assert.equal((await (await preInputInterrupt).json()).accepted, true);
  const preInputRetry = await postLease(preInputLease, typedEnvelope(preInputId, 'pre-input', 'delayed by earlier input extension', 'brief', 'pre-input-retry'));
  assert.equal((await preInputRetry.json()).duplicate, true);
  assert.equal(preInput.sent.filter((text) => text === 'delayed by earlier input extension').length, 1, 'post-send/pre-input control never permits a second typed injection');
  await preInput.emit('session_shutdown', { reason: 'quit' });

  // Once Pi has emitted the exact extension input, interrupt cannot release
  // the claim: Pi 0.80.10 may still continue its idle auth/compaction preflight.
  // Hold the claim, re-abort at agent_start, and make retries duplicates.
  const preflightId = 'pi-correlated-preflight-control';
  const preflight = createHarness(extension, preflightId);
  await preflight.start();
  const preflightLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === preflightId);
  const preflightStart = postLease(preflightLease, typedEnvelope(preflightId, 'preflight', 'correlated preflight turn'));
  await waitFor(() => preflight.sent.length === 1, 'preflight typed input was not injected');
  await preflight.emit('input', { source: 'extension', text: 'correlated preflight turn' });
  const preflightInterrupt = postLease(preflightLease, typedEnvelope(preflightId, 'preflight-interrupt', 'stop preflight', 'interrupt'));
  await waitFor(() => preflight.aborted, 'preflight control did not request abort');
  assert.equal(readJson(path.join(env.GOLEM_HOME, 'pi-workers', preflightId, 'delivery.json')).inbox.deliveries.find((row) => row.envelope_id === 'preflight').lifecycle_state, 'claimed');
  preflight.setIdle(false);
  await preflight.emit('agent_start', {});
  assert.equal((await (await preflightStart).json()).accepted, true);
  preflight.setIdle(true);
  await preflight.emit('agent_settled', {});
  assert.equal((await (await preflightInterrupt).json()).accepted, true);
  const preflightRetry = await postLease(preflightLease, typedEnvelope(preflightId, 'preflight', 'correlated preflight turn', 'brief', 'preflight-retry'));
  assert.equal((await preflightRetry.json()).duplicate, true);
  assert.equal(preflight.sent.length, 1, 'preflight retry never injects a second Pi prompt');
  await preflight.emit('session_shutdown', { reason: 'quit' });

  // Handled local input remains durable until its own agent_start. A crash
  // releases the unaccepted typed claim, but restart replays the local turn.
  const durableInputId = 'pi-durable-deferred-input';
  const durableInput = createHarness(extension, durableInputId);
  await durableInput.start();
  const durableInputLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === durableInputId);
  const durableTyped = postLease(durableInputLease, typedEnvelope(durableInputId, 'durable-owner', 'typed owner before crash'));
  await waitFor(() => durableInput.sent.length === 1, 'durable typed injection did not begin');
  assert.equal((await durableInput.emit('input', { source: 'rpc', text: 'survive worker restart' })).action, 'handled');
  await durableInput.emit('session_shutdown', { reason: 'crash' });
  assert.equal((await durableTyped).status, 503);
  const durableRestart = createHarness(extension, durableInputId, { reason: 'resume' });
  await durableRestart.start();
  await waitFor(() => durableRestart.sent.length === 1, 'restart did not replay durable deferred input');
  assert.equal(durableRestart.sent[0], 'survive worker restart');
  // A generic extension-triggered turn has no input event and cannot dequeue
  // or cause duplicate reinjection of the replayed durable item.
  durableRestart.setIdle(false);
  await durableRestart.emit('agent_start', {});
  durableRestart.setIdle(true);
  await durableRestart.emit('agent_settled', {});
  await sleep(25);
  assert.equal(durableRestart.sent.length, 1, 'uncorrelated settle does not reinject deferred input');
  assert.equal(readJson(path.join(env.GOLEM_HOME, 'pi-workers', durableInputId, 'delivery.json')).deferred_inputs.length, 1, 'uncorrelated start cannot dequeue deferred input');
  await durableRestart.emit('input', { source: 'extension', text: 'survive worker restart' });
  // Even after exact input is observed, a generic prompt-bearing start cannot
  // consume it; before_agent_start is the correlation boundary.
  await durableRestart.emit('before_agent_start', { prompt: 'generic extension turn' });
  durableRestart.setIdle(false);
  await durableRestart.emit('agent_start', { skipBefore: true });
  durableRestart.setIdle(true);
  await durableRestart.emit('agent_settled', {});
  assert.equal(readJson(path.join(env.GOLEM_HOME, 'pi-workers', durableInputId, 'delivery.json')).deferred_inputs.length, 1, 'post-input unrelated start cannot dequeue deferred input');
  durableRestart.setIdle(false);
  await durableRestart.emit('agent_start', {});
  assert.equal(readJson(path.join(env.GOLEM_HOME, 'pi-workers', durableInputId, 'delivery.json')).deferred_inputs.length, 0, 'deferred input dequeues only at its own agent_start');
  durableRestart.setIdle(true);
  await durableRestart.emit('agent_settled', {});
  await durableRestart.emit('session_shutdown', { reason: 'quit' });

  // Halt does not discard input already acknowledged as handled. It stops
  // after typed settlement, and the next session drains the durable FIFO.
  const haltDurableId = 'pi-halt-durable-input';
  const haltDurable = createHarness(extension, haltDurableId);
  await haltDurable.start();
  const haltDurableLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === haltDurableId);
  const haltOwned = postLease(haltDurableLease, typedEnvelope(haltDurableId, 'halt-owner', 'typed owner before halt'));
  await waitFor(() => haltDurable.sent.length === 1, 'halt-owned typed injection did not begin');
  assert.equal((await haltDurable.emit('input', { source: 'interactive', text: 'survive explicit halt' })).action, 'handled');
  const haltControl = postLease(haltDurableLease, typedEnvelope(haltDurableId, 'durable-halt', 'halt with deferred input', 'halt'));
  await waitFor(() => haltDurable.aborted, 'halt did not request preflight abort');
  await haltDurable.emit('input', { source: 'extension', text: 'typed owner before halt' });
  haltDurable.setIdle(false);
  await haltDurable.emit('agent_start', {});
  assert.equal((await (await haltOwned).json()).accepted, true);
  haltDurable.setIdle(true);
  await haltDurable.emit('agent_settled', {});
  assert.equal((await (await haltControl).json()).accepted, true);
  await waitFor(() => haltDurable.shutdown, 'halt did not request shutdown');
  await haltDurable.emit('session_shutdown', { reason: 'halt' });
  const haltRestart = createHarness(extension, haltDurableId, { reason: 'resume' });
  await haltRestart.start();
  await waitFor(() => haltRestart.sent.length === 1, 'halt restart did not replay durable input');
  assert.equal(haltRestart.sent[0], 'survive explicit halt');
  await haltRestart.emit('input', { source: 'extension', text: 'survive explicit halt' });
  haltRestart.setIdle(false);
  await haltRestart.emit('agent_start', {});
  haltRestart.setIdle(true);
  await haltRestart.emit('agent_settled', {});
  await haltRestart.emit('session_shutdown', { reason: 'quit' });

  // Timeout is outcome-unknown but retains native lineage. A late start is
  // still observed, and timed-out interrupt intent is re-applied there.
  const timeoutId = 'pi-late-native-start';
  const timeoutHarness = createHarness((pi) => new PiNativeAdapter(pi, {
    home: env.GOLEM_HOME, acceptTimeoutMs: 250, controlTimeoutMs: 50,
  }).bind(), timeoutId);
  await timeoutHarness.start();
  const timeoutLease = readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json')).leases.find((row) => row.canonical_id === timeoutId);
  const timeoutTyped = postLease(timeoutLease, typedEnvelope(timeoutId, 'late-start', 'late native prompt'));
  await waitFor(() => timeoutHarness.sent.length === 1, 'late-start typed injection did not begin');
  const timeoutControl = await postLease(timeoutLease, typedEnvelope(timeoutId, 'late-interrupt', 'interrupt before late start', 'interrupt'));
  assert.equal(timeoutControl.status, 503);
  assert.equal((await (await timeoutTyped).json()).delivery_state, 'recovery_required');
  await timeoutHarness.emit('input', { source: 'extension', text: 'late native prompt' });
  timeoutHarness.setIdle(false);
  await timeoutHarness.emit('agent_start', {});
  assert.equal(timeoutHarness.aborted, true, 'timed-out interrupt is re-applied to late native start');
  timeoutHarness.setIdle(true);
  await timeoutHarness.emit('agent_settled', {});
  const timeoutRetry = await postLease(timeoutLease, typedEnvelope(timeoutId, 'late-start', 'late native prompt', 'brief', 'late-retry'));
  assert.equal((await timeoutRetry.json()).duplicate, true);
  assert.equal(timeoutHarness.sent.length, 1);
  await timeoutHarness.emit('session_shutdown', { reason: 'quit' });

  const journal = fs.readFileSync(path.join(env.GOLEM_HOME, 'journals', projectIdFor(repo), 'hook.jsonl'), 'utf8');
  assert.match(journal, /"event":"agent_start"/);
  assert.doesNotMatch(journal, /owner_token|api.key|authorization/i, 'journal contains no endpoint/auth secrets');

  // Native Pi binary proof: a local OpenAI-compatible provider holds the real
  // Pi turn open while typed delivery proves correlated acceptance, FIFO, and
  // abort settlement through Pi's actual extension events.
  let providerRequests = 0;
  const providerServer = http.createServer((request, response) => {
    providerRequests += 1;
    request.resume();
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify({
      id: 'pi-native-proof', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    })}\n\n`);
    const timer = setTimeout(() => {
      response.write(`data: ${JSON.stringify({
        id: 'pi-native-proof', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'test-model',
        choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }],
      })}\n\n`);
      response.end('data: [DONE]\n\n');
    }, 30_000);
    timer.unref?.();
    response.on('close', () => clearTimeout(timer));
  });
  await new Promise((resolve, reject) => {
    providerServer.once('error', reject);
    providerServer.listen(0, '127.0.0.1', resolve);
  });
  const providerAddress = providerServer.address();
  assert.ok(providerAddress && typeof providerAddress !== 'string');
  const providerExtension = path.join(temp, 'pi-test-provider.ts');
  fs.writeFileSync(providerExtension, `export default function (pi) {
  pi.registerProvider('golem-test', {
    baseUrl: 'http://127.0.0.1:${providerAddress.port}/v1',
    apiKey: 'test-key',
    api: 'openai-completions',
    models: [{
      id: 'test-model', name: 'Golem native proof', reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16000, maxTokens: 256
    }]
  });
}\n`);
  const nativeEnv = { ...env };
  delete nativeEnv.PI_OFFLINE;
  const native = spawn(process.execPath, [path.join(repo, 'cli/golem.js'),
    'pi', '--provider', 'golem-test', '--model', 'test-model', '--',
    '--mode', 'rpc', '--no-approve', '-e', providerExtension,
  ], { cwd: handProjectCwd, env: nativeEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let nativeErr = '';
  let nativeOut = '';
  let nativeId = null;
  native.stderr.on('data', (chunk) => { nativeErr += chunk; });
  native.stdout.on('data', (chunk) => { nativeOut += chunk; });
  try {
    const nativeFact = await waitFor(() => readJson(path.join(env.GOLEM_HOME, 'session-facts.json'))?.facts?.find((row) => (
      row.harness === 'pi' && row.provider === 'golem-test' && row.observations?.launch_nonce
    )), `native Pi did not record resolved model facts: ${nativeErr}`, 20_000);
    nativeId = nativeFact.canonical_id;
    assert.equal(nativeFact.model, 'test-model');
    assert.ok(nativeFact.locator.session_file.startsWith(path.join(env.HOME, '.pi')), 'native Pi stores the bridged session in its canonical profile');
    assert.match(nativeFact.observations.pi_version, /^\d+\.\d+\.\d+/);
    assert.equal(nativeFact.observations.extension_version, JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version);
    assert.equal(nativeFact.project_path, handProjectRoot);
    assert.equal(projectIdFor(nativeFact.project_path), handProjectId);
    const handProject = await waitFor(() => readJson(path.join(env.GOLEM_HOME, 'projects.json'))?.projects?.find((row) => row.id === handProjectId), 'hand-started Pi did not register its fresh project');
    assert.deepEqual({
      id: handProject.id,
      name: handProject.name,
      path: handProject.path,
      kind: handProject.kind,
      registered_by: handProject.registered_by,
    }, {
      id: handProjectId,
      name: path.basename(handProjectRoot),
      path: handProjectRoot,
      kind: 'auto',
      registered_by: 'hook',
    });
    assert.ok(handProject.first_seen);
    assert.ok(handProject.last_seen);
    const nativeLease = await waitFor(() => readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json'))?.leases?.find((row) => row.canonical_id === nativeId), `native Pi did not register typed lease: ${nativeErr}`, 20_000);
    const nativeStart = await postLease(nativeLease, typedEnvelope(nativeId, 'native-first', 'hold this real Pi turn open', 'brief', 'native-attempt-a'));
    const nativeStartBody = await nativeStart.json();
    assert.equal(nativeStartBody.accepted, true, `native Pi rejected typed delivery: ${JSON.stringify(nativeStartBody)} ${nativeErr}`);
    assert.equal(nativeStartBody.delivery_state, 'accepted');
    await waitFor(() => providerRequests === 1, `native Pi did not call the isolated provider: ${nativeErr}`);

    const nativeSteer = await postLease(nativeLease, typedEnvelope(nativeId, 'native-second', 'steer real Pi turn'));
    assert.equal(nativeSteer.status, 200, 'real Pi process accepts mid-turn steer while native work is active');
    const nativeSteerBody = await nativeSteer.json();
    assert.equal(nativeSteerBody.accepted, true);
    assert.equal(nativeSteerBody.delivery_state, 'accepted');
    const nativeInterrupt = await postLease(nativeLease, typedEnvelope(nativeId, 'native-interrupt', 'abort real Pi', 'interrupt'));
    assert.equal((await nativeInterrupt.json()).accepted, true, `native interrupt did not observe settlement: ${nativeErr}`);
    const nativeRecord = readJson(path.join(env.GOLEM_HOME, 'pi-workers', nativeId, 'delivery.json'));
    assert.equal(nativeRecord.inbox.deliveries.find((row) => row.envelope_id === 'native-first').lifecycle_state, 'interrupted');
    const nativeJournal = fs.readFileSync(path.join(env.GOLEM_HOME, 'journals', handProjectId, 'hook.jsonl'), 'utf8');
    assert.match(nativeJournal, new RegExp(`"event":"agent_start","session_id":"${nativeId}"`));
    assert.match(nativeJournal, new RegExp(`"event":"agent_settled","session_id":"${nativeId}"`));
  } finally {
    native.kill('SIGTERM');
    await new Promise((resolve) => {
      if (native.exitCode !== null) return resolve();
      const timeout = setTimeout(() => { native.kill('SIGKILL'); resolve(); }, 10_000);
      native.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
    providerServer.closeAllConnections?.();
    await new Promise((resolve) => providerServer.close(resolve));
  }
  assert.doesNotMatch(nativeOut, /"success":false/, `native Pi RPC reported failure: ${nativeOut}`);
  await waitFor(() => !readJson(path.join(env.GOLEM_HOME, 'endpoint-leases.json'))?.leases?.some((row) => row.canonical_id === nativeId), 'native Pi did not release endpoint lease');
  assert.ok(fs.existsSync(path.join(env.HOME, '.pi', 'agent')), 'native Pi used its canonical profile');

  const beforeRepeat = readJson(path.join(env.GOLEM_HOME, 'projects.json')).projects.find((row) => row.id === handProjectId);
  const repeated = createHarness(extension, 'pi-fresh-repeat', { cwd: handProjectCwd });
  await repeated.start();
  await repeated.emit('session_shutdown', { reason: 'quit' });
  const afterRepeat = readJson(path.join(env.GOLEM_HOME, 'projects.json')).projects.filter((row) => row.id === handProjectId);
  assert.equal(afterRepeat.length, 1, 'a second Pi session does not duplicate an existing project');
  const stableBefore = { ...beforeRepeat };
  const stableAfter = { ...afterRepeat[0] };
  delete stableBefore.last_seen;
  delete stableAfter.last_seen;
  assert.deepEqual(stableAfter, stableBefore, 'an existing project keeps its metadata on repeat registration');

  console.log('Pi native typed-worker journey passed: hand-started fresh-project registration, repeat registration, quiet lease renewal, terminal cleanup, FIFO reservation, correlated acceptance, settlement, controls, crash recovery, reload/fork identity, facts/journal, and real Pi typed delivery');
}

try {
  await main();
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
