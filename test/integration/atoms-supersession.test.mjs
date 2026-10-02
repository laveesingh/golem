// Real rejected artifact bytes are read from immutable git history into owned temp facilities.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test, vi } from 'vitest';
import {
  validateExactRejected,
  rejectedInitialTuple,
  replaceExactRejected,
  retireRejectedPrivate,
  copyValidatedCandidates,
} from './atoms-candidates.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
function setup(callback) {
  const root = fs.mkdtempSync(
      path.join(process.env.GOLEM_W2_SANDBOX, 'rejected-control-'),
    ),
    work = path.join(root, 'work'),
    target = path.join(work, 'test/e2e/__screenshots__/atoms');
  fs.mkdirSync(work);
  const archive = spawnSync(
    'git',
    [
      'archive',
      '--format=tar',
      rejectedInitialTuple.candidateCommit,
      'test/e2e/__screenshots__/atoms',
    ],
    { cwd: repo, timeout: 10000, maxBuffer: 5 * 1024 * 1024 },
  );
  assert.equal(archive.status, 0);
  const tar = path.join(root, 'old.tar');
  fs.writeFileSync(tar, archive.stdout);
  assert.equal(
    spawnSync('tar', ['-xf', tar, '-C', work], { timeout: 10000 }).status,
    0,
  );
  const candidate = path.join(root, 'new');
  fs.cpSync(target, candidate, { recursive: true });
  const file = path.join(candidate, 'manifest.json'),
    manifest = JSON.parse(fs.readFileSync(file));
  manifest.provenance.sourceCommit = 'a'.repeat(40);
  manifest.provenance.supersedes = rejectedInitialTuple;
  fs.writeFileSync(file, JSON.stringify(manifest));
  try {
    callback({
      root,
      work,
      target,
      candidate,
      evidence: path.join(root, 'evidence'),
    });
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('only exact rejected tuple privately retired and preserved, default existing copy still refuses', () =>
  setup(({ root, work, target, candidate }) => {
    assert.throws(() => copyValidatedCandidates(candidate, target));
    validateExactRejected(target);
    const backup = path.join(root, 'old-preserved');
    retireRejectedPrivate(work, target, backup);
    assert.equal(fs.existsSync(target), false);
    validateExactRejected(backup);
  }));
test('explicit rejected transaction installs new candidate and retains original verified evidence', () =>
  setup(({ target, candidate, evidence }) => {
    const result = replaceExactRejected(candidate, target, evidence);
    assert.equal(result.journal.state, 'complete');
    validateExactRejected(path.join(evidence, 'old-rejected'));
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'))).provenance
        .sourceCommit,
      'a'.repeat(40),
    );
  }));
test('new-target rename failure restores known old only and retains journal', () =>
  setup(({ target, candidate, evidence }) => {
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes('.stage-') && to === target)
        throw Error('synthetic-stage-publication-failure');
      return rename(from, to);
    });
    assert.throws(
      () => replaceExactRejected(candidate, target, evidence),
      /synthetic/,
    );
    validateExactRejected(target);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(evidence, 'transaction.json')))
        .state,
      'known-old-restored',
    );
  }));
test('unknown replacement path remains untouched; no guessed rollback or delete', () =>
  setup(({ target, candidate, evidence }) => {
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      const result = rename(from, to);
      if (from === target) {
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'unknown.txt'), 'replacement');
      }
      return result;
    });
    assert.throws(() => replaceExactRejected(candidate, target, evidence));
    assert.equal(
      fs.readFileSync(path.join(target, 'unknown.txt'), 'utf8'),
      'replacement',
    );
    assert.equal(fs.existsSync(path.join(evidence, 'transaction.json')), true);
  }));
for (const defect of [
  'accepted-kind',
  'old-hash',
  'old-png',
  'unknown-source',
  'missing-file',
])
  test(`rejected supersession ${defect} refuses before moves`, () =>
    setup(({ target, candidate, evidence }) => {
      const file = path.join(target, 'manifest.json'),
        manifest = JSON.parse(fs.readFileSync(file));
      if (defect === 'accepted-kind') manifest.kind = 'accepted';
      if (defect === 'unknown-source')
        manifest.provenance.sourceCommit = '0'.repeat(40);
      if (['accepted-kind', 'unknown-source'].includes(defect))
        fs.writeFileSync(file, JSON.stringify(manifest));
      if (defect === 'old-hash') fs.appendFileSync(file, ' ');
      if (defect === 'old-png')
        fs.appendFileSync(path.join(target, manifest.files[0].name), 'tamper');
      if (defect === 'missing-file')
        fs.unlinkSync(path.join(target, manifest.files[0].name));
      assert.throws(() => replaceExactRejected(candidate, target, evidence));
      assert.equal(fs.existsSync(evidence), false);
      assert.equal(fs.existsSync(target), true);
    }));
