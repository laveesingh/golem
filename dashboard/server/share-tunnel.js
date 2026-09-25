// GOL-384 managed quick-tunnel supervisor: reuse one verified cloudflared
// quick tunnel for public document sharing, never the admin dashboard tunnel.
// All process/port effects are injectable for isolated tests; production wires
// the real spawn/fetch/kill. Never rely on /ready (GOL-385 false-negative).

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn as nodeSpawn } from 'node:child_process';
import { spawnSync as nodeSpawnSync } from 'node:child_process';

export const SHARE_REGISTRY_NAME = 'share-tunnel.json';
export const SHARE_METRICS_CANDIDATES = [20241, 20242, 20243, 20244, 20245];
export const SHARE_TUNNEL_BUDGET_MS = 30_000;
export const SHARE_HOSTNAME_PATTERN = /^[a-z0-9-]+\.trycloudflare\.com$/;

const flightByHome = new Map();

export function registryPath(homeDir) {
  return path.join(homeDir, SHARE_REGISTRY_NAME);
}

export function readShareRegistry(homeDir) {
  try {
    const raw = fs.readFileSync(registryPath(homeDir), 'utf8');
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object') return null;
    return doc;
  } catch {
    return null;
  }
}

export function writeShareRegistry(homeDir, doc) {
  fs.mkdirSync(homeDir, { recursive: true });
  const target = registryPath(homeDir);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, target);
  try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }
  return doc;
}

export function invalidateShareTunnelUrl(homeDir) {
  const reg = readShareRegistry(homeDir) || {};
  const next = {};
  if (Number.isInteger(reg.publicPort)) next.publicPort = reg.publicPort;
  writeShareRegistry(homeDir, next);
  return next;
}

async function fetchText(url, timeoutMs, fetchFn) {
  const fetcher = fetchFn || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs, fetchFn) {
  const { status, text } = await fetchText(url, timeoutMs, fetchFn);
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status, text, json };
}

export function parseHostname(value) {
  const host = String(value ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return SHARE_HOSTNAME_PATTERN.test(host) ? host : null;
}

export function parseHaConnections(metricsText) {
  const m = /cloudflared_tunnel_ha_connections\s+(\d+(?:\.\d+)?)/.exec(String(metricsText ?? ''));
  if (!m) return 0;
  return Number(m[1]);
}

export function parseConfigService(configText, configJson) {
  if (configJson && typeof configJson === 'object') {
    // cloudflared /config shape: { ingress: [{ service }] } or similar.
    const ingress = configJson.ingress;
    if (Array.isArray(ingress)) {
      for (const rule of ingress) {
        if (rule && typeof rule.service === 'string' && rule.service && rule.service !== 'http_status:404') {
          // First non-catchall is the origin; but scan all and prefer a
          // loopback http service if present.
          if (/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rule.service)) return rule.service;
        }
      }
      for (const rule of ingress) {
        if (rule && typeof rule.service === 'string' && rule.service && rule.service !== 'http_status:404') return rule.service;
      }
    }
    if (typeof configJson.service === 'string') return configJson.service;
  }
  const m = /\"service\"\s*:\s*\"([^\"]+)\"/.exec(String(configText ?? ''));
  return m ? m[1] : null;
}

// Read the three local facts for one metrics port. Throws on unreachable;
// returns { hostname, service, haConnections } (fields may be null/0).
export async function readTunnelFacts(metricsPort, { fetchFn = null, timeoutMs = 2000 } = {}) {
  const base = `http://127.0.0.1:${metricsPort}`;
  const quick = await fetchJson(`${base}/quicktunnel`, timeoutMs, fetchFn);
  if (quick.status !== 200 || !quick.json) throw new Error(`metrics :${metricsPort} /quicktunnel unreachable`);
  const hostname = parseHostname(quick.json.hostname);
  const config = await fetchJson(`${base}/config`, timeoutMs, fetchFn);
  const service = config.status === 200 ? parseConfigService(config.text, config.json) : null;
  let haConnections = 0;
  try {
    const metrics = await fetchText(`${base}/metrics`, timeoutMs, fetchFn);
    if (metrics.status === 200) haConnections = parseHaConnections(metrics.text);
  } catch { haConnections = 0; }
  return { hostname, service, haConnections };
}

export function defaultIsProcessAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function defaultPsCommand(pid, { spawnSyncFn = null } = {}) {
  try {
    const run = spawnSyncFn || nodeSpawnSync;
    const res = run('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return String(res.stdout || '').trim();
  } catch { return ''; }
}

// Validate a registry candidate against the expected public origin. Returns
// { ok, hostname, service, haConnections, reason } — never throws for
// unreachable metrics (returns ok:false).
export async function validateRegistryTunnel(registry, publicOrigin, { fetchFn = null, isProcessAlive = defaultIsProcessAlive } = {}) {
  if (!registry || !Number.isInteger(registry.metricsPort) || !registry.hostname) {
    return { ok: false, reason: 'no_registry' };
  }
  if (!parseHostname(registry.hostname)) return { ok: false, reason: 'bad_hostname' };
  if (registry.pid != null && !isProcessAlive(registry.pid)) return { ok: false, reason: 'dead_child' };
  let facts;
  try {
    facts = await readTunnelFacts(registry.metricsPort, { fetchFn });
  } catch {
    return { ok: false, reason: 'metrics_unreachable' };
  }
  if (!facts.hostname || !parseHostname(facts.hostname)) return { ok: false, reason: 'no_hostname' };
  if (facts.service !== publicOrigin) return { ok: false, reason: 'origin_mismatch', service: facts.service };
  if (!(facts.haConnections > 0)) return { ok: false, reason: 'no_connection', haConnections: facts.haConnections };
  return { ok: true, hostname: facts.hostname, service: facts.service, haConnections: facts.haConnections };
}

// Probe well-known local metrics ports (+ an optional recorded port) for a
// tunnel targeting publicOrigin. Returns { metricsPort, hostname } or null.
export async function discoverPublicTunnel(publicOrigin, { fetchFn = null, extraPorts = [] } = {}) {
  const ports = [...new Set([...(extraPorts || []), ...SHARE_METRICS_CANDIDATES])];
  for (const port of ports) {
    try {
      const facts = await readTunnelFacts(port, { fetchFn });
      if (facts.hostname && facts.service === publicOrigin && facts.haConnections > 0) {
        return { metricsPort: port, hostname: facts.hostname };
      }
    } catch { /* next candidate */ }
  }
  return null;
}

export function adminOriginVariants(adminOrigin) {
  const m = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)$/.exec(String(adminOrigin || ''));
  if (!m) return [String(adminOrigin)];
  const port = m[2];
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

// Detect any locally discoverable cloudflared tunnel targeting the admin
// dashboard origin. Probes metrics /config + falls back to ps command scan.
// Returns { unsafe, detail }.
export async function detectUnsafeAdminTunnel(adminOrigin, { fetchFn = null, psFn = null, metricsPorts = null, spawnSyncFn = null } = {}) {
  const variants = new Set(adminOriginVariants(adminOrigin));
  const ports = [...new Set([...(metricsPorts || []), ...SHARE_METRICS_CANDIDATES])];
  for (const port of ports) {
    try {
      const facts = await readTunnelFacts(port, { fetchFn });
      if (facts.service && variants.has(facts.service)) {
        return { unsafe: true, detail: `cloudflared metrics :${port} targets dashboard ${facts.service}` };
      }
    } catch { /* not a tunnel */ }
  }
  // Fallback: scan process commands for cloudflared --url pointing at admin.
  try {
    let output = '';
    if (psFn) {
      output = String(await psFn() || '');
    } else {
      const run = spawnSyncFn || nodeSpawnSync;
      const res = run('ps', ['-ax', '-o', 'command='], { encoding: 'utf8' });
      output = String(res.stdout || '');
    }
    const adminPort = (/:(\d+)$/.exec(String(adminOrigin)) || [])[1] || '';
    for (const line of output.split('\n')) {
      if (!/cloudflared/i.test(line) || !/tunnel/i.test(line)) continue;
      if (!line.includes('--url')) continue;
      const hasAdminHost = variants.size === 0 ? false : [...variants].some((v) => line.includes(v));
      const hasAdminPort = adminPort && line.includes(`:${adminPort}`) && /127\.0\.0\.1|localhost/.test(line);
      if (hasAdminHost || hasAdminPort) {
        return { unsafe: true, detail: `cloudflared process targets dashboard (${line.trim().slice(0, 160)})` };
      }
    }
  } catch { /* ps unavailable: metadata probe above already ran */ }
  return { unsafe: false, detail: '' };
}

export function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Prove Golem owns the recorded tunnel (for safe rebind kill): pid alive,
// metrics/config prove it targets publicOrigin (never admin), and the process
// command looks like our cloudflared child when available.
export async function registryOwnsLiveTunnel(registry, publicOrigin, { fetchFn = null, isProcessAlive = defaultIsProcessAlive, spawnSyncFn = null } = {}) {
  if (!registry || !Number.isInteger(registry.pid)) return false;
  if (!isProcessAlive(registry.pid)) return false;
  const check = await validateRegistryTunnel(registry, publicOrigin, { fetchFn, isProcessAlive });
  if (!check.ok) return false;
  try {
    const cmd = defaultPsCommand(registry.pid, { spawnSyncFn });
    if (cmd && !/cloudflared/i.test(cmd)) return false;
  } catch { /* ps unavailable: metrics proof above suffices */ }
  return true;
}

// Stop only the registry-owned child after proving it targets publicOrigin.
// Refuses when the tunnel targets adminOrigin or ownership cannot be proved.
export async function stopOwnedTunnel(homeDir, publicOrigin, adminOrigin, { fetchFn = null, isProcessAlive = defaultIsProcessAlive, killFn = null, spawnSyncFn = null } = {}) {
  const registry = readShareRegistry(homeDir);
  if (!registry || !Number.isInteger(registry.pid)) throw new Error('no owned tunnel to stop');
  const variants = new Set(adminOriginVariants(adminOrigin));
  // Fail closed: never kill a tunnel that targets the admin dashboard.
  if (Number.isInteger(registry.metricsPort)) {
    try {
      const facts = await readTunnelFacts(registry.metricsPort, { fetchFn });
      if (facts.service && variants.has(facts.service)) {
        throw new Error('refusing to stop a tunnel targeting the admin dashboard');
      }
    } catch (err) {
      if (String(err?.message || '').includes('refusing to stop')) throw err;
      // Unreachable metrics: fall through to ownership proof below.
    }
  }
  const owned = await registryOwnsLiveTunnel(registry, publicOrigin, { fetchFn, isProcessAlive, spawnSyncFn });
  if (!owned) throw new Error('tunnel ownership unproven; refusing to stop');
  const kill = killFn || ((pid) => process.kill(pid, 'SIGTERM'));
  await kill(registry.pid);
  invalidateShareTunnelUrl(homeDir);
  return { stopped: registry.pid };
}

// Single-flight supervised ensure. Returns { hostname, metricsPort, pid, reused }.
export async function ensureShareTunnel({
  publicPort,
  publicOrigin,
  adminOrigin,
  homeDir,
  spawnFn = null,
  fetchFn = null,
  isProcessAlive = defaultIsProcessAlive,
  killFn = null,
  pickMetricsPort = null,
  timeoutMs = SHARE_TUNNEL_BUDGET_MS,
  cloudflaredBin = 'cloudflared',
} = {}) {
  if (!Number.isInteger(publicPort)) throw new Error('publicPort is required');
  const origin = publicOrigin || `http://127.0.0.1:${publicPort}`;
  const key = `${homeDir}::${publicPort}`;
  if (flightByHome.has(key)) return flightByHome.get(key);
  const flight = (async () => {
    const registry = readShareRegistry(homeDir) || {};
    // 1. Reuse the recorded tunnel when it still validates.
    if (Number.isInteger(registry.metricsPort) && registry.hostname) {
      const check = await validateRegistryTunnel(registry, origin, { fetchFn, isProcessAlive });
      if (check.ok) {
        if (check.hostname !== registry.hostname) {
          writeShareRegistry(homeDir, { ...registry, publicPort, hostname: check.hostname, updated_at: new Date().toISOString() });
        }
        return { hostname: check.hostname, metricsPort: registry.metricsPort, pid: registry.pid ?? null, reused: true };
      }
    }
    // 2. Adopt a locally discoverable tunnel targeting our public origin
    // (registry stale). Never adopt an admin-targeting tunnel: discovery
    // requires exact publicOrigin equality.
    const discovered = await discoverPublicTunnel(origin, {
      fetchFn,
      extraPorts: Number.isInteger(registry.metricsPort) ? [registry.metricsPort] : [],
    });
    if (discovered) {
      const next = {
        publicPort,
        metricsPort: discovered.metricsPort,
        hostname: discovered.hostname,
        pid: registry.pid && isProcessAlive(registry.pid) ? registry.pid : null,
        updated_at: new Date().toISOString(),
      };
      writeShareRegistry(homeDir, next);
      return { hostname: discovered.hostname, metricsPort: discovered.metricsPort, pid: next.pid, reused: true };
    }
    // 3. Launch a new child. Explicit loopback --metrics, >=30s budget.
    const metricsPort = pickMetricsPort ? await pickMetricsPort() : await pickFreePort();
    const args = ['tunnel', '--url', origin, '--metrics', `127.0.0.1:${metricsPort}`];
    const runSpawn = spawnFn || ((bin, a, opts) => nodeSpawn(bin, a, opts));
    let child;
    try {
      child = runSpawn(cloudflaredBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      throw new Error(`cloudflared launch failed: ${err?.message ?? err} (is cloudflared installed?)`);
    }
    // Attach the error listener synchronously: a missing binary emits
    // 'error' (ENOENT) async, which crashes the process when unhandled.
    let exited = null;
    const onExit = (code, signal) => { exited = { code, signal }; };
    const onError = (err) => { exited = { code: null, signal: null, error: err }; };
    if (child && typeof child.on === 'function') {
      child.on('exit', onExit);
      child.on('error', onError);
    }
    if (!child || child.pid == null) {
      // Give a sync-throwing fake or an ENOENT child one tick to report.
      await sleep(50);
      const cause = exited?.error ? `: ${exited.error.message ?? exited.error}` : '';
      throw new Error(`cloudflared launch failed${cause} (is cloudflared installed?)`);
    }
    const killChild = async () => {
      try {
        if (killFn) await killFn(child.pid);
        else if (typeof child.kill === 'function') child.kill('SIGTERM');
        else process.kill(child.pid, 'SIGTERM');
      } catch { /* already gone */ }
    };
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || SHARE_TUNNEL_BUDGET_MS);
    let lastFacts = null;
    while (Date.now() < deadline) {
      if (exited) {
        await killChild().catch(() => {});
        if (exited.error) throw new Error(`cloudflared launch failed: ${exited.error.message ?? exited.error} (is cloudflared installed?)`);
        throw new Error(`cloudflared exited before provisioning (code ${exited.code ?? '?'}${exited.signal ? ` signal ${exited.signal}` : ''})`);
      }
      try {
        const facts = await readTunnelFacts(metricsPort, { fetchFn });
        lastFacts = facts;
        if (facts.hostname && facts.service === origin && facts.haConnections > 0) {
          const next = { publicPort, metricsPort, hostname: facts.hostname, pid: child.pid, updated_at: new Date().toISOString() };
          writeShareRegistry(homeDir, next);
          if (typeof child.removeListener === 'function') {
            child.removeListener('exit', onExit);
            child.removeListener('error', onError);
          }
          return { hostname: facts.hostname, metricsPort, pid: child.pid, reused: false };
        }
      } catch { /* still provisioning: connection refused / empty hostname */ }
      await sleep(250);
    }
    // Timeout: kill ONLY the child this attempt spawned.
    await killChild().catch(() => {});
    const hint = lastFacts ? ` (last state: hostname=${lastFacts.hostname || 'none'} service=${lastFacts.service || 'none'} ha=${lastFacts.haConnections || 0})` : '';
    throw new Error(`cloudflared provisioning timed out after ${Math.round((Number(timeoutMs) || SHARE_TUNNEL_BUDGET_MS) / 1000)}s${hint}`);
  })();
  flightByHome.set(key, flight);
  try {
    return await flight;
  } finally {
    if (flightByHome.get(key) === flight) flightByHome.delete(key);
  }
}

export function __clearTunnelFlights() {
  flightByHome.clear();
}
