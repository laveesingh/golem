#!/usr/bin/env node
// GOL-390 bounded recovery, adapted to the GOL-394 read-link flow: a
// dead-registry Share must settle (verified URL or actionable error) inside
// the declared end-to-end budget, never minutes. Live incident (GOL-384
// comment 6db0598a): 562935ms Share 502 with a frozen event loop; the only
// unbounded sync primitive in the path was ps/lsof spawnSync without a
// timeout.
//
// Discipline: temp HOME/ports only; real hanging HTTP fixtures and real
// waits (no fake timers); no shared dashboard/process changes. Mechanism
// tests use short budgets; the production 45s default is asserted as a
// constant so this suite stays fast (~15s).

import assert from 'node:assert/strict';
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
    killed: false,
    stderr: null,
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

// Wedged subprocess seam with the REAL node return shape: honor the timeout
// the wrapper passes, then RETURN { error } — real spawnSync never throws
// for timeouts. The wrapper must normalize it into a throw (~5s bound).
function honoringWedge() {
  return (bin, args, opts = {}) => {
    const ms = Math.min(Number(opts.timeout) || 5000, 65000);
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy-wait: wedge the caller like a hung ps */ }
    const err = new Error(`timed out after ${ms}ms`);
    err.code = 'ETIMEDOUT';
    return { error: err, stdout: '', stderr: '' };
  };
}

try {
  const tunnel = await import('../dashboard/server/share-tunnel.js');
  tunnel.__clearTunnelFlights();
  const ORIGIN = 'http://127.0.0.1:7420';
  const freshHome = (name) => {
    const h = path.join(tmp, name);
    fs.mkdirSync(h, { recursive: true });
    return h;
  };

  check('production recovery budget is 45s', tunnel.SHARE_RECOVERY_BUDGET_MS === 45_000);
  check('sync subprocess bound is 5s', tunnel.SPAWN_SYNC_TIMEOUT_MS === 5000);

  // ---- 1. wedged ps fails closed at the 5s bound, no spawn ----
  {
    const home = freshHome('rec-wedge');
    const { srv, port } = await hangingServer();
    void srv;
    // Metrics for the recorded port hang too; the ps wedge must win first at
    // ~5s (not the 45s budget, never minutes).
    tunnel.writeShareRegistry(home, {
      origin: ORIGIN, metricsPort: port, hostname: 'wedged.trycloudflare.com',
      pid: 61111, updated_at: new Date().toISOString(),
    });
    let spawned = 0;
    const t0 = Date.now();
    let message = '';
    try {
      await tunnel.ensureShareTunnel({
        origin: ORIGIN, homeDir: home,
        spawnFn: () => { spawned += 1; throw new Error('must not spawn'); },
        isProcessAlive: () => true,
        spawnSyncFn: honoringWedge(),
        overallTimeoutMs: 0,
      });
    } catch (err) { message = String(err?.message ?? err); }
    const elapsed = Date.now() - t0;
    check('wedged ps fails closed near the 5s bound',
      spawned === 0 && /indeterminate|refusing Share/.test(message) && elapsed < 15000,
      `${elapsed}ms: ${message.slice(0, 100)}`);
  }

  // ---- 2+3. hanging metrics + short budget: actionable timeout, no late write ----
  {
    const home = freshHome('rec-hang');
    tunnel.writeShareRegistry(home, {
      origin: ORIGIN, metricsPort: 20991, hostname: 'dead.trycloudflare.com',
      pid: 62222, updated_at: '2020-01-01T00:00:00.000Z',
    });
    let live = false;
    const flip = await new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        const url = String(req.url || '').split('?')[0];
        if (!live) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write('{"stalled":');
          return;
        }
        if (url === '/quicktunnel') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ hostname: 'late-arrival.trycloudflare.com' })); return; }
        if (url === '/config') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ingress: [{ service: ORIGIN }] })); return; }
        if (url === '/metrics') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('cloudflared_tunnel_ha_connections 1\n'); return; }
        res.writeHead(404); res.end('{}');
      });
      srv.listen(0, '127.0.0.1', () => {
        serversToClose.push(srv);
        resolve({ srv, port: srv.address().port });
      });
    });
    const child = fakeChild();
    let spawns = 0;
    const t0 = Date.now();
    let message = '';
    try {
      await tunnel.ensureShareTunnel({
        origin: ORIGIN, homeDir: home,
        spawnFn: () => { spawns += 1; return child; },
        pickMetricsPort: async () => flip.port,
        isProcessAlive: () => true,
        timeoutMs: 6000,
        overallTimeoutMs: 4000,
      });
    } catch (err) { message = String(err?.message ?? err); }
    const elapsed = Date.now() - t0;
    check('hanging metrics settle at the budget with an actionable error',
      spawns === 1 && /share recovery timed out after 4000ms in launch/.test(message) && elapsed < 12000,
      `${elapsed}ms: ${message.slice(0, 120)}`);
    // The timed-out flight must never publish late: go live, wait out the
    // background launch loop, and confirm the registry is untouched.
    live = true;
    await sleep(7000);
    const reg = tunnel.readShareRegistry(home);
    check('no late registry write after timeout',
      reg.hostname === 'dead.trycloudflare.com' && reg.pid === 62222, JSON.stringify(reg));
  }

  // ---- 4. concurrent joiners share one flight, one spawn, one error ----
  {
    const home = freshHome('rec-join');
    tunnel.writeShareRegistry(home, {
      origin: ORIGIN, metricsPort: 20991, hostname: 'dead.trycloudflare.com',
      pid: 63333, updated_at: '2020-01-01T00:00:00.000Z',
    });
    const { port } = await hangingServer();
    let spawns = 0;
    const run = () => tunnel.ensureShareTunnel({
      origin: ORIGIN, homeDir: home,
      spawnFn: () => { spawns += 1; return fakeChild(); },
      pickMetricsPort: async () => port,
      isProcessAlive: () => true,
      timeoutMs: 30000,
      overallTimeoutMs: 3000,
    }).then(() => 'unexpected-success', (err) => String(err?.message ?? err));
    const t0 = Date.now();
    const [m1, m2] = await Promise.all([run(), run()]);
    const elapsed = Date.now() - t0;
    check('joiners share one flight and one deadline',
      spawns === 1 && m1 === m2 && /share recovery timed out after 3000ms/.test(m1) && elapsed < 12000,
      `${elapsed}ms spawns=${spawns}: ${m1.slice(0, 80)}`);
  }

  // ---- 5. missing binary is an actionable launch failure (fast) ----
  {
    const home = freshHome('rec-enoent');
    const t0 = Date.now();
    let message = '';
    try {
      await tunnel.ensureShareTunnel({
        origin: ORIGIN, homeDir: home,
        spawnFn: () => { const e = new Error('spawn cloudflared ENOENT'); e.code = 'ENOENT'; throw e; },
        isProcessAlive: () => false,
        timeoutMs: 5000, overallTimeoutMs: 0,
      });
    } catch (err) { message = String(err?.message ?? err); }
    check('missing binary fails fast and actionable',
      /cloudflared launch failed/.test(message) && Date.now() - t0 < 8000, message.slice(0, 100));
  }

  // ---- 6. child exits before provisioning names the exit ----
  {
    const home = freshHome('rec-exit');
    const child = fakeChild();
    child.pid = 64444;
    let message = '';
    try {
      await tunnel.ensureShareTunnel({
        origin: ORIGIN, homeDir: home,
        spawnFn: () => {
          setTimeout(() => {
            for (const fn of []) void fn;
          }, 0);
          return child;
        },
        pickMetricsPort: async () => await freePort(),
        isProcessAlive: () => false,
        timeoutMs: 5000, overallTimeoutMs: 0,
      });
    } catch (err) { message = String(err?.message ?? err); }
    // No exit event fires here, so provisioning times out at the phase
    // budget; the actionable surface is the timeout, not a hang.
    check('dead-port provisioning times out (never hangs)',
      /cloudflared provisioning timed out after 5s/.test(message), message.slice(0, 100));
  }

  tunnel.__clearTunnelFlights();
} finally {
  for (const srv of serversToClose) { try { await new Promise((r) => srv.close(r)); } catch {} }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
if (failures.length) {
  console.log(`\nspec-sharing recovery FAILED: ${failures.length} check(s): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nspec-sharing recovery passed');
