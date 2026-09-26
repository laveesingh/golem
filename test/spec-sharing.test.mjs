#!/usr/bin/env node
// GOL-394 minimal read-link share: supervisor unit tests (fakes only) + share
// route tests against an isolated dashboard with a fake `cloudflared` on PATH.
// No shared state: temp HOME/GOLEM_HOME, temp tracker DB, ephemeral ports.
// Never touches :7420, ~/.golem/share-tunnel.json, or any real cloudflared.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-share-'));
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const serversToClose = [];
let dashboard = null;

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

function startHttp(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      serversToClose.push(srv);
      resolve({ srv, port: srv.address().port });
    });
  });
}

// Fake cloudflared metrics server: serves /quicktunnel, /config, /metrics.
function startFakeMetrics({ hostname, service, haConnections = 1 }) {
  return startHttp((req, res) => {
    const url = String(req.url || '').split('?')[0];
    if (url === '/quicktunnel') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hostname }));
      return;
    }
    if (url === '/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ingress: [{ service }, { service: 'http_status:404' }] }));
      return;
    }
    if (url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`# HELP cloudflared_tunnel_ha_connections\ncloudflared_tunnel_ha_connections ${haConnections}\n`);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
}

let fakePidCounter = 50000;
function fakeChild() {
  const pid = fakePidCounter += 1;
  const listeners = new Map();
  return {
    pid,
    stderr: null,
    on: (ev, fn) => {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
    },
    removeListener: () => {},
    kill: () => {},
  };
}

const tunnelCmd = (origin, metricsPort) =>
  `cloudflared tunnel --url ${origin} --metrics 127.0.0.1:${metricsPort}`;

try {
  const tunnel = await import('../dashboard/server/share-tunnel.js');
  tunnel.__clearTunnelFlights();
  const ORIGIN = 'http://127.0.0.1:7420';
  const HOST = 'alpha-quick-tunnel-1.trycloudflare.com';

  const freshHome = (name) => {
    const h = path.join(tmp, name);
    fs.mkdirSync(h, { recursive: true });
    return h;
  };
  const writeReg = (home, doc) => tunnel.writeShareRegistry(home, doc);

  // ---- 1. healthy owned tunnel reused, no spawn ----
  {
    const home = freshHome('home-reuse');
    const { port: metrics } = await startFakeMetrics({ hostname: HOST, service: ORIGIN, haConnections: 1 });
    writeReg(home, { origin: ORIGIN, metricsPort: metrics, hostname: HOST, pid: 999001, updated_at: new Date().toISOString() });
    let spawned = 0;
    const out = await tunnel.ensureShareTunnel({
      origin: ORIGIN, homeDir: home,
      spawnFn: () => { spawned += 1; throw new Error('must not spawn'); },
      isProcessAlive: (pid) => pid === 999001,
      psCommandFn: async (pid) => (pid === 999001 ? tunnelCmd(ORIGIN, metrics) : ''),
    });
    check('healthy owned tunnel reused, no spawn', out.reused === true && out.hostname === HOST && spawned === 0);
  }

  // ---- 2. hostname rotation adopted without spawn ----
  {
    const home = freshHome('home-rotate');
    const host2 = 'rotated-host-2.trycloudflare.com';
    const { port: metrics } = await startFakeMetrics({ hostname: host2, service: ORIGIN, haConnections: 2 });
    writeReg(home, { origin: ORIGIN, metricsPort: metrics, hostname: HOST, pid: 999002, updated_at: new Date().toISOString() });
    let spawned = 0;
    const out = await tunnel.ensureShareTunnel({
      origin: ORIGIN, homeDir: home,
      spawnFn: () => { spawned += 1; throw new Error('must not spawn'); },
      isProcessAlive: (pid) => pid === 999002,
      psCommandFn: async (pid) => (pid === 999002 ? tunnelCmd(ORIGIN, metrics) : ''),
    });
    const reg = tunnel.readShareRegistry(home);
    check('changed hostname adopted without spawn', out.hostname === host2 && out.reused === true && spawned === 0 && reg.hostname === host2);
  }

  // ---- 3. dead pid launches exactly one child ----
  {
    const home = freshHome('home-dead');
    writeReg(home, { origin: ORIGIN, metricsPort: 20991, hostname: 'stale-host.trycloudflare.com', pid: 111111, updated_at: '2020-01-01T00:00:00.000Z' });
    const hostB = 'fresh-launch-3.trycloudflare.com';
    const { port: liveMetrics } = await startFakeMetrics({ hostname: hostB, service: ORIGIN, haConnections: 1 });
    const child = fakeChild();
    let spawns = 0;
    const out = await tunnel.ensureShareTunnel({
      origin: ORIGIN, homeDir: home,
      spawnFn: () => { spawns += 1; return child; },
      pickMetricsPort: async () => liveMetrics,
      isProcessAlive: () => true,
      psCommandFn: async () => tunnelCmd(ORIGIN, liveMetrics),
      timeoutMs: 8000, overallTimeoutMs: 0,
    });
    check('dead pid launches exactly one child', spawns === 1 && out.reused === false && out.hostname === hostB && out.pid === child.pid);
  }

  // ---- 4. same-origin foreign tunnel: never reused, never stopped ----
  {
    const home = freshHome('home-foreign');
    // A live tunnel for our origin exists, but there is no registry: it is
    // someone else's. ensure must not even probe it (no discovery) and must
    // launch its own beside it.
    const { port: foreignMetrics } = await startFakeMetrics({ hostname: 'foreign-owner.trycloudflare.com', service: ORIGIN, haConnections: 1 });
    void foreignMetrics;
    const hostOurs = 'ours-beside-4.trycloudflare.com';
    const { port: liveMetrics } = await startFakeMetrics({ hostname: hostOurs, service: ORIGIN, haConnections: 1 });
    const child = fakeChild();
    let spawns = 0;
    const kills = [];
    const out = await tunnel.ensureShareTunnel({
      origin: ORIGIN, homeDir: home,
      spawnFn: () => { spawns += 1; return child; },
      pickMetricsPort: async () => liveMetrics,
      isProcessAlive: () => true,
      psCommandFn: async () => tunnelCmd(ORIGIN, liveMetrics),
      killFn: async (pid, sig) => { kills.push([pid, sig]); },
      timeoutMs: 8000, overallTimeoutMs: 0,
    });
    const reg = tunnel.readShareRegistry(home);
    check('foreign same-origin tunnel ignored, own launched beside it',
      spawns === 1 && kills.length === 0 && out.hostname === hostOurs && reg.pid === child.pid && reg.origin === ORIGIN);
  }

  // ---- 4b. valid metrics but unowned pid: launch beside, no kill ----
  {
    const home = freshHome('home-unowned');
    const { port: metrics } = await startFakeMetrics({ hostname: HOST, service: ORIGIN, haConnections: 1 });
    writeReg(home, { origin: ORIGIN, metricsPort: metrics, hostname: HOST, pid: 999004, updated_at: new Date().toISOString() });
    const hostNew = 'replaced-unowned-4b.trycloudflare.com';
    const { port: liveMetrics } = await startFakeMetrics({ hostname: hostNew, service: ORIGIN, haConnections: 1 });
    const child = fakeChild();
    let spawns = 0;
    const kills = [];
    const out = await tunnel.ensureShareTunnel({
      origin: ORIGIN, homeDir: home,
      spawnFn: () => { spawns += 1; return child; },
      pickMetricsPort: async () => liveMetrics,
      isProcessAlive: () => true,
      // Recorded pid is some other owner's tunnel: command targets elsewhere.
      psCommandFn: async () => 'cloudflared tunnel --url http://127.0.0.1:8765',
      killFn: async (pid, sig) => { kills.push([pid, sig]); },
      timeoutMs: 8000, overallTimeoutMs: 0,
    });
    check('unowned record never killed, fresh tunnel launched', spawns === 1 && kills.length === 0 && out.pid === child.pid);
  }

  // ---- 4c. R8: same origin but a different metrics port is NOT owned ----
  // (review GOL-394 #1: a stale PID reused by another cloudflared for the
  // same dashboard must be neither reused nor stopped).
  {
    const home = freshHome('home-wrong-metrics');
    const { port: metrics } = await startFakeMetrics({ hostname: HOST, service: ORIGIN, haConnections: 1 });
    const pid = 999014;
    const alive = new Set([pid]);
    writeReg(home, { origin: ORIGIN, metricsPort: metrics, hostname: HOST, pid, updated_at: new Date().toISOString() });
    const psWrong = async () => `cloudflared tunnel --url ${ORIGIN} --metrics 127.0.0.1:29999`;
    const kills = [];
    const killFn = async (p, sig) => { kills.push(sig); };
    let threw = '';
    try {
      await tunnel.stopOwnedTunnel(home, ORIGIN, {
        isProcessAlive: (p) => alive.has(p),
        psCommandFn: psWrong,
        killFn,
      });
    } catch (err) { threw = String(err?.message ?? err); }
    check('stop refuses same-origin wrong-metrics pid',
      /ownership unproven/.test(threw) && kills.length === 0 && alive.has(pid)
      && tunnel.readShareRegistry(home).pid === pid);
    const hostNew = 'replaced-wrong-metrics-4c.trycloudflare.com';
    const { port: liveMetrics } = await startFakeMetrics({ hostname: hostNew, service: ORIGIN, haConnections: 1 });
    const child = fakeChild();
    let spawns = 0;
    const out = await tunnel.ensureShareTunnel({
      origin: ORIGIN, homeDir: home,
      spawnFn: () => { spawns += 1; return child; },
      pickMetricsPort: async () => liveMetrics,
      isProcessAlive: (p) => alive.has(p) || p === child.pid,
      psCommandFn: psWrong,
      killFn,
      timeoutMs: 8000, overallTimeoutMs: 0,
    });
    check('same-origin wrong-metrics pid never reused, launched beside',
      spawns === 1 && kills.length === 0 && out.pid === child.pid && out.hostname === hostNew && alive.has(pid));
  }

  // ---- 5. R5 migration: stale legacy registry, owned -> stopped + fresh ----
  {
    const home = freshHome('home-migrate-owned');
    const staleOrigin = 'http://127.0.0.1:61961';
    const oldPid = 999005;
    const alive = new Set([oldPid]);
    writeReg(home, { publicPort: 61961, metricsPort: 20991, hostname: 'old-host.trycloudflare.com', pid: oldPid, updated_at: '2020-01-01T00:00:00.000Z' });
    const hostNew = 'migrated-fresh-5.trycloudflare.com';
    const { port: liveMetrics } = await startFakeMetrics({ hostname: hostNew, service: ORIGIN, haConnections: 1 });
    const child = fakeChild();
    let spawns = 0;
    const kills = [];
    const out = await tunnel.ensureShareTunnel({
      origin: ORIGIN, homeDir: home,
      spawnFn: () => { spawns += 1; return child; },
      pickMetricsPort: async () => liveMetrics,
      isProcessAlive: (pid) => alive.has(pid),
      psCommandFn: async (pid) => (pid === oldPid ? tunnelCmd(staleOrigin, 20991) : tunnelCmd(ORIGIN, liveMetrics)),
      killFn: async (pid, sig) => { kills.push(sig); if (sig === 'SIGTERM') alive.delete(pid); },
      timeoutMs: 8000, overallTimeoutMs: 0,
      stopPollMs: 10,
    });
    const reg = tunnel.readShareRegistry(home);
    check('stale owned tunnel stopped, fresh started',
      kills.includes('SIGTERM') && !alive.has(oldPid) && spawns === 1 && out.hostname === hostNew && reg.origin === ORIGIN && reg.pid === child.pid);
  }

  // ---- 6. R5 migration: stale unowned -> no kill, still start fresh ----
  {
    const home = freshHome('home-migrate-foreign');
    const oldPid = 999006;
    const alive = new Set([oldPid]);
    writeReg(home, { publicPort: 61961, metricsPort: 20991, hostname: 'old-host.trycloudflare.com', pid: oldPid, updated_at: '2020-01-01T00:00:00.000Z' });
    const hostNew = 'migrated-beside-6.trycloudflare.com';
    const { port: liveMetrics } = await startFakeMetrics({ hostname: hostNew, service: ORIGIN, haConnections: 1 });
    const child = fakeChild();
    let spawns = 0;
    const kills = [];
    const out = await tunnel.ensureShareTunnel({
      origin: ORIGIN, homeDir: home,
      spawnFn: () => { spawns += 1; return child; },
      pickMetricsPort: async () => liveMetrics,
      isProcessAlive: (pid) => alive.has(pid),
      // Unknown owner's process (e.g. pid 16776 pattern): never touch it.
      psCommandFn: async () => 'cloudflared tunnel --url http://127.0.0.1:8765',
      killFn: async (pid, sig) => { kills.push(sig); },
      timeoutMs: 8000, overallTimeoutMs: 0,
    });
    check('stale foreign process left alone, fresh started',
      kills.length === 0 && alive.has(oldPid) && spawns === 1 && out.hostname === hostNew);
  }

  // ---- 7. owned-but-disconnected: stopped under contract, then relaunched ----
  {
    const home = freshHome('home-replace');
    const oldPid = 999007;
    const alive = new Set([oldPid]);
    const { port: deadMetrics } = await startFakeMetrics({ hostname: HOST, service: ORIGIN, haConnections: 0 });
    writeReg(home, { origin: ORIGIN, metricsPort: deadMetrics, hostname: HOST, pid: oldPid, updated_at: new Date().toISOString() });
    const hostNew = 'replaced-disconnected-7.trycloudflare.com';
    const { port: liveMetrics } = await startFakeMetrics({ hostname: hostNew, service: ORIGIN, haConnections: 1 });
    const child = fakeChild();
    let spawns = 0;
    const kills = [];
    const out = await tunnel.ensureShareTunnel({
      origin: ORIGIN, homeDir: home,
      spawnFn: () => { spawns += 1; return child; },
      pickMetricsPort: async () => liveMetrics,
      isProcessAlive: (pid) => alive.has(pid) || pid === child.pid,
      psCommandFn: async (pid) => (pid === oldPid ? tunnelCmd(ORIGIN, deadMetrics) : tunnelCmd(ORIGIN, liveMetrics)),
      killFn: async (pid, sig) => { kills.push(sig); if (pid === oldPid && sig === 'SIGTERM') alive.delete(pid); },
      timeoutMs: 8000, overallTimeoutMs: 0,
      stopPollMs: 10,
    });
    check('owned-but-disconnected stopped then relaunched',
      kills.includes('SIGTERM') && !alive.has(oldPid) && spawns === 1 && out.hostname === hostNew);
  }

  // ---- 8/9. stop with missing / dead pid -> already_stopped + cleared ----
  {
    const home = freshHome('home-stop-missing');
    writeReg(home, { origin: ORIGIN, metricsPort: 20991, hostname: HOST });
    const out = await tunnel.stopOwnedTunnel(home, ORIGIN, { isProcessAlive: () => false });
    check('stop with missing pid clears + already_stopped',
      out.already_stopped === true && Object.keys(tunnel.readShareRegistry(home) || {}).length === 0);
    const home2 = freshHome('home-stop-dead');
    writeReg(home2, { origin: ORIGIN, metricsPort: 20991, hostname: HOST, pid: 999009 });
    const out2 = await tunnel.stopOwnedTunnel(home2, ORIGIN, { isProcessAlive: () => false });
    check('stop with dead pid clears + already_stopped',
      out2.already_stopped === true && Object.keys(tunnel.readShareRegistry(home2) || {}).length === 0);
  }

  // ---- 10. stop owned: SIGTERM exits, no SIGKILL, registry cleared ----
  {
    const home = freshHome('home-stop-term');
    const pid = 999010;
    const alive = new Set([pid]);
    const { port: metrics } = await startFakeMetrics({ hostname: HOST, service: ORIGIN, haConnections: 1 });
    writeReg(home, { origin: ORIGIN, metricsPort: metrics, hostname: HOST, pid, updated_at: new Date().toISOString() });
    const kills = [];
    const out = await tunnel.stopOwnedTunnel(home, ORIGIN, {
      isProcessAlive: (p) => alive.has(p),
      psCommandFn: async () => tunnelCmd(ORIGIN, metrics),
      killFn: async (p, sig) => { kills.push(sig); if (sig === 'SIGTERM') alive.delete(p); },
      stopPollMs: 10,
    });
    check('stop owned exits on SIGTERM, registry cleared',
      out.stopped === true && kills.join(',') === 'SIGTERM' && Object.keys(tunnel.readShareRegistry(home) || {}).length === 0);
  }

  // ---- 11. SIGTERM ignored -> SIGKILL path ----
  {
    const home = freshHome('home-stop-kill');
    const pid = 999011;
    const alive = new Set([pid]);
    const { port: metrics } = await startFakeMetrics({ hostname: HOST, service: ORIGIN, haConnections: 1 });
    writeReg(home, { origin: ORIGIN, metricsPort: metrics, hostname: HOST, pid, updated_at: new Date().toISOString() });
    const kills = [];
    const out = await tunnel.stopOwnedTunnel(home, ORIGIN, {
      isProcessAlive: (p) => alive.has(p),
      psCommandFn: async () => tunnelCmd(ORIGIN, metrics),
      killFn: async (p, sig) => { kills.push(sig); if (sig === 'SIGKILL') alive.delete(p); },
      stopTermMs: 120, stopKillMs: 2000, stopPollMs: 10,
    });
    check('SIGTERM ignored escalates to SIGKILL and stops',
      out.stopped === true && kills[0] === 'SIGTERM' && kills.includes('SIGKILL'));
  }

  // ---- 12. kill that never exits -> STOP_UNCONFIRMED, registry kept ----
  {
    const home = freshHome('home-stop-unconfirmed');
    const pid = 999012;
    writeReg(home, { origin: ORIGIN, metricsPort: 20991, hostname: HOST, pid, updated_at: new Date().toISOString() });
    const kills = [];
    let code = null;
    try {
      await tunnel.stopOwnedTunnel(home, ORIGIN, {
        isProcessAlive: () => true,
        psCommandFn: async () => tunnelCmd(ORIGIN, 20991),
        killFn: async (p, sig) => { kills.push(sig); },
        stopTermMs: 120, stopKillMs: 100, stopPollMs: 10,
      });
    } catch (err) { code = err?.code; }
    const reg = tunnel.readShareRegistry(home);
    check('unconfirmed exit keeps registry with STOP_UNCONFIRMED',
      code === 'STOP_UNCONFIRMED' && kills.includes('SIGTERM') && kills.includes('SIGKILL') && reg.pid === pid);
  }

  // ---- 13. live pid, wrong command -> refused, nothing killed ----
  {
    const home = freshHome('home-stop-foreign');
    const pid = 999013;
    writeReg(home, { origin: ORIGIN, metricsPort: 20991, hostname: HOST, pid, updated_at: new Date().toISOString() });
    const kills = [];
    let threw = '';
    try {
      await tunnel.stopOwnedTunnel(home, ORIGIN, {
        isProcessAlive: () => true,
        psCommandFn: async () => 'cloudflared tunnel --url http://127.0.0.1:8765',
        killFn: async (p, sig) => { kills.push(sig); },
      });
    } catch (err) { threw = String(err?.message ?? err); }
    check('foreign live pid refused, registry kept',
      /ownership unproven/.test(threw) && kills.length === 0 && tunnel.readShareRegistry(home).pid === pid);
  }

  // ---- 14. R9: Stop cancels an in-flight Share; the spawned child is ----
  // killed and exit-confirmed, the Share reports SHARE_STOPPED, never a URL.
  {
    const home = freshHome('home-stop-cancels');
    // No registry yet; metrics hang (dead port) so ensure sits provisioning.
    const deadPort = await freePort();
    const child = fakeChild();
    const alive = new Set([child.pid]);
    const events = [];
    const ensureP = tunnel.ensureShareTunnel({
      origin: ORIGIN, homeDir: home,
      spawnFn: () => { events.push('spawn'); return child; },
      pickMetricsPort: async () => deadPort,
      isProcessAlive: (p) => alive.has(p),
      psCommandFn: async () => tunnelCmd(ORIGIN, deadPort),
      timeoutMs: 8000, overallTimeoutMs: 0,
    });
    await sleep(100); // let the Share spawn and enter provisioning
    const stopP = tunnel.stopOwnedTunnel(home, ORIGIN, {
      isProcessAlive: (p) => alive.has(p),
      psCommandFn: async () => tunnelCmd(ORIGIN, deadPort),
      killFn: async (p, sig) => { events.push(`kill:${sig}`); alive.delete(p); },
      stopPollMs: 10,
    });
    const [ensured, stopped] = await Promise.allSettled([ensureP, stopP]);
    check('in-flight Share cancelled with SHARE_STOPPED, spawned child killed',
      ensured.status === 'rejected' && ensured.reason?.code === 'SHARE_STOPPED'
      && events[0] === 'spawn' && events.includes('kill:SIGTERM') && !alive.has(child.pid)
      && stopped.status === 'fulfilled' && stopped.value.already_stopped === true);
    const reg = tunnel.readShareRegistry(home);
    check('cancelled Share writes no registry', !reg || !reg.hostname);
  }

  // ---- 15. R9: a Share waiting on Stop is cancelled, never spawns ----
  {
    const home = freshHome('home-waiting-cancelled');
    const pid = 999015;
    const alive = new Set([pid]);
    const { port: metrics } = await startFakeMetrics({ hostname: HOST, service: ORIGIN, haConnections: 1 });
    writeReg(home, { origin: ORIGIN, metricsPort: metrics, hostname: HOST, pid, updated_at: new Date().toISOString() });
    const events = [];
    const stopP = tunnel.stopOwnedTunnel(home, ORIGIN, {
      isProcessAlive: (p) => alive.has(p),
      psCommandFn: async () => tunnelCmd(ORIGIN, metrics),
      killFn: async (p, sig) => { events.push(`stop:${sig}`); await sleep(400); alive.delete(p); },
      stopPollMs: 10,
    });
    await sleep(50);
    let spawns = 0;
    const ensureP = tunnel.ensureShareTunnel({
      origin: ORIGIN, homeDir: home,
      spawnFn: () => { spawns += 1; events.push('spawn'); return fakeChild(); },
      pickMetricsPort: async () => metrics,
      isProcessAlive: (p) => alive.has(p),
      psCommandFn: async () => tunnelCmd(ORIGIN, metrics),
      timeoutMs: 8000, overallTimeoutMs: 0,
    });
    const [stopped, ensured] = await Promise.allSettled([stopP, ensureP]);
    check('waiting Share cancelled with SHARE_STOPPED and never spawns',
      stopped.status === 'fulfilled' && stopped.value.stopped === true
      && ensured.status === 'rejected' && ensured.reason?.code === 'SHARE_STOPPED' && spawns === 0);
  }

  // ---- 16. R9 fence: timeout before spawn -> no spawn ever, no write ----
  {
    const home = freshHome('home-fence-prespawn');
    let spawns = 0;
    let message = '';
    let code = null;
    try {
      await tunnel.ensureShareTunnel({
        origin: ORIGIN, homeDir: home,
        spawnFn: () => { spawns += 1; return fakeChild(); },
        // Port selection lands after the 40ms budget: the reviewer probe shape.
        pickMetricsPort: async () => { await sleep(180); return await freePort(); },
        isProcessAlive: () => false,
        timeoutMs: 8000, overallTimeoutMs: 40,
      });
    } catch (err) { message = String(err?.message ?? err); code = err?.code; }
    check('budget timeout before spawn settles fast', /share recovery timed out after 40ms/.test(message) && !code);
    await sleep(400); // past the delayed port selection
    check('fenced flight never spawns after timeout', spawns === 0);
    const reg = tunnel.readShareRegistry(home);
    check('fenced flight never writes the registry', !reg || !reg.hostname);
  }

  // ---- 17. R9 fence: timeout after spawn -> child killed + confirmed ----
  {
    const home = freshHome('home-fence-postspawn');
    const { port } = await startHttp(() => { /* hang forever: headers never sent */ });
    const child = fakeChild();
    const alive = new Set([child.pid]);
    const kills = [];
    let message = '';
    try {
      await tunnel.ensureShareTunnel({
        origin: ORIGIN, homeDir: home,
        spawnFn: () => child,
        pickMetricsPort: async () => port,
        isProcessAlive: (p) => alive.has(p),
        killFn: async (p, sig) => { kills.push(sig); alive.delete(p); },
        timeoutMs: 30000, overallTimeoutMs: 300,
        stopTermMs: 200, stopKillMs: 100, stopPollMs: 10,
      });
    } catch (err) { message = String(err?.message ?? err); }
    check('budget timeout after spawn settles', /share recovery timed out after 300ms/.test(message));
    await sleep(800); // fence TERM + background exit-confirm
    check('pre-fence child killed and exit-confirmed', kills.includes('SIGTERM') && !alive.has(child.pid), kills.join(','));
    const reg = tunnel.readShareRegistry(home);
    check('fenced flight never writes the registry', !reg || !reg.hostname);
  }

  tunnel.__clearTunnelFlights();

  // ---- routes: isolated dashboard + fake cloudflared on PATH ----
  const fakeBin = path.join(tmp, 'fakebin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeCloudflared = path.join(fakeBin, 'cloudflared');
  fs.writeFileSync(fakeCloudflared, `#!${process.execPath}
const http = require('node:http');
const args = process.argv.slice(2);
const ui = args.indexOf('--url');
const mi = args.indexOf('--metrics');
const url = ui >= 0 ? args[ui + 1] : 'http://127.0.0.1:0';
const metrics = mi >= 0 ? args[mi + 1] : '127.0.0.1:0';
const mhost = String(metrics).split(':')[0] || '127.0.0.1';
const mport = Number(String(metrics).split(':').pop());
const hostname = process.env.FAKE_TUNNEL_HOST || 'golem-share-test.trycloudflare.com';
const srv = http.createServer((req, res) => {
  const u = String(req.url || '').split('?')[0];
  if (u === '/quicktunnel') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ hostname })); return; }
  if (u === '/config') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ingress: [{ service: url }, { service: 'http_status:404' }] })); return; }
  if (u === '/metrics') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('cloudflared_tunnel_ha_connections 1\\n'); return; }
  res.writeHead(404); res.end('{}');
});
srv.listen(mport, mhost);
`);
  fs.chmodSync(fakeCloudflared, 0o755);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const home = path.join(tmp, 'home-routes');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1',
    GOLEM_HOME: home, GOLEM_TRACKER_DB: path.join(tmp, 'tracker.db'),
    XDG_CONFIG_HOME: path.join(tmp, 'xdg'), HOME: home,
    GOLEM_PROJECTS_ROOT: path.join(tmp, 'projects'), GOLEM_IDEAS_ROOT: path.join(tmp, 'ideas'),
    GOLEM_ROOT: repo, LOG_LEVEL: 'error',
    PATH: `${fakeBin}:/usr/bin:/bin`,
  };
  dashboard = spawn(process.execPath, [path.join(repo, 'dashboard/server/index.js')], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errText = '';
  dashboard.stderr.on('data', (c) => { errText += c; });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* retry */ }
    if (dashboard.exitCode !== null) throw new Error(`dashboard exited: ${errText}`);
    await sleep(150);
  }
  check('isolated dashboard ready (fake cloudflared on PATH)', true);

  const api = async (method, p, body = null) => {
    const res = await fetch(`${base}${p}`, {
      method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  };
  let res = await api('POST', '/api/tickets', { project_id: 'share-test-abcdef', kind: 'spec', title: 'Route spec', body: '# Body', state: 'todo' });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const spec = res.json;
  res = await api('POST', '/api/tickets', { project_id: 'share-test-abcdef', kind: 'task', title: 'Route task', body: 't', state: 'todo' });
  assert.equal(res.status, 201);
  const task = res.json;

  // Task kind refused everywhere it matters.
  res = await api('POST', `/api/tickets/${task.id}/share`);
  check('POST task refused INELIGIBLE_KIND', res.status === 400 && res.json?.code === 'INELIGIBLE_KIND', JSON.stringify(res.json));
  res = await api('GET', `/api/tickets/${task.id}/share`);
  check('GET task not shareable', res.status === 200 && res.json?.shareable === false && res.json?.url === null, JSON.stringify(res.json));
  res = await api('GET', '/api/tickets/TKT-missing/share');
  check('GET missing 404', res.status === 404);

  // Spec share: read link through the fake tunnel.
  res = await api('POST', `/api/tickets/${spec.display_id}/share`);
  check('POST spec returns /read/ link', res.status === 200
    && res.json?.url === `https://${res.json?.hostname}/read/${spec.display_id}`
    && /[a-z0-9-]+\.trycloudflare\.com/.test(res.json?.hostname ?? ''), JSON.stringify(res.json));
  const firstHost = res.json?.hostname;
  res = await api('GET', `/api/tickets/${spec.id}/share`);
  check('GET reports active with url', res.status === 200 && res.json?.shareable === true
    && res.json?.active === true && (res.json?.url ?? '').endsWith(`/read/${spec.display_id}`), JSON.stringify(res.json));
  // Second Share reuses the same host.
  res = await api('POST', `/api/tickets/${spec.id}/share`);
  check('repeat Share reuses the host', res.status === 200 && res.json?.hostname === firstHost, JSON.stringify(res.json));

  // Stop ends every link at once.
  res = await api('DELETE', `/api/tickets/${spec.id}/share`);
  check('DELETE stops the tunnel', res.status === 200 && res.json?.stopped === true, JSON.stringify(res.json));
  res = await api('GET', `/api/tickets/${spec.id}/share`);
  check('GET inactive after stop', res.status === 200 && res.json?.active === false && res.json?.url === null, JSON.stringify(res.json));
  res = await api('DELETE', `/api/tickets/${spec.id}/share`);
  check('second DELETE already_stopped', res.status === 200 && res.json?.already_stopped === true, JSON.stringify(res.json));

  // R5 migration at route level: legacy publicPort registry with a dead pid.
  const legacyReg = {
    publicPort: 61961, metricsPort: 20991, hostname: 'old-host.trycloudflare.com',
    pid: 987654, updated_at: '2020-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(home, 'share-tunnel.json'), JSON.stringify(legacyReg));
  res = await api('POST', `/api/tickets/${spec.id}/share`);
  check('stale legacy registry migrates to a fresh tunnel', res.status === 200 && /\/read\//.test(res.json?.url ?? ''), JSON.stringify(res.json));
  const migrated = JSON.parse(fs.readFileSync(path.join(home, 'share-tunnel.json'), 'utf8'));
  check('migrated registry carries the dashboard origin', migrated.origin === `http://127.0.0.1:${port}` && Number.isInteger(migrated.pid));
  // Clean up the migrated tunnel so no fake cloudflared lingers.
  res = await api('DELETE', `/api/tickets/${spec.id}/share`);
  check('migrated tunnel stops cleanly', res.status === 200 && res.json?.stopped === true, JSON.stringify(res.json));
} finally {
  if (dashboard && dashboard.exitCode === null) {
    dashboard.kill('SIGTERM');
    await Promise.race([new Promise((r) => dashboard.on('exit', r)), sleep(3000)]);
    if (dashboard.exitCode === null) dashboard.kill('SIGKILL');
  }
  for (const srv of serversToClose) { try { await new Promise((r) => srv.close(r)); } catch {} }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
if (failures.length) {
  console.log(`\nspec-sharing FAILED: ${failures.length} check(s): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nspec-sharing passed');
