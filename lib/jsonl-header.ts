// Versioned JSONL header owner for journal and spool files (S1/C2).
//
// New files start with one header line, `{"schema_version":1,"kind":...}`.
// Legacy files without a header keep every data line and are never rewritten
// by reads. A higher header version is refused; malformed data lines are
// skipped by readers, preserving the existing best-effort feed behavior.

import fs from 'node:fs';
import path from 'node:path';
import {
  validateJournalHeader,
  validateSpoolHeader,
} from './contracts/store-validator.js';
import { VersionedFileError } from './read-versioned.ts';

export type JsonlKind = 'journal' | 'spool';

function jsonlHeaderLine(kind: JsonlKind): string {
  return JSON.stringify({ schema_version: 1, kind });
}

function headerValidator(kind: JsonlKind): (value: unknown) => boolean {
  return kind === 'journal' ? validateJournalHeader : validateSpoolHeader;
}

/** True when a raw line is a v1 header; used to skip it while streaming. */
export function isJsonlHeaderLine(line: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  return (
    validateJournalHeader(parsed) ||
    (parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as Record<string, unknown>).schema_version === 1 &&
      validateSpoolHeader(parsed))
  );
}

/** Create parent dirs and a header-only file; legacy nonempty files untouched. */
export function ensureJsonlHeader(file: string, kind: JsonlKind): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      return;
    }
    if (!stat.isFile() || stat.size > 0) return;
    try {
      fs.writeFileSync(file, `${jsonlHeaderLine(kind)}\n`, { mode: 0o600 });
    } catch {
      /* best-effort seeding of a raced empty file */
    }
    return;
  }
  try {
    fs.writeSync(fd, `${jsonlHeaderLine(kind)}\n`);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* creation already succeeded */
    }
  }
}

export interface JsonlRead {
  version: 0 | 1;
  kind: JsonlKind | null;
  migrated: boolean;
  values: unknown[];
}

function parseDataLines(lines: string[]): unknown[] {
  const values: unknown[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      /* malformed data lines stay skipped, as before */
    }
  }
  return values;
}

/**
 * Read a JSONL file minus its header. Missing files read as empty legacy;
 * other IO failures refuse. Never creates or rewrites the file.
 */
export function readJsonl(file: string, kind: JsonlKind): JsonlRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { version: 0, kind: null, migrated: false, values: [] };
    throw new VersionedFileError('VERSIONED_FILE_IO', file, 500, error);
  }
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length)
    return { version: 0, kind: null, migrated: false, values: [] };
  let first: unknown;
  try {
    first = JSON.parse(lines[0]);
  } catch {
    first = null;
  }
  if (
    first !== null &&
    typeof first === 'object' &&
    Object.hasOwn(first as Record<string, unknown>, 'schema_version')
  ) {
    const record = first as Record<string, unknown>;
    if (typeof record.schema_version !== 'number')
      throw new VersionedFileError('VERSIONED_VERSION_INVALID', file);
    if (record.schema_version !== 1)
      throw new VersionedFileError('VERSIONED_VERSION_UNSUPPORTED', file);
    if (!headerValidator(kind)(first))
      throw new VersionedFileError('VERSIONED_DATA_INVALID', file);
    return {
      version: 1,
      kind,
      migrated: false,
      values: parseDataLines(lines.slice(1)),
    };
  }
  return {
    version: 0,
    kind: null,
    migrated: lines.length > 0,
    values: parseDataLines(lines),
  };
}

/**
 * Cheap first-line version check before streaming a large journal. Missing
 * files are legacy-empty; other IO failures refuse. Never writes.
 */
export function assertJsonlReadable(file: string, _kind: JsonlKind): void {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new VersionedFileError('VERSIONED_FILE_IO', file, 500, error);
  }
  try {
    const buffer = Buffer.alloc(512);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, read).toString('utf8').split('\n')[0];
    if (!first) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(first);
    } catch {
      return;
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !Object.hasOwn(parsed as Record<string, unknown>, 'schema_version')
    )
      return;
    const record = parsed as Record<string, unknown>;
    if (typeof record.schema_version !== 'number')
      throw new VersionedFileError('VERSIONED_VERSION_INVALID', file);
    if (record.schema_version !== 1)
      throw new VersionedFileError('VERSIONED_VERSION_UNSUPPORTED', file);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* probe handle is best-effort */
    }
  }
}

/** Ensure the header exists, then append one JSON entry line. */
export function appendJsonl(
  file: string,
  kind: JsonlKind,
  entry: unknown,
): void {
  ensureJsonlHeader(file, kind);
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}
