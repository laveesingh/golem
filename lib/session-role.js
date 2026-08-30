import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readEndpointLeases, readSessionFacts } from './session-facts.js';

export const THINKING_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

// These defaults are deliberately global. Per-project execution overrides are
// out of scope for the Pi worker launch contract.
export const ROLE_EXEC_DEFAULTS = Object.freeze({
  harness: 'pi',
  provider: 'ollama-cloud',
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function presetPrefix(role) {
  return role ? `invalid role preset for "${role}"` : 'invalid role preset';
}

function fail(role, message) {
  throw new Error(`${presetPrefix(role)}: ${message}`);
}

export const ROLE_HARNESSES = Object.freeze(['pi', 'hermes']);

/** Validate and normalize one resolved execution preset. */
export function validateRolePreset(preset, { role = null, applyDefaults = true } = {}) {
  if (!isRecord(preset)) fail(role, 'exec must be an object');
  const candidate = applyDefaults ? { ...ROLE_EXEC_DEFAULTS, ...preset } : { ...preset };

  if (!ROLE_HARNESSES.includes(candidate.harness)) {
    fail(role, `harness must be one of ${ROLE_HARNESSES.map((h) => JSON.stringify(h)).join(', ')} (got ${JSON.stringify(candidate.harness)})`);
  }
  if (typeof candidate.provider !== 'string' || !candidate.provider.trim()) {
    fail(role, 'provider is required when a model is configured');
  }
  if (typeof candidate.model !== 'string' || !candidate.model.trim()) {
    fail(role, 'model is required');
  }
  if (!THINKING_LEVELS.includes(candidate.thinking)) {
    fail(role, `thinking must be one of ${THINKING_LEVELS.join(', ')} (got ${JSON.stringify(candidate.thinking)})`);
  }

  let name = null;
  if (candidate.name != null) {
    if (typeof candidate.name !== 'string' || !candidate.name.trim()) {
      fail(role, 'name must be a non-empty string when supplied');
    }
    name = candidate.name.trim();
  }

  return {
    harness: candidate.harness,
    provider: candidate.provider.trim(),
    model: candidate.model.trim(),
    thinking: candidate.thinking,
    name,
  };
}

const BUILTIN_PI_EXEC = Object.freeze({
  ...ROLE_EXEC_DEFAULTS,
  model: 'deepseek-v4-flash:0731',
  thinking: 'medium',
  name: null,
});

export const BUILTIN_ROLES = Object.freeze([
  { name: 'lead', color: '#a78bfa', glyph: 'LD', builtin: true },
  { name: 'builder', color: '#4ade80', glyph: 'BU', builtin: true, exec: BUILTIN_PI_EXEC },
  { name: 'explorer', color: '#38bdf8', glyph: 'EX', builtin: true, exec: BUILTIN_PI_EXEC },
  { name: 'reviewer', color: '#f472b6', glyph: 'RV', builtin: true, exec: BUILTIN_PI_EXEC },
]);
// `manager` and `planner` merged into `lead` (GOL-103). `general` previously
// pointed at `manager`, so it has to follow the merge or it would migrate to a
// role that no longer exists.
export const ROLE_MIGRATIONS = Object.freeze({
  general: 'lead',
  manager: 'lead',
  planner: 'lead',
  researcher: 'explorer',
  'ui-tester': 'explorer',
});
export const SESSION_ROLES = new Proxy([], {
  get(_target, prop) {
    const roles = roleNames();
    const value = roles[prop];
    return typeof value === 'function' ? value.bind(roles) : value;
  },
  ownKeys() { return Reflect.ownKeys(roleNames()); },
  getOwnPropertyDescriptor(_target, prop) { return Object.getOwnPropertyDescriptor(roleNames(), prop); },
});
export const SESSION_ROLE_UPDATED_BY = Object.freeze(['human:dashboard', 'human:cli', 'self:mcp']);

let roleRegistryCache = null;
let roleRegistryCacheStamp = null;

function registryFileStamp(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    return `error:${error?.code || 'unknown'}`;
  }
}

function roleRegistryStamp() {
  const directory = rolesOverlayDir();
  return `${directory}|${registryFileStamp(rolesIndexPath())}|${registryFileStamp(roleRegistryStatePath())}`;
}

function isRealDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function golemHome() {
  if (process.env.GOLEM_HOME) return process.env.GOLEM_HOME;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'golem');
  const migrated = path.join(os.homedir(), '.golem');
  if (isRealDir(migrated)) return migrated;
  return path.join(os.homedir(), '.config', 'golem');
}

export function sessionsJsonPath() {
  return path.join(golemHome(), 'sessions.json');
}

function channelsJsonPath() {
  return path.join(golemHome(), 'channels.json');
}

function rolesOverlayDir() {
  return path.join(golemHome(), 'roles');
}

const ROLE_REGISTRY_VERSION = 2;
const ROLE_REGISTRY_STATE_VERSION = 1;

function rolesIndexPath() {
  return path.join(rolesOverlayDir(), 'index.json');
}

function roleRegistryStatePath() {
  return path.join(rolesOverlayDir(), 'registry-state.json');
}

function roleOverlayPath(role) {
  return path.join(rolesOverlayDir(), `${role}.md`);
}

function roleDefaultPath(role) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', 'roles', `${role}.md`),
    path.join(here, '..', 'plugin', 'roles', `${role}.md`),
    path.join(here, '..', 'substrate', 'roles', `${role}.md`),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  return null;
}

function roleCardPath(role) {
  const overlay = roleOverlayPath(role);
  try { if (fs.statSync(overlay).isFile()) return overlay; } catch { /* ignore */ }
  if (process.env.GOLEM_ROLES_DIR) {
    const custom = path.join(process.env.GOLEM_ROLES_DIR, `${role}.md`);
    try { if (fs.statSync(custom).isFile()) return custom; } catch { /* ignore */ }
  }
  return roleDefaultPath(role);
}

export function readRoleCard(role) {
  const normalized = normalizeRole(role);
  if (!normalized) return null;
  const p = roleCardPath(normalized);
  if (!p) return null;
  try { return fs.readFileSync(p, 'utf8').trimEnd(); } catch { return null; }
}

export function roleMission(role) {
  try {
    const card = readRoleCard(role);
    return card?.match(/^Mission:\s*(.+)$/m)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function normalizeRoleName(name) {
  const value = String(name || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(value)) throw new Error('role name must be 2-32 chars: a-z, 0-9, hyphen; start with a letter');
  return value;
}

function cloneRoleExec(exec) {
  if (exec == null || typeof exec !== 'object' || Array.isArray(exec)) return exec;
  return { ...exec };
}

function normalizeRoleMeta(role, fallback = {}) {
  const name = normalizeRoleName(role?.name ?? fallback.name);
  const color = String(role?.color ?? fallback.color ?? '#8a909c').trim() || '#8a909c';
  const glyph = String(role?.glyph ?? fallback.glyph ?? name.slice(0, 2).toUpperCase()).trim().slice(0, 4) || name.slice(0, 2).toUpperCase();
  const meta = { name, color, glyph, builtin: role?.builtin === true || fallback.builtin === true };
  const roleHasExec = role != null && typeof role === 'object' && Object.hasOwn(role, 'exec');
  const fallbackHasExec = fallback != null && typeof fallback === 'object' && Object.hasOwn(fallback, 'exec');
  if (roleHasExec || fallbackHasExec) meta.exec = cloneRoleExec(roleHasExec ? role.exec : fallback.exec);
  return meta;
}

function atomicWriteJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
}

function readRolesIndexRaw() {
  const target = rolesIndexPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!isRecord(parsed) || !Array.isArray(parsed.roles)) throw new Error('roles must be an array');
    return {
      version: Number.isInteger(parsed.version) ? parsed.version : 1,
      roles: parsed.roles,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`cannot read role registry at ${target}: ${error.message}`, { cause: error });
  }
}

function readRoleRegistryState() {
  const target = roleRegistryStatePath();
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (parsed?.version !== ROLE_REGISTRY_STATE_VERSION || !isRecord(parsed.known_exec)) {
      throw new Error('invalid registry provenance schema');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`cannot read role registry provenance at ${target}: ${error.message}`, { cause: error });
  }
}

function roleRegistryStateFor(roles) {
  const known_exec = {};
  for (const role of roles) {
    if (!isRecord(role)) continue;
    let name;
    try { name = normalizeRoleName(role.name); } catch { continue; }
    if (Object.hasOwn(role, 'exec')) known_exec[name] = cloneRoleExec(role.exec);
  }
  return {
    version: ROLE_REGISTRY_STATE_VERSION,
    registry_version: ROLE_REGISTRY_VERSION,
    updated_at: new Date().toISOString(),
    known_exec,
  };
}

function rebuildRoleRegistryState(raw, reason) {
  const target = roleRegistryStatePath();
  try {
    atomicWriteJson(target, roleRegistryStateFor(raw.roles));
  } catch (error) {
    throw new Error(
      `cannot rebuild role registry provenance at ${target} from ${rolesIndexPath()}: ${error.message}. `
      + `Recovery: restore a writable roles directory or restore ${target} manually, then retry.`,
      { cause: error },
    );
  }
  console.warn(
    `[golem] role registry provenance at ${target} is ${reason}; `
    + `rebuilt from the intact version-${ROLE_REGISTRY_VERSION} index at ${rolesIndexPath()}.`,
  );
  return readRoleRegistryState();
}

function writeRolesIndex(roles) {
  atomicWriteJson(rolesIndexPath(), { version: ROLE_REGISTRY_VERSION, roles });
  // This sidecar is intentionally separate from index.json. Older dashboard
  // processes rewrite only { version, roles }, so provenance must survive their
  // stale write in a file they do not know about.
  atomicWriteJson(roleRegistryStatePath(), roleRegistryStateFor(roles));
  roleRegistryCache = null;
  roleRegistryCacheStamp = null;
}

export function migrateSessionRoles({ actor = 'system:role-migration' } = {}) {
  const file = sessionsJsonPath();
  const now = new Date().toISOString();
  let changed = false;
  let migrated = [];
  try {
    withFileLock(`${file}.lock`, () => {
      const reg = readRegistry(file);
      reg.sessions = reg.sessions.map((s) => {
        // hasOwn for the same reason as the two lookups above, but the stakes are
        // higher here: a bare lookup on a role named `constructor` resolves to
        // Object via the prototype, passes the truthiness check, and writes a
        // function into `role` — which JSON.stringify drops, silently destroying
        // the session's role instead of merely skipping a check.
        const nextRole = Object.hasOwn(ROLE_MIGRATIONS, s.role) ? ROLE_MIGRATIONS[s.role] : undefined;
        if (!nextRole) return s;
        changed = true;
        const next = {
          ...s,
          role: nextRole,
          role_updated_at: now,
          role_updated_by: actor,
          role_migrated_from: s.role,
        };
        migrated.push({ session_id: s.session_id, name: s.name ?? null, from: s.role, to: nextRole });
        return next;
      });
      if (changed) writeRegistry(file, reg);
    });
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return { changed, migrated };
}

function rawRoleMap(rawRoles) {
  const byName = new Map();
  for (const item of rawRoles) {
    if (!isRecord(item)) continue;
    try {
      byName.set(normalizeRoleName(item.name), item);
    } catch { /* skip invalid old rows */ }
  }
  return byName;
}

function roleRegistryLossError(names) {
  const roles = names.length ? names.map((name) => `"${name}"`).join(', ') : 'the registry';
  return new Error(
    `role registry lost execution preset for ${roles}; refusing to re-seed builtin defaults. `
    + `Recovery: restore ${rolesIndexPath()} with the missing exec block(s) from a known-good copy, then retry. `
    + `Last-known presets are recorded in ${roleRegistryStatePath()}.`,
  );
}

function assertRoleRegistryExecIntact(raw, state) {
  if (!state) {
    if (raw?.version >= ROLE_REGISTRY_VERSION) {
      throw new Error(
        `role registry provenance is missing at ${roleRegistryStatePath()}; refusing to trust execution presets. `
        + `Recovery: rebuild it from the intact ${rolesIndexPath()} or restore a known-good copy, then retry`,
      );
    }
    return;
  }
  if (!raw) throw roleRegistryLossError(Object.keys(state.known_exec));
  const rawByName = rawRoleMap(raw.roles);
  const lost = Object.keys(state.known_exec).filter((name) => {
    const role = rawByName.get(name);
    return !role || !Object.hasOwn(role, 'exec');
  });
  if (lost.length) throw roleRegistryLossError(lost);
}

function legacyRegistryNeedsSeed(raw) {
  if (!raw || raw.version >= ROLE_REGISTRY_VERSION) return false;
  const rawByName = rawRoleMap(raw.roles);
  return BUILTIN_ROLES.some((builtin) => Object.hasOwn(builtin, 'exec')
    && (!rawByName.has(builtin.name) || !Object.hasOwn(rawByName.get(builtin.name), 'exec')));
}

function cloneRoleRegistry(roles) {
  return roles.map((r) => ({ ...r, ...(Object.hasOwn(r, 'exec') ? { exec: cloneRoleExec(r.exec) } : {}) }));
}

export function readRoleRegistry() {
  const stamp = roleRegistryStamp();
  if (roleRegistryCache && roleRegistryCacheStamp === stamp) return cloneRoleRegistry(roleRegistryCache);
  roleRegistryCache = null;
  roleRegistryCacheStamp = null;

  const raw = readRolesIndexRaw();
  let state = null;
  let stateError = null;
  try {
    state = readRoleRegistryState();
  } catch (error) {
    stateError = error;
  }
  if (raw?.version >= ROLE_REGISTRY_VERSION) {
    if (stateError) state = rebuildRoleRegistryState(raw, `corrupt (${stateError.message})`);
    else if (!state) state = rebuildRoleRegistryState(raw, 'missing');
  } else if (stateError) {
    if (!raw) throw stateError;
    console.warn(
      `[golem] ignoring invalid role registry provenance at ${roleRegistryStatePath()} while migrating a legacy index: `
      + `${stateError.message}`,
    );
  }
  assertRoleRegistryExecIntact(raw, state);
  if (legacyRegistryNeedsSeed(raw)) {
    console.warn(
      `[golem] role registry at ${rolesIndexPath()} has no execution provenance; `
      + 'seeding builtin presets as a legacy pre-exec registry. Future preset loss will fail loudly.',
    );
  }

  const byName = new Map(BUILTIN_ROLES.map((r) => [r.name, normalizeRoleMeta(r)]));
  if (raw) {
    byName.clear();
    for (const item of raw.roles) {
      try {
        const role = normalizeRoleMeta(item);
        // hasOwn, not truthy: a role named `constructor` or `valueof` passes
        // normalizeRoleName and would otherwise resolve against Object.prototype
        // and be silently dropped from the registry.
        if (!Object.hasOwn(ROLE_MIGRATIONS, role.name)) byName.set(role.name, role);
      } catch { /* skip invalid old rows */ }
    }
    for (const builtin of BUILTIN_ROLES) {
      const existing = byName.get(builtin.name);
      if (!existing) {
        byName.set(builtin.name, normalizeRoleMeta(builtin));
      } else {
        // A version-1 index written before execution presets existed is still
        // valid. Add the builtin seed only when provenance says this is the
        // first migration, never after a known preset has gone missing.
        byName.set(builtin.name, {
          ...existing,
          builtin: existing.builtin || builtin.builtin,
          ...(!Object.hasOwn(existing, 'exec') && Object.hasOwn(builtin, 'exec')
            ? { exec: cloneRoleExec(builtin.exec) }
            : {}),
        });
      }
    }
  }
  const roles = [...byName.values()].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
  writeRolesIndex(roles);
  migrateSessionRoles();
  roleRegistryCache = roles;
  roleRegistryCacheStamp = roleRegistryStamp();
  return cloneRoleRegistry(roles);
}

export function roleNames() {
  return readRoleRegistry().map((r) => r.name);
}

export function getRole(name) {
  let normalized = null;
  try {
    normalized = normalizeRoleName(name);
  } catch {
    return null;
  }
  return readRoleRegistry().find((r) => r.name === normalized) || null;
}

export function createRole({ name, color, glyph, body, exec } = {}) {
  const input = { name, color, glyph, builtin: false };
  if (exec !== undefined) input.exec = exec;
  const meta = normalizeRoleMeta(input);
  if (Object.hasOwn(meta, 'exec')) {
    meta.exec = validateRolePreset(meta.exec, { role: meta.name });
  }
  const roles = readRoleRegistry();
  if (roles.some((r) => r.name === meta.name)) throw new Error(`role already exists: ${meta.name}`);
  writeRolesIndex([...roles, meta].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name)));
  if (body != null && String(body).trim()) writeRoleCard(meta.name, body);
  return listRoleCards().find((r) => r.name === meta.name);
}

function assignedSessionsForRole(role) {
  const reg = readRegistry(sessionsJsonPath());
  return reg.sessions.filter((s) => s.role === role);
}

export function deleteRole(name, { force = false } = {}) {
  const normalized = normalizeRoleName(name);
  const roles = readRoleRegistry();
  const role = roles.find((r) => r.name === normalized);
  if (!role) throw new Error(`role not found: ${normalized}`);
  if (role.builtin) throw new Error(`cannot delete builtin role: ${normalized}`);
  const assigned = assignedSessionsForRole(normalized);
  if (assigned.length && !force) throw new Error(`role is assigned to ${assigned.length} session(s)`);
  if (assigned.length && force) {
    const file = sessionsJsonPath();
    const now = new Date().toISOString();
    withFileLock(`${file}.lock`, () => {
      const reg = readRegistry(file);
      reg.sessions = reg.sessions.map((s) => s.role === normalized ? { ...s, role: null, role_updated_at: now, role_updated_by: 'system:role-delete' } : s);
      writeRegistry(file, reg);
    });
  }
  writeRolesIndex(roles.filter((r) => r.name !== normalized));
  return { ok: true, role: normalized, cleared_sessions: force ? assigned.length : 0 };
}

export function updateRoleMeta(name, patch = {}) {
  const normalized = normalizeRoleName(name);
  const roles = readRoleRegistry();
  const idx = roles.findIndex((r) => r.name === normalized);
  if (idx < 0) throw new Error(`role not found: ${normalized}`);
  const current = roles[idx];
  const next = {
    ...current,
    color: patch.color ?? current.color,
    glyph: patch.glyph ?? current.glyph,
    builtin: current.builtin,
  };
  if (Object.hasOwn(patch, 'exec')) {
    if (patch.exec == null) {
      if (current.builtin && Object.hasOwn(current, 'exec')) {
        throw new Error(`cannot remove execution preset for builtin role "${normalized}"; provide a valid preset instead`);
      }
      delete next.exec;
    } else {
      next.exec = patch.exec && typeof patch.exec === 'object' && !Array.isArray(patch.exec)
        ? { ...(current.exec && typeof current.exec === 'object' ? current.exec : {}), ...patch.exec }
        : patch.exec;
    }
  }
  const normalizedNext = normalizeRoleMeta(next);
  if (Object.hasOwn(normalizedNext, 'exec')) {
    normalizedNext.exec = validateRolePreset(normalizedNext.exec, { role: normalized });
  }
  roles[idx] = normalizedNext;
  writeRolesIndex(roles);
  return roles[idx];
}

export function updateRoleExec(name, exec) {
  return updateRoleMeta(name, { exec });
}

export function listRoleCards() {
  return readRoleRegistry().map((meta) => {
    const role = meta.name;
    const overlay = roleOverlayPath(role);
    const defaultPath = roleDefaultPath(role);
    let currentPath = null;
    let overridden = false;
    let updated_at = null;
    try {
      const st = fs.statSync(overlay);
      if (st.isFile()) {
        currentPath = overlay;
        overridden = true;
        updated_at = st.mtime.toISOString();
      }
    } catch { /* no override */ }
    if (!currentPath) currentPath = defaultPath;
    let body = '';
    if (currentPath) {
      try { body = fs.readFileSync(currentPath, 'utf8').trimEnd(); } catch { body = ''; }
    }
    return { ...meta, body, overridden, updated_at, default_path: defaultPath, overlay_path: overlay };
  });
}

export function writeRoleCard(role, body) {
  const normalized = normalizeRole(role);
  if (!normalized) throw new Error('role is required');
  const text = String(body ?? '').trimEnd();
  if (!text.trim()) throw new Error('role body cannot be empty');
  fs.mkdirSync(rolesOverlayDir(), { recursive: true });
  const target = roleOverlayPath(normalized);
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${text}\n`, 'utf8');
  fs.renameSync(tmp, target);
  const st = fs.statSync(target);
  return { name: normalized, body: text, overridden: true, updated_at: st.mtime.toISOString(), overlay_path: target, default_path: roleDefaultPath(normalized) };
}

export function roleChangeBrief(role, row = {}) {
  const normalized = normalizeRole(role);
  if (!normalized) return null;
  const card = readRoleCard(normalized);
  if (!card) return null;
  const name = row.name || row.session_id || 'this session';
  // Role assignment is identity only — NOT a task, dispatch, or work brief.
  // Agents must ack and wait; they must not hunt tickets or start work.
  return [
    'ROLE ASSIGNMENT ONLY — not a task, not a brief, not a dispatch.',
    `Your session role is now: ${normalized}`,
    `Roster label: ${name}`,
    '',
    'Required response: ack only (one short sentence). Then STOP and wait.',
    'Do NOT: ticket_list, ticket_get, explore, plan, build, dispatch, search for work, or invent a next step.',
    'Work starts only on an explicit user brief or ticket_dispatch — never from role assignment alone.',
    '',
    'Role card (identity context for later; do not execute it now):',
    card,
  ].join('\n');
}

function readRegistry(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed?.sessions)) return parsed;
  } catch { /* ignore */ }
  return { version: 1, sessions: [] };
}

function readClaudeParentSession(pid) {
  if (!pid) return null;
  const p = path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const sessionId = parsed?.sessionId || parsed?.session_id || null;
    return {
      session_id: sessionId ? String(sessionId) : null,
      name: parsed?.name ? String(parsed.name) : null,
      project_path: parsed?.cwd || parsed?.projectPath || parsed?.project_path || null,
    };
  } catch {
    return null;
  }
}

function writeRegistry(file, reg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, file);
}

function withFileLock(lockPath, fn) {
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* ignore */ }
  for (let i = 0; i < 50; i++) {
    try {
      fs.mkdirSync(lockPath);
      try { return fn(); }
      finally { try { fs.rmdirSync(lockPath); } catch { /* ignore */ } }
    } catch (err) {
      if (err?.code === 'EEXIST') {
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > 5000) fs.rmdirSync(lockPath);
        } catch { /* ignore */ }
        const wait = Date.now() + 20;
        while (Date.now() < wait) { /* brief spin */ }
        continue;
      }
      throw err;
    }
  }
  throw new Error(`failed to acquire ${lockPath}`);
}

function normalizeRole(role) {
  if (role == null || role === '' || role === 'clear') return null;
  const value = normalizeRoleName(role);
  const roles = roleNames();
  if (!roles.includes(value)) {
    throw new Error(`invalid session role: ${value} (expected ${roles.join('|')} or clear)`);
  }
  return value;
}

function validateBy(by) {
  if (!SESSION_ROLE_UPDATED_BY.includes(by)) {
    throw new Error(`invalid role updater: ${by} (expected ${SESSION_ROLE_UPDATED_BY.join('|')})`);
  }
}

function projectIdFor(root) {
  const base = path.basename(root || 'project');
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const hash = crypto.createHash('sha256').update(String(root || '')).digest('hex').slice(0, 6);
  return `${slug}-${hash}`;
}

function appendRoleJournal(row, role, by, ts) {
  const projectId = row.project_id || (row.project_path ? projectIdFor(row.project_path) : null);
  if (!projectId) return;
  try {
    const dir = path.join(golemHome(), 'journals', projectId);
    fs.mkdirSync(dir, { recursive: true });
    const text = `session role ${role ?? 'cleared'} for ${row.name || row.session_id} by ${by}`;
    fs.appendFileSync(path.join(dir, 'hook.jsonl'), JSON.stringify({
      ts,
      event: 'milestone',
      session_id: row.session_id,
      project_id: projectId,
      text,
    }) + '\n');
  } catch { /* audit is best-effort; role write already succeeded */ }
}

function roleTargetForSession(reg, sessionId) {
  const channels = readChannels();
  const channel = channels.find((c) => c.session_id === sessionId && pidAlive(c.pid))
    || channels.find((c) => c.session_id === sessionId);
  const facts = readSessionFacts();
  const fact = facts.find((row) => row.canonical_id === sessionId) ?? null;
  const lease = readEndpointLeases({ includeExpired: true })
    .find((row) => row.canonical_id === sessionId) ?? null;
  const exactIdx = reg.sessions.findIndex((s) => s.session_id === sessionId);
  if (exactIdx >= 0) {
    return {
      index: exactIdx,
      row: reg.sessions[exactIdx],
      canonical_id: sessionId,
      parent: null,
      channel,
      fact,
      lease,
      created: false,
    };
  }

  const parent = readClaudeParentSession(channel?.pid);
  const canonicalId = parent?.session_id || sessionId;
  const canonicalFact = canonicalId === sessionId
    ? fact
    : (facts.find((row) => row.canonical_id === canonicalId) ?? fact);
  const canonicalLease = canonicalId === sessionId
    ? lease
    : (readEndpointLeases({ includeExpired: true }).find((row) => row.canonical_id === canonicalId) ?? lease);

  if (canonicalId !== sessionId) {
    const canonicalIdx = reg.sessions.findIndex((s) => s.session_id === canonicalId);
    if (canonicalIdx >= 0) {
      return { index: canonicalIdx, row: reg.sessions[canonicalIdx], canonical_id: canonicalId, parent, channel, fact: canonicalFact, lease: canonicalLease, created: false };
    }
  }

  if (channel?.pid) {
    const byPidIdx = reg.sessions.findIndex((s) => Number(s.hook_ppid) === Number(channel.pid));
    if (byPidIdx >= 0) {
      return { index: byPidIdx, row: reg.sessions[byPidIdx], canonical_id: canonicalId, parent, channel, fact: canonicalFact, lease: canonicalLease, created: false };
    }
  }

  // Only materialize a sessions.json row when identity evidence already exists
  // (fact, live/known channel, or lease). Never invent rows for unknown ids —
  // that resurfaced zombie Codex cards and extended their recency TTL.
  if (!canonicalFact && !channel && !canonicalLease && !parent) {
    throw new Error(`session not found: ${sessionId}`);
  }

  const projectPath = parent?.project_path || canonicalFact?.project_path || channel?.project_path || channel?.cwd || null;
  // Preserve fact observation time for last_seen_at so role assign cannot
  // refresh zombie recency windows.
  const observed = canonicalFact?.observed_at || null;
  const row = {
    session_id: canonicalId,
    hook_ppid: channel?.pid ? Number(channel.pid) : null,
    project_id: canonicalFact?.project_id || canonicalFact?.observations?.project_id || channel?.project_id || (projectPath ? projectIdFor(projectPath) : null),
    project_path: projectPath,
    harness: canonicalFact?.harness || canonicalLease?.harness || channel?.harness || undefined,
    name: parent?.name || canonicalFact?.name || channel?.name || null,
    boot_time: observed || new Date().toISOString(),
    last_seen_at: observed || null,
  };
  reg.sessions.push(row);
  return { index: reg.sessions.length - 1, row, canonical_id: canonicalId, parent, channel, fact: canonicalFact, lease: canonicalLease, created: true };
}

export function setSessionRole(sessionId, role, { by } = {}) {
  if (!sessionId) throw new Error('session id is required');
  validateBy(by);
  const nextRole = normalizeRole(role);
  const file = sessionsJsonPath();
  const now = new Date().toISOString();
  return withFileLock(`${file}.lock`, () => {
    const reg = readRegistry(file);
    const target = roleTargetForSession(reg, sessionId);
    const harness = target.row?.harness || target.fact?.harness || target.lease?.harness || target.channel?.harness || null;
    const base = target.row || {};
    const updated = {
      ...base,
      session_id: target.canonical_id || sessionId,
      hook_ppid: base.hook_ppid ?? (target.channel?.pid ? Number(target.channel.pid) : null),
      project_id: base.project_id || target.fact?.project_id || target.fact?.observations?.project_id || target.channel?.project_id
        || ((base.project_path || target.fact?.project_path) ? projectIdFor(base.project_path || target.fact.project_path) : null),
      project_path: base.project_path || target.parent?.project_path || target.fact?.project_path || target.channel?.project_path || target.channel?.cwd || null,
      harness: base.harness || target.fact?.harness || target.lease?.harness || target.channel?.harness,
      name: base.name || target.parent?.name || target.fact?.name || target.channel?.name || null,
      // Role writes must never refresh last_seen_at (zombie TTL / recency).
      last_seen_at: base.last_seen_at ?? target.fact?.observed_at ?? null,
      role: nextRole,
      role_updated_at: now,
      role_updated_by: by,
    };
    reg.sessions = reg.sessions.filter((s, idx) => idx !== target.index && s.session_id !== updated.session_id);
    reg.sessions.push(updated);
    writeRegistry(file, reg);
    appendRoleJournal(updated, nextRole, by, now);
    return updated;
  });
}

function pidAlive(pid) {
  if (!pid || pid === 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function readChannels() {
  try {
    const parsed = JSON.parse(fs.readFileSync(channelsJsonPath(), 'utf8'));
    return Array.isArray(parsed?.channels) ? parsed.channels : [];
  } catch {
    return [];
  }
}

export async function pushRoleBriefDirect(sessionId, role, row = {}) {
  const content = roleChangeBrief(role, { session_id: sessionId, ...row });
  if (!sessionId || !content) return { ok: false, skipped: true };
  const ch = readChannels().find((c) => c.session_id === sessionId && pidAlive(c.pid));
  const managedCodex = readEndpointLeases().find((lease) => (
    lease.canonical_id === sessionId && lease.harness === 'codex'
  ));
  if (!ch && managedCodex) {
    // A role is persisted above, but a managed App Server must never receive
    // an uncorrelated generic /role event. An explicit ticket dispatch is the
    // supported activation path; an operator may also stop/restart the
    // supervisor after changing its role context.
    return {
      ok: false,
      gated: true,
      status: 409,
      error: 'managed Codex role activation is gated: the role was saved, but no generic /role is injected into an App Server thread. Use an explicit ticket dispatch to activate work, or restart the managed Codex supervisor before its next dispatch.',
      target: `http://${managedCodex.host}:${managedCodex.port}`,
    };
  }
  const baseUrl = ch?.url || (ch?.host && ch?.port ? `http://${ch.host}:${ch.port}` : null);
  if (!baseUrl) return { ok: false, skipped: true };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    // POST /role → channel kind role_assign (no-op identity), never /brief (work).
    const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/role`, {
      method: 'POST',
      headers: { 'X-Sender': 'cli', 'Content-Type': 'text/plain' },
      body: content,
      signal: ctl.signal,
    });
    return { ok: resp.ok, status: resp.status, target: baseUrl };
  } catch {
    return { ok: false, skipped: true, target: baseUrl };
  } finally {
    clearTimeout(timer);
  }
}

export function validateSessionRole(role) {
  return normalizeRole(role);
}
