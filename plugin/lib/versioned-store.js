// Shared versioned-store owner; original config allocation/fencing engine.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readVersioned as readFileVersioned, VersionedFileError, } from "./read-versioned.js";
export function readVersioned(file, { schema, current, migrations }) {
    let migrated = false;
    const migrate = (value, version) => {
        let next = value;
        for (let step = version; step < current; step++) {
            const migration = migrations[step];
            if (!migration)
                throw new VersionedFileError('VERSIONED_VERSION_UNSUPPORTED', file);
            next = migration(next);
        }
        if (!schema(next))
            throw new VersionedFileError('VERSIONED_DATA_INVALID', file);
        migrated = true;
        return next;
    };
    const value = readFileVersioned(file, {
        currentVersion: current,
        validateCurrent: schema,
        validateLegacy: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
        migrateLegacy: (value) => migrate(value, 0),
        migrateVersion: migrate,
        missing: () => {
            const value = schema.default?.() ?? { schema_version: current };
            if (!schema(value))
                throw new VersionedFileError('VERSIONED_DATA_INVALID', file);
            return value;
        },
    });
    return { value, version: current, migrated };
}
function sameNode(a, b) {
    return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}
function sameFile(a, b) {
    return (sameNode(a, b) &&
        a.size === b.size &&
        a.mtimeMs === b.mtimeMs &&
        a.ctimeMs === b.ctimeMs);
}
function statOrMissing(file) {
    try {
        return fs.lstatSync(file);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
function changed(file) {
    throw new VersionedFileError('VERSIONED_FILE_CHANGED', file);
}
function closeOwned(owned) {
    if (owned.closed)
        return;
    // Mark BEFORE both the ownership probe and close. Neither failure permits retry.
    owned.closed = true;
    try {
        if (!sameNode(fs.fstatSync(owned.fd), owned.identity))
            changed(owned.file);
    }
    catch (error) {
        owned.descriptorLost = true;
        throw error;
    }
    fs.closeSync(owned.fd);
}
function readCaptured(owned) {
    if (!sameNode(fs.fstatSync(owned.fd), owned.identity))
        changed(owned.file);
    const expected = owned.expected;
    if (!expected)
        changed(owned.file);
    const bytes = Buffer.alloc(expected.length + 1);
    let count = 0;
    while (count < bytes.length) {
        if (!sameNode(fs.fstatSync(owned.fd), owned.identity))
            changed(owned.file);
        const read = fs.readSync(owned.fd, bytes, count, bytes.length - count, count);
        if (read === 0)
            break;
        count += read;
    }
    if (!sameNode(fs.fstatSync(owned.fd), owned.identity) ||
        !bytes.subarray(0, count).equals(expected))
        changed(owned.file);
    return bytes.subarray(0, count);
}
function sealSnapshot(owned, parent) {
    assertOwned(owned, parent);
    const before = fs.fstatSync(owned.fd);
    readCaptured(owned);
    const after = fs.fstatSync(owned.fd);
    if (!sameFile(before, after))
        changed(owned.file);
    // Content was checked against the ORIGINAL expectation, not recaptured data.
    owned.seal = after;
}
function assertSnapshot(owned, parent, file = owned.file) {
    assertParent(parent);
    if (!owned.seal || owned.descriptorLost)
        changed(file);
    const moved = file !== owned.file;
    const matches = (stat) => sameNode(stat, owned.identity) &&
        stat.size === owned.seal?.size &&
        stat.mtimeMs === owned.seal?.mtimeMs &&
        (moved || stat.ctimeMs === owned.seal?.ctimeMs);
    const current = fs.lstatSync(file);
    if (!current.isFile() || !matches(current))
        changed(file);
    let handle = owned;
    if (owned.closed) {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        // The reopened fd is compared to original authority, never adopted.
        handle = { ...owned, file, fd, closed: false };
    }
    let failure;
    try {
        const before = fs.fstatSync(handle.fd);
        if (!matches(before))
            changed(file);
        readCaptured(handle);
        if (!sameFile(before, fs.fstatSync(handle.fd)))
            changed(file);
        assertParent(parent);
        if (!matches(fs.lstatSync(file)))
            changed(file);
    }
    catch (error) {
        failure = error;
    }
    if (handle !== owned) {
        try {
            closeOwned(handle);
        }
        catch (error) {
            if (handle.descriptorLost)
                owned.descriptorLost = true;
            failure = failure
                ? new AggregateError([failure, error], 'snapshot read and close failed')
                : error;
        }
    }
    if (failure)
        throw failure;
}
function assertOwned(owned, parent) {
    assertParent(parent);
    const current = statOrMissing(owned.file);
    const same = owned.immutable ? sameFile : sameNode;
    if (owned.descriptorLost ||
        !current?.isFile() ||
        !same(current, owned.identity) ||
        (!owned.closed && !same(fs.fstatSync(owned.fd), owned.identity)))
        changed(owned.file);
}
function assertParent(parent) {
    const current = fs.lstatSync(parent.file);
    if (parent.descriptorLost ||
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        !sameNode(current, parent.identity) ||
        (!parent.closed && !sameNode(fs.fstatSync(parent.fd), parent.identity)))
        changed(parent.file);
}
function assertTarget(file, original, parent) {
    assertParent(parent);
    const current = statOrMissing(file);
    if (original === null
        ? current !== null
        : !current?.isFile() || !sameFile(current, original))
        changed(file);
}
function originalBytes(file, original, parent) {
    assertTarget(file, original, parent);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let bytes;
    let failure;
    try {
        if (!sameFile(fs.fstatSync(fd), original))
            changed(file);
        bytes = Buffer.from(fs.readFileSync(fd));
        if (!sameFile(fs.fstatSync(fd), original))
            changed(file);
        assertTarget(file, original, parent);
    }
    catch (error) {
        failure = error;
    }
    try {
        closeOwned({ file, fd, identity: original });
    }
    catch (error) {
        failure = failure
            ? new AggregateError([failure, error], 'original read and close failed')
            : error;
    }
    if (failure)
        throw failure;
    if (bytes === undefined)
        throw new VersionedFileError('VERSIONED_FILE_IO', file, 500);
    return bytes;
}
function allocate(file) {
    const fd = fs.openSync(file, fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW, 0o600);
    // Locked trust boundary: exclusive O_EXCL allocation through initial capture
    // is trusted. A matching fd/path swap inside open before return is a LIMIT,
    // not a portable provenance guarantee. Freeze this identity for every later
    // fence; failed/mismatched capture grants no close/unlink authority.
    try {
        const identity = fs.fstatSync(fd);
        const current = fs.lstatSync(file);
        if (!current.isFile() || !sameFile(identity, current))
            changed(file);
        return { file, fd, identity };
    }
    catch (error) {
        // Capture failed: neither the path nor numeric fd has destruction authority.
        throw new AggregateError([error, new VersionedFileError('VERSIONED_FILE_CHANGED', file)], 'allocation identity unavailable; descriptor and path retained');
    }
}
/** Validate caller input before allocation. Stored refusals stay 409, IO 500. */
export function writeVersioned(file, input, { schema, version }) {
    let bytes;
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new Error('invalid store input');
        const object = input;
        if (Object.hasOwn(object, 'schema_version') &&
            object.schema_version !== version)
            throw new Error('unsupported input version');
        const value = { ...object, schema_version: version };
        // Validate before serialization: stringify drops undefined/functions and
        // maps non-finite numbers to null, which would hide invalid input.
        if (!schema(value))
            throw new Error('invalid store input');
        bytes = `${JSON.stringify(value, null, 2)}\n`;
        // Detached JSON snapshot prevents getters or later mutations changing publication.
        if (!schema(JSON.parse(bytes)))
            throw new Error('invalid store snapshot');
    }
    catch (error) {
        throw new VersionedFileError('VERSIONED_DATA_INVALID', file, 400, error);
    }
    let parent, lock, temp;
    let backup;
    let recovery;
    let restoredSnapshot;
    let prior;
    let original = null;
    let published = false, restored = false, restorationComplete = false;
    const failures = [];
    try {
        const dir = path.dirname(file);
        fs.mkdirSync(dir, { recursive: true });
        const parentIdentity = fs.lstatSync(dir);
        const fd = fs.openSync(dir, fs.constants.O_RDONLY |
            fs.constants.O_DIRECTORY |
            fs.constants.O_NOFOLLOW);
        try {
            parent = { file: dir, fd, identity: parentIdentity };
            if (!sameNode(fs.fstatSync(fd), parentIdentity))
                changed(dir);
        }
        catch (error) {
            try {
                if (parent)
                    closeOwned(parent);
            }
            catch (close) {
                throw new AggregateError([error, close], 'parent capture and close failed');
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
        }
        catch (error) {
            if (error.code === 'EEXIST')
                throw new VersionedFileError('VERSIONED_FILE_CHANGED', `${file}.lock`, 409, error);
            throw error;
        }
        assertOwned(lock, parent);
        assertTarget(file, original, parent);
        // A refused stored file is never replaced by a caller's valid/default config.
        readVersioned(file, {
            schema,
            current: version,
            migrations: {
                0: (value) => ({
                    ...value,
                    schema_version: version,
                }),
            },
        });
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
        if (backup)
            assertSnapshot(backup, parent);
        assertOwned(lock, parent);
        assertTarget(file, original, parent);
        // Mark before the syscall: an injected/platform failure after publication
        // must not make cleanup discard the only captured old-byte backup.
        published = true;
        fs.renameSync(temp.file, file);
        assertParent(parent);
        const committed = fs.lstatSync(file);
        if (!sameNode(committed, temp.identity))
            changed(file);
        assertSnapshot(temp, parent, file);
        fs.fsyncSync(parent.fd);
        assertParent(parent);
        assertSnapshot(temp, parent, file);
        assertOwned(lock, parent);
    }
    catch (error) {
        failures.push(error);
    }
    // Close before discarding rollback evidence. Mark a descriptor indeterminate
    // before close, so a throw after actual close cannot cause a reused-fd retry.
    for (const owned of [temp, backup, lock, parent]) {
        if (!owned)
            continue;
        try {
            closeOwned(owned);
        }
        catch (error) {
            failures.push(error);
        }
    }
    if (!failures.length && published && parent && lock && temp) {
        try {
            assertOwned(lock, parent);
            assertSnapshot(temp, parent, file);
            if (backup)
                assertSnapshot(backup, parent);
        }
        catch (error) {
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
            const untouched = original === null
                ? current === null
                : current !== null && sameFile(current, original);
            if (untouched) {
                published = false;
            }
            else {
                if (!current || !sameNode(current, temp.identity))
                    changed(file);
                assertSnapshot(temp, parent, file);
                if (backup) {
                    let rollback = backup;
                    try {
                        assertSnapshot(backup, parent);
                    }
                    catch (error) {
                        failures.push(error);
                        // Keep altered prior evidence. One exclusive recovery allocation may
                        // use ORIGINAL bytes only, under all still-original authority fences.
                        if (!prior)
                            changed(backup.file);
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
                }
                else {
                    assertOwned(lock, parent);
                    assertSnapshot(temp, parent, file);
                    fs.unlinkSync(file);
                }
                restored = true;
                assertParent(parent);
                // Reopened descriptor is checked against the original parent, not treated
                // as new authority. The backup's bytes were already fsynced pre-publication.
                const rollbackFd = fs.openSync(parent.file, fs.constants.O_RDONLY |
                    fs.constants.O_DIRECTORY |
                    fs.constants.O_NOFOLLOW);
                let rollbackFailure;
                const rollbackHandle = {
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
                    if (restoredSnapshot)
                        assertSnapshot(restoredSnapshot, parent, file);
                    else
                        assertTarget(file, null, parent);
                }
                catch (error) {
                    rollbackFailure = error;
                }
                try {
                    closeOwned(rollbackHandle);
                }
                catch (error) {
                    rollbackFailure = rollbackFailure
                        ? new AggregateError([rollbackFailure, error], 'rollback fsync and close failed')
                        : error;
                }
                if (rollbackFailure)
                    throw rollbackFailure;
                restorationComplete = true;
            }
        }
        catch (error) {
            failures.push(error);
        }
    }
    // Every cleanup operation rechecks the originally captured parent/node.
    if (recovery && !recovery.closed) {
        try {
            closeOwned(recovery);
        }
        catch (error) {
            failures.push(error);
        }
    }
    for (const owned of [temp, lock, backup, recovery]) {
        if (!owned)
            continue;
        const moved = (owned === temp && published) ||
            (restored && owned === (recovery ?? backup));
        // A valid seal proves content, not permission to destroy the last known
        // original snapshot. Rename alone also does not prove completed restoration.
        const retainBackup = owned === backup &&
            published &&
            failures.length > 0 &&
            !restorationComplete;
        const retainRecovery = owned === recovery && failures.length > 0 && !restorationComplete;
        if (!moved && !retainBackup && !retainRecovery && parent) {
            try {
                assertOwned(owned, parent);
                if (owned.expected) {
                    // A write that failed before sealing is indeterminate evidence, not a
                    // completed snapshot that cleanup may destroy.
                    assertSnapshot(owned, parent);
                }
                if (published && !restored && temp)
                    assertSnapshot(temp, parent, file);
                else if (restoredSnapshot)
                    assertSnapshot(restoredSnapshot, parent, file);
                else
                    assertTarget(file, restored ? null : original, parent);
                fs.unlinkSync(owned.file);
            }
            catch (error) {
                failures.push(error);
            }
        }
    }
    if (failures.length) {
        const first = failures[0];
        if (failures.length === 1 && first instanceof VersionedFileError)
            throw first;
        throw new VersionedFileError('VERSIONED_FILE_IO', file, 500, failures.length === 1
            ? first
            : new AggregateError(failures, 'config save and cleanup failed'));
    }
}
