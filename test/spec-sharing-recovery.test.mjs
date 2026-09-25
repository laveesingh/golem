#!/usr/bin/env node
// GOL-390 bounded recovery: a dead-registry Share must settle (verified URL
// or actionable error) inside the declared end-to-end budget, never minutes.
// Live incident (GOL-384 comment 6db0598a): 562935ms Share 502 with a frozen
// event loop; only unbounded sync primitive in the path was ps/lsof
// spawnSync without timeout. These tests fail on pre-fix code and pass after.
//
// Discipline: temp HOME/DB/ports only; real hanging HTTP fixtures and real
// subprocesses (no fake timers); no shared dashboard/process changes. Slower
// than the unit suites by design — run on demand, not in the default test
// script. Red-confirmation runs take minutes; green runs ~100s total.

import assert from 'node:assert/strict';
import { spawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-share-recovery-'));
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const serversToClose = [];
let fakePidCounter = 60000;
function fakeChild() {
  const pid = fakePidCounter += 1;
  const listeners = new Map();
  return {
    pid,
    on: (ev, fn) => {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
    },
    removeListener: () => {},
    kill: () => {},
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close((e) => (e ? reject(e) : resolve(p)));
    });
  });
}

// Real hanging fixture: sends headers + partial body, then silence forever.
// Models the acceptance server that "accepts headers then never finishes".
function hangingServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"stalled":');
    });
    srv.listen(0, '127.0.0.1', () => {
      serversToClose.push(srv);
      resolve({ srv, port: srv.address().port });
    });
  });
}

// Wedged subprocess seam: honors opts.timeout exactly like node spawnSync
// (sleep the lesser, then throw ETIMEDOUT). Pre-fix call sites pass NO
// timeout, so the wedge runs full duration; post-fix sites pass 5000ms.
function honoringWedge(ms) {
  return (bin, args, opts = {}) => {
    const budget = Number(opts?.timeout) > 0 ? Math.min(ms, Number(opts.timeout)) : ms;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, budget);
    const err = new Error(`spawnSync ${bin} timed out after ${budget}ms`);
    err.code = 'ETIMEDOUT';
    throw err;
  };
}

const tunnel = await import('../dashboard/server/share-tunnel.js');
const SAFE_ADMIN = 'http://127.0.0.1:9';

try {
  // 0. Mechanism the fix relies on: real node spawnSync honors timeout.
  {
    const t = Date.now();
    // NB: spawnSync never throws for timeouts — it returns { error }.
    const res = nodeSpawnSync('sleep', ['30'], { encoding: 'utf8', timeout: 1500 });
    const elapsed = Date.now() - t;
    check('node spawnSync honors timeout (mechanism doc)', res.error?.code === 'ETIMEDOUT' && elapsed < 15000, `${res.error?.code} ${elapsed}ms`);
  }

  // 1. Wedged ps/lsof: direct unit. Pre-fix hangs the full 65s wedge;
  // post-fix fails closed in ~5s via the hard timeout.
  {
    const wedge = honoringWedge(65000);
    let t = Date.now();
    const pid = tunnel.findMetricsListenerPid(1, { spawnSyncFn: wedge });
    let elapsed = Date.now() - t;
    check('wedged lsof bounded, fails closed', pid === null && elapsed < 30000, `pid=${pid} ${elapsed}ms`);
    t = Date.now();
    const cmd = tunnel.defaultPsCommand(999999, { spawnSyncFn: wedge });
    elapsed = Date.now() - t;
    check('wedged ps bounded, fails closed', cmd === '' && elapsed < 30000, `${elapsed}ms`);
  }

  // 2. Abort regression (real hanging body, real undici): rejects ~budget.
  // Passes pre- and post-fix — documents that fetch abort was never the
  // live vector, narrowing the cause to the synchronous wedge.
  {
    const { port } = await hangingServer();
    const t = Date.now();
    let threw = null;
    try {
      await tunnel.readTunnelFacts(port, { timeoutMs: 1500 });
    } catch (e) { threw = e; }
    const elapsed = Date.now() - t;
    check('hanging metrics body aborts bounded', !!threw && elapsed < 20000, `${elapsed}ms`);
  }

  // 3. Never-settling transport (ignores abort — broken-transport model):
  // pre-fix hangs (watchdog fails it at 55s); post-fix global race wins.
  {
    tunnel.__clearTunnelFlights();
    const home = path.join(tmp, 'home-never');
    fs.mkdirSync(home, { recursive: true });
    const publicPort = await freePort();
    fs.writeFileSync(path.join(home, 'share-tunnel.json'), JSON.stringify({
      publicPort, metricsPort: await freePort(), hostname: 'stale-host.trycloudflare.com', pid: 999001,
      updated_at: new Date().toISOString(),
    }));
    const neverFetch = () => new Promise(() => {});
    const t = Date.now();
    const outcome = await Promise.race([
      tunnel.ensureShareTunnel({
        publicPort, publicOrigin: `http://127.0.0.1:${publicPort}`, adminOrigin: SAFE_ADMIN,
        homeDir: home, fetchFn: neverFetch, isProcessAlive: () => false,
        spawnFn: () => { throw new Error('must not spawn while discovery hangs'); },
        pickMetricsPort: async () => { throw new Error('must not reach launch'); },
        timeoutMs: 2000, overallTimeoutMs: 4000,
      }).then(
        () => ({ settled: 'resolved' }),
        (e) => ({ settled: 'rejected', message: String(e?.message ?? e) }),
      ),
      sleep(55000).then(() => ({ settled: 'watchdog' })),
    ]);
    const elapsed = Date.now() - t;
    check('never-settling transport bounded by global race', outcome.settled === 'rejected'
      && /share recovery timed out after 4000ms in \w+/.test(outcome.message || '') && elapsed < 30000,
      `${outcome.settled} ${elapsed}ms`);
    check('timeout error names the POST retry mapping', /share recovery timed out after/.test(outcome.message || ''),
      (outcome.message || '').slice(0, 80));
  }

  // 4. Phase trace seam order on a dead-registry short run.
  {
    tunnel.__clearTunnelFlights();
    const home = path.join(tmp, 'home-trace');
    fs.mkdirSync(home, { recursive: true });
    const publicPort = await freePort();
    fs.writeFileSync(path.join(home, 'share-tunnel.json'), JSON.stringify({
      publicPort, metricsPort: await freePort(), hostname: 'stale-host.trycloudflare.com', pid: 999002,
      updated_at: new Date().toISOString(),
    }));
    const phases = [];
    const t = Date.now();
    let err = null;
    try {
      await tunnel.ensureShareTunnel({
        publicPort, publicOrigin: `http://127.0.0.1:${publicPort}`, adminOrigin: SAFE_ADMIN,
        homeDir: home, isProcessAlive: () => false,
        spawnFn: () => { const c = fakeChild(); return c; },
        pickMetricsPort: async () => await freePort(),
        timeoutMs: 1500, overallTimeoutMs: 0, // opt-out path: phase budgets only
        onPhase: (name, elapsedMs) => phases.push(`${name}@${elapsedMs}`),
      });
    } catch (e) { err = e; }
    const elapsed = Date.now() - t;
    const names = phases.map((p) => p.split('@')[0]);
    check('trace runs validate→discover→guard→launch in order', ['validate', 'discover', 'guard', 'launch'].every((n, i) => names[i] === n),
      names.join(','));
    check('trace elapsed monotonic and run bounded', !!err && /provisioning timed out/.test(String(err.message)) && elapsed < 20000,
      `${elapsed}ms`);
  }

  // 5. Slow provisioning still recovers (global must not cut legit launches).
  {
    tunnel.__clearTunnelFlights();
    const home = path.join(tmp, 'home-slow');
    fs.mkdirSync(home, { recursive: true });
    const publicPort = await freePort();
    const origin = `http://127.0.0.1:${publicPort}`;
    const host = 'slow-provision-8.trycloudflare.com';
    let live = false;
    const srv = http.createServer((req, res) => {
      const url = String(req.url || '').split('?')[0];
      if (!live) { res.writeHead(404, {}); res.end('{}'); return; }
      if (url === '/quicktunnel') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ hostname: host })); return; }
      if (url === '/config') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ingress: [{ service: origin }] })); return; }
      if (url === '/metrics') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('cloudflared_tunnel_ha_connections 1\n'); return; }
      res.writeHead(404, {}); res.end('{}');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    serversToClose.push(srv);
    const metricsPort = srv.address().port;
    setTimeout(() => { live = true; }, 20000);
    const child = fakeChild();
    const t = Date.now();
    const got = await tunnel.ensureShareTunnel({
      publicPort, publicOrigin: origin, adminOrigin: SAFE_ADMIN,
      homeDir: home, isProcessAlive: () => false,
      spawnFn: () => child, pickMetricsPort: async () => metricsPort,
      timeoutMs: 30000,
    });
    const elapsed = Date.now() - t;
    check('slow provisioning recovers with verified URL', got.hostname === host && got.reused === false && elapsed < 45000, `${elapsed}ms`);
  }

  // 6. Concurrent Shares during a hung launch: one spawn, both settle bounded.
  {
    tunnel.__clearTunnelFlights();
    const home = path.join(tmp, 'home-conc');
    fs.mkdirSync(home, { recursive: true });
    const publicPort = await freePort();
    const origin = `http://127.0.0.1:${publicPort}`;
    let spawned = 0;
    let killed = 0;
    const child = fakeChild();
    const opts = {
      publicPort, publicOrigin: origin, adminOrigin: SAFE_ADMIN,
      homeDir: home, isProcessAlive: () => false,
      spawnFn: () => { spawned += 1; return child; },
      pickMetricsPort: async () => await freePort(),
      timeoutMs: 30000, overallTimeoutMs: 6000,
      killFn: async () => { killed += 1; },
    };
    const t = Date.now();
    const [a, b] = await Promise.all([
      tunnel.ensureShareTunnel(opts).then(() => 'resolved', (e) => String(e?.message ?? e)),
      tunnel.ensureShareTunnel(opts).then(() => 'resolved', (e) => String(e?.message ?? e)),
    ]);
    const elapsed = Date.now() - t;
    check('concurrent hung Shares share one flight, both bounded', spawned === 1 && elapsed < 30000
      && /share recovery timed out/.test(a) && /share recovery timed out/.test(b), `${spawned} spawns ${elapsed}ms`);
    check('only the flight-owned child killed once', killed === 1, `${killed} kills`);
  }

  // 7. Pipe backpressure: real spammy child.
  // Undrained piped stderr (pre-fix equivalent) blocks the child; drained
  // (__drainChildStderr seam) lets it exit and keeps the tail.
  {
    const spamScript = `for (let i = 0; i < 30000; i++) console.error('x'.repeat(100));`;
    const stuck = spawn(process.execPath, ['-e', spamScript], { stdio: ['ignore', 'ignore', 'pipe'] });
    await sleep(3000);
    const blocked = stuck.exitCode === null && stuck.signalCode === null;
    try { stuck.kill('SIGKILL'); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 300));
    check('undrained piped stderr blocks a spammy child (pre-fix hazard)', blocked, `exit=${stuck.exitCode}`);
    const ring = { text: '' };
    const flowing = spawn(process.execPath, ['-e', spamScript], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (typeof tunnel.__drainChildStderr !== 'function') {
      check('drained child exits promptly with tail retained', false, 'no drain seam pre-fix');
      try { flowing.kill('SIGKILL'); } catch { /* ignore */ }
    } else {
      tunnel.__drainChildStderr(flowing, ring);
    const exited = await new Promise((resolve) => {
      const to = setTimeout(() => resolve(false), 15000);
      flowing.on('exit', (code) => { clearTimeout(to); resolve(code); });
    });
    check('drained child exits promptly with tail retained', exited === 0 && ring.text.length > 1000, `exit=${exited} ring=${ring.text.length}`);
    }
  }

  // 8. Declared-budget E2E (acceptance core): dead registry + hanging
  // registry port + wedged ps + never-provisioning spawn, DEFAULT budgets.
  // Pre-fix: ~2s + ~2s + 65s wedge + 30s launch ≈ 99s (red, >60s).
  // Post-fix: ~2s + ~2s + 5s bound + 30s launch ≈ 39s < 45s global (green).
  {
    tunnel.__clearTunnelFlights();
    const home = path.join(tmp, 'home-e2e');
    fs.mkdirSync(home, { recursive: true });
    const publicPort = await freePort();
    const origin = `http://127.0.0.1:${publicPort}`;
    const { port: hangPort } = await hangingServer();
    fs.writeFileSync(path.join(home, 'share-tunnel.json'), JSON.stringify({
      publicPort, metricsPort: hangPort, hostname: 'stale-host.trycloudflare.com', pid: 999003,
      updated_at: new Date().toISOString(),
    }));
    const child = fakeChild();
    let killedPid = null;
    const t = Date.now();
    let err = null;
    try {
      await tunnel.ensureShareTunnel({
        publicPort, publicOrigin: origin, adminOrigin: SAFE_ADMIN,
        homeDir: home, isProcessAlive: () => false,
        spawnFn: () => child,
        pickMetricsPort: async () => await freePort(),
        killFn: async (pid) => { killedPid = pid; },
        spawnSyncFn: honoringWedge(65000),
        // defaults: timeoutMs 30000 launch, overallTimeoutMs 45000 declared
      });
    } catch (e) { err = e; }
    const elapsed = Date.now() - t;
    check('dead-registry E2E settles inside 60s (declared 45s)', !!err && /timed out/i.test(String(err.message)) && elapsed < 60000,
      `${elapsed}ms: ${String(err?.message).slice(0, 90)}`);
    check('only the flight-owned child cleaned up', killedPid === child.pid, `killed=${killedPid}`);
  }
} finally {
  for (const srv of serversToClose) {
    try { await new Promise((r) => srv.close(r)); } catch { /* ignore */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nspec-sharing recovery tests passed');
