// Versioned JSONL header owner for journal and spool files (S1/C2).
//
// New files start with one header line, `{"schema_version":1,"kind":...}`.
// Legacy files without a header keep every data line and are never rewritten
// by reads. A higher header version is refused; malformed data lines are
// skipped by readers, preserving the existing best-effort feed behavior.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateJournalHeader, validateSpoolHeader, } from './contracts/store-validator.js';
import { VersionedFileError } from "./read-versioned.js";
function jsonlHeaderLine(kind) {
    return JSON.stringify({ schema_version: 1, kind });
}
function headerValidator(kind) {
    return kind === 'journal' ? validateJournalHeader : validateSpoolHeader;
}
/** True when a raw line is a v1 header; used to skip it while streaming. */
export function isJsonlHeaderLine(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return false;
    }
    return (validateJournalHeader(parsed) ||
        (parsed !== null &&
            typeof parsed === 'object' &&
            parsed.schema_version === 1 &&
            validateSpoolHeader(parsed)));
}
/**
 * Publish the header for a new file without ever truncating another writer.
 * The header is written to a unique temp file in the same directory, synced,
 * then hard-linked to the target name: the link wins exactly once and fails
 * with EEXIST when another process published first. The temp is unlinked in
 * every case. Legacy files stay untouched; no path is ever truncated here.
 */
export function ensureJsonlHeader(file, kind) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.header-${process.pid}-${randomUUID()}.tmp`;
    let fd;
    try {
        fd = fs.openSync(tmp, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, 0o600);
    }
    catch (error) {
        if (error.code === 'EEXIST')
            return;
        throw error;
    }
    try {
        fs.writeSync(fd, `${jsonlHeaderLine(kind)}\n`);
        fs.fsyncSync(fd);
    }
    finally {
        try {
            fs.closeSync(fd);
        }
        catch {
            /* a failed close still leaves the synced temp for linking */
        }
    }
    try {
        fs.linkSync(tmp, file);
    }
    catch (error) {
        if (error.code !== 'EEXIST') {
            try {
                fs.unlinkSync(tmp);
            }
            catch {
                /* temp cleanup is best-effort; the publish itself failed */
            }
            throw error;
        }
    }
    try {
        fs.unlinkSync(tmp);
    }
    catch {
        /* temp cleanup is best-effort; the header is already published */
    }
}
function parseDataLines(lines) {
    const values = [];
    for (const line of lines) {
        if (!line)
            continue;
        try {
            values.push(JSON.parse(line));
        }
        catch {
            /* malformed data lines stay skipped, as before */
        }
    }
    return values;
}
/**
 * Read a JSONL file minus its header. Missing files read as empty legacy;
 * other IO failures refuse. Never creates or rewrites the file.
 */
export function readJsonl(file, kind) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { version: 0, kind: null, migrated: false, values: [] };
        throw new VersionedFileError('VERSIONED_FILE_IO', file, 500, error);
    }
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '')
        lines.pop();
    if (!lines.length)
        return { version: 0, kind: null, migrated: false, values: [] };
    let first;
    try {
        first = JSON.parse(lines[0]);
    }
    catch {
        first = null;
    }
    if (first !== null &&
        typeof first === 'object' &&
        Object.hasOwn(first, 'schema_version')) {
        const record = first;
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
export function assertJsonlReadable(file, _kind) {
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw new VersionedFileError('VERSIONED_FILE_IO', file, 500, error);
    }
    try {
        const buffer = Buffer.alloc(512);
        const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const first = buffer.subarray(0, read).toString('utf8').split('\n')[0];
        if (!first)
            return;
        let parsed;
        try {
            parsed = JSON.parse(first);
        }
        catch {
            return;
        }
        if (parsed === null ||
            typeof parsed !== 'object' ||
            !Object.hasOwn(parsed, 'schema_version'))
            return;
        const record = parsed;
        if (typeof record.schema_version !== 'number')
            throw new VersionedFileError('VERSIONED_VERSION_INVALID', file);
        if (record.schema_version !== 1)
            throw new VersionedFileError('VERSIONED_VERSION_UNSUPPORTED', file);
    }
    finally {
        try {
            fs.closeSync(fd);
        }
        catch {
            /* probe handle is best-effort */
        }
    }
}
/** Ensure the header exists, then append one JSON entry line. */
export function appendJsonl(file, kind, entry) {
    ensureJsonlHeader(file, kind);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}
/**
 * Lenient feed read for best-effort consumers: missing or unreadable files
 * read as no values (the feed predates the file), while version and data
 * errors refuse. Callers stay mechanical: no catch, no classification.
 */
export function readJournalValues(file, kind) {
    let read;
    try {
        read = readJsonl(file, kind);
    }
    catch (error) {
        if (error instanceof VersionedFileError &&
            (error.code === 'VERSIONED_VERSION_UNSUPPORTED' ||
                error.code === 'VERSIONED_VERSION_INVALID' ||
                error.code === 'VERSIONED_DATA_INVALID'))
            throw error;
        return null;
    }
    return read.values;
}
