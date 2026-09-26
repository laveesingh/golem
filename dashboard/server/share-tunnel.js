// GOL-384 managed quick-tunnel supervisor: one Golem-owned cloudflared quick
// tunnel pointing at the dashboard origin (http://127.0.0.1:<port>) so Share
// can hand out https://<host>/read/<display-id> links. No tokens, no grants,
// no adoption of foreign tunnels (R8), exit-confirmed serialized Stop (R9).
// All process/port effects are injectable for isolated tests; production wires
// the real spawn/fetch/kill. Never rely on /ready (GOL-385 false-negative).

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn as nodeSpawn } from 'node:child_process';
import { spawnSync as nodeSpawnSync } from 'node:child_process';

export const SHARE_REGISTRY_NAME = 'share-tunnel.json';
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
// R9: Stop registers here while it runs; an ensure that starts during Stop
// waits for it, and Stop waits for an in-flight ensure. Keyed exactly like
// the ensure flight so both sides rendezvous.
const stopFlightByHome = new Map();

export const STOP_UNCONFIRMED = 'STOP_UNCONFIRMED';

export function flightKeyFor(homeDir, origin) {
  return `${homeDir}::${origin}`;
}

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

// Registry shape (GOL-394): { origin, metricsPort, hostname, pid, updated_at }.
// Legacy registries carry publicPort instead of origin; registryOrigin
// translates both so R5 migration can tell stale from current.
export function registryOrigin(registry) {
  if (!registry || typeof registry !== 'object') return null;
  if (typeof registry.origin === 'string' && registry.origin) return registry.origin;
  if (Number.isInteger(registry.publicPort)) return `http://127.0.0.1:${registry.publicPort}`;
  return null;
}

export function clearShareRegistry(homeDir) {
  writeShareRegistry(homeDir, {});
  return {};
}

// R8 identity: a tunnel is Golem-owned only if the registry PID Golem wrote
// at spawn is alive and its live command is `cloudflared tunnel --url
// <expectedOrigin>`. No health requirement (R9 reuses this for Stop, so an
// owned-but-disconnected tunnel stays stoppable). Returns false on clean
// mismatch; throws on indeterminate process state (fail closed) so callers
// never kill or publish on a guess.
export async function isOwnedTunnel(pid, expectedOrigin, { isProcessAlive = defaultIsProcessAlive, psCommandFn = null, spawnSyncFn = null } = {}) {
  if (!Number.isInteger(pid)) return false;
  if (!isProcessAlive(pid)) return false;
  let cmd = '';
  try {
    cmd = psCommandFn ? String(await psCommandFn(pid) ?? '') : defaultPsCommand(pid, { spawnSyncFn });
  } catch (err) {
    throw new Error(`tunnel ownership indeterminate for pid ${pid}: ${err?.message ?? err}`);
  }
  return isCloudflaredTunnelForOrigin(cmd, expectedOrigin);
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

// Poll until pid exits (or timeout). Returns true on confirmed exit.
async function pollForExit(pid, timeoutMs, pollMs, isProcessAlive) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  for (;;) {
    let alive = true;
    try { alive = isProcessAlive(pid); } catch { alive = true; } // indeterminate: keep waiting, never assume exit
    if (!alive) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.max(1, Math.min(Number(pollMs) || 100, Math.max(0, deadline - Date.now()))));
  }
}

// R9 kill contract on one proven-owned pid: SIGTERM, poll for exit up to
// termMs, then SIGKILL and poll up to killMs. Returns 'term'/'kill' on
// confirmed exit, null when exit stays unconfirmed. killFn(pid, signal)
// is injectable; fakes model ignored signals by keeping the pid alive.
// An ESRCH-style throw from kill means the pid is already gone → confirmed.
async function killPidWithContract(pid, { isProcessAlive = defaultIsProcessAlive, killFn = null, termMs = 5000, killMs = 2000, pollMs = 100 } = {}) {
  const kill = killFn || ((p, sig) => process.kill(p, sig));
  const attempt = async (signal) => {
    try { await kill(pid, signal); }
    catch (err) {
      const code = err && (err.code || err.errno);
      if (code === 'ESRCH' || /ESRCH|no such process/i.test(String(err?.message ?? ''))) return 'gone';
      throw err;
    }
    return 'signalled';
  };
  if (await attempt('SIGTERM') === 'gone') return 'term';
  if (await pollForExit(pid, termMs, pollMs, isProcessAlive)) return 'term';
  if (await attempt('SIGKILL') === 'gone') return 'kill';
  if (await pollForExit(pid, killMs, pollMs, isProcessAlive)) return 'kill';
  return null;
}

function stopUnconfirmedError(pid) {
  const err = new Error(`tunnel pid ${pid} did not exit after SIGTERM+SIGKILL; registry kept (retry Stop)`);
  err.code = STOP_UNCONFIRMED;
  return err;
}

// Stop the registry-recorded tunnel after proving R8 identity against
// expectedOrigin (no health requirement). Dead or missing PID clears the
// registry and reports already_stopped. The registry is cleared only after
// exit is confirmed; otherwise STOP_UNCONFIRMED is thrown and the registry
// is kept. Never kills a process whose ownership is unproven.
export async function stopOwnedTunnelInner(homeDir, expectedOrigin, { isProcessAlive = defaultIsProcessAlive, killFn = null, psCommandFn = null, spawnSyncFn = null, stopTermMs = 5000, stopKillMs = 2000, stopPollMs = 100 } = {}) {
  const registry = readShareRegistry(homeDir) || {};
  if (!Number.isInteger(registry.pid)) {
    clearShareRegistry(homeDir);
    return { stopped: false, already_stopped: true };
  }
  const pid = registry.pid;
  let alive = true;
  try { alive = isProcessAlive(pid); } catch { alive = true; } // indeterminate: identity below fails closed
  if (!alive) {
    clearShareRegistry(homeDir);
    return { stopped: false, already_stopped: true };
  }
  let owned = false;
  try {
    owned = await isOwnedTunnel(pid, expectedOrigin, { isProcessAlive, psCommandFn, spawnSyncFn });
  } catch (err) {
    throw new Error(`refusing to stop: ${err?.message ?? err}`);
  }
  if (!owned) throw new Error(`tunnel ownership unproven for pid ${pid}; refusing to stop`);
  const outcome = await killPidWithContract(pid, { isProcessAlive, killFn, termMs: stopTermMs, killMs: stopKillMs, pollMs: stopPollMs });
  if (!outcome) throw stopUnconfirmedError(pid);
  clearShareRegistry(homeDir);
  return { stopped: true, already_stopped: false, pid };
}

// R9: Stop serialized with the ensure flight both ways. Waits for an
// in-flight ensure before proving ownership, and registers a stop flight so
// an ensure that starts during Stop waits until Stop finishes.
export async function stopOwnedTunnel(homeDir, expectedOrigin, opts = {}) {
  if (!expectedOrigin) throw new Error('expectedOrigin is required');
  const key = flightKeyFor(homeDir, expectedOrigin);
  const flight = flightByHome.get(key);
  if (flight) {
    try { await flight; } catch { /* settle: Stop re-reads the registry, never the flight result */ }
  }
  let release = null;
  const mine = new Promise((resolve) => { release = resolve; });
  const prev = stopFlightByHome.get(key);
  stopFlightByHome.set(key, mine);
  try {
    if (prev) await prev; // a prior Stop always resolves; re-read below
    return await stopOwnedTunnelInner(homeDir, expectedOrigin, opts);
  } finally {
    if (stopFlightByHome.get(key) === mine) stopFlightByHome.delete(key);
    if (release) release();
  }
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

// Single-flight supervised ensure for the dashboard-origin tunnel. Returns
// { hostname, metricsPort, pid, reused }. Reuse returns the validated
// recorded tunnel without spawning; otherwise a new Golem-owned child is
// launched. Never adopts a foreign tunnel (R8); serialized with Stop (R9).
export async function ensureShareTunnel({
  origin,
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
  // R9 kill-contract bounds reused by the migration/replace stops below.
  stopTermMs = 5000,
  stopKillMs = 2000,
  stopPollMs = 100,
  // GOL-390: end-to-end recovery budget (ms) across reuse + migration +
  // launch. <=0 disables the race (phase budgets still apply).
  overallTimeoutMs = SHARE_RECOVERY_BUDGET_MS,
  // GOL-390: timestamped instrumentation seam — onPhase(name, elapsedMs).
  onPhase = null,
} = {}) {
  if (!origin) throw new Error('origin is required');
  const key = flightKeyFor(homeDir, origin);
  // R9: an ensure that starts during Stop waits until Stop finishes, so no
  // Share publishes or recreates a tunnel mid-Stop.
  const pendingStop = stopFlightByHome.get(key);
  if (pendingStop) await pendingStop; // a Stop flight always resolves; re-read the registry below
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
    const recordedOrigin = registryOrigin(registry);
    const verifyOpts = { fetchFn, isProcessAlive, findPidFn, psCommandFn, spawnSyncFn };
    const ownedOpts = { isProcessAlive, psCommandFn, spawnSyncFn };
    const stopOpts = { isProcessAlive, killFn, psCommandFn, spawnSyncFn, stopTermMs, stopKillMs, stopPollMs };
    // 1. Reuse only what Golem spawned and recorded (R8): the registry
    // origin must be this dashboard origin, the tunnel must validate
    // (hostname + origin + edge health), and the recorded pid must prove
    // identity. A same-origin tunnel started by anyone else has no recorded
    // pid — ignored: never reused, never stopped.
    mark('validate');
    if (recordedOrigin === origin && Number.isInteger(registry.metricsPort) && registry.hostname && Number.isInteger(registry.pid)) {
      const check = await validateRegistryTunnel(registry, origin, verifyOpts);
      let owned = false;
      try {
        owned = await isOwnedTunnel(registry.pid, origin, ownedOpts);
      } catch (err) {
        // Indeterminate process state: fail closed rather than reuse or
        // overwrite the registry of a possibly-owned tunnel.
        throw new Error(`refusing Share: ${err?.message ?? err}`);
      }
      if (check.ok && owned) {
        if (check.hostname !== registry.hostname && !state.timedOut) {
          writeShareRegistry(homeDir, { origin, metricsPort: registry.metricsPort, hostname: check.hostname, pid: registry.pid, updated_at: new Date().toISOString() });
        }
        mark('reused');
        return { hostname: check.hostname, metricsPort: registry.metricsPort, pid: registry.pid, reused: true };
      }
      if (owned) {
        // Owned but not validating (edge down, rotated metrics): stop the
        // useless child under the R9 contract, then launch fresh. Keeps the
        // one-owned-tunnel invariant instead of leaking it. An unconfirmed
        // exit propagates (Share 502s, registry kept for retry).
        mark('replace-owned');
        await stopOwnedTunnelInner(homeDir, origin, stopOpts);
      }
      // Unowned records fall through to launch beside whatever process is
      // out there — never killed, never reused.
    } else if (recordedOrigin && recordedOrigin !== origin) {
      // 2. R5 migration: the registry points at another origin (the old
      // public listener). Stop it only with R8 identity against THAT
      // origin; a foreign process (or an indeterminate check) is left
      // alone — fail closed without killing — then start fresh.
      mark('migrate');
      if (Number.isInteger(registry.pid)) {
        let owned = false;
        try {
          owned = await isOwnedTunnel(registry.pid, recordedOrigin, ownedOpts);
        } catch {
          owned = false; // indeterminate: leave the process alone, still start fresh
        }
        if (owned) {
          // An unconfirmed exit throws (Share 502s, stale registry kept
          // for retry) rather than leak the child under a fresh registry.
          await stopOwnedTunnelInner(homeDir, recordedOrigin, stopOpts);
        }
      }
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
            const next = { origin, metricsPort, hostname: facts.hostname, pid: child.pid, updated_at: new Date().toISOString() };
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
  stopFlightByHome.clear();
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
