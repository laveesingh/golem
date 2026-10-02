import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repo } from '../support/sandbox.mjs';

// Native desired-behavior probes. --before loads the actual frozen bad owner
// AND reader, not a handwritten approximation or current reader under old owner.
const home = process.env.GOLEM_HOME;
const sandbox = process.env.GOLEM_W2_SANDBOX;
assert.ok(home && sandbox, 'owned sandbox required');
const old = process.argv.includes('--before');
const kind = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7);
assert.ok(['snapshot', 'descriptor'].includes(kind));
let owner;
if (old) {
  const target = path.join(sandbox, 'f733-config');
  fs.mkdirSync(path.join(target, 'contracts'), { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), '{"type":"module"}', {
    flag: 'wx',
  });
  for (const name of [
    'golem-config.ts',
    'read-versioned.ts',
    'contracts/config-validator.js',
  ]) {
    let source = execFileSync(
      'git',
      ['show', `f7332713580c69c316f795f9017444a3d52c3ba0:lib/${name}`],
      {
        cwd: repo,
        encoding: 'utf8',
      },
    );
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
  assert.ok(failures.some((error) => error.code === 'VERSIONED_FILE_CHANGED'));
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
