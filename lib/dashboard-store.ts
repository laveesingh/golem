// Versioned owner for dashboard.json (S1/C2).
//
// The dashboard self-registers this file at startup; discovery readers fall
// back to the canonical URL when it is missing or unusable. Reads never
// create or rewrite the file; only explicit save stamps schema_version 1.
// Unknown extension JSON is preserved; a higher stored version is refused.

import {
  validateDashboard,
  validateLegacyDashboard,
} from './contracts/store-validator.js';
import type { DashboardStore } from './contracts/stores.ts';
import { dashboardJsonPath } from './golem-home.js';
import { VersionedFileError } from './read-versioned.ts';
import type { StoreSchema } from './versioned-store.ts';
import { readVersioned, writeVersioned } from './versioned-store.ts';

const defaults = (): DashboardStore => ({ schema_version: 1 });

const schema: StoreSchema<DashboardStore> = Object.assign(validateDashboard, {
  default: defaults,
});

const migrations = {
  0: (value: unknown): DashboardStore => {
    if (!validateLegacyDashboard(value))
      throw new VersionedFileError(
        'VERSIONED_DATA_INVALID',
        dashboardJsonPath(),
      );
    return { ...(value as Record<string, unknown>), schema_version: 1 };
  },
};

export function loadDashboardStore(file = dashboardJsonPath()): {
  value: DashboardStore;
  version: number;
  migrated: boolean;
} {
  return readVersioned(file, { schema, current: 1, migrations });
}

export function saveDashboardStore(
  input: unknown,
  file = dashboardJsonPath(),
): void {
  writeVersioned(file, input, { schema: validateDashboard, version: 1 });
}

export const DASHBOARD_FALLBACK_URL = 'http://dashboard.golem.localhost:7420';

/** Existing discovery contract: missing/unusable file falls back; v1 url wins. */
export function dashboardBaseUrlFrom(file = dashboardJsonPath()): string {
  let value: DashboardStore;
  try {
    value = loadDashboardStore(file).value;
  } catch {
    return DASHBOARD_FALLBACK_URL;
  }
  if (typeof value?.url === 'string' && value.url.trim())
    return value.url.replace(/\/+$/, '');
  if (value?.host && value?.port) return `http://${value.host}:${value.port}`;
  return DASHBOARD_FALLBACK_URL;
}
