import {
  getRole,
  readRoleRegistry,
  ROLE_EXEC_DEFAULTS,
  THINKING_LEVELS,
  validateRolePreset,
} from './session-role.js';
import { resolveProfile, getRoleDefault, listProfileNames } from './model-profiles.js';

export { ROLE_EXEC_DEFAULTS, THINKING_LEVELS, validateRolePreset };

// Descriptive alias for callers that want to make the global scope explicit.
export const GLOBAL_ROLE_EXEC_DEFAULTS = ROLE_EXEC_DEFAULTS;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanOverrides(overrides) {
  if (!isRecord(overrides)) return {};
  // `profile` is a resolver selector, not an exec field. Keep it out of the
  // merge even though validateRolePreset currently ignores unknown keys.
  return Object.fromEntries(Object.entries(overrides)
    .filter(([key, value]) => key !== 'profile' && value !== undefined));
}

/** The exec-shaped layer a resolved profile contributes on top of a role's exec. */
function profileExecLayer(profileName, { role, explicit = false } = {}) {
  const profile = resolveProfile(profileName);
  if (!profile) {
    const suffix = explicit ? '' : ` (default model profile for role "${role}")`;
    throw new Error(
      `unknown model profile "${profileName}"${suffix}; expected one of: ${listProfileNames().join(', ') || '(none)'}`,
    );
  }
  return { harness: profile.harness || 'pi', provider: profile.provider, model: profile.model, thinking: profile.thinking };
}

/** Resolve a role into its normalized execution attributes.
 *
 * Precedence (GOL-251 D8): an explicit `overrides.profile` beats the role's
 * default model profile, which beats the role's leftover `exec`. The chosen
 * profile's {provider, model, thinking} is copied over the exec fields; the
 * exec's optional `name` survives. Raw overrides still win over everything —
 * `defaults < preset(profile|exec) < overrides` stays intact.
 */
export function resolveRoleExecution(role, overrides = {}) {
  const record = getRole(role);
  if (!record) {
    const available = readRoleRegistry().map(({ name }) => name).join(', ');
    throw new Error(`unknown role "${role}"; expected one of: ${available}`);
  }

  const explicitProfile = typeof overrides.profile === 'string' && overrides.profile.trim()
    ? overrides.profile.trim()
    : null;
  let profileLayer = null;
  if (explicitProfile) {
    profileLayer = profileExecLayer(explicitProfile, { role: record.name, explicit: true });
  } else {
    const defaultProfile = getRoleDefault(record.name);
    if (defaultProfile) profileLayer = profileExecLayer(defaultProfile, { role: record.name });
  }

  const roleExec = record.exec;
  if (!profileLayer && !isRecord(roleExec)) {
    const available = readRoleRegistry()
      .filter(({ exec }) => isRecord(exec))
      .map(({ name }) => name);
    throw new Error(`role "${record.name}" has no execution preset (no default model profile and no exec); roles with presets: ${available.join(', ') || '(none)'}`);
  }
  const merged = {
    ...ROLE_EXEC_DEFAULTS,
    ...(isRecord(roleExec) ? roleExec : {}),
    ...profileLayer,
    ...cleanOverrides(overrides),
  };
  return validateRolePreset(merged, { role: record.name, applyDefaults: false });
}

/**
 * Resolve a role into the Pi argv fragment owned by golem.
 *
 * The returned order is stable: provider, model, thinking, then optional name.
 * `harness` is validated but is not emitted because Pi is the only supported
 * harness in this contract.
 */
export function resolveRolePreset(role, overrides = {}) {
  const exec = resolveRoleExecution(role, overrides);
  return [
    '--provider', exec.provider,
    '--model', exec.model,
    '--thinking', exec.thinking,
    ...(exec.name ? ['--name', exec.name] : []),
  ];
}
