// Config owner: reads are zero-write; only explicit save publishes schema v1.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config, ConfigJson, LegacyConfig } from './contracts/config.ts';
import {
  validateConfig,
  validateLegacyConfig,
} from './contracts/config-validator.js';
import { configJsonPath } from './golem-home.js';
import type { VersionPolicy } from './read-versioned.ts';
import {
  readVersioned,
  VersionedFileError,
  validateVersioned,
} from './read-versioned.ts';

const defaults = (): Config => ({
  schema_version: 1,
  dispatch: { unackedWindowMinutes: 5 },
  harnesses: { claudecode: { enabled: true } },
});
const policy: VersionPolicy<Config> = {
  currentVersion: 1,
  validateCurrent: validateConfig,
  validateLegacy: validateLegacyConfig,
  migrateLegacy: (value) => ({ ...(value as LegacyConfig), schema_version: 1 }),
  missing: defaults,
};
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
    readVersioned(configJsonPath(), policy),
  ) as Config;
}
export function isHarnessEnabled(target: string): boolean {
  return Boolean(loadConfig().harnesses?.[target]?.enabled);
}

interface CapturedFile {
  file: string;
  fd: number;
  identity: fs.Stats;
  closed?: boolean;
  immutable?: boolean;
}
function sameNode(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}
function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return (
    sameNode(a, b) &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
function statOrMissing(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function changed(file: string): never {
  throw new VersionedFileError('VERSIONED_FILE_CHANGED', file);
}
function assertOwned(owned: CapturedFile, parent: CapturedFile): void {
  assertParent(parent);
  const current = statOrMissing(owned.file);
  const same = owned.immutable ? sameFile : sameNode;
  if (
    !current?.isFile() ||
    !same(current, owned.identity) ||
    (!owned.closed && !same(fs.fstatSync(owned.fd), owned.identity))
  )
    changed(owned.file);
}
function assertParent(parent: CapturedFile): void {
  const current = fs.lstatSync(parent.file);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameNode(current, parent.identity) ||
    (!parent.closed && !sameNode(fs.fstatSync(parent.fd), parent.identity))
  )
    changed(parent.file);
}
function assertTarget(
  file: string,
  original: fs.Stats | null,
  parent: CapturedFile,
): void {
  assertParent(parent);
  const current = statOrMissing(file);
  if (
    original === null
      ? current !== null
      : !current?.isFile() || !sameFile(current, original)
  )
    changed(file);
}
function originalBytes(
  file: string,
  original: fs.Stats,
  parent: CapturedFile,
): Buffer {
  assertTarget(file, original, parent);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  let bytes: Buffer | undefined;
  let failure: unknown;
  try {
    if (!sameFile(fs.fstatSync(fd), original)) changed(file);
    bytes = fs.readFileSync(fd);
    if (!sameFile(fs.fstatSync(fd), original)) changed(file);
    assertTarget(file, original, parent);
  } catch (error) {
    failure = error;
  }
  try {
    fs.closeSync(fd);
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], 'original read and close failed')
      : error;
  }
  if (failure) throw failure;
  if (bytes === undefined)
    throw new VersionedFileError('VERSIONED_FILE_IO', file, 500);
  return bytes;
}
function allocate(file: string): CapturedFile {
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  // Capture the allocated descriptor, not a later path lookup. If capture fails,
  // retain the path as indeterminate evidence; no fresh stat grants unlink rights.
  try {
    return { file, fd, identity: fs.fstatSync(fd) };
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch (close) {
      throw new AggregateError(
        [error, close],
        'allocation capture and close failed',
      );
    }
    throw error;
  }
}
/** Validate caller input before allocation. Stored refusals stay 409, IO 500. */
export function saveConfig(input: unknown): void {
  const file = configJsonPath();
  let bytes: string;
  try {
    const value = validateVersioned(input, policy, file);
    bytes = `${JSON.stringify(value, null, 2)}\n`;
    // Detached JSON snapshot prevents getters or later mutations changing publication.
    if (!validateConfig(JSON.parse(bytes)))
      throw new Error('invalid config snapshot');
  } catch (error) {
    throw new VersionedFileError('VERSIONED_DATA_INVALID', file, 400, error);
  }
  let parent: CapturedFile | undefined,
    lock: CapturedFile | undefined,
    temp: CapturedFile | undefined;
  let backup: CapturedFile | undefined;
  let original: fs.Stats | null = null;
  let published = false,
    restored = false;
  const failures: unknown[] = [];
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(
      dir,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW,
    );
    try {
      parent = { file: dir, fd, identity: fs.fstatSync(fd) };
    } catch (error) {
      try {
        fs.closeSync(fd);
      } catch (close) {
        throw new AggregateError(
          [error, close],
          'parent capture and close failed',
        );
      }
      throw error;
    }
    assertParent(parent);
    original = statOrMissing(file);
    if (original && (!original.isFile() || original.isSymbolicLink()))
      throw new VersionedFileError('VERSIONED_FILE_KIND', file, 500);
    assertTarget(file, original, parent);
    try {
      lock = allocate(`${file}.lock`);
      lock.immutable = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new VersionedFileError(
          'VERSIONED_FILE_CHANGED',
          `${file}.lock`,
          409,
          error,
        );
      throw error;
    }
    assertOwned(lock, parent);
    assertTarget(file, original, parent);
    // A refused stored file is never replaced by a caller's valid/default config.
    readVersioned(file, policy);
    assertOwned(lock, parent);
    assertTarget(file, original, parent);
    if (original) {
      const prior = originalBytes(file, original, parent);
      assertOwned(lock, parent);
      assertTarget(file, original, parent);
      backup = allocate(`${file}.prior-${randomUUID()}`);
      assertOwned(backup, parent);
      assertOwned(lock, parent);
      assertTarget(file, original, parent);
      fs.writeFileSync(backup.fd, prior);
      assertOwned(backup, parent);
      assertOwned(lock, parent);
      assertTarget(file, original, parent);
      fs.fsyncSync(backup.fd);
      assertOwned(backup, parent);
      assertOwned(lock, parent);
      assertTarget(file, original, parent);
    }
    temp = allocate(`${file}.tmp-${randomUUID()}`);
    assertOwned(temp, parent);
    assertOwned(lock, parent);
    assertTarget(file, original, parent);
    fs.writeFileSync(temp.fd, bytes, 'utf8');
    assertOwned(temp, parent);
    assertOwned(lock, parent);
    assertTarget(file, original, parent);
    fs.fsyncSync(temp.fd);
    assertOwned(temp, parent);
    assertOwned(lock, parent);
    assertTarget(file, original, parent);
    // Mark before the syscall: an injected/platform failure after publication
    // must not make cleanup discard the only captured old-byte backup.
    published = true;
    fs.renameSync(temp.file, file);
    assertParent(parent);
    const committed = fs.lstatSync(file);
    if (!sameNode(committed, temp.identity)) changed(file);
    fs.fsyncSync(parent.fd);
    assertParent(parent);
    if (!sameNode(fs.lstatSync(file), temp.identity)) changed(file);
    assertOwned(lock, parent);
  } catch (error) {
    failures.push(error);
  }
  // Close before discarding rollback evidence. Mark a descriptor indeterminate
  // before close, so a throw after actual close cannot cause a reused-fd retry.
  for (const owned of [temp, backup, lock, parent]) {
    if (!owned) continue;
    owned.closed = true;
    try {
      fs.closeSync(owned.fd);
    } catch (error) {
      failures.push(error);
    }
  }
  if (!failures.length && published && parent && lock && temp) {
    try {
      assertOwned(lock, parent);
      if (!sameNode(fs.lstatSync(file), temp.identity)) changed(file);
    } catch (error) {
      failures.push(error);
    }
  }
  // Rollback uses only captured identities. If any path/lock was replaced,
  // retain the old-byte backup and published evidence rather than touching it.
  if (failures.length && published && parent && lock && temp) {
    try {
      assertParent(parent);
      assertOwned(lock, parent);
      const current = statOrMissing(file);
      const untouched =
        original === null
          ? current === null
          : current !== null && sameFile(current, original);
      if (untouched) {
        published = false;
      } else {
        if (!current || !sameNode(current, temp.identity)) changed(file);
        if (backup) {
          assertOwned(backup, parent);
          assertOwned(lock, parent);
          if (!sameNode(fs.lstatSync(file), temp.identity)) changed(file);
          fs.renameSync(backup.file, file);
        } else {
          assertOwned(lock, parent);
          if (!sameNode(fs.lstatSync(file), temp.identity)) changed(file);
          fs.unlinkSync(file);
        }
        restored = true;
        assertParent(parent);
        // Reopened descriptor is checked against the original parent, not treated
        // as new authority. The backup's bytes were already fsynced pre-publication.
        const rollbackFd = fs.openSync(
          parent.file,
          fs.constants.O_RDONLY |
            fs.constants.O_DIRECTORY |
            fs.constants.O_NOFOLLOW,
        );
        try {
          if (!sameNode(fs.fstatSync(rollbackFd), parent.identity))
            changed(parent.file);
          assertParent(parent);
          fs.fsyncSync(rollbackFd);
          assertParent(parent);
        } finally {
          fs.closeSync(rollbackFd);
        }
      }
    } catch (error) {
      failures.push(error);
    }
  }
  // Every cleanup operation rechecks the originally captured parent/node.
  for (const owned of [temp, lock, backup]) {
    if (!owned) continue;
    const moved =
      (owned === temp && published) || (owned === backup && restored);
    const retainBackup =
      owned === backup && published && failures.length > 0 && !restored;
    if (!moved && !retainBackup && parent) {
      try {
        assertOwned(owned, parent);
        if (
          published &&
          !restored &&
          temp &&
          !sameNode(fs.lstatSync(file), temp.identity)
        )
          changed(file);
        fs.unlinkSync(owned.file);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length) {
    const first = failures[0];
    if (failures.length === 1 && first instanceof VersionedFileError)
      throw first;
    throw new VersionedFileError(
      'VERSIONED_FILE_IO',
      file,
      500,
      failures.length === 1
        ? first
        : new AggregateError(failures, 'config save and cleanup failed'),
    );
  }
}
