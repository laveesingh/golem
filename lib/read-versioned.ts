import fs from 'node:fs';

export type FileFailureCode =
  | 'VERSIONED_FILE_IO'
  | 'VERSIONED_FILE_KIND'
  | 'VERSIONED_FILE_CHANGED'
  | 'VERSIONED_JSON_INVALID'
  | 'VERSIONED_DATA_INVALID'
  | 'VERSIONED_VERSION_INVALID'
  | 'VERSIONED_VERSION_UNSUPPORTED';

/** Recovery text intentionally omits raw JSON, schema values and parser text. */
export class VersionedFileError extends Error {
  readonly code: FileFailureCode;
  readonly file: string;
  readonly statusCode: number;
  constructor(
    code: FileFailureCode,
    file: string,
    statusCode = 409,
    cause?: unknown,
  ) {
    super(
      `${code}: refusing ${file}. Recovery: preserve a backup, inspect the file with a compatible Golem version, and explicitly repair or migrate it before retrying.`,
      { cause },
    );
    this.name = 'VersionedFileError';
    this.code = code;
    this.file = file;
    this.statusCode = statusCode;
  }
}
export interface VersionPolicy<T> {
  currentVersion: number;
  validateCurrent: (value: unknown) => value is T;
  validateLegacy: (value: unknown) => boolean;
  migrateLegacy: (value: unknown) => T;
  missing: () => T;
}
interface FileIdentity {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
function identity(stat: fs.Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}
function unchanged(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
export function validateVersioned<T>(
  value: unknown,
  policy: VersionPolicy<T>,
  file: string,
): T {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new VersionedFileError('VERSIONED_DATA_INVALID', file);
  const object = value as Record<string, unknown>;
  if (!Object.hasOwn(object, 'schema_version')) {
    if (!policy.validateLegacy(value))
      throw new VersionedFileError('VERSIONED_DATA_INVALID', file);
    const migrated = policy.migrateLegacy(value);
    if (!policy.validateCurrent(migrated))
      throw new VersionedFileError('VERSIONED_DATA_INVALID', file);
    return migrated;
  }
  const version = object.schema_version;
  if (typeof version !== 'number' || !Number.isInteger(version))
    throw new VersionedFileError('VERSIONED_VERSION_INVALID', file);
  if (version !== policy.currentVersion)
    throw new VersionedFileError('VERSIONED_VERSION_UNSUPPORTED', file);
  if (!policy.validateCurrent(value))
    throw new VersionedFileError('VERSIONED_DATA_INVALID', file);
  return value;
}

/** Pure file boundary: missing alone permits defaults; never mkdir/stamp/write. */
export function readVersioned<T>(file: string, policy: VersionPolicy<T>): T {
  let fd: number;
  let captured: fs.Stats | undefined;
  try {
    try {
      captured = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (captured)
        throw new VersionedFileError('VERSIONED_FILE_CHANGED', file);
      const missing = policy.missing();
      if (!policy.validateCurrent(missing))
        throw new VersionedFileError('VERSIONED_DATA_INVALID', file);
      try {
        fs.lstatSync(file);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ENOENT') return missing;
        throw new VersionedFileError('VERSIONED_FILE_IO', file, 500, probe);
      }
      throw new VersionedFileError('VERSIONED_FILE_CHANGED', file);
    }
    throw new VersionedFileError('VERSIONED_FILE_IO', file, 500, error);
  }
  let result: T | undefined;
  let failure: unknown;
  try {
    const before = fs.fstatSync(fd);
    if (!captured || !unchanged(identity(captured), identity(before)))
      throw new VersionedFileError('VERSIONED_FILE_CHANGED', file);
    if (!before.isFile())
      throw new VersionedFileError('VERSIONED_FILE_KIND', file, 500);
    let text: string;
    try {
      text = fs.readFileSync(fd, 'utf8');
    } catch (error) {
      throw new VersionedFileError('VERSIONED_FILE_IO', file, 500, error);
    }
    const after = fs.fstatSync(fd),
      current = fs.lstatSync(file);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      !unchanged(identity(before), identity(after)) ||
      !unchanged(identity(after), identity(current))
    )
      throw new VersionedFileError('VERSIONED_FILE_CHANGED', file);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new VersionedFileError('VERSIONED_JSON_INVALID', file);
    }
    result = validateVersioned(value, policy, file);
  } catch (error) {
    failure =
      error instanceof VersionedFileError
        ? error
        : new VersionedFileError('VERSIONED_FILE_IO', file, 500, error);
  }
  try {
    // A numeric descriptor is not authority. Never adopt a replacement or close
    // an uncaptured handle; a throwing close is attempted once only.
    const current = fs.fstatSync(fd);
    if (
      !captured ||
      current.dev !== captured.dev ||
      current.ino !== captured.ino ||
      current.mode !== captured.mode
    )
      throw new VersionedFileError('VERSIONED_FILE_CHANGED', file);
    fs.closeSync(fd);
  } catch (error) {
    failure = failure
      ? new VersionedFileError(
          'VERSIONED_FILE_IO',
          file,
          500,
          new AggregateError([failure, error], 'read and close failed'),
        )
      : new VersionedFileError('VERSIONED_FILE_IO', file, 500, error);
  }
  if (failure) throw failure;
  return result as T;
}
