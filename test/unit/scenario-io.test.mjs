import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import {
  MAX_SCENARIO_BYTES,
  privateTempDirectory,
  readScenarioFile,
  writeCandidate,
} from '../../lib/scenario-io.ts';

let root;
beforeEach(() => {
  root = fs.mkdtempSync('/tmp/w5-io-');
  fs.chmodSync(root, 0o700);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
const file = (name) => path.join(root, name);

test('explicit private temp owner and exclusive600 candidate round trip', () => {
  assert.equal(privateTempDirectory(root), fs.realpathSync(root));
  const target = file('candidate.json');
  writeCandidate(target, { schema: 1 });
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(readScenarioFile(target), { schema: 1 });
  const before = fs.readFileSync(target);
  assert.throws(() => writeCandidate(target, { schema: 2 }));
  assert.deepEqual(fs.readFileSync(target), before);
  assert.throws(() => readScenarioFile('relative.json'));
  assert.throws(() => writeCandidate('relative.json', {}));
});

test('unknown directory permissions, symlinks and existing outputs fail without overwrite', () => {
  fs.chmodSync(root, 0o755);
  assert.throws(() => writeCandidate(file('new.json'), {}));
  assert.equal(fs.existsSync(file('new.json')), false);
  fs.chmodSync(root, 0o700);
  const target = file('real.json');
  fs.writeFileSync(target, '{"private":"synthetic"}');
  const link = file('link.json');
  fs.symlinkSync(target, link);
  assert.throws(() => readScenarioFile(link));
  assert.throws(() => writeCandidate(link, {}));
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"private":"synthetic"}');
  const dirLink = file('dir-link');
  fs.symlinkSync(root, dirLink);
  assert.throws(() => privateTempDirectory(dirLink));
});

test('oversized and malformed inputs are bounded and do not echo source bytes', () => {
  const large = file('large.json');
  fs.writeFileSync(large, 'x'.repeat(MAX_SCENARIO_BYTES + 1));
  assert.throws(() => readScenarioFile(large));
  const bad = file('bad.json');
  fs.writeFileSync(bad, 'synthetic-private-token');
  assert.throws(
    () => readScenarioFile(bad),
    (error) => !error.message.includes('synthetic-private-token'),
  );
  assert.throws(() =>
    writeCandidate(
      file('large-output.json'),
      'x'.repeat(MAX_SCENARIO_BYTES + 1),
    ),
  );
  assert.equal(fs.existsSync(file('large-output.json')), false);
});

test('failed creation reclaims only its exact newly allocated inode', () => {
  const target = file('failed.json');
  const original = fs.writeFileSync;
  vi.spyOn(fs, 'writeFileSync').mockImplementation((fd, ...args) => {
    if (typeof fd === 'number') throw Error('synthetic-write-failure');
    return original(fd, ...args);
  });
  assert.throws(() => writeCandidate(target, {}), /synthetic-write-failure/);
  assert.equal(fs.existsSync(target), false);
});

test('failed write preserves a substituted replacement rather than guessing ownership', () => {
  const target = file('replacement.json'),
    displaced = file('owned-displaced');
  const original = fs.writeFileSync;
  vi.spyOn(fs, 'writeFileSync').mockImplementation((fd, ...args) => {
    if (typeof fd === 'number') {
      fs.renameSync(target, displaced);
      original(target, 'owned replacement sentinel', { mode: 0o600 });
      throw Error('synthetic-write-failure');
    }
    return original(fd, ...args);
  });
  assert.throws(() => writeCandidate(target, {}), /synthetic-write-failure/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'owned replacement sentinel');
  assert.equal(fs.existsSync(displaced), true);
});
