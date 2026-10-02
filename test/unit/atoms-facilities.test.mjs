import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { recreateDeclaredResults } from '../e2e/atoms.fixture.ts';

function facility(callback) {
  const root = fs.mkdtempSync('/tmp/gol501-facility-'),
    parent = path.join(root, 'parent'),
    leaf = path.join(parent, 'results');
  fs.mkdirSync(parent, { mode: 0o700 });
  const stat = fs.lstatSync(parent),
    expected = {
      device: stat.dev,
      inode: stat.ino,
      uid: stat.uid,
      canonical: fs.realpathSync(parent),
    };
  try {
    callback({ root, parent, leaf, expected });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('Playwright-deleted declared leaf recreated under same allocated parent only', () =>
  facility(({ root, leaf, expected }) => {
    recreateDeclaredResults(root, leaf, expected);
    assert.equal(fs.lstatSync(leaf).isDirectory(), true);
    fs.rmSync(leaf, { recursive: true });
    recreateDeclaredResults(root, leaf, expected);
    assert.equal(fs.lstatSync(leaf).isDirectory(), true);
  }));
for (const defect of [
  'missing-env',
  'missing-identity',
  'changed-parent',
  'symlink-parent',
  'writable-parent',
  'symlink-leaf',
])
  test(`result lifecycle ${defect} refuses unsafe recreation`, () =>
    facility(({ root, parent, leaf, expected }) => {
      if (defect === 'changed-parent') {
        fs.renameSync(parent, path.join(root, 'old'));
        fs.mkdirSync(parent, { mode: 0o700 });
      }
      if (defect === 'symlink-parent') {
        fs.renameSync(parent, path.join(root, 'old'));
        fs.symlinkSync(path.join(root, 'old'), parent);
      }
      if (defect === 'writable-parent') fs.chmodSync(parent, 0o777);
      if (defect === 'symlink-leaf') fs.symlinkSync(root, leaf);
      assert.throws(() =>
        recreateDeclaredResults(
          defect === 'missing-env' ? '' : root,
          leaf,
          defect === 'missing-identity' ? undefined : expected,
        ),
      );
      if (defect !== 'symlink-leaf') assert.equal(fs.existsSync(leaf), false);
    }));
test('declared leaf cannot escape TMP even with owned parent', () =>
  facility(({ parent, leaf, expected }) => {
    const other = fs.mkdtempSync('/tmp/gol501-other-');
    try {
      assert.throws(() => recreateDeclaredResults(other, leaf, expected));
      assert.equal(fs.existsSync(leaf), false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  }));
