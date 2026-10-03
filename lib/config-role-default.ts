// Internal shell bridge: preserve the shell's raw role value and filename gate.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './golem-config.ts';
import { VersionedFileError } from './read-versioned.ts';

export function rawDefaultSessionRole(): string {
  const roles = loadConfig().roles;
  if (!roles || !Object.hasOwn(roles, 'default')) return 'lead';
  return roles.default ?? '';
}
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.stdout.write(rawDefaultSessionRole());
  } catch (error) {
    console.error(
      error instanceof VersionedFileError
        ? error.message
        : 'CONFIG_ROLE_DEFAULT_FAILED: unable to read configuration; repair the config or helper installation before retrying.',
    );
    process.exitCode = 1;
  }
}
