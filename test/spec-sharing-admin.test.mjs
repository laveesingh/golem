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
