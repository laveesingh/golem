#!/usr/bin/env node
// GOL-387 admin Share/Stop routes against an isolated dashboard (temp DB/HOME,
// ephemeral port, PATH without cloudflared so no real tunnel launches).
// Asserts: task rejected, unsafe admin tunnel blocks POST/DELETE, tunnel
// failure mints no grant (atomicity), no token in getTicket/snapshot.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-share-admin-'));
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

let dashboard = null;
const extraServers = [];
try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  // PATH without cloudflared (/opt/homebrew/bin) so Share cannot launch a
  // real tunnel; /usr/bin:/bin keeps /bin/ps for the safety probe.
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1',
    GOLEM_HOME: home, GOLEM_TRACKER_DB: path.join(tmp, 'tracker.db'),
    XDG_CONFIG_HOME: path.join(tmp, 'xdg'), HOME: home,
    GOLEM_PROJECTS_ROOT: path.join(tmp, 'projects'), GOLEM_IDEAS_ROOT: path.join(tmp, 'ideas'),
    GOLEM_ROOT: repo, LOG_LEVEL: 'error',
    PATH: '/usr/bin:/bin',
  };
  dashboard = spawn(process.execPath, [path.join(repo, 'dashboard/server/index.js')], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errText = '';
  dashboard.stderr.on('data', (c) => { errText += c; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* retry */ }
    if (dashboard.exitCode !== null) throw new Error(`dashboard exited: ${errText}`);
    await sleep(100);
  }
  check('isolated dashboard ready (no cloudflared on PATH)', true, base);

  const api = async (method, p, body = null) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  };
  // Create spec + task.
  const proj = 'share-admin-abcdef';
  let res = await api('POST', '/api/tickets', { project_id: proj, kind: 'spec', title: 'Admin spec', body: '# Body', state: 'todo' });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const spec = res.json;
  res = await api('POST', '/api/tickets', { project_id: proj, kind: 'task', title: 'Admin task', body: 't', state: 'todo' });
  assert.equal(res.status, 201);
  const task = res.json;

  // Task Share rejected before any tunnel work.
  res = await api('POST', `/api/tickets/${task.id}/share`, {});
  check('task Share 400 INELIGIBLE_KIND', res.status === 400 && res.json?.code === 'INELIGIBLE_KIND', JSON.stringify(res.json));
  res = await api('POST', `/api/tickets/${task.display_id}/share`, {});
  check('task Share by display id also 400 (canonical resolve)', res.status === 400);

  // Spec Share with no cloudflared binary: 502, and no grant minted.
  res = await api('POST', `/api/tickets/${spec.id}/share`, {});
  check('spec Share without binary 502 TUNNEL_FAILED', res.status === 502 && res.json?.code === 'TUNNEL_FAILED', JSON.stringify(res.json));
  res = await api('GET', `/api/tickets/${spec.id}/share`);
  check('failed Share mints no grant (atomicity)', res.status === 200 && res.json?.shared === false, JSON.stringify(res.json));

  // Fake unsafe tunnel targeting this temp admin port blocks POST/DELETE.
  // Bind an ephemeral metrics port (never 20241-20245: the live :7420 tunnel
  // already holds 20241) and point the temp HOME registry at it so the
  // dashboard's safety probe includes it.
  const adminOrigin = `http://127.0.0.1:${port}`;
  const unsafeSrv = http.createServer((req, res2) => {
    const url = String(req.url || '').split('?')[0];
    if (url === '/quicktunnel') { res2.writeHead(200, { 'Content-Type': 'application/json' }); res2.end(JSON.stringify({ hostname: 'unsafe-admin.trycloudflare.com' })); return; }
    if (url === '/config') { res2.writeHead(200, { 'Content-Type': 'application/json' }); res2.end(JSON.stringify({ ingress: [{ service: adminOrigin }] })); return; }
    if (url === '/metrics') { res2.writeHead(200, { 'Content-Type': 'text/plain' }); res2.end('cloudflared_tunnel_ha_connections 1\n'); return; }
    res2.writeHead(404, {}); res2.end('{}');
  });
  await new Promise((r) => unsafeSrv.listen(0, '127.0.0.1', r));
  extraServers.push(unsafeSrv);
  const unsafeMetricsPort = unsafeSrv.address().port;
  fs.writeFileSync(path.join(home, 'share-tunnel.json'), JSON.stringify({ metricsPort: unsafeMetricsPort }));
  await sleep(200);
  res = await api('POST', `/api/tickets/${spec.id}/share`, {});
  check('unsafe admin tunnel blocks POST 409', res.status === 409 && res.json?.code === 'UNSAFE_ADMIN_TUNNEL', JSON.stringify(res.json));
  res = await api('DELETE', `/api/tickets/${spec.id}/share`);
  check('unsafe admin tunnel blocks DELETE 409', res.status === 409 && res.json?.code === 'UNSAFE_ADMIN_TUNNEL', JSON.stringify(res.json));
  res = await api('GET', `/api/tickets/${spec.id}/share`);
  check('GET reports unsafe without minting', res.status === 200 && res.json?.unsafe === true && res.json?.shared === false, JSON.stringify(res.json));
  await new Promise((r) => unsafeSrv.close(r));
  extraServers.splice(extraServers.indexOf(unsafeSrv), 1);
  try { fs.rmSync(path.join(home, 'share-tunnel.json'), { force: true }); } catch {}
  await sleep(200);

  // DELETE on unshared doc is idempotent, works by display id too.
  res = await api('DELETE', `/api/tickets/${spec.display_id}/share`);
  check('DELETE unshared idempotent via display id', res.status === 200 && res.json?.revoked === false, JSON.stringify(res.json));

  // No token in ordinary surfaces.
  res = await api('GET', `/api/tickets/${spec.id}`);
  check('getTicket carries no token', res.status === 200 && !('token' in (res.json || {})) && !JSON.stringify(res.json).includes('UNSAFE'));
  res = await api('GET', '/api/snapshot');
  check('snapshot carries no token', res.status === 200 && !JSON.stringify(res.json).includes('share_grants'));
  // Unknown ticket 404s on share routes.
  res = await api('POST', '/api/tickets/TKT-missing/share', {});
  // Unsafe is gone, so this should be 404 (not 409).
  check('Share missing ticket 404', res.status === 404, JSON.stringify(res.json));

  // ---- Phase 2 (GOL-388): restart rebind + GET bearer discipline ----
  // Pre-seed a second isolated dashboard: tracker DB with a granted spec and
  // a registry recording a live fake tunnel on a reserved public port. On
  // boot the server must rebind that port so the copied link works with NO
  // fresh POST (reviewer repro: pre-fix the port stays dark). Then, with an
  // unsafe admin tunnel present, GET must omit the bearer URL (pre-fix it
  // leaks the token) while keeping the shared/unsafe flags.
  const home2 = path.join(tmp, 'home2');
  const dbPath2 = path.join(tmp, 'tracker2.db');
  for (const d of [home2, path.join(tmp, 'xdg2'), path.join(tmp, 'projects2'), path.join(tmp, 'ideas2')]) fs.mkdirSync(d, { recursive: true });
  const { openTrackerDb } = await import('../dashboard/server/tracker-db.js');
  const seedDb = openTrackerDb(dbPath2);
  const spec2 = seedDb.createTicket({ project_id: proj, kind: 'spec', title: 'Restart Doc', body: '# Restart\n\nSurvives reboot.', state: 'todo' });
  const grant2 = seedDb.createShareGrant(spec2.id);
  seedDb.close();
  const publicPort2 = await freePort();
  const publicOrigin2 = `http://127.0.0.1:${publicPort2}`;
  const host2 = 'restart-live-7.trycloudflare.com';
  const fake2 = http.createServer((req, res2) => {
    const url = String(req.url || '').split('?')[0];
    if (url === '/quicktunnel') { res2.writeHead(200, { 'Content-Type': 'application/json' }); res2.end(JSON.stringify({ hostname: host2 })); return; }
    if (url === '/config') { res2.writeHead(200, { 'Content-Type': 'application/json' }); res2.end(JSON.stringify({ ingress: [{ service: publicOrigin2 }] })); return; }
    if (url === '/metrics') { res2.writeHead(200, { 'Content-Type': 'text/plain' }); res2.end('cloudflared_tunnel_ha_connections 1\n'); return; }
    res2.writeHead(404, {}); res2.end('{}');
  });
  await new Promise((r) => fake2.listen(0, '127.0.0.1', r));
  extraServers.push(fake2);
  const metrics2 = fake2.address().port;
  // pid:null: a previously adopted entry. Startup rebind needs no validation
  // (it only binds the recorded port); the pid is filled below for the GET
  // URL path, simulating a listener verified at adoption time.
  fs.writeFileSync(path.join(home2, 'share-tunnel.json'), JSON.stringify({
    publicPort: publicPort2, metricsPort: metrics2, hostname: host2, pid: null, updated_at: new Date().toISOString(),
  }));
  const port2 = await freePort();
  const base2 = `http://127.0.0.1:${port2}`;
  let dashboard2 = spawn(process.execPath, [path.join(repo, 'dashboard/server/index.js')], {
    cwd: repo,
    env: { ...env, PORT: String(port2), GOLEM_HOME: home2, GOLEM_TRACKER_DB: dbPath2, XDG_CONFIG_HOME: path.join(tmp, 'xdg2'), HOME: home2, GOLEM_PROJECTS_ROOT: path.join(tmp, 'projects2'), GOLEM_IDEAS_ROOT: path.join(tmp, 'ideas2') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    const deadline2 = Date.now() + 25000;
    while (Date.now() < deadline2) {
      try { if ((await fetch(`${base2}/api/health`)).ok) break; } catch { /* retry */ }
      if (dashboard2.exitCode !== null) throw new Error('dashboard2 exited during restart test');
      await sleep(150);
    }
    check('restarted dashboard healthy', true, base2);
    const api2 = async (method, q, body = null) => {
      const r2 = await fetch(`${base2}${q}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r2.status, json: await r2.json().catch(() => null), text: null };
    };
    // Copied link works with NO fresh POST: the recorded public port was
    // rebound at startup and the grant survived in the DB. Connection-level
    // failure (pre-fix: nothing listens) reports as status 0, not a crash.
    const fetchPub2 = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${publicPort2}/s/${grant2.token}`);
        return { status: r.status, text: await r.text() };
      } catch { return { status: 0, text: '' }; }
    };
    const pub2 = await fetchPub2();
    check('restart rebinds recorded public port (copied link live, no POST)', pub2.status === 200, `got ${pub2.status}`);
    check('rebound reader serves granted title', pub2.text.includes('Restart Doc'));
    // A failed Share POST binds the public listener even when the tunnel
    // cannot launch (no binary on PATH): 502, grant untouched. This also
    // covers pre-fix code paths that only bind on POST, so the leak setup
    // below discriminates the GET fix independently of the rebind fix.
    res = await api2('POST', `/api/tickets/${spec2.id}/share`, {});
    check('phase-2 Share fails closed without binary', res.status === 502, JSON.stringify(res.json)?.slice(0, 100));
    // Record the (simulated verified) owner pid so GET can build the URL.
    const reg2 = JSON.parse(fs.readFileSync(path.join(home2, 'share-tunnel.json'), 'utf8'));
    reg2.pid = dashboard2.pid;
    fs.writeFileSync(path.join(home2, 'share-tunnel.json'), JSON.stringify(reg2));
    res = await api2('GET', `/api/tickets/${spec2.id}/share`);
    check('GET returns bearer URL when safe (setup can leak)', res.status === 200 && typeof res.json?.url === 'string' && res.json.url.includes(grant2.token), JSON.stringify(res.json)?.slice(0, 120));
    // Unsafe admin tunnel on a probed default port: GET must omit the URL
    // and the token must appear nowhere in the response body.
    const adminOrigin2 = `http://127.0.0.1:${port2}`;
    const occupyUnsafe = async () => {
      for (const p of [20244, 20242, 20243, 20245]) {
        const srv = http.createServer((req, res2) => {
          const url = String(req.url || '').split('?')[0];
          if (url === '/quicktunnel') { res2.writeHead(200, { 'Content-Type': 'application/json' }); res2.end(JSON.stringify({ hostname: 'cutover-hole.trycloudflare.com' })); return; }
          if (url === '/config') { res2.writeHead(200, { 'Content-Type': 'application/json' }); res2.end(JSON.stringify({ ingress: [{ service: adminOrigin2 }] })); return; }
          if (url === '/metrics') { res2.writeHead(200, { 'Content-Type': 'text/plain' }); res2.end('cloudflared_tunnel_ha_connections 1\n'); return; }
          res2.writeHead(404, {}); res2.end('{}');
        });
        try {
          await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(p, '127.0.0.1', resolve); });
          return srv;
        } catch { /* held: try next */ }
      }
      throw new Error('no free default metrics port for unsafe GET test');
    };
    const unsafe2 = await occupyUnsafe();
    extraServers.push(unsafe2);
    await sleep(300);
    const raw2 = await fetch(`${base2}/api/tickets/${spec2.id}/share`);
    const body2 = await raw2.text();
    let json2 = null;
    try { json2 = JSON.parse(body2); } catch { json2 = null; }
    check('GET omits bearer URL while unsafe', raw2.status === 200 && json2 && json2.url === null && json2.unsafe === true && json2.shared === true, body2.slice(0, 160));
    check('no token bytes leak via unsafe GET', !body2.includes(grant2.token));
    await new Promise((r) => unsafe2.close(r));
    extraServers.splice(extraServers.indexOf(unsafe2), 1);
  } finally {
    if (dashboard2 && dashboard2.exitCode === null) {
      dashboard2.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 800));
      if (dashboard2.exitCode === null) dashboard2.kill('SIGKILL');
    }
  }
} finally {
  for (const s of extraServers) { try { await new Promise((r) => s.close(r)); } catch {} }
  if (dashboard && dashboard.exitCode === null) {
    dashboard.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 800));
    if (dashboard.exitCode === null) dashboard.kill('SIGKILL');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nspec-sharing admin routes passed');
