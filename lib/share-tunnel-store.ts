// Versioned owner for share-tunnel.json (S1/C2).
//
// Legacy registries carry publicPort instead of origin; migration stamps
// schema_version 1 in memory and preserves every known field plus unknown
// extension JSON. Reads never create or rewrite the file; only explicit save
// stamps version 1. A higher stored version is refused, never mistaken for
// an absent tunnel.

import path from 'node:path';
import {
  validateLegacyShareTunnel,
  validateShareTunnel,
} from './contracts/store-validator.js';
import type { ShareTunnelStore } from './contracts/stores.ts';
import { VersionedFileError } from './read-versioned.ts';
import type { StoreSchema } from './versioned-store.ts';
import { readVersioned, writeVersioned } from './versioned-store.ts';

export const SHARE_REGISTRY_NAME = 'share-tunnel.json';

export function shareRegistryPath(homeDir: string): string {
  return path.join(homeDir, SHARE_REGISTRY_NAME);
}

const defaults = (): ShareTunnelStore => ({ schema_version: 1 });

const schema: StoreSchema<ShareTunnelStore> = Object.assign(
  validateShareTunnel,
  { default: defaults },
);

const migrations = {
  0: (value: unknown): ShareTunnelStore => {
    if (!validateLegacyShareTunnel(value))
      throw new VersionedFileError(
        'VERSIONED_DATA_INVALID',
        SHARE_REGISTRY_NAME,
      );
    return { ...(value as Record<string, unknown>), schema_version: 1 };
  },
};

export function loadShareTunnelStore(file: string): {
  value: ShareTunnelStore;
  version: number;
  migrated: boolean;
} {
  return readVersioned(file, { schema, current: 1, migrations });
}

export function saveShareTunnelStore(file: string, input: unknown): void {
  writeVersioned(file, input, {
    schema: validateShareTunnel,
    version: 1,
  });
}
