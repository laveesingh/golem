// Model profiles — first-class named execution configs for Pi workers.
//
// Lives deliberately OUTSIDE `~/.golem/roles/index.json`: older dashboard
// processes rewrite that index with only { version, roles } and strip unknown
// fields (the same strip that forced `registry-state.json` to be a sidecar).
// A separate `~/.golem/profiles.json` survives those writers untouched.
//
// Resolution contract (spec GOL-251, D8): an explicit `--profile` beats a
// role's default profile, which beats the role's leftover `exec`. The chosen
// profile's { provider, model, thinking } is copied into the exec layer that
// `lib/role-preset.js` merges and emits — role `exec` is never removed.

import fs from 'node:fs';
import path from 'node:path';

import { golemHome } from './golem-home.js';
import { withRegistryLock } from './session-facts.js';
import { getRole, readRoleRegistry, THINKING_LEVELS } from './session-role.js';

export { THINKING_LEVELS };

const PROFILES_VERSION = 1;
const PROFILE_NAME_MAX_LENGTH = 80;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function profilesJsonPath() {
  return path.join(golemHome(), 'profiles.json');
}

function atomicWriteJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, target);
}

function normalizeProfileName(name) {
  const value = String(name ?? '').trim();
  if (!value || value.length > PROFILE_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`profile name must be 1-${PROFILE_NAME_MAX_LENGTH} characters without control characters (got ${JSON.stringify(name)})`);
  }
  return value;
}

function validateProfileFields({ provider, model, thinking }) {
  if (typeof provider !== 'string' || !provider.trim()) throw new Error('profile provider is required');
  if (typeof model !== 'string' || !model.trim()) throw new Error('profile model is required');
  if (!THINKING_LEVELS.includes(thinking)) {
    throw new Error(`profile thinking must be one of ${THINKING_LEVELS.join(', ')} (got ${JSON.stringify(thinking)})`);
  }
  return { provider: provider.trim(), model: model.trim(), thinking };
}

const ALLOWED_HARNESSES = ['pi', 'hermes'];

function normalizeProfile(row, index) {
  if (!isRecord(row)) throw new Error(`profiles.json profile #${index} must be an object`);
  const harness = row.harness || 'pi';
  if (!ALLOWED_HARNESSES.includes(harness)) {
    throw new Error(`profiles.json profile #${index}: harness must be one of ${ALLOWED_HARNESSES.join(', ')} (got ${JSON.stringify(row.harness)})`);
  }
  return {
    name: normalizeProfileName(row.name),
    harness,
    ...validateProfileFields(row),
  };
}

function normalizeStore(raw) {
  if (raw == null) {
    return { version: PROFILES_VERSION, seeded_from_roles: false, profiles: [], role_defaults: {} };
  }
  if (!isRecord(raw)) throw new Error('profiles.json must contain a JSON object');
  if (raw.version != null && raw.version !== PROFILES_VERSION) {
    throw new Error(`profiles.json version must be ${PROFILES_VERSION} (got ${JSON.stringify(raw.version)})`);
  }
  if (!Array.isArray(raw.profiles)) throw new Error('profiles.json "profiles" must be an array');
  if (raw.role_defaults != null && !isRecord(raw.role_defaults)) {
    throw new Error('profiles.json "role_defaults" must be an object');
  }
  const profiles = raw.profiles.map(normalizeProfile);
  const seen = new Set();
  for (const profile of profiles) {
    if (seen.has(profile.name)) throw new Error(`duplicate profile name in profiles.json: ${profile.name}`);
    seen.add(profile.name);
  }
  const role_defaults = {};
  for (const [role, target] of Object.entries(raw.role_defaults ?? {})) {
    if (typeof target !== 'string' || !seen.has(target)) {
      throw new Error(`role_defaults["${role}"] points at missing profile ${JSON.stringify(target)}`);
    }
    role_defaults[role] = target;
  }
  return {
    version: PROFILES_VERSION,
    seeded_from_roles: raw.seeded_from_roles === true,
    profiles,
    role_defaults,
  };
}

function readStoreRaw() {
  const target = profilesJsonPath();
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`cannot read model profiles at ${target}: ${error.message}`, { cause: error });
  }
}

function cloneStore(store) {
  return {
    version: store.version,
    seeded_from_roles: store.seeded_from_roles,
    profiles: store.profiles.map((profile) => ({ ...profile })),
    role_defaults: { ...store.role_defaults },
  };
}

function execTripleKey(exec) {
  return [exec.provider, exec.model, exec.thinking].join('\u0000');
}

/** Deterministic, collision-safe profile name derived from an exec. */
function deriveProfileName(model, thinking, taken) {
  const base = String(model).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const stem = `${base || 'model'}-${thinking}`;
  let name = stem;
  let suffix = 2;
  while (taken.has(name)) {
    name = `${stem}-${suffix}`;
    suffix += 1;
  }
  return name;
}

function seedFromRoles(store) {
  // Dedupe on (provider, model, thinking): the builtin seed gives builder,
  // explorer, and reviewer identical execs — those must share ONE profile.
  const byTriple = new Map(store.profiles.map((profile) => [execTripleKey(profile), profile.name]));
  const taken = new Set(store.profiles.map((profile) => profile.name));
  for (const role of readRoleRegistry()) {
    if (!isRecord(role.exec)) continue;
    let exec;
    try {
      exec = validateProfileFields(role.exec);
    } catch {
      continue; // role execs are validated elsewhere; skip malformed rows
    }
    const key = execTripleKey(exec);
    let name = byTriple.get(key);
    if (name == null) {
      name = deriveProfileName(exec.model, exec.thinking, taken);
      store.profiles.push({ name, harness: 'pi', ...exec });
      byTriple.set(key, name);
      taken.add(name);
    }
    // Preserve any pointer written after file creation; first seed only fills.
    if (!Object.hasOwn(store.role_defaults, role.name)) store.role_defaults[role.name] = name;
  }
  store.seeded_from_roles = true;
  return store;
}

let storeCache = null;
let storeCacheStamp = null;

function storeStamp() {
  try {
    const stat = fs.statSync(profilesJsonPath());
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    return `error:${error?.code || 'unknown'}`;
  }
}

function invalidateCache() {
  storeCache = null;
  storeCacheStamp = null;
}

/**
 * Load the profiles store, seeding it from role execs on first load.
 *
 * Sentinel (D2): `profiles.json` absent OR `seeded_from_roles` not true.
 * Seeding is idempotent — dedupe by exec triple both against new rows and
 * against profiles already present in a partially-written file — and runs
 * under the store lock with a re-read inside the lock.
 */
export function loadProfilesStore({ seed = true, cache = true } = {}) {
  const stamp = `${seed}|${storeStamp()}`;
  if (cache && storeCache && storeCacheStamp === stamp) return cloneStore(storeCache);
  if (cache) invalidateCache();

  const raw = readStoreRaw();
  let store = normalizeStore(raw);
  if (seed && !store.seeded_from_roles) {
    store = withRegistryLock(profilesJsonPath(), () => {
      // Re-read inside the lock: another process may have seeded while we waited.
      const current = normalizeStore(readStoreRaw());
      if (current.seeded_from_roles) return current;
      seedFromRoles(current);
      atomicWriteJson(profilesJsonPath(), current);
      return current;
    });
  }

  storeCache = cloneStore(store);
  storeCacheStamp = `${seed}|${storeStamp()}`;
  return cloneStore(store);
}

function mutateStore(mutator) {
  const result = withRegistryLock(profilesJsonPath(), () => {
    // Do not use a cached snapshot while holding the writer lock. A dashboard
    // process or another CLI may have written the store since this process last
    // read it.
    const store = loadProfilesStore({ seed: false, cache: false });
    const outcome = mutator(store);
    if (outcome !== false) atomicWriteJson(profilesJsonPath(), store);
    return outcome;
  });
  invalidateCache();
  return result;
}

export function profilesPath() {
  return profilesJsonPath();
}

/** Read the normalized store. Kept as a small alias for dashboard callers. */
export function readProfiles() {
  return loadProfilesStore();
}

/** Registry-style alias matching the role store naming convention. */
export function readProfileRegistry() {
  return loadProfilesStore();
}

export function listProfiles() {
  return loadProfilesStore().profiles;
}

export function listProfileNames() {
  return listProfiles().map((profile) => profile.name);
}

export function getProfile(name) {
  const wanted = String(name ?? '').trim();
  return loadProfilesStore().profiles.find((profile) => profile.name === wanted) || null;
}

/** A profile as the exec-shaped layer that role-preset merges on top of. */
export function resolveProfile(name) {
  const profile = getProfile(name);
  if (!profile) return null;
  return { harness: profile.harness || 'pi', provider: profile.provider, model: profile.model, thinking: profile.thinking };
}

export function createProfile({ name, harness = 'pi', provider, model, thinking } = {}) {
  const normHarness = harness || 'pi';
  if (!ALLOWED_HARNESSES.includes(normHarness)) {
    throw new Error(`harness must be one of ${ALLOWED_HARNESSES.join(', ')} (got ${JSON.stringify(harness)})`);
  }
  const normalized = {
    name: normalizeProfileName(name),
    harness: normHarness,
    ...validateProfileFields({ provider, model, thinking }),
  };
  return mutateStore((store) => {
    if (store.profiles.some((profile) => profile.name === normalized.name)) {
      throw new Error(`profile already exists: ${normalized.name}`);
    }
    store.profiles.push(normalized);
    return normalized;
  });
}

export function updateProfile(name, patch = {}) {
  const target = String(name ?? '').trim();
  const incoming = isRecord(patch) ? patch : {};
  return mutateStore((store) => {
    const profile = store.profiles.find((row) => row.name === target);
    if (!profile) throw new Error(`profile not found: ${target}`);
    const nextName = Object.hasOwn(incoming, 'name')
      ? normalizeProfileName(incoming.name)
      : target;
    if (nextName !== target && store.profiles.some((row) => row.name === nextName)) {
      throw new Error(`profile already exists: ${nextName}`);
    }
    const next = validateProfileFields({
      provider: incoming.provider ?? profile.provider,
      model: incoming.model ?? profile.model,
      thinking: incoming.thinking ?? profile.thinking,
    });
    profile.name = nextName;
    Object.assign(profile, next);
    if (nextName !== target) {
      for (const [role, pointer] of Object.entries(store.role_defaults)) {
        if (pointer === target) store.role_defaults[role] = nextName;
      }
    }
    return { ...profile };
  });
}

export function renameProfile(from, to) {
  return updateProfile(from, { name: to });
}

export function deleteProfile(name) {
  const target = String(name ?? '').trim();
  return mutateStore((store) => {
    const index = store.profiles.findIndex((row) => row.name === target);
    if (index < 0) throw new Error(`profile not found: ${target}`);
    const referencing = Object.entries(store.role_defaults)
      .filter(([, value]) => value === target)
      .map(([role]) => role);
    if (referencing.length) {
      throw new Error(
        `profile "${target}" is the default model profile for role(s) ${referencing.join(', ')}; `
        + 'clear or reassign those defaults before deleting it',
      );
    }
    store.profiles.splice(index, 1);
    return { deleted: target };
  });
}

export function setRoleDefault(role, profileName) {
  const roleName = String(role ?? '').trim();
  if (!getRole(roleName)) {
    throw new Error(`unknown role: ${roleName} (expected one of: ${readRoleRegistry().map((row) => row.name).join(', ')})`);
  }
  return mutateStore((store) => {
    if (profileName == null) {
      delete store.role_defaults[roleName];
      return { role: roleName, profile: null };
    }
    const target = normalizeProfileName(profileName);
    if (!store.profiles.some((row) => row.name === target)) {
      throw new Error(`unknown model profile: ${target} (expected one of: ${store.profiles.map((row) => row.name).join(', ') || '(none)'})`);
    }
    store.role_defaults[roleName] = target;
    return { role: roleName, profile: target };
  });
}

export function getRoleDefault(role) {
  const roleName = String(role ?? '').trim();
  return loadProfilesStore().role_defaults[roleName] ?? null;
}

/** Clear a pointer after its role has been deleted. Unlike setRoleDefault this
 * intentionally does not require the role to still exist. */
export function clearRoleDefault(role) {
  const roleName = String(role ?? '').trim();
  return mutateStore((store) => {
    const previous = store.role_defaults[roleName] ?? null;
    delete store.role_defaults[roleName];
    return { role: roleName, profile: null, previous };
  });
}

export function roleDefaults() {
  return { ...loadProfilesStore().role_defaults };
}
