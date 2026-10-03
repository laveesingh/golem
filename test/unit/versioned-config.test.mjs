import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { rawDefaultSessionRole } from '../../lib/config-role-default.ts';
import {
  validateConfig,
  validateLegacyConfig,
} from '../../lib/contracts/config-validator.js';
import { loadConfig, saveConfig } from '../../lib/golem-config.ts';
import { readVersioned, VersionedFileError } from '../../lib/read-versioned.ts';
import { defaultSessionRole } from '../../lib/session-role.ts';

let root, file, before;
const restorers = [];
const extraRoots = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-config-unit-'));
  file = path.join(root, 'config.json');
  before = process.env.GOLEM_HOME;
  process.env.GOLEM_HOME = root;
});
afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) restore();
  if (before === undefined) delete process.env.GOLEM_HOME;
  else process.env.GOLEM_HOME = before;
  fs.rmSync(root, { recursive: true, force: true });
  for (const extra of extraRoots.splice(0))
    fs.rmSync(extra, { recursive: true, force: true });
});
function patch(name, wrapper) {
  const original = fs[name];
  fs[name] = wrapper(original);
  restorers.push(() => {
    fs[name] = original;
  });
}
function stored(value) {
  const bytes = typeof value === 'string' ? value : JSON.stringify(value);
  fs.writeFileSync(file, bytes);
  return bytes;
}
function refusal(fn, status = 409) {
  assert.throws(
    fn,
    (error) =>
      error instanceof VersionedFileError && error.statusCode === status,
  );
}
const finitePolicy = {
  currentVersion: 1,
  validateCurrent: validateConfig,
  validateLegacy: validateLegacyConfig,
  migrateLegacy: (value) => ({ ...value, schema_version: 1 }),
  missing: () => ({ schema_version: 1 }),
};
test('missing defaults and all role default read paths are zero-write', () => {
  assert.deepEqual(loadConfig(), {
    schema_version: 1,
    dispatch: { unackedWindowMinutes: 5 },
    harnesses: { claudecode: { enabled: true } },
  });
  assert.equal(defaultSessionRole(), 'lead');
  assert.equal(rawDefaultSessionRole(), 'lead');
  assert.deepEqual(fs.readdirSync(root), []);
});
test('v0 migrates only in memory; v1 retains recursive extensions and nullable fields', () => {
  for (const tag of [{}, { schema_version: 1 }]) {
    const value = {
      ...tag,
      dispatch: null,
      harnesses: {
        claudecode: null,
        custom: {
          enabled: null,
          modelMap: { custom: [null, 4, { opaque: true }] },
          testedVersion: { opaque: ['metadata'] },
          extension: false,
        },
      },
      roles: null,
      extra: [1, { nested: [null, 'kept'] }],
    };
    const bytes = stored(value);
    const loaded = loadConfig();
    assert.equal(loaded.schema_version, 1);
    assert.equal(loaded.dispatch, null);
    assert.equal(loaded.harnesses.claudecode, null);
    assert.deepEqual(loaded.extra, value.extra);
    assert.deepEqual(loaded.harnesses.custom, value.harnesses.custom);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.deepEqual(fs.readdirSync(root), ['config.json']);
  }
});
test('zero, negative, fractional and null window values survive without clamp/coercion', () => {
  for (const window of [0, -3, 0.25, null]) {
    stored({ dispatch: { unackedWindowMinutes: window } });
    assert.equal(loadConfig().dispatch.unackedWindowMinutes, window);
  }
});
test('missing/null/empty/custom role distinction and raw shell vs normalized JS semantics', () => {
  for (const [roles, normalized, raw] of [
    [{}, 'lead', 'lead'],
    [{ default: null }, null, ''],
    [{ default: '' }, null, ''],
    [{ default: '  Custom-Role  ' }, 'custom-role', '  Custom-Role  '],
    [{ default: '../planner' }, '../planner', '../planner'],
  ]) {
    const bytes = stored({ roles });
    assert.equal(defaultSessionRole(), normalized);
    assert.equal(rawDefaultSessionRole(), raw);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
});
test('schema rejects invalid known kinds and versions without raw-value diagnostics or writes', () => {
  for (const value of [
    '{secret-parser-text',
    [],
    null,
    { schema_version: 2 },
    { schema_version: '1' },
    { schema_version: 1.5 },
    { schema_version: null },
    { dispatch: [] },
    { dispatch: { unackedWindowMinutes: 'secret-number' } },
    { harnesses: { pi: { enabled: 'secret-boolean' } } },
    { roles: { default: 4 } },
  ]) {
    const bytes = stored(value);
    for (const read of [
      loadConfig,
      defaultSessionRole,
      rawDefaultSessionRole,
    ]) {
      refusal(read);
      try {
        read();
      } catch (error) {
        assert.doesNotMatch(
          error.message,
          /secret-parser-text|secret-number|secret-boolean/,
        );
      }
    }
    refusal(() => saveConfig({ harnesses: {} }));
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.deepEqual(fs.readdirSync(root), ['config.json']);
  }
});
test('request validation fails 400 before any allocations, including non-JSON numbers/extensions', () => {
  const bytes = stored({ roles: { default: 'custom' } });
  for (const value of [
    { schema_version: 2 },
    { roles: { default: 2 } },
    { extension: Infinity },
    { extension: undefined },
    { extension: () => 'not-json' },
  ])
    refusal(() => saveConfig(value), 400);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(fs.readdirSync(root), ['config.json']);
});
test('explicit save stamps v1, preserves extensions and uses private mode', () => {
  saveConfig({ roles: { default: null }, extension: [1, true, null] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {
    schema_version: 1,
    roles: { default: null },
    extension: [1, true, null],
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(root), ['config.json']);
});
test('JSON extension __proto__ stays an own data property, not prototype mutation', () => {
  stored('{"__proto__":{"polluted":true},"roles":{"default":"custom"}}');
  const config = loadConfig();
  assert.equal(Object.hasOwn(config, '__proto__'), true);
  assert.equal(config.polluted, undefined);
  assert.equal({}.polluted, undefined);
});
test('IO and regular/no-follow failures are named500, not missing defaults', () => {
  fs.mkdirSync(file);
  refusal(loadConfig, 500);
  fs.rmdirSync(file);
  fs.symlinkSync(path.join(root, 'missing-target'), file);
  refusal(loadConfig, 500);
  fs.unlinkSync(file);
  patch('openSync', (original) => (target, ...args) => {
    if (target === file)
      throw Object.assign(new Error('permission fixture'), { code: 'EACCES' });
    return original(target, ...args);
  });
  refusal(loadConfig, 500);
  assert.deepEqual(fs.readdirSync(root), []);
});
test('generic fallback must pass current schema validation; close failure retains original refusal cause', () => {
  refusal(() =>
    readVersioned(file, {
      ...finitePolicy,
      missing: () => ({ schema_version: 2 }),
    }),
  );
  stored('{invalid');
  patch('closeSync', (original) => (fd) => {
    original(fd);
    throw Error('close fixture');
  });
  assert.throws(
    () => readVersioned(file, finitePolicy),
    (error) =>
      error.statusCode === 500 &&
      error.cause instanceof AggregateError &&
      error.cause.errors.some(
        (cause) => cause.code === 'VERSIONED_JSON_INVALID',
      ),
  );
});
for (const when of ['before', 'after'])
  test(`rename failure ${when} publication restores exact prior bytes`, () => {
    const bytes = stored(
      '{ "roles": { "default": "custom" }, "extension": 4 }\n',
    );
    let fired = false;
    patch('renameSync', (original) => (source, destination) => {
      if (!fired && destination === file && source.includes('.tmp-')) {
        fired = true;
        if (when === 'after') original(source, destination);
        throw Error('rename fixture');
      }
      return original(source, destination);
    });
    refusal(() => saveConfig({ roles: { default: null } }), 500);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.deepEqual(fs.readdirSync(root), ['config.json']);
  });
for (const kind of ['prior', 'temp', 'parent'])
  test(`${kind} fsync failure preserves exact old bytes`, () => {
    const bytes = stored('{"extension":"old bytes"}');
    const descriptors = new Map();
    patch('openSync', (original) => (target, ...args) => {
      const fd = original(target, ...args);
      descriptors.set(fd, String(target));
      return fd;
    });
    let fired = false;
    patch('fsyncSync', (original) => (fd) => {
      const target = descriptors.get(fd);
      if (
        !fired &&
        (kind === 'parent'
          ? target === root
          : target?.includes(kind === 'temp' ? '.tmp-' : '.prior-'))
      ) {
        fired = true;
        throw Error('fsync fixture');
      }
      return original(fd);
    });
    refusal(() => saveConfig({ extension: 'new bytes' }), 500);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.deepEqual(fs.readdirSync(root), ['config.json']);
  });
test('partial temp write failure preserves original and indeterminate incomplete evidence', () => {
  const bytes = stored('{"extension":"original"}');
  const descriptors = new Map();
  patch('openSync', (original) => (target, ...args) => {
    const fd = original(target, ...args);
    descriptors.set(fd, String(target));
    return fd;
  });
  patch('writeFileSync', (original) => (target, data, ...args) => {
    if (
      typeof target === 'number' &&
      descriptors.get(target)?.includes('.tmp-')
    ) {
      original(target, String(data).slice(0, 3));
      throw Error('partial write fixture');
    }
    return original(target, data, ...args);
  });
  refusal(() => saveConfig({ extension: 'new' }), 500);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  const partial = fs.readdirSync(root).find((name) => name.includes('.tmp-'));
  assert.ok(
    partial,
    'incomplete snapshot retained, not granted cleanup authority',
  );
  assert.equal(fs.readFileSync(path.join(root, partial), 'utf8').length, 3);
});
test('failed rollback with replaced lock retains exact old-byte backup and replacement evidence', () => {
  const bytes = stored('{ "extension": "captured old bytes" }\n');
  const descriptors = new Map();
  patch('openSync', (original) => (target, ...args) => {
    const fd = original(target, ...args);
    descriptors.set(fd, String(target));
    return fd;
  });
  let fired = false;
  patch('fsyncSync', (original) => (fd) => {
    if (!fired && descriptors.get(fd) === root) {
      fired = true;
      fs.renameSync(`${file}.lock`, `${file}.lock-detached`);
      fs.writeFileSync(`${file}.lock`, 'replacement-lock');
      throw Error('post-publication fixture');
    }
    return original(fd);
  });
  refusal(() => saveConfig({ extension: 'new' }), 500);
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), 'replacement-lock');
  const backup = fs
    .readdirSync(root)
    .find((name) => name.startsWith('config.json.prior-'));
  assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(root, backup), 'utf8'), bytes);
  assert.equal(JSON.parse(fs.readFileSync(file)).extension, 'new');
});
for (const kind of ['temp', 'prior', 'lock', 'parent'])
  test(`${kind} close failure after actual close restores old bytes without reused-fd retry`, () => {
    const bytes = stored('{"extension":"before close"}');
    const descriptors = new Map();
    patch('openSync', (original) => (target, ...args) => {
      const fd = original(target, ...args);
      descriptors.set(fd, String(target));
      return fd;
    });
    let fired = false;
    patch('closeSync', (original) => (fd) => {
      const target = descriptors.get(fd);
      original(fd);
      if (
        !fired &&
        (kind === 'parent'
          ? target === root
          : target?.includes(
              kind === 'temp'
                ? '.tmp-'
                : kind === 'prior'
                  ? '.prior-'
                  : '.lock',
            ))
      ) {
        fired = true;
        throw Error('post-close fixture');
      }
    });
    refusal(() => saveConfig({ extension: 'after close' }), 500);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.deepEqual(fs.readdirSync(root), ['config.json']);
  });
test('post-publication fsync failure restores originally missing file to absence', () => {
  const descriptors = new Map();
  patch('openSync', (original) => (target, ...args) => {
    const fd = original(target, ...args);
    descriptors.set(fd, String(target));
    return fd;
  });
  let fired = false;
  patch('fsyncSync', (original) => (fd) => {
    if (!fired && descriptors.get(fd) === root) {
      fired = true;
      throw Error('parent fsync fixture');
    }
    return original(fd);
  });
  refusal(() => saveConfig({ extension: 'new file' }), 500);
  assert.deepEqual(fs.readdirSync(root), []);
});
test('occupied lock refuses without deleting or reclaiming another writer', () => {
  const bytes = stored({ extension: 'old' });
  fs.writeFileSync(`${file}.lock`, 'other-owner');
  refusal(() => saveConfig({ extension: 'new' }));
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), 'other-owner');
});
for (const kind of ['file', 'lock', 'parent', 'temp'])
  test(`replaced ${kind} survives publication and cleanup refusal`, () => {
    const bytes = stored({ extension: 'old' });
    let replacement, detached;
    let fired = false;
    patch('openSync', (original) => (target, ...args) => {
      const fd = original(target, ...args);
      if (!fired && String(target).includes('.tmp-')) {
        fired = true;
        const selected =
          kind === 'file'
            ? file
            : kind === 'lock'
              ? `${file}.lock`
              : kind === 'parent'
                ? root
                : String(target);
        detached = `${selected}.detached`;
        if (kind === 'parent') extraRoots.push(detached);
        fs.renameSync(selected, detached);
        if (kind === 'parent') {
          fs.mkdirSync(root);
          replacement = path.join(root, 'replacement');
        } else replacement = selected;
        fs.writeFileSync(replacement, 'replacement-survives');
      }
      return fd;
    });
    assert.throws(() => saveConfig({ extension: 'new' }), VersionedFileError);
    assert.equal(fs.readFileSync(replacement, 'utf8'), 'replacement-survives');
    if (kind === 'parent') {
      assert.equal(
        fs.readFileSync(path.join(detached, 'config.json'), 'utf8'),
        bytes,
      );
      fs.rmSync(detached, { recursive: true });
    } else if (kind === 'file')
      assert.equal(fs.readFileSync(detached, 'utf8'), bytes);
    else assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  });

test('published temp corruption refuses rollback/destruction and retains exact original backup', () => {
  const bytes = stored('{"extension":"original"}');
  const paths = descriptors();
  let fired = false;
  patch('fsyncSync', (original) => (fd) => {
    if (!fired && paths.get(fd) === root) {
      fired = true;
      fs.writeFileSync(file, 'modified-published-temp');
      throw Error('parent sync with altered publication');
    }
    return original(fd);
  });
  refusal(() => saveConfig({ extension: 'new' }), 500);
  assert.ok(fired);
  assert.equal(fs.readFileSync(file, 'utf8'), 'modified-published-temp');
  const backup = fs.readdirSync(root).find((name) => name.includes('.prior-'));
  assert.equal(fs.readFileSync(path.join(root, backup), 'utf8'), bytes);
});
for (const kind of [
  'temp',
  'prior',
  'lock',
  'parent',
  'generic',
  'originalBytes',
])
  test(`${kind} throwing close after actual close and reuse is never retried`, () => {
    const bytes = stored('{"extension":"original"}');
    const paths = descriptors();
    const rawOpen = fs.openSync,
      rawClose = fs.closeSync;
    const foreignPath = path.join(root, 'foreign');
    fs.writeFileSync(foreignPath, 'unrelated bytes');
    let fired = false,
      foreign,
      attempts = 0;
    patch('closeSync', (original) => (fd) => {
      const target = paths.get(fd);
      if (fired && fd === foreign) attempts++;
      original(fd);
      if (
        !fired &&
        (kind === 'parent'
          ? target === root
          : kind === 'generic' || kind === 'originalBytes'
            ? target === file
            : target?.includes(
                kind === 'temp'
                  ? '.tmp-'
                  : kind === 'prior'
                    ? '.prior-'
                    : '.lock',
              ))
      ) {
        // For originalBytes, skip the earlier owner validation read's close.
        if (kind === 'originalBytes' && !paths.has('validationClosed')) {
          paths.set('validationClosed', true);
          return;
        }
        fired = true;
        foreign = rawOpen(foreignPath, 'r');
        assert.equal(foreign, fd);
        throw Error('closed then reused fixture');
      }
    });
    try {
      assert.throws(
        () =>
          kind === 'generic'
            ? readVersioned(file, finitePolicy)
            : saveConfig({ extension: 'new' }),
        VersionedFileError,
      );
      assert.ok(fired);
      assert.equal(attempts, 0, 'owner must not retry a throwing close');
      assert.ok(fs.fstatSync(foreign).isFile());
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    } finally {
      if (foreign !== undefined) rawClose(foreign);
    }
  });
test('primary, rollback and cleanup failures all survive with captured prior evidence', () => {
  const bytes = stored('{"extension":"original"}');
  const paths = descriptors();
  let fired = false;
  patch('fsyncSync', (original) => (fd) => {
    if (!fired && paths.get(fd) === root) {
      fired = true;
      throw Error('PRIMARY_FSYNC');
    }
    return original(fd);
  });
  patch('renameSync', (original) => (source, destination) => {
    if (String(source).includes('.prior-')) throw Error('ROLLBACK_RENAME');
    return original(source, destination);
  });
  patch('unlinkSync', (original) => (target) => {
    if (target === `${file}.lock`) throw Error('CLEANUP_UNLINK');
    return original(target);
  });
  let failure;
  try {
    saveConfig({ extension: 'new' });
  } catch (error) {
    failure = error;
  }
  assert.ok(fired && failure instanceof VersionedFileError);
  function causes(error) {
    return [
      error,
      ...(error?.cause ? causes(error.cause) : []),
      ...(error instanceof AggregateError ? error.errors.flatMap(causes) : []),
    ];
  }
  for (const message of ['PRIMARY_FSYNC', 'ROLLBACK_RENAME', 'CLEANUP_UNLINK'])
    assert.ok(
      causes(failure).some((error) => error.message === message),
      message,
    );
  const prior = fs.readdirSync(root).find((name) => name.includes('.prior-'));
  assert.equal(fs.readFileSync(path.join(root, prior), 'utf8'), bytes);
  assert.equal(JSON.parse(fs.readFileSync(file)).extension, 'new');
});
for (const kind of ['allocation', 'generic', 'parent'])
  test(`${kind} initial-open fd replacement is never adopted as close authority`, () => {
    const bytes = stored('{"extension":"original"}');
    let fired = false,
      foreign;
    patch('openSync', (original) => (target, ...args) => {
      const fd = original(target, ...args);
      if (
        !fired &&
        (kind === 'allocation'
          ? String(target).includes('.lock')
          : kind === 'parent'
            ? target === root
            : target === file)
      ) {
        fired = true;
        foreign = foreignReuse(fd);
      }
      return fd;
    });
    try {
      assert.throws(
        () =>
          kind === 'generic'
            ? readVersioned(file, finitePolicy)
            : saveConfig({ extension: 'new' }),
        VersionedFileError,
      );
      assert.ok(fired);
      survives(foreign);
      foreign = undefined;
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    } finally {
      if (foreign !== undefined) {
        let present = false;
        try {
          present = fs.fstatSync(foreign).isFile();
        } catch (error) {
          assert.equal(error.code, 'EBADF');
        }
        if (present) fs.closeSync(foreign);
      }
    }
  });
for (const kind of [
  'write-after',
  'fsync',
  'close-before',
  'close-after',
  'rename-before',
  'rename-after',
  'rollback-fsync',
  'rollback-close',
])
  test(`incomplete recovery ${kind} retains last ORIGINAL bytes, altered prior and causes`, () => {
    const bytes = stored('{ "extension": "ORIGINAL EXPECTED BYTES" }\n');
    const paths = descriptors();
    let primaryFired = false,
      faultFired = false,
      renamed = false;
    let prior, recovery;
    const fault = `RECOVERY_${kind}`;
    patch('writeFileSync', (original) => (target, ...args) => {
      const result = original(target, ...args);
      if (
        kind === 'write-after' &&
        !faultFired &&
        paths.get(target)?.includes('.recovery-')
      ) {
        recovery = paths.get(target);
        faultFired = true;
        assert.equal(fs.readFileSync(recovery, 'utf8'), bytes);
        throw Error(fault);
      }
      return result;
    });
    patch('fsyncSync', (original) => (fd) => {
      if (!primaryFired && paths.get(fd) === root) {
        primaryFired = true;
        prior = path.join(
          root,
          fs.readdirSync(root).find((name) => name.includes('.prior-')),
        );
        fs.writeFileSync(prior, 'ALTERED PRIOR');
        throw Error('PRIMARY_PARENT_FSYNC');
      }
      if (
        !faultFired &&
        (kind === 'fsync'
          ? paths.get(fd)?.includes('.recovery-')
          : kind === 'rollback-fsync' && renamed && paths.get(fd) === root)
      ) {
        faultFired = true;
        if (kind === 'fsync') recovery = paths.get(fd);
        throw Error(fault);
      }
      return original(fd);
    });
    patch('closeSync', (original) => (fd) => {
      const selected = kind.startsWith('close-')
        ? paths.get(fd)?.includes('.recovery-')
        : kind === 'rollback-close' && renamed && paths.get(fd) === root;
      if (!faultFired && selected) {
        faultFired = true;
        if (kind.startsWith('close-')) recovery = paths.get(fd);
        if (kind !== 'close-before') original(fd);
        else {
          // Deliberately retain a possibly unclosed original handle. The fixture,
          // not owner cleanup, closes it after patches are restored.
          restorers.push(() => original(fd));
        }
        throw Error(fault);
      }
      return original(fd);
    });
    patch('renameSync', (original) => (source, destination) => {
      if (String(source).includes('.recovery-')) {
        recovery = String(source);
        assert.equal(fs.readFileSync(source, 'utf8'), bytes);
        if (kind.startsWith('rename-')) {
          faultFired = true;
          if (kind === 'rename-after') {
            original(source, destination);
            renamed = true;
          }
          throw Error(fault);
        }
        original(source, destination);
        renamed = true;
        return;
      }
      return original(source, destination);
    });
    let failure;
    try {
      saveConfig({ extension: 'new published bytes' });
    } catch (error) {
      failure = error;
    }
    assert.ok(
      primaryFired && faultFired && failure instanceof VersionedFileError,
    );
    recovery ??= [...paths.values()].find((target) =>
      target.includes('.recovery-'),
    );
    assert.ok(recovery);
    assert.equal(fs.readFileSync(prior, 'utf8'), 'ALTERED PRIOR');
    assert.ok(
      fs
        .readdirSync(root)
        .some(
          (name) => fs.readFileSync(path.join(root, name), 'utf8') === bytes,
        ),
      'at least one on-disk snapshot must retain ORIGINAL expected bytes',
    );
    if (!renamed) assert.equal(fs.readFileSync(recovery, 'utf8'), bytes);
    function tree(error) {
      return [
        error,
        ...(error?.cause ? tree(error.cause) : []),
        ...(error instanceof AggregateError ? error.errors.flatMap(tree) : []),
      ];
    }
    for (const message of ['PRIMARY_PARENT_FSYNC', fault])
      assert.ok(
        tree(failure).some((error) => error.message === message),
        message,
      );
    assert.ok(
      tree(failure).some((error) => error.code === 'VERSIONED_FILE_CHANGED'),
    );
  });
for (const kind of ['target', 'lock'])
  test(`original recovery stays retained when ${kind} authority is lost`, () => {
    const bytes = stored('{ "extension": "ORIGINAL EXPECTED BYTES" }\n');
    const paths = descriptors();
    let primaryFired = false,
      replacementFired = false;
    let recovery, prior;
    patch('fsyncSync', (original) => (fd) => {
      if (!primaryFired && paths.get(fd) === root) {
        primaryFired = true;
        prior = path.join(
          root,
          fs.readdirSync(root).find((name) => name.includes('.prior-')),
        );
        fs.writeFileSync(prior, 'ALTERED PRIOR');
        throw Error('PRIMARY_PARENT_FSYNC');
      }
      if (!replacementFired && paths.get(fd)?.includes('.recovery-')) {
        replacementFired = true;
        recovery = paths.get(fd);
        const selected = kind === 'target' ? file : `${file}.lock`;
        fs.renameSync(selected, `${selected}.detached`);
        fs.writeFileSync(selected, 'UNKNOWN REPLACEMENT');
      }
      return original(fd);
    });
    refusal(() => saveConfig({ extension: 'new published bytes' }), 500);
    assert.ok(primaryFired && replacementFired);
    assert.equal(
      fs.readFileSync(kind === 'target' ? file : `${file}.lock`, 'utf8'),
      'UNKNOWN REPLACEMENT',
    );
    assert.equal(fs.readFileSync(prior, 'utf8'), 'ALTERED PRIOR');
    assert.equal(fs.readFileSync(recovery, 'utf8'), bytes);
  });
test('failed recovery close after actual close and foreign reuse retains bytes without retry', () => {
  const bytes = stored('{ "extension": "ORIGINAL EXPECTED BYTES" }\n');
  const paths = descriptors();
  const rawOpen = fs.openSync,
    rawClose = fs.closeSync;
  const foreignPath = path.join(root, 'foreign');
  fs.writeFileSync(foreignPath, 'foreign bytes');
  let primaryFired = false,
    closeFired = false,
    foreign,
    recovery,
    retries = 0;
  patch('fsyncSync', (original) => (fd) => {
    if (!primaryFired && paths.get(fd) === root) {
      primaryFired = true;
      const prior = fs
        .readdirSync(root)
        .find((name) => name.includes('.prior-'));
      fs.writeFileSync(path.join(root, prior), 'ALTERED PRIOR');
      throw Error('PRIMARY_PARENT_FSYNC');
    }
    return original(fd);
  });
  patch('closeSync', (original) => (fd) => {
    if (closeFired && fd === foreign) retries++;
    const target = paths.get(fd);
    original(fd);
    if (!closeFired && target?.includes('.recovery-')) {
      closeFired = true;
      recovery = target;
      foreign = rawOpen(foreignPath, 'r');
      assert.equal(foreign, fd);
      throw Error('RECOVERY_CLOSE_AFTER_REUSE');
    }
  });
  try {
    refusal(() => saveConfig({ extension: 'new published bytes' }), 500);
    assert.ok(primaryFired && closeFired);
    assert.equal(retries, 0);
    assert.ok(fs.fstatSync(foreign).isFile());
    assert.equal(fs.readFileSync(recovery, 'utf8'), bytes);
  } finally {
    if (foreign !== undefined) rawClose(foreign);
  }
});
function descriptors() {
  const paths = new Map();
  patch('openSync', (original) => (target, ...args) => {
    const fd = original(target, ...args);
    paths.set(fd, String(target));
    return fd;
  });
  return paths;
}
function foreignReuse(fd) {
  const foreign = path.join(root, 'foreign');
  fs.writeFileSync(foreign, 'unrelated bytes');
  fs.closeSync(fd);
  const replacement = fs.openSync(foreign, 'r');
  assert.equal(replacement, fd, 'must reuse the original numeric descriptor');
  return replacement;
}
function survives(fd) {
  assert.ok(
    fs.fstatSync(fd).isFile(),
    'foreign descriptor must survive cleanup',
  );
  fs.closeSync(fd); // fixture owner, not the config owner
}
for (const kind of ['prior', 'temp'])
  test(`completed ${kind} in-place corruption is retained, never published or destroyed`, () => {
    const bytes = stored('{ "extension": "original" }\n');
    const paths = descriptors();
    let fired = false,
      evidence;
    patch('fsyncSync', (original) => (fd) => {
      if (
        !fired &&
        paths.get(fd)?.includes(kind === 'prior' ? '.prior-' : '.tmp-')
      ) {
        fired = true;
        evidence = paths.get(fd);
        fs.writeFileSync(evidence, 'modified-completed-snapshot');
      }
      return original(fd);
    });
    assert.throws(() => saveConfig({ extension: 'new' }), VersionedFileError);
    assert.ok(fired);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal(
      fs.readFileSync(evidence, 'utf8'),
      'modified-completed-snapshot',
    );
  });
test('modified sole prior backup after publication recovers ORIGINAL bytes and retains changed evidence', () => {
  const bytes = stored('{ "extension": "original" }\n');
  const paths = descriptors();
  let fired = false,
    evidence;
  patch('fsyncSync', (original) => (fd) => {
    if (!fired && paths.get(fd) === root) {
      fired = true;
      evidence = path.join(
        root,
        fs.readdirSync(root).find((name) => name.includes('.prior-')),
      );
      fs.writeFileSync(evidence, 'modified-prior');
      throw Error('parent sync fixture');
    }
    return original(fd);
  });
  refusal(() => saveConfig({ extension: 'new' }), 500);
  assert.ok(fired);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(fs.readFileSync(evidence, 'utf8'), 'modified-prior');
});
for (const kind of ['lock', 'recovery-content'])
  test(`modified prior plus ${kind} uncertainty retains evidence and bounds recovery`, () => {
    stored('{"extension":"original"}');
    const paths = descriptors();
    let fired = false;
    patch('fsyncSync', (original) => (fd) => {
      if (!fired && paths.get(fd) === root) {
        fired = true;
        const backup = fs
          .readdirSync(root)
          .find((name) => name.includes('.prior-'));
        fs.writeFileSync(path.join(root, backup), 'modified-prior');
        if (kind === 'lock') {
          fs.renameSync(`${file}.lock`, `${file}.lock-detached`);
          fs.writeFileSync(`${file}.lock`, 'foreign-lock');
        }
        throw Error('parent sync fixture');
      }
      if (kind === 'recovery-content' && paths.get(fd)?.includes('.recovery-'))
        fs.writeFileSync(paths.get(fd), 'modified-recovery');
      return original(fd);
    });
    refusal(() => saveConfig({ extension: 'new' }), 500);
    assert.ok(fired);
    assert.equal(JSON.parse(fs.readFileSync(file)).extension, 'new');
    const evidence = fs.readdirSync(root);
    assert.equal(
      fs.readFileSync(
        path.join(
          root,
          evidence.find((name) => name.includes('.prior-')),
        ),
        'utf8',
      ),
      'modified-prior',
    );
    assert.equal(
      evidence.filter((name) => name.includes('.recovery-')).length,
      kind === 'lock' ? 0 : 1,
    );
    if (kind === 'lock')
      assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), 'foreign-lock');
  });
for (const kind of ['prior', 'temp'])
  test(`${kind} snapshot read fd reuse is fenced before close`, () => {
    const bytes = stored('{"extension":"original"}');
    const paths = descriptors();
    let fired = false,
      foreign;
    patch('readSync', (original) => (fd, ...args) => {
      if (
        !fired &&
        paths.get(fd)?.includes(kind === 'prior' ? '.prior-' : '.tmp-')
      ) {
        fired = true;
        foreign = foreignReuse(fd);
      }
      return original(fd, ...args);
    });
    try {
      assert.throws(() => saveConfig({ extension: 'new' }), VersionedFileError);
      assert.ok(fired);
      survives(foreign);
      foreign = undefined;
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    } finally {
      if (foreign !== undefined) fs.closeSync(foreign);
    }
  });
for (const kind of ['parent', 'temp', 'prior', 'lock'])
  test(`detected ${kind} fd reuse before cleanup never closes the foreign descriptor`, () => {
    const bytes = stored('{"extension":"original"}');
    const paths = descriptors();
    let fired = false,
      foreign;
    patch('fsyncSync', (original) => (fd) => {
      if (!fired && paths.get(fd)?.includes('.tmp-')) {
        fired = true;
        const selected = [...paths].find(([, target]) =>
          kind === 'parent'
            ? target === root
            : target.includes(
                kind === 'temp'
                  ? '.tmp-'
                  : kind === 'prior'
                    ? '.prior-'
                    : '.lock',
              ),
        );
        assert.ok(selected);
        foreign = foreignReuse(selected[0]);
      }
      return original(fd);
    });
    try {
      assert.throws(() => saveConfig({ extension: 'new' }), VersionedFileError);
      assert.ok(fired);
      survives(foreign);
      foreign = undefined;
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    } finally {
      if (foreign !== undefined) fs.closeSync(foreign);
    }
  });
for (const kind of ['originalBytes', 'generic'])
  test(`${kind} read fd reuse remains unclosed with all refusal causes`, () => {
    const bytes = stored('{"extension":"original"}');
    const paths = descriptors();
    let fired = false,
      foreign;
    patch('readFileSync', (original) => (fd, ...args) => {
      if (
        !fired &&
        typeof fd === 'number' &&
        paths.get(fd) === file &&
        (kind === 'generic' ? args[0] === 'utf8' : args.length === 0)
      ) {
        fired = true;
        foreign = foreignReuse(fd);
      }
      return original(fd, ...args);
    });
    try {
      assert.throws(
        () =>
          kind === 'generic'
            ? readVersioned(file, finitePolicy)
            : saveConfig({ extension: 'new' }),
        VersionedFileError,
      );
      assert.ok(fired);
      survives(foreign);
      foreign = undefined;
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    } finally {
      if (foreign !== undefined) fs.closeSync(foreign);
    }
  });
for (const kind of ['rollback', 'recovery-read'])
  test(`${kind} reopened fd compares original identity and preserves foreign fd`, () => {
    const bytes = stored('{"extension":"original"}');
    const paths = descriptors();
    let syncFired = false,
      reuseFired = false,
      foreign;
    patch('fsyncSync', (original) => (fd) => {
      if (!syncFired && paths.get(fd) === root) {
        syncFired = true;
        throw Error('post-publication parent fsync');
      }
      return original(fd);
    });
    patch('openSync', (original) => (target, ...args) => {
      const fd = original(target, ...args);
      if (
        syncFired &&
        !reuseFired &&
        (kind === 'rollback'
          ? target === root
          : String(target).includes('.prior-'))
      ) {
        reuseFired = true;
        foreign = foreignReuse(fd);
      }
      return fd;
    });
    try {
      refusal(() => saveConfig({ extension: 'new' }), 500);
      assert.ok(syncFired && reuseFired);
      survives(foreign);
      foreign = undefined;
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    } finally {
      if (foreign !== undefined) fs.closeSync(foreign);
    }
  });
for (const kind of ['allocation', 'generic-capture', 'parent-capture'])
  test(`${kind} identity capture failure does not invent numeric-fd authority`, () => {
    stored('{"extension":"original"}');
    const paths = descriptors();
    let fired = false,
      capturedFd;
    patch('fstatSync', (original) => (fd, ...args) => {
      const target = paths.get(fd);
      if (
        !fired &&
        (kind === 'allocation'
          ? target?.includes('.lock')
          : kind === 'parent-capture'
            ? target === root
            : target === file)
      ) {
        fired = true;
        capturedFd = fd;
        throw Error('capture fixture');
      }
      return original(fd, ...args);
    });
    assert.throws(
      () =>
        kind === 'generic-capture'
          ? readVersioned(file, finitePolicy)
          : saveConfig({ extension: 'new' }),
      VersionedFileError,
    );
    assert.ok(fired);
    if (kind === 'parent-capture' || kind === 'generic-capture') {
      // Existing parent/reader had original path identity before open; close is compared.
      assert.throws(() => fs.fstatSync(capturedFd), { code: 'EBADF' });
    } else survives(capturedFd);
  });
