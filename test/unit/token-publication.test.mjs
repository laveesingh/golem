import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test, vi } from 'vitest';
import {
  checkTokenFreshness,
  loadTokenSources,
  materializeTokens,
  publishTokens,
  tokenSnapshot,
} from '../../tools/tokens-io.ts';

const ui = fileURLToPath(
  new URL('../../dashboard/web/src/ui/', import.meta.url),
);
let parent, root;
beforeEach(() => {
  parent = fs.mkdtempSync('/tmp/gol485-publication-');
  root = path.join(parent, 'tokens');
  fs.cpSync(path.join(ui, 'tokens'), root, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  fs.cpSync(path.join(ui, 'fonts'), path.join(parent, 'fonts'), {
    recursive: true,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(parent, { recursive: true, force: true });
});
function changed() {
  const data = loadTokenSources(root);
  const ref = data.semantic.semantic.type.body.$value.slice(1, -1).split('.');
  const token = ref.reduce((value, key) => value[key], data.primitive);
  token.$value.fontSize.value += 1;
  return data;
}

test('validated generation publishes once through confined relative pointer and captures snapshots once', () => {
  const first = tokenSnapshot(root),
    second = publishTokens(root, changed());
  assert.notEqual(first.id, second.id);
  assert.equal(fs.existsSync(first.directory), true);
  assert.deepEqual(tokenSnapshot(root).files, second.files);
  let reads = 0;
  const original = fs.readlinkSync;
  vi.spyOn(fs, 'readlinkSync').mockImplementation((...args) => {
    reads++;
    return original(...args);
  });
  tokenSnapshot(root);
  assert.equal(reads, 1);
});
test('invalid contrast/font input writes nothing and leaves previous pointer/files intact', () => {
  const before = tokenSnapshot(root),
    entries = fs.readdirSync(path.join(root, '.generations'));
  const bad = loadTokenSources(root);
  bad.component.component.button.primary.hover.background.$value =
    bad.component.component.button.primary.hover.foreground.$value;
  assert.throws(() => publishTokens(root, bad), /CONTRAST/);
  assert.deepEqual(tokenSnapshot(root).files, before.files);
  assert.deepEqual(fs.readdirSync(path.join(root, '.generations')), entries);
  const font = path.join(parent, 'fonts/geist-latin-400-normal.woff2');
  fs.writeFileSync(font, 'corrupt');
  assert.throws(() => publishTokens(root, changed()), /FONT_HASH/);
  assert.deepEqual(tokenSnapshot(root).files, before.files);
});
test('publication rename failure leaves the whole old generation usable and cleans only owned staging', () => {
  const before = tokenSnapshot(root),
    original = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (path.basename(from).startsWith('.pointer-'))
      throw Error('synthetic-publication-failure');
    return original(from, to);
  });
  assert.throws(
    () => publishTokens(root, changed()),
    /synthetic-publication-failure/,
  );
  assert.deepEqual(tokenSnapshot(root).files, before.files);
  assert.equal(
    fs.existsSync(path.join(root, '.token-publication.lock')),
    false,
  );
  assert.equal(
    fs.readdirSync(root).some((n) => n.startsWith('.pointer-')),
    false,
  );
});
for (const kind of [
  'dangling',
  'outside',
  'directory',
  'permissions',
  'tampered',
])
  test(`unknown ${kind} pointer/target fails closed without overwrite`, () => {
    const pointer = path.join(root, 'generated'),
      before = fs.readlinkSync(pointer);
    if (kind === 'permissions')
      fs.chmodSync(path.join(root, '.generations'), 0o777);
    else if (kind === 'tampered')
      fs.appendFileSync(
        path.join(tokenSnapshot(root).directory, 'tokens.css'),
        'tamper',
      );
    else {
      fs.unlinkSync(pointer);
      if (kind === 'directory') fs.mkdirSync(pointer);
      else
        fs.symlinkSync(
          kind === 'outside'
            ? '/tmp/outside'
            : '.generations/g-' + 'a'.repeat(64),
          pointer,
        );
    }
    assert.throws(() => publishTokens(root, changed()));
    if (['dangling', 'outside'].includes(kind))
      assert.equal(fs.lstatSync(pointer).isSymbolicLink(), true);
    if (kind === 'directory')
      assert.equal(fs.lstatSync(pointer).isDirectory(), true);
    if (kind === 'permissions' || kind === 'tampered')
      assert.equal(fs.readlinkSync(pointer), before);
  });
test('check is read-only and detects source/output freshness, materialization uses pinned regular bytes', () => {
  const snapshot = checkTokenFreshness(root),
    before = fs.readlinkSync(path.join(root, 'generated'));
  publishTokens(root, changed());
  const dest = path.join(parent, 'materialized');
  materializeTokens(snapshot, dest);
  assert.equal(fs.lstatSync(dest).isSymbolicLink(), false);
  for (const [name, bytes] of Object.entries(snapshot.files))
    assert.equal(fs.readFileSync(path.join(dest, name), 'utf8'), bytes);
  assert.notEqual(fs.readlinkSync(path.join(root, 'generated')), before);
  assert.throws(() => checkTokenFreshness(root), /STALE/);
  assert.throws(() => materializeTokens(snapshot, dest));
});
