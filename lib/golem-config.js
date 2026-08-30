// golem-config — ~/.golem/config.json: harness enable switches + per-harness
// options (TKT-0576, ADR-6/ADR-8). `golem sync` reads this to decide which
// targets to render; a disabled harness is reported as "disabled", not
// "drifted" (ADR-8).

import fs from 'node:fs';
import path from 'node:path';
import { configJsonPath } from './golem-home.js';

const DEFAULTS = {
  dispatch: {
    // TKT-0607: after a delivery attempt, warn if the target session produces
    // no ticket activity inside this window. Visibility only — no auto-actions.
    unackedWindowMinutes: 5,
  },
  harnesses: {
    claudecode: { enabled: true },
    hermes: { enabled: true },
    // opencode lands dark (P4): disabled by default, empty model map (no
    // guessing at model-tier equivalence — see TKT-0576 research item 3).
    // testedVersion is pinned once P4's adapter is verified against a real
    // opencode build; `golem doctor` warns on skew.
    opencode: { enabled: false, modelMap: {}, testedVersion: null },
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** Load ~/.golem/config.json, merged over defaults. Missing/unreadable file → defaults. */
export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configJsonPath(), 'utf8'));
    return deepMerge(DEFAULTS, raw);
  } catch {
    return deepMerge(DEFAULTS, {});
  }
}

export function saveConfig(cfg) {
  const p = configJsonPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}

export function isHarnessEnabled(target) {
  const cfg = loadConfig();
  return Boolean(cfg.harnesses?.[target]?.enabled);
}
