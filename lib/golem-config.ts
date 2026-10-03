// Config owner: reads are zero-write; only explicit save publishes schema v1.

import type { Config, ConfigJson } from './contracts/config.ts';
import {
  validateConfig,
  validateLegacyConfig,
} from './contracts/config-validator.js';
import { configJsonPath } from './golem-home.js';
import { VersionedFileError } from './read-versioned.ts';
import { readVersioned, writeVersioned } from './versioned-store.ts';

const defaults = (): Config => ({
  schema_version: 1,
  dispatch: { unackedWindowMinutes: 5 },
  harnesses: { claudecode: { enabled: true } },
});
function isObject(
  value: ConfigJson | undefined,
): value is Record<string, ConfigJson> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function deepMerge(base: ConfigJson, override: ConfigJson): ConfigJson {
  if (!isObject(base) || !isObject(override)) return override ?? base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const merged =
      isObject(value) && isObject(base[key])
        ? deepMerge(base[key], value)
        : value;
    // JSON extension names are data, including __proto__; never invoke setters.
    Object.defineProperty(out, key, {
      value: merged,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
export function loadConfig(): Config {
  return deepMerge(
    defaults(),
    readVersioned(configJsonPath(), {
      schema: Object.assign(validateConfig, { default: defaults }),
      current: 1,
      migrations: {
        0: (value) => {
          if (!validateLegacyConfig(value))
            throw new VersionedFileError(
              'VERSIONED_DATA_INVALID',
              configJsonPath(),
            );
          return { ...value, schema_version: 1 };
        },
      },
    }).value,
  ) as Config;
}
export function isHarnessEnabled(target: string): boolean {
  return Boolean(loadConfig().harnesses?.[target]?.enabled);
}

export function saveConfig(input: unknown): void {
  writeVersioned(configJsonPath(), input, {
    schema: validateConfig,
    version: 1,
  });
}
