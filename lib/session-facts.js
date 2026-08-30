import fs from 'node:fs';
import path from 'node:path';
import { endpointLeasesJsonPath, sessionFactsJsonPath } from './golem-home.js';

export const SESSION_FACTS_VERSION = 1;
export const ENDPOINT_LEASES_VERSION = 1;
export const DEFAULT_LEASE_TTL_MS = 45_000;

function iso(value = Date.now()) { return new Date(value).toISOString(); }
function ms(value) { const n = Date.parse(value || ''); return Number.isFinite(n) ? n : 0; }
function read(file, key, version) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.version !== version || !Array.isArray(value[key])) throw new Error(`invalid ${key} registry schema at ${file}`);
    return { version, [key]: value[key] };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version, [key]: [] };
    throw new Error(`cannot read ${key} registry at ${file}: ${error.message}`, { cause: error });
  }
}
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function withRegistryLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      fs.mkdirSync(lock);
      try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
      const until = Date.now() + 20; while (Date.now() < until) {}
    }
  }
  throw new Error(`failed to acquire ${lock}`);
}

export function readSessionFacts({ file = sessionFactsJsonPath() } = {}) {
  return read(file, 'facts', SESSION_FACTS_VERSION).facts;
}

// Immutable canonical identity/continuation ownership wins over later locators.
// Mutable observations advance only by revision, then observed_at.
//
// `reassert: true` is for periodic re-registration (endpoint heartbeats): a row
// that is materially identical to what is already stored — everything except
// revision/observed_at — is NOT rewritten, so observed_at keeps meaning "last
// observed session activity" rather than "endpoint process still alive". A
// missing row or a material change (rename, status flip) still writes.
export function upsertSessionFact(input, { file = sessionFactsJsonPath(), now = Date.now(), reassert = false } = {}) {
  if (!input?.canonical_id || !input?.harness || !input?.locator?.raw_session_id) throw new Error('canonical_id, harness and locator.raw_session_id are required');
  return withRegistryLock(file, () => {
    const registry = read(file, 'facts', SESSION_FACTS_VERSION);
    const index = registry.facts.findIndex((fact) => fact.canonical_id === input.canonical_id);
    const previous = index >= 0 ? registry.facts[index] : null;
    const incomingRevision = Number(input.revision ?? (previous?.revision ?? 0) + 1);
    const observedAt = input.observed_at || iso(now);
    const advances = !previous || incomingRevision > Number(previous.revision || 0)
      || (incomingRevision === Number(previous.revision || 0) && ms(observedAt) >= ms(previous.observed_at));
    // Live observations clear an earlier retirement so a resumed/cleared session
    // can reappear under the same canonical id without a second card.
    const clearingTerminal = advances && input.status && !['dead', 'stopped', 'failed', 'superseded'].includes(String(input.status).toLowerCase())
      && input.ended_at == null;
    const fact = previous ? {
      ...previous,
      ...(advances ? input : {}),
      canonical_id: previous.canonical_id,
      continuation_key: previous.continuation_key ?? input.continuation_key ?? null,
      harness: previous.harness,
      locator: advances ? input.locator : previous.locator,
      revision: advances ? incomingRevision : previous.revision,
      observed_at: advances ? observedAt : previous.observed_at,
      ...(clearingTerminal ? { ended_at: null } : {}),
    } : { ...input, continuation_key: input.continuation_key ?? null, revision: incomingRevision, observed_at: observedAt };
    if (reassert && previous) {
      const material = ({ revision, observed_at, ...rest }) => JSON.stringify(rest);
      if (material(fact) === material(previous)) return previous;
    }
    if (index >= 0) registry.facts[index] = fact; else registry.facts.push(fact);
    atomicWrite(file, registry);
    return fact;
  });
}

const SESSION_FACT_TERMINAL_STATUSES = new Set(['dead', 'stopped', 'failed', 'superseded']);

/** True when a fact was explicitly retired (not bare turn-stop `ended`). */
export function isSessionFactTerminal(fact) {
  if (!fact) return false;
  if (fact.ended_at) return true;
  return SESSION_FACT_TERMINAL_STATUSES.has(String(fact.status || '').toLowerCase());
}

// Capability is a durable session fact, not a lease-derived observation. A
// lease says where a live endpoint is reachable now; this tells the shared
// queue never to regress a live typed worker to a harness-specific spool when
// that endpoint is cleanly released for reload/rebind.
export function hasTypedWorkerCapability(fact) {
  return fact?.capabilities?.typed_worker === true;
}

/**
 * Retire existing facts by canonical_id. Does not create rows.
 * Sets status + ended_at; bumps revision so the retirement advances.
 */
export function markSessionFactsEnded(canonicalIds, {
  status = 'superseded',
  endedAt = iso(),
  file = sessionFactsJsonPath(),
  now = Date.now(),
} = {}) {
  const ids = new Set((Array.isArray(canonicalIds) ? canonicalIds : [canonicalIds]).filter(Boolean));
  if (!ids.size) return [];
  return withRegistryLock(file, () => {
    const registry = read(file, 'facts', SESSION_FACTS_VERSION);
    const marked = [];
    const observedAt = iso(now);
    registry.facts = registry.facts.map((fact) => {
      if (!ids.has(fact?.canonical_id) || isSessionFactTerminal(fact)) return fact;
      marked.push(fact.canonical_id);
      return {
        ...fact,
        status,
        ended_at: endedAt,
        revision: Number(fact.revision || 0) + 1,
        observed_at: observedAt,
      };
    });
    if (marked.length) atomicWrite(file, registry);
    return marked;
  });
}

/**
 * End prior Codex facts for the same project path, keeping keepCanonicalIds.
 * Only retires facts that are still non-terminal.
 */
export function supersedePriorCodexFacts({
  projectPath,
  keepCanonicalIds = [],
  protectCanonicalIds = [],
  file = sessionFactsJsonPath(),
  now = Date.now(),
} = {}) {
  if (!projectPath) return [];
  const keep = new Set([...keepCanonicalIds, ...protectCanonicalIds].filter(Boolean));
  return withRegistryLock(file, () => {
    const registry = read(file, 'facts', SESSION_FACTS_VERSION);
    const marked = [];
    const observedAt = iso(now);
    const endedAt = observedAt;
    registry.facts = registry.facts.map((fact) => {
      if (fact?.harness !== 'codex') return fact;
      if (keep.has(fact.canonical_id)) return fact;
      if (isSessionFactTerminal(fact)) return fact;
      if (fact.project_path !== projectPath) return fact;
      marked.push(fact.canonical_id);
      return {
        ...fact,
        status: 'superseded',
        ended_at: endedAt,
        revision: Number(fact.revision || 0) + 1,
        observed_at: observedAt,
      };
    });
    if (marked.length) atomicWrite(file, registry);
    return marked;
  });
}

export function readEndpointLeases({ file = endpointLeasesJsonPath(), now = Date.now(), includeExpired = false } = {}) {
  const leases = read(file, 'leases', ENDPOINT_LEASES_VERSION).leases;
  return includeExpired ? leases : leases.filter((lease) => ms(lease.expires_at) > now);
}
export function renewEndpointLease(input, { file = endpointLeasesJsonPath(), now = Date.now(), ttlMs = DEFAULT_LEASE_TTL_MS } = {}) {
  if (!input?.canonical_id || !input?.host || !input?.port || !input?.owner_token) throw new Error('canonical_id, host, port and owner_token are required');
  return withRegistryLock(file, () => {
    const registry = read(file, 'leases', ENDPOINT_LEASES_VERSION);
    const lease = { ...input, renewed_at: iso(now), expires_at: iso(now + ttlMs) };
    const index = registry.leases.findIndex((row) => row.canonical_id === input.canonical_id && row.owner_token === input.owner_token);
    if (index >= 0) registry.leases[index] = lease; else registry.leases.push(lease);
    atomicWrite(file, registry);
    return lease;
  });
}
export function releaseEndpointLeases(ownerToken, { file = endpointLeasesJsonPath(), canonicalId = null } = {}) {
  return withRegistryLock(file, () => {
    const registry = read(file, 'leases', ENDPOINT_LEASES_VERSION);
    registry.leases = registry.leases.filter((lease) => lease.owner_token !== ownerToken || (canonicalId && lease.canonical_id !== canonicalId));
    atomicWrite(file, registry);
  });
}

export function retireEndpointLeasesForCanonical(canonicalIds, { file = endpointLeasesJsonPath() } = {}) {
  const ids = new Set((Array.isArray(canonicalIds) ? canonicalIds : [canonicalIds]).filter(Boolean));
  if (!ids.size) return [];
  return withRegistryLock(file, () => {
    const registry = read(file, 'leases', ENDPOINT_LEASES_VERSION);
    const before = registry.leases.length;
    registry.leases = registry.leases.filter((lease) => !ids.has(lease.canonical_id));
    if (registry.leases.length !== before) atomicWrite(file, registry);
    return before - registry.leases.length;
  });
}
