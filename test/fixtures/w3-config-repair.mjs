import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repo } from '../support/sandbox.mjs';

// Native desired-behavior probes. --before loads the actual frozen bad owner
// AND reader, not a handwritten approximation or current reader under old owner.
// --before-recovery uses complete frozen fca for the later retention failure.
const home = process.env.GOLEM_HOME;
const sandbox = process.env.GOLEM_W2_SANDBOX;
assert.ok(home && sandbox, 'owned sandbox required');
const beforeRecovery = process.argv.includes('--before-recovery');
const old = process.argv.includes('--before') || beforeRecovery;
const kind = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7);
assert.ok(
  [
    'snapshot',
    'descriptor',
    'recovery-fsync',
    'recovery-close',
    'recovery-rename',
    'allocation-limit',
  ].includes(kind),
);
assert.ok(!beforeRecovery || kind.startsWith('recovery-'));
assert.ok(!kind.startsWith('recovery-') || !process.argv.includes('--before'));
let owner;
if (old) {
  const baseline = beforeRecovery
    ? 'fca585c2750c2b8c26ed30e3a8b88b9d86bb2051'
    : 'f7332713580c69c316f795f9017444a3d52c3ba0';
  const target = path.join(
    sandbox,
    beforeRecovery ? 'fca-config' : 'f733-config',
  );
  fs.mkdirSync(path.join(target, 'contracts'), { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), '{"type":"module"}', {
    flag: 'wx',
  });
  for (const name of [
    'golem-config.ts',
    'read-versioned.ts',
    'contracts/config-validator.js',
  ]) {
    let source = execFileSync('git', ['show', `${baseline}:lib/${name}`], {
      cwd: repo,
      encoding: 'utf8',
    });
    if (name === 'golem-config.ts')
      source = source.replace(
        "'./golem-home.js'",
        JSON.stringify(
          pathToFileURL(path.join(repo, 'lib/golem-home.js')).href,
        ),
      );
    fs.writeFileSync(path.join(target, name), source, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  owner = await import(
    pathToFileURL(path.join(target, 'golem-config.ts')).href
  );
} else owner = await import('../../lib/golem-config.ts');
if (kind.startsWith('recovery-')) {
  recoveryProbe(owner, kind, old);
} else if (kind === 'allocation-limit') {
  assert.equal(old, false);
  allocationLimit(owner);
} else {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'config.json');
  const bytes = '{ "extension": "captured original bytes" }\n';
  fs.writeFileSync(file, bytes);
  const foreign = path.join(home, 'foreign');
  fs.writeFileSync(foreign, 'unrelated bytes');
  const open = fs.openSync,
    close = fs.closeSync,
    sync = fs.fsyncSync;
  const descriptors = new Map();
  let parentFd,
    foreignFd,
    fired = false,
    failure;
  fs.openSync = (target, ...args) => {
    const fd = open(target, ...args);
    descriptors.set(fd, String(target));
    if (target === home) parentFd = fd;
    return fd;
  };
  fs.fsyncSync = (fd) => {
    if (
      !fired &&
      (kind === 'snapshot'
        ? descriptors.get(fd) === home
        : descriptors.get(fd)?.includes('.tmp-'))
    ) {
      fired = true;
      if (kind === 'snapshot') {
        const backup = fs
          .readdirSync(home)
          .find((name) => name.startsWith('config.json.prior-'));
        assert.ok(backup);
        fs.writeFileSync(
          path.join(home, backup),
          '{"extension":"unexpected modified backup"}',
        );
        throw Error('post-publication parent fsync fixture');
      }
      close(parentFd);
      foreignFd = open(foreign, 'r');
      assert.equal(
        foreignFd,
        parentFd,
        'fault must reuse original numeric parent fd',
      );
    }
    return sync(fd);
  };
  try {
    owner.saveConfig({ extension: 'requested new bytes' });
  } catch (error) {
    failure = error;
  } finally {
    fs.openSync = open;
    fs.closeSync = close;
    fs.fsyncSync = sync;
  }
  assert.ok(fired && failure, 'fault exercised and refused');
  const originalPreserved = fs.readFileSync(file, 'utf8') === bytes;
  let foreignFdOpen = null;
  let foreignFdCode = null;
  if (kind === 'descriptor') {
    try {
      foreignFdOpen = fs.fstatSync(foreignFd).isFile();
    } catch (error) {
      foreignFdOpen = false;
      foreignFdCode = error.code;
    }
  }
  // Negative controls must demonstrate the REPORTED behavior, not any arbitrary
  // failed expectation, setup/import error or unexercised fault.
  if (old && kind === 'snapshot') {
    assert.equal(originalPreserved, false);
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      '{"extension":"unexpected modified backup"}',
    );
  }
  if (old && kind === 'descriptor') {
    assert.equal(foreignFdOpen, false);
    assert.equal(foreignFdCode, 'EBADF');
  }
  function causes(error) {
    return [
      error,
      ...(error?.cause ? causes(error.cause) : []),
      ...(error instanceof AggregateError ? error.errors.flatMap(causes) : []),
    ];
  }
  if (!old && kind === 'snapshot') {
    const failures = causes(failure);
    assert.ok(
      failures.some(
        (error) => error.message === 'post-publication parent fsync fixture',
      ),
    );
    assert.ok(
      failures.some((error) => error.code === 'VERSIONED_FILE_CHANGED'),
    );
  }
  let regressionPassed = false;
  try {
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    if (kind === 'snapshot') {
      const backup = fs
        .readdirSync(home)
        .find((name) => name.startsWith('config.json.prior-'));
      assert.ok(backup, 'modified snapshot evidence retained');
      assert.equal(
        fs.readFileSync(path.join(home, backup), 'utf8'),
        '{"extension":"unexpected modified backup"}',
      );
    } else
      assert.ok(
        fs.fstatSync(foreignFd).isFile(),
        'foreign fd survives detected ownership loss',
      );
    regressionPassed = true;
  } catch (error) {
    if (!old) throw error;
  } finally {
    if (foreignFd !== undefined) {
      try {
        close(foreignFd);
      } catch (error) {
        assert.equal(error.code, 'EBADF');
      }
    }
  }
  console.log(
    JSON.stringify({
      old,
      kind,
      regressionPassed,
      refused: true,
      originalPreserved,
      foreignFdOpen,
      foreignFdCode,
    }),
  );
  assert.equal(
    regressionPassed,
    !old,
    'frozen old must fail desired behavior; repaired source must pass',
  );
}

// Locked7d4b2d93 LIMIT, not a repaired guard: replacing the original fd/path
// INSIDE the primitive before return is outside the trusted capture boundary.
function allocationLimit(owner) {
  fs.mkdirSync(home, { recursive: true });
  const observations = [];
  for (const allocation of ['lock', 'temp'])
    for (const content of ['', 'unknown foreign bytes']) {
      const root = path.join(
        home,
        `limit-${allocation}-${content ? 'nonempty' : 'empty'}`,
      );
      fs.mkdirSync(root);
      process.env.GOLEM_HOME = root;
      const file = path.join(root, 'config.json');
      fs.writeFileSync(file, '{"extension":"original"}');
      const foreign = path.join(root, 'foreign');
      fs.writeFileSync(foreign, content, { mode: 0o600 });
      const rawOpen = fs.openSync,
        rawClose = fs.closeSync;
      let fired = false,
        selected,
        foreignFd,
        failure;
      fs.openSync = (target, ...args) => {
        const fd = rawOpen(target, ...args);
        if (
          !fired &&
          String(target).includes(allocation === 'lock' ? '.lock' : '.tmp-')
        ) {
          fired = true;
          selected = String(target);
          rawClose(fd);
          fs.renameSync(selected, `${selected}.held-original`);
          fs.renameSync(foreign, selected);
          foreignFd = rawOpen(selected, 'r+');
          assert.equal(foreignFd, fd);
        }
        return fd;
      };
      try {
        owner.saveConfig({ extension: 'new' });
      } catch (error) {
        failure = error;
      } finally {
        fs.openSync = rawOpen;
        process.env.GOLEM_HOME = home;
      }
      assert.ok(fired);
      assert.equal(
        failure,
        undefined,
        'documented pre-capture LIMIT, not an in-scope rejection guard',
      );
      assert.throws(() => fs.fstatSync(foreignFd), { code: 'EBADF' });
      assert.ok(fs.existsSync(`${selected}.held-original`));
      assert.equal(JSON.parse(fs.readFileSync(file)).extension, 'new');
      observations.push({
        allocation,
        foreignEmpty: content === '',
        foreignMode: '0600',
        actualAccepted: true,
        foreignFdClosed: true,
        originalAllocationRetainedAside: true,
      });
    }
  console.log(
    JSON.stringify({
      kind: 'allocation-limit',
      classification: 'LIMIT_OUT_OF_SCOPE_PRE_CAPTURE_PRIMITIVE_INTERCEPTION',
      observations,
    }),
  );
}

function recoveryProbe(owner, kind, old) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'config.json');
  const bytes = '{ "extension": "ORIGINAL EXPECTED BYTES" }\n';
  fs.writeFileSync(file, bytes);
  const raw = {
    open: fs.openSync,
    sync: fs.fsyncSync,
    close: fs.closeSync,
    rename: fs.renameSync,
    unlink: fs.unlinkSync,
  };
  const descriptors = new Map();
  let primaryFired = false,
    recoveryFired = false,
    cleanupFired = false;
  let recovery, prior, failure;
  fs.openSync = (target, ...args) => {
    const fd = raw.open(target, ...args);
    descriptors.set(fd, String(target));
    if (String(target).includes('.recovery-')) recovery = String(target);
    return fd;
  };
  fs.fsyncSync = (fd) => {
    if (!primaryFired && descriptors.get(fd) === home) {
      primaryFired = true;
      prior = path.join(
        home,
        fs.readdirSync(home).find((name) => name.includes('.prior-')),
      );
      fs.writeFileSync(prior, 'ALTERED PRIOR');
      throw Error('PRIMARY_PARENT_FSYNC');
    }
    if (
      kind === 'recovery-fsync' &&
      descriptors.get(fd)?.includes('.recovery-')
    ) {
      recoveryFired = true;
      assert.equal(fs.readFileSync(recovery, 'utf8'), bytes);
      throw Error('RECOVERY_FSYNC');
    }
    return raw.sync(fd);
  };
  fs.closeSync = (fd) => {
    raw.close(fd);
    if (
      kind === 'recovery-close' &&
      !recoveryFired &&
      descriptors.get(fd)?.includes('.recovery-')
    ) {
      recoveryFired = true;
      assert.equal(fs.readFileSync(recovery, 'utf8'), bytes);
      throw Error('RECOVERY_CLOSE_AFTER_ACTUAL_CLOSE');
    }
  };
  fs.renameSync = (source, destination) => {
    if (kind === 'recovery-rename' && String(source).includes('.recovery-')) {
      recoveryFired = true;
      assert.equal(fs.readFileSync(source, 'utf8'), bytes);
      throw Error('RECOVERY_RENAME');
    }
    return raw.rename(source, destination);
  };
  fs.unlinkSync = (target) => {
    if (target === `${file}.lock`) {
      cleanupFired = true;
      throw Error('CLEANUP_LOCK_UNLINK');
    }
    return raw.unlink(target);
  };
  try {
    owner.saveConfig({ extension: 'new published bytes' });
  } catch (error) {
    failure = error;
  } finally {
    fs.openSync = raw.open;
    fs.fsyncSync = raw.sync;
    fs.closeSync = raw.close;
    fs.renameSync = raw.rename;
    fs.unlinkSync = raw.unlink;
  }
  assert.ok(
    primaryFired && recoveryFired && cleanupFired && failure,
    'all fault phases exercised',
  );
  assert.equal(fs.readFileSync(prior, 'utf8'), 'ALTERED PRIOR');
  const recoveryExists = fs.existsSync(recovery);
  const originalAnywhere = fs
    .readdirSync(home, { withFileTypes: true })
    .some(
      (entry) =>
        entry.isFile() &&
        fs.readFileSync(path.join(home, entry.name), 'utf8') === bytes,
    );
  if (old) {
    assert.equal(recoveryExists, false, 'actual fca removes sealed recovery');
    assert.equal(
      originalAnywhere,
      false,
      'actual fca loses last ORIGINAL bytes',
    );
  } else {
    assert.ok(
      recoveryExists && originalAnywhere,
      'incomplete restoration retains ORIGINAL recovery',
    );
    assert.equal(fs.readFileSync(recovery, 'utf8'), bytes);
  }
  function tree(error) {
    return [
      error,
      ...(error?.cause ? tree(error.cause) : []),
      ...(error instanceof AggregateError ? error.errors.flatMap(tree) : []),
    ];
  }
  const expected =
    kind === 'recovery-close'
      ? 'RECOVERY_CLOSE_AFTER_ACTUAL_CLOSE'
      : kind === 'recovery-fsync'
        ? 'RECOVERY_FSYNC'
        : 'RECOVERY_RENAME';
  for (const message of [
    'PRIMARY_PARENT_FSYNC',
    expected,
    'CLEANUP_LOCK_UNLINK',
  ])
    assert.ok(
      tree(failure).some((error) => error.message === message),
      message,
    );
  assert.ok(
    tree(failure).some((error) => error.code === 'VERSIONED_FILE_CHANGED'),
  );
  console.log(
    JSON.stringify({
      old,
      kind,
      regressionPassed: recoveryExists && originalAnywhere,
      recoveryExists,
      originalAnywhere,
      alteredPriorRetained: true,
      completeCauses: true,
    }),
  );
}
