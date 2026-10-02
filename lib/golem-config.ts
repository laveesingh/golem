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
  descriptorLost?: boolean;
  expected?: Buffer;
  seal?: fs.Stats;
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
function closeOwned(owned: CapturedFile): void {
  if (owned.closed) return;
  // Mark BEFORE both the ownership probe and close. Neither failure permits retry.
  owned.closed = true;
  try {
    if (!sameNode(fs.fstatSync(owned.fd), owned.identity)) changed(owned.file);
  } catch (error) {
    owned.descriptorLost = true;
    throw error;
  }
  fs.closeSync(owned.fd);
}
function readCaptured(owned: CapturedFile): Buffer {
  if (!sameNode(fs.fstatSync(owned.fd), owned.identity)) changed(owned.file);
  const expected = owned.expected;
  if (!expected) changed(owned.file);
  const bytes = Buffer.alloc(expected.length + 1);
  let count = 0;
  while (count < bytes.length) {
    if (!sameNode(fs.fstatSync(owned.fd), owned.identity)) changed(owned.file);
    const read = fs.readSync(
      owned.fd,
      bytes,
      count,
      bytes.length - count,
      count,
    );
    if (read === 0) break;
    count += read;
  }
  if (
    !sameNode(fs.fstatSync(owned.fd), owned.identity) ||
    !bytes.subarray(0, count).equals(expected)
  )
    changed(owned.file);
  return bytes.subarray(0, count);
}
function sealSnapshot(owned: CapturedFile, parent: CapturedFile): void {
  assertOwned(owned, parent);
  const before = fs.fstatSync(owned.fd);
  readCaptured(owned);
  const after = fs.fstatSync(owned.fd);
  if (!sameFile(before, after)) changed(owned.file);
  // Content was checked against the ORIGINAL expectation, not recaptured data.
  owned.seal = after;
}
function assertSnapshot(
  owned: CapturedFile,
  parent: CapturedFile,
  file = owned.file,
): void {
  assertParent(parent);
  if (!owned.seal || owned.descriptorLost) changed(file);
  const moved = file !== owned.file;
  const matches = (stat: fs.Stats): boolean =>
    sameNode(stat, owned.identity) &&
    stat.size === owned.seal?.size &&
    stat.mtimeMs === owned.seal?.mtimeMs &&
    (moved || stat.ctimeMs === owned.seal?.ctimeMs);
  const current = fs.lstatSync(file);
  if (!current.isFile() || !matches(current)) changed(file);
  let handle = owned;
  if (owned.closed) {
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    // The reopened fd is compared to original authority, never adopted.
    handle = { ...owned, file, fd, closed: false };
  }
  let failure: unknown;
  try {
    const before = fs.fstatSync(handle.fd);
    if (!matches(before)) changed(file);
    readCaptured(handle);
    if (!sameFile(before, fs.fstatSync(handle.fd))) changed(file);
    assertParent(parent);
    if (!matches(fs.lstatSync(file))) changed(file);
  } catch (error) {
    failure = error;
  }
  if (handle !== owned) {
    try {
      closeOwned(handle);
    } catch (error) {
      if (handle.descriptorLost) owned.descriptorLost = true;
      failure = failure
        ? new AggregateError([failure, error], 'snapshot read and close failed')
        : error;
    }
  }
  if (failure) throw failure;
}
function assertOwned(owned: CapturedFile, parent: CapturedFile): void {
  assertParent(parent);
  const current = statOrMissing(owned.file);
  const same = owned.immutable ? sameFile : sameNode;
  if (
    owned.descriptorLost ||
    !current?.isFile() ||
    !same(current, owned.identity) ||
    (!owned.closed && !same(fs.fstatSync(owned.fd), owned.identity))
  )
    changed(owned.file);
}
function assertParent(parent: CapturedFile): void {
  const current = fs.lstatSync(parent.file);
  if (
    parent.descriptorLost ||
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
    bytes = Buffer.from(fs.readFileSync(fd));
    if (!sameFile(fs.fstatSync(fd), original)) changed(file);
    assertTarget(file, original, parent);
  } catch (error) {
    failure = error;
  }
  try {
    closeOwned({ file, fd, identity: original });
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
    fs.constants.O_RDWR |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  // Capture the allocated descriptor, not a later path lookup. If capture fails,
  // retain the path as indeterminate evidence; no fresh stat grants unlink rights.
  try {
    const identity = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    if (!current.isFile() || !sameFile(identity, current)) changed(file);
    return { file, fd, identity };
  } catch (error) {
    // Capture failed: neither the path nor numeric fd has destruction authority.
    throw new AggregateError(
      [error, new VersionedFileError('VERSIONED_FILE_CHANGED', file)],
      'allocation identity unavailable; descriptor and path retained',
    );
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
  let recovery: CapturedFile | undefined;
  let restoredSnapshot: CapturedFile | undefined;
  let prior: Buffer | undefined;
  let original: fs.Stats | null = null;
  let published = false,
    restored = false;
  const failures: unknown[] = [];
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const parentIdentity = fs.lstatSync(dir);
    const fd = fs.openSync(
      dir,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW,
    );
    try {
      parent = { file: dir, fd, identity: parentIdentity };
      if (!sameNode(fs.fstatSync(fd), parentIdentity)) changed(dir);
    } catch (error) {
      try {
        if (parent) closeOwned(parent);
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
      prior = Buffer.from(originalBytes(file, original, parent));
      assertOwned(lock, parent);
      assertTarget(file, original, parent);
      backup = allocate(`${file}.prior-${randomUUID()}`);
      assertOwned(backup, parent);
      assertOwned(lock, parent);
      assertTarget(file, original, parent);
      backup.expected = Buffer.from(prior);
      fs.writeFileSync(backup.fd, Buffer.from(prior));
      sealSnapshot(backup, parent);
      assertSnapshot(backup, parent);
      assertOwned(lock, parent);
      assertTarget(file, original, parent);
      fs.fsyncSync(backup.fd);
      assertSnapshot(backup, parent);
      assertOwned(lock, parent);
      assertTarget(file, original, parent);
    }
    temp = allocate(`${file}.tmp-${randomUUID()}`);
    assertOwned(temp, parent);
    assertOwned(lock, parent);
    assertTarget(file, original, parent);
    temp.expected = Buffer.from(bytes);
    fs.writeFileSync(temp.fd, bytes, 'utf8');
    sealSnapshot(temp, parent);
    assertSnapshot(temp, parent);
    assertOwned(lock, parent);
    assertTarget(file, original, parent);
    fs.fsyncSync(temp.fd);
    assertSnapshot(temp, parent);
    if (backup) assertSnapshot(backup, parent);
    assertOwned(lock, parent);
    assertTarget(file, original, parent);
    // Mark before the syscall: an injected/platform failure after publication
    // must not make cleanup discard the only captured old-byte backup.
    published = true;
    fs.renameSync(temp.file, file);
    assertParent(parent);
    const committed = fs.lstatSync(file);
    if (!sameNode(committed, temp.identity)) changed(file);
    assertSnapshot(temp, parent, file);
    fs.fsyncSync(parent.fd);
    assertParent(parent);
    assertSnapshot(temp, parent, file);
    assertOwned(lock, parent);
  } catch (error) {
    failures.push(error);
  }
  // Close before discarding rollback evidence. Mark a descriptor indeterminate
  // before close, so a throw after actual close cannot cause a reused-fd retry.
  for (const owned of [temp, backup, lock, parent]) {
    if (!owned) continue;
    try {
      closeOwned(owned);
    } catch (error) {
      failures.push(error);
    }
  }
  if (!failures.length && published && parent && lock && temp) {
    try {
      assertOwned(lock, parent);
      assertSnapshot(temp, parent, file);
      if (backup) assertSnapshot(backup, parent);
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
        assertSnapshot(temp, parent, file);
        if (backup) {
          let rollback = backup;
          try {
            assertSnapshot(backup, parent);
          } catch (error) {
            failures.push(error);
            // Keep altered prior evidence. One exclusive recovery allocation may
            // use ORIGINAL bytes only, under all still-original authority fences.
            if (!prior) changed(backup.file);
            assertParent(parent);
            assertOwned(lock, parent);
            assertSnapshot(temp, parent, file);
            recovery = allocate(`${file}.recovery-${randomUUID()}`);
            recovery.expected = Buffer.from(prior);
            assertOwned(recovery, parent);
            assertOwned(lock, parent);
            assertSnapshot(temp, parent, file);
            fs.writeFileSync(recovery.fd, Buffer.from(recovery.expected));
            sealSnapshot(recovery, parent);
            assertOwned(lock, parent);
            assertSnapshot(temp, parent, file);
            fs.fsyncSync(recovery.fd);
            assertSnapshot(recovery, parent);
            closeOwned(recovery);
            rollback = recovery;
          }
          assertSnapshot(rollback, parent);
          assertOwned(lock, parent);
          assertSnapshot(temp, parent, file);
          fs.renameSync(rollback.file, file);
          restoredSnapshot = rollback;
          assertSnapshot(rollback, parent, file);
        } else {
          assertOwned(lock, parent);
          assertSnapshot(temp, parent, file);
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
        let rollbackFailure: unknown;
        const rollbackHandle: CapturedFile = {
          file: parent.file,
          fd: rollbackFd,
          identity: parent.identity,
        };
        try {
          if (!sameNode(fs.fstatSync(rollbackFd), parent.identity))
            changed(parent.file);
          assertParent(parent);
          fs.fsyncSync(rollbackFd);
          assertParent(parent);
          if (restoredSnapshot) assertSnapshot(restoredSnapshot, parent, file);
          else assertTarget(file, null, parent);
        } catch (error) {
          rollbackFailure = error;
        }
        try {
          closeOwned(rollbackHandle);
        } catch (error) {
          rollbackFailure = rollbackFailure
            ? new AggregateError(
                [rollbackFailure, error],
                'rollback fsync and close failed',
              )
            : error;
        }
        if (rollbackFailure) throw rollbackFailure;
      }
    } catch (error) {
      failures.push(error);
    }
  }
  // Every cleanup operation rechecks the originally captured parent/node.
  if (recovery && !recovery.closed) {
    try {
      closeOwned(recovery);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const owned of [temp, lock, backup, recovery]) {
    if (!owned) continue;
    const moved =
      (owned === temp && published) ||
      (restored && owned === (recovery ?? backup));
    const retainBackup =
      owned === backup && published && failures.length > 0 && !restored;
    if (!moved && !retainBackup && parent) {
      try {
        assertOwned(owned, parent);
        if (owned.expected) {
          // A write that failed before sealing is indeterminate evidence, not a
          // completed snapshot that cleanup may destroy.
          assertSnapshot(owned, parent);
        }
        if (published && !restored && temp) assertSnapshot(temp, parent, file);
        else if (restoredSnapshot)
          assertSnapshot(restoredSnapshot, parent, file);
        else assertTarget(file, restored ? null : original, parent);
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
