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
// GOL-390: every synchronous subprocess call in the Share path carries a
// hard timeout (same convention as model-catalog.js). A wedged ps/lsof must
// fail closed in seconds, never freeze the dashboard event loop for minutes.
export const SPAWN_SYNC_TIMEOUT_MS = 5000;
// GOL-390: declared end-to-end recovery budget for one ensureShareTunnel
// pass (reuse + discovery + unsafe guard + launch). The launch phase keeps
// its >=30s provisioning budget from its own start; this race caps the SUM
// so a dead-registry Share returns a verified URL or an actionable timeout
// well under 60s. Worst legitimate path ≈ 30s launch + ~9s phase overhead
// (a dripping registry port re-probed at 2s per abort plus the 5s sync
// bound), hence 45s: inside the ~30s+small-tolerance intent with margin,
// 25% under the 60s acceptance line. Injectable via overallTimeoutMs.
export const SHARE_RECOVERY_BUDGET_MS = 45_000;
// Bounded stderr retained from a spawned child for failure diagnostics.
export const SHARE_STDERR_RING_MAX = 32 * 1024;

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

// Run a synchronous subprocess with a hard timeout. Real node spawnSync
// never throws for timeouts/spawn failures — it RETURNS { error } — so the
// wrapper normalizes any result-carried error into a throw (GOL-390 fix
// round 1: without this, a timed-out ps looked like clean empty output and
// the unsafe-admin guard failed open). Injected fakes receive the timeout in
// opts (mirroring node semantics); fakes that ignore it model pre-fix
// unbounded behavior. Callers fail closed via their existing try/catch.
function runSyncBounded(spawnSyncFn, bin, args, opts = {}) {
  const run = spawnSyncFn || nodeSpawnSync;
  const res = run(bin, args, { ...opts, timeout: SPAWN_SYNC_TIMEOUT_MS });
  if (res && res.error) throw res.error;
  return res;
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

export function escapeRegExp(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True when a process command line is a cloudflared quick tunnel serving
// exactly publicOrigin (GOL-388: fake metrics//config alone prove nothing).
// Requires the literal `--url <origin>` bounded by whitespace/end so
// :808 never matches :8080.
export function isCloudflaredTunnelForOrigin(command, publicOrigin) {
  const cmd = String(command ?? '');
  if (!/cloudflared/i.test(cmd) || !/\btunnel\b/.test(cmd)) return false;
  return new RegExp(`--url\\s+${escapeRegExp(publicOrigin)}(?=\\s|$)`).test(cmd);
}

// PID of the process LISTENing on a TCP port (lsof, loopback only). Null
// when unresolvable — callers fail closed on null.
export function findMetricsListenerPid(port, { spawnSyncFn = null } = {}) {
  try {
    const res = runSyncBounded(spawnSyncFn, 'lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-FpcL'], { encoding: 'utf8' });
    for (const line of String(res.stdout || '').split('\n')) {
      if (line.startsWith('p')) {
        const pid = Number(line.slice(1));
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
    }
  } catch { /* unavailable: caller treats null as unverified */ }
  return null;
}

export function processCommandForPid(pid, { spawnSyncFn = null } = {}) {
  return defaultPsCommand(pid, { spawnSyncFn });
}

// Verify a metrics port is served by a cloudflared tunnel for publicOrigin.
// Returns { ok, pid?, reason? } — never throws for unresolvable listeners.
export async function verifyMetricsListener(metricsPort, publicOrigin, { findPidFn = null, psCommandFn = null, spawnSyncFn = null } = {}) {
  let pid = null;
  try {
    pid = findPidFn ? await findPidFn(metricsPort) : findMetricsListenerPid(metricsPort, { spawnSyncFn });
  } catch { pid = null; }
  if (!Number.isInteger(pid)) return { ok: false, reason: 'no_listener_pid' };
  let cmd = '';
  try {
    cmd = psCommandFn ? String(await psCommandFn(pid) ?? '') : processCommandForPid(pid, { spawnSyncFn });
  } catch { cmd = ''; }
  if (!isCloudflaredTunnelForOrigin(cmd, publicOrigin)) return { ok: false, reason: 'command_mismatch', pid };
  return { ok: true, pid };
}

export function defaultPsCommand(pid, { spawnSyncFn = null } = {}) {
  try {
    const res = runSyncBounded(spawnSyncFn, 'ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return String(res.stdout || '').trim();
  } catch (err) {
    // A hung enumeration is indeterminate (never clean-empty): callers that
    // gate destructive or security decisions must fail closed on it.
    if (err && err.code === 'ETIMEDOUT') throw err;
    return '';
  }
}

// Validate a registry candidate against the expected public origin. Returns
// { ok, hostname, service, haConnections, reason } — never throws for
// unreachable metrics (returns ok:false).
export async function validateRegistryTunnel(registry, publicOrigin, { fetchFn = null, isProcessAlive = defaultIsProcessAlive, findPidFn = null, psCommandFn = null, spawnSyncFn = null } = {}) {
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
  // GOL-388: a pid-less (previously adopted) entry must re-prove its metrics
  // listener is a cloudflared tunnel for this origin — metrics alone can be
  // impersonated. Entries with a live recorded pid were spawned or verified
  // with that pid and keep the pid-liveness proof above. Unresolvable
  // listeners fail closed here (verifyMetricsListener returns ok:false).
  if (registry.pid == null) {
    const proof = await verifyMetricsListener(registry.metricsPort, publicOrigin, { findPidFn, psCommandFn, spawnSyncFn });
    if (!proof.ok) return { ok: false, reason: `listener_unverified:${proof.reason}` };
  }
  return { ok: true, hostname: facts.hostname, service: facts.service, haConnections: facts.haConnections };
}

// Probe well-known local metrics ports (+ an optional recorded port) for a
// tunnel targeting publicOrigin. GOL-388: a candidate is adopted only when
// its metrics listener PID proves to be `cloudflared tunnel --url
// <exact publicOrigin>` — matching /config alone can be impersonated.
// Returns { metricsPort, hostname, pid } or null. Unverifiable candidates
// are skipped (fail closed toward launching a Golem-owned child).
export async function discoverPublicTunnel(publicOrigin, { fetchFn = null, extraPorts = [], findPidFn = null, psCommandFn = null, spawnSyncFn = null } = {}) {
  const ports = [...new Set([...(extraPorts || []), ...SHARE_METRICS_CANDIDATES])];
  for (const port of ports) {
    try {
      const facts = await readTunnelFacts(port, { fetchFn });
      if (!(facts.hostname && facts.service === publicOrigin && facts.haConnections > 0)) continue;
      const proof = await verifyMetricsListener(port, publicOrigin, { findPidFn, psCommandFn, spawnSyncFn });
      if (!proof.ok) continue;
      return { metricsPort: port, hostname: facts.hostname, pid: proof.pid };
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
  // Fail-closed contract (GOL-390 fix round 1): a hung enumeration is
  // INDETERMINATE and propagates — callers answer 502/omit rather than
  // minting or emitting bearer URLs. A missing ps tool degrades to the
  // metrics verdict above (refused/unreachable metrics + no ps still means
  // nothing was found, not hidden evidence).
  let output = '';
  if (psFn) {
    output = String(await psFn() || '');
  } else {
    try {
      const res = runSyncBounded(spawnSyncFn, 'ps', ['-ax', '-o', 'command='], { encoding: 'utf8' });
      output = String(res.stdout || '');
    } catch (err) {
      if (err && err.code === 'ETIMEDOUT') {
        throw new Error(`unsafe-admin check indeterminate: process listing timed out (${err.message || 'ETIMEDOUT'})`);
      }
      return { unsafe: false, detail: '' };
    }
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
// command is a cloudflared tunnel for that exact origin when available.
export async function registryOwnsLiveTunnel(registry, publicOrigin, { fetchFn = null, isProcessAlive = defaultIsProcessAlive, spawnSyncFn = null, psCommandFn = null } = {}) {
  if (!registry || !Number.isInteger(registry.pid)) return false;
  if (!isProcessAlive(registry.pid)) return false;
  const check = await validateRegistryTunnel(registry, publicOrigin, { fetchFn, isProcessAlive });
  if (!check.ok) return false;
  try {
    const cmd = psCommandFn ? String(await psCommandFn(registry.pid) ?? '') : defaultPsCommand(registry.pid, { spawnSyncFn });
    if (cmd && !isCloudflaredTunnelForOrigin(cmd, publicOrigin)) return false;
  } catch (err) {
    // Hung enumeration is indeterminate: refuse the kill (fail closed).
    // Other ps failures keep the long-standing metrics-suffice behavior.
    if (err && err.code === 'ETIMEDOUT') return false;
  }
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
// Reuse returns a live validated tunnel without spawning; launching a NEW
// child while an admin-targeting tunnel is discoverable refuses (no spawn).
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
  findPidFn = null,
  psCommandFn = null,
  spawnSyncFn = null,
  // GOL-390: end-to-end recovery budget (ms) across reuse + discovery +
  // guard + launch. <=0 disables the race (phase budgets still apply).
  overallTimeoutMs = SHARE_RECOVERY_BUDGET_MS,
  // GOL-390: timestamped instrumentation seam — onPhase(name, elapsedMs).
  onPhase = null,
} = {}) {
  if (!Number.isInteger(publicPort)) throw new Error('publicPort is required');
  const origin = publicOrigin || `http://127.0.0.1:${publicPort}`;
  const key = `${homeDir}::${publicPort}`;
  const t0 = Date.now();
  const state = { phase: 'start', timedOut: false, child: null };
  const ring = { text: '' };
  const mark = (name) => {
    state.phase = name;
    try { onPhase?.(name, Date.now() - t0); } catch {} // seam must never break recovery
  };
  // Bound one flight by the end-to-end budget. The FIRST bounded waiter
  // establishes exactly one timer from flight start (normally the owner);
  // every later bounded joiner shares that same raced promise, so staggered
  // waiters observe one absolute deadline, one owned-child kill, and one
  // actionable error — never a fresh budget per waiter. A caller with
  // budget <= 0 opts out and awaits the raw flight (phase budgets only).
  // Joiners share the owner's tracking so a timeout reports the real phase
  // and gates late registry writes consistently.
  const raceWithBudget = (target, st = state) => {
    const budget = Number(overallTimeoutMs);
    const cleanupFlight = () => { if (flightByHome.get(key) === target) flightByHome.delete(key); };
    if (!(budget > 0)) {
      try {
        return target;
      } finally {
        // Attach cleanup without altering the shared promise identity.
        Promise.resolve(target).then(cleanupFlight, cleanupFlight);
      }
    }
    let timer = null;
    const timeoutRace = new Promise((_, reject) => {
      timer = setTimeout(() => {
        st.timedOut = true;
        cleanupFlight();
        const c = st.child;
        st.child = null;
        killSpawned(c);
        reject(new Error(`share recovery timed out after ${budget}ms in ${st.phase} (end-to-end budget ${SHARE_RECOVERY_BUDGET_MS}ms); retry Share — a stale tunnel is replaced, never reused`));
      }, budget);
      if (timer.unref) timer.unref();
    });
    return (async () => {
      try {
        return await Promise.race([target, timeoutRace]);
      } finally {
        if (timer) clearTimeout(timer);
        cleanupFlight();
      }
    })();
  };
  // Best-effort kill of ONLY the child this flight spawned. Safe to call on
  // an exited child (ESRCH ignored) and safe to call twice.
  const killSpawned = (proc) => {
    try {
      if (!proc) return;
      if (typeof killFn === 'function') { Promise.resolve(killFn(proc.pid)).catch(() => {}); return; }
      if (typeof proc.kill === 'function') { try { proc.kill('SIGTERM'); } catch { /* already gone */ } return; }
      try { process.kill(proc.pid, 'SIGTERM'); } catch { /* already gone */ }
    } catch { /* never throw from cleanup */ }
  };
  // Drain stderr so a chatty sustained child can never block on a full pipe.
  // Attached synchronously at spawn, before any output is possible. The ring
  // holds only cloudflared's own logs (hostname/edge lines) — bearer tokens
  // are never passed to or through the child, so the tail is safe to quote
  // in timeout errors. Exported for lifecycle tests (see __ seam below).
  const drainStderr = (proc) => __drainChildStderr(proc, ring);
  const stderrTail = () => ring.text.slice(-300).replace(/\s+/g, ' ').trim();
  // One absolute deadline per flight: the first bounded waiter establishes
  // the single raced promise (normally the owner at flight start); later
  // bounded joiners share it instead of starting fresh budgets. A caller
  // with budget <= 0 opts out and awaits the raw flight.
  const boundedFor = (targetFlight, st) => {
    if (!(Number(overallTimeoutMs) > 0)) return raceWithBudget(targetFlight, st);
    if (!targetFlight.boundedRace) targetFlight.boundedRace = raceWithBudget(targetFlight, st);
    return targetFlight.boundedRace;
  };
  if (flightByHome.has(key)) {
    const owner = flightByHome.get(key);
    return boundedFor(owner, owner.shareState ?? state);
  }
  const flight = (async () => {
    const registry = readShareRegistry(homeDir) || {};
    const verifyOpts = { fetchFn, isProcessAlive, findPidFn, psCommandFn, spawnSyncFn };
    // 1. Reuse the recorded tunnel when it still validates.
    mark('validate');
    if (Number.isInteger(registry.metricsPort) && registry.hostname) {
      const check = await validateRegistryTunnel(registry, origin, verifyOpts);
      if (check.ok) {
        if (check.hostname !== registry.hostname && !state.timedOut) {
          writeShareRegistry(homeDir, { ...registry, publicPort, hostname: check.hostname, updated_at: new Date().toISOString() });
        }
        mark('reused');
        return { hostname: check.hostname, metricsPort: registry.metricsPort, pid: registry.pid ?? null, reused: true };
      }
    }
    // 2. Adopt a locally discoverable tunnel targeting our public origin
    // (registry stale). Never adopt an admin-targeting tunnel: discovery
    // requires exact publicOrigin equality PLUS listener PID/command proof.
    mark('discover');
    const discovered = await discoverPublicTunnel(origin, {
      fetchFn,
      extraPorts: Number.isInteger(registry.metricsPort) ? [registry.metricsPort] : [],
      findPidFn,
      psCommandFn,
      spawnSyncFn,
    });
    if (discovered) {
      // The discovered listener PID is verified cloudflared-for-origin
      // (discoverPublicTunnel proves it); record it for future ownership.
      // Skipped after a global timeout (a retry owns the registry then).
      if (!state.timedOut) {
        const next = {
          publicPort,
          metricsPort: discovered.metricsPort,
          hostname: discovered.hostname,
          pid: Number.isInteger(discovered.pid) ? discovered.pid : null,
          updated_at: new Date().toISOString(),
        };
        writeShareRegistry(homeDir, next);
      }
      mark('adopted');
      return { hostname: discovered.hostname, metricsPort: discovered.metricsPort, pid: Number.isInteger(discovered.pid) ? discovered.pid : null, reused: true };
    }
    // 2b. Never spawn a new public tunnel while an admin-targeting tunnel
    // is discoverable (GOL-388: the admin route already 409s; this keeps a
    // direct ensureShareTunnel caller from launching into the cutover hole).
    // An INDETERMINATE check (hung enumeration) propagates as a refusal —
    // no .catch downgrade to safe (GOL-390 fix round 2): launching blind is
    // the same hole. Reuse above stays available — it spawns nothing new.
    mark('guard');
    if (adminOrigin) {
      const guardPorts = Number.isInteger(registry.metricsPort) ? [registry.metricsPort] : [];
      const guard = await detectUnsafeAdminTunnel(adminOrigin, { fetchFn, metricsPorts: guardPorts, spawnSyncFn });
      if (guard.unsafe) throw new Error(`refusing to launch a public tunnel while an admin-targeting tunnel exists (${guard.detail})`);
    }
    // 3. Launch a new child. Explicit loopback --metrics, >=30s budget.
    mark('launch');
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
    drainStderr(child);
    if (child && Number.isInteger(child.pid)) state.child = child;
    if (!child || child.pid == null) {
      // Give a sync-throwing fake or an ENOENT child one tick to report.
      await sleep(50);
      const cause = exited?.error ? `: ${exited.error.message ?? exited.error}` : '';
      throw new Error(`cloudflared launch failed${cause} (is cloudflared installed?)`);
    }
    const killChild = async () => {
      const c = child;
      state.child = null;
      try {
        if (typeof killFn === 'function') await killFn(c.pid);
        else killSpawned(c);
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
          state.child = null;
          // Skipped after a global timeout (a retry owns the registry then);
          // validation gates any later reuse, so a skipped write only costs
          // one extra relaunch, never a stale success.
          if (!state.timedOut) {
            const next = { publicPort, metricsPort, hostname: facts.hostname, pid: child.pid, updated_at: new Date().toISOString() };
            writeShareRegistry(homeDir, next);
          }
          if (typeof child.removeListener === 'function') {
            child.removeListener('exit', onExit);
            child.removeListener('error', onError);
          }
          mark('done');
          return { hostname: facts.hostname, metricsPort, pid: child.pid, reused: false };
        }
      } catch { /* still provisioning: connection refused / empty hostname */ }
      await sleep(250);
    }
    // Timeout: kill ONLY the child this attempt spawned.
    await killChild().catch(() => {});
    mark('launch-timeout');
    const hint = lastFacts ? ` (last state: hostname=${lastFacts.hostname || 'none'} service=${lastFacts.service || 'none'} ha=${lastFacts.haConnections || 0})` : '';
    const tail = stderrTail();
    throw new Error(`cloudflared provisioning timed out after ${Math.round((Number(timeoutMs) || SHARE_TUNNEL_BUDGET_MS) / 1000)}s${hint}${tail ? ` (child log tail: ${tail})` : ''}`);
  })();
  flight.shareState = state;
  flightByHome.set(key, flight);
  // The timer cannot rescue a synchronously blocked loop (spawnSync hard
  // timeouts cover that), but it bounds every awaited path so one
  // dead-registry Share settles in ~budget, never minutes.
  return boundedFor(flight, state);
}

export function __clearTunnelFlights() {
  flightByHome.clear();
}

// GOL-390 seam: drain a spawned child's stderr into a bounded ring so pipe
// backpressure can never stall it. Test-only export (same convention as
// __clearTunnelFlights); production calls it synchronously at spawn.
export function __drainChildStderr(proc, ring) {
  try {
    const s = proc && proc.stderr;
    if (!s || typeof s.on !== 'function') return;
    s.on('data', (chunk) => {
      ring.text += String(chunk);
      if (ring.text.length > SHARE_STDERR_RING_MAX) ring.text = ring.text.slice(-SHARE_STDERR_RING_MAX);
    });
    s.on('error', () => {});
    if (typeof s.resume === 'function') s.resume();
  } catch { /* diagnostics must never break recovery */ }
}
