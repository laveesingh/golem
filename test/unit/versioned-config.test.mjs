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
test('partial temp write failure never overwrites original bytes', () => {
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
  assert.deepEqual(fs.readdirSync(root), ['config.json']);
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
