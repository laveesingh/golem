// Real rejected artifact bytes are read from immutable git history into owned temp facilities.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, vi } from 'vitest';
import {
  copyValidatedCandidates,
  rejectedInitialTuple,
  replaceExactRejected,
  retireRejectedPrivate,
  validateExactRejected,
} from './atoms-candidates.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
async function setup(callback) {
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
    await callback({
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
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((cause) => String(cause).includes('synthetic')),
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

async function oldHelper(
  root,
  pin = '2ab9c6fa62f71b5de4d20bef579b49107abfabb4',
) {
  const value = spawnSync(
    'git',
    ['show', pin + ':test/integration/atoms-candidates.mjs'],
    { cwd: repo, timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
  );
  assert.equal(value.status, 0);
  const file = path.join(root, 'original-helper-' + pin + '.mjs');
  fs.writeFileSync(file, value.stdout);
  return import(pathToFileURL(file).href);
}
function journalFault(evidence, phase, callback) {
  const write = fs.writeFileSync;
  let fired = false;
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, value, ...rest) => {
    const result = write(file, value, ...rest);
    if (
      !fired &&
      String(file) === path.join(evidence, 'transaction.json') &&
      JSON.parse(String(value)).state === phase
    ) {
      fired = true;
      callback(JSON.parse(String(value)));
    }
    return result;
  });
  return () =>
    assert.equal(fired, true, 'Actual transaction phase fault must execute');
}
test('approved two-plane bridge preserves all nontransaction helper sections byte-identically', () => {
  const old = spawnSync(
    'git',
    [
      'show',
      '2ab9c6fa62f71b5de4d20bef579b49107abfabb4:test/integration/atoms-candidates.mjs',
    ],
    { cwd: repo, encoding: 'utf8', timeout: 10000 },
  ).stdout;
  const current = fs.readFileSync(
    new URL('./atoms-candidates.mjs', import.meta.url),
    'utf8',
  );
  assert.equal(
    current.slice(0, current.indexOf('// Transaction-only:')),
    old.slice(0, old.indexOf('function copySet(')),
  );
  const section = (text) =>
    text.slice(
      text.indexOf('export function retireRejectedPrivate'),
      text.indexOf('export function replaceExactRejected'),
    );
  assert.equal(section(current), section(old));
});
test('review evidence replacement FAILS on original helper (old concern), fixed helper retains original backup', async () => {
  await setup(async ({ root, target, candidate, evidence }) => {
    const old = await oldHelper(root),
      checked = journalFault(evidence, 'old-evidence-verified', () => {
        const retained = path.join(evidence, 'old-rejected');
        fs.renameSync(retained, path.join(evidence, 'actual-old-aside'));
        fs.mkdirSync(retained);
        fs.writeFileSync(path.join(retained, 'unknown.txt'), 'replacement');
      });
    const result = old.replaceExactRejected(candidate, target, evidence);
    checked();
    assert.equal(result.journal.state, 'complete');
    assert.equal(fs.existsSync(result.journal.backup), false);
    assert.throws(() =>
      validateExactRejected(path.join(evidence, 'old-rejected')),
    );
    console.log(
      'OLD_EVIDENCE_FAILOPEN reproduced: COMPLETE with unknown retained evidence and deleted original',
    );
  });
  await setup(({ target, candidate, evidence }) => {
    const checked = journalFault(evidence, 'old-evidence-verified', () => {
      const retained = path.join(evidence, 'old-rejected');
      fs.renameSync(retained, path.join(evidence, 'actual-old-aside'));
      fs.mkdirSync(retained);
      fs.writeFileSync(path.join(retained, 'unknown.txt'), 'replacement');
    });
    assert.throws(
      () => replaceExactRejected(candidate, target, evidence),
      (error) => error instanceof AggregateError,
    );
    checked();
    const journal = JSON.parse(
      fs.readFileSync(path.join(evidence, 'transaction.json')),
    );
    assert.notEqual(journal.state, 'complete');
    validateExactRejected(journal.backup);
    assert.equal(
      fs.readFileSync(path.join(evidence, 'old-rejected/unknown.txt'), 'utf8'),
      'replacement',
    );
  });
});
test('review same-inode stage tamper was published by old helper, fixed helper refuses before publication', async () => {
  const mutate = (journal) => {
    const file = path.join(journal.stage, 'manifest.json'),
      manifest = JSON.parse(fs.readFileSync(file));
    manifest.provenance.transactionTamper = true;
    fs.writeFileSync(file, JSON.stringify(manifest));
  };
  await setup(async ({ root, target, candidate, evidence }) => {
    const old = await oldHelper(root),
      checked = journalFault(evidence, 'old-backed-up', mutate);
    assert.throws(() => old.replaceExactRejected(candidate, target, evidence));
    checked();
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'))).provenance
        .transactionTamper,
      true,
    );
    console.log(
      'OLD_STAGE_FAILOPEN reproduced: same-inode changed stage published before hash failure',
    );
  });
  await setup(({ target, candidate, evidence }) => {
    const checked = journalFault(evidence, 'old-backed-up', mutate);
    assert.throws(
      () => replaceExactRejected(candidate, target, evidence),
      // Publication safety is asserted below, independently of exception representation.
    );
    checked();
    validateExactRejected(target);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'))).provenance
        .transactionTamper,
      undefined,
    );
  });
});
for (const phase of ['stage-verified-before-moves', 'old-backed-up'])
  test('original stage hashes fence publication at ' + phase, () =>
    setup(({ target, candidate, evidence }) => {
      const checked = journalFault(evidence, phase, (journal) =>
        fs.appendFileSync(path.join(journal.stage, 'manifest.json'), ' '),
      );
      assert.throws(() => replaceExactRejected(candidate, target, evidence));
      checked();
      validateExactRejected(target);
    }),
  );
for (const phase of [
  'old-evidence-verified',
  'original-backup-retention-ready',
  'original-backup-retained',
  'complete',
])
  test(
    'original old-evidence hashes fence retention/completion at ' + phase,
    () =>
      setup(({ target, candidate, evidence }) => {
        const checked = journalFault(evidence, phase, () =>
          fs.appendFileSync(
            path.join(evidence, 'old-rejected/manifest.json'),
            ' ',
          ),
        );
        assert.throws(
          () => replaceExactRejected(candidate, target, evidence),
          (error) => error instanceof AggregateError,
        );
        checked();
        const journal = JSON.parse(
          fs.readFileSync(path.join(evidence, 'transaction.json')),
        );
        assert.notEqual(journal.state, 'complete');
        validateExactRejected(
          fs.existsSync(journal.backup)
            ? journal.backup
            : path.join(evidence, 'original-backup'),
        );
      }),
  );
test('unknown evidence root is untouched and original backup survives', () =>
  setup(({ root, target, candidate, evidence }) => {
    const checked = journalFault(evidence, 'old-evidence-verified', () => {
      fs.renameSync(evidence, path.join(root, 'original-evidence-aside'));
      fs.mkdirSync(evidence);
      fs.writeFileSync(path.join(evidence, 'unknown.txt'), 'root-replacement');
    });
    assert.throws(
      () => replaceExactRejected(candidate, target, evidence),
      (error) => error instanceof AggregateError && error.errors.length >= 2,
    );
    checked();
    assert.equal(
      fs.readFileSync(path.join(evidence, 'unknown.txt'), 'utf8'),
      'root-replacement',
    );
    const journal = JSON.parse(
      fs.readFileSync(
        path.join(root, 'original-evidence-aside/transaction.json'),
      ),
    );
    validateExactRejected(journal.backup);
  }));
test('missing rollback path aggregates primary/fence failures and retains known bytes', () =>
  setup(({ root, target, candidate, evidence }) => {
    const held = path.join(root, 'original-backup-aside'),
      checked = journalFault(evidence, 'old-backed-up', (journal) =>
        fs.renameSync(journal.backup, held),
      );
    assert.throws(
      () => replaceExactRejected(candidate, target, evidence),
      (error) => error instanceof AggregateError && error.errors.length >= 2,
    );
    checked();
    validateExactRejected(held);
    assert.equal(fs.existsSync(target), false);
  }));

test('replaced evidence parent fails without touching replacement or deleting original backup', () =>
  setup(({ root, target, candidate, evidence }) => {
    const parent = path.join(root, 'evidence-parent');
    fs.mkdirSync(parent);
    const receipt = path.join(parent, 'receipt');
    const checked = journalFault(receipt, 'old-evidence-verified', () => {
      fs.renameSync(parent, path.join(root, 'original-parent-aside'));
      fs.mkdirSync(parent);
      fs.mkdirSync(receipt);
      fs.writeFileSync(path.join(receipt, 'unknown.txt'), 'parent-replacement');
    });
    assert.throws(
      () => replaceExactRejected(candidate, target, receipt),
      (error) => error instanceof AggregateError && error.errors.length >= 2,
    );
    checked();
    assert.equal(
      fs.readFileSync(path.join(receipt, 'unknown.txt'), 'utf8'),
      'parent-replacement',
    );
    const journal = JSON.parse(
      fs.readFileSync(
        path.join(root, 'original-parent-aside/receipt/transaction.json'),
      ),
    );
    validateExactRejected(journal.backup);
  }));

function aggregationFault(target, evidence) {
  let armed = false,
    stage;
  const stat = fs.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => {
    if (
      armed &&
      (String(file) === path.dirname(target) || String(file) === stage)
    ) {
      const error = new Error(
        'indeterminate ' +
          (String(file) === stage ? 'stage existence' : 'rollback parent'),
      );
      error.code = String(file) === stage ? 'EIO' : 'EACCES';
      throw error;
    }
    return stat(file, ...args);
  });
  const checked = journalFault(evidence, 'old-backed-up', (journal) => {
    stage = journal.stage;
    armed = true;
    throw Error('review primary journal callback failure');
  });
  return checked;
}
test('original1e3 aggregation defect reproduces raw stage error and lost named primary', async () =>
  setup(async ({ root, target, candidate, evidence }) => {
    const old = await oldHelper(
        root,
        '1e3e7809dfdeee03206d377bad5aef304a5e5147',
      ),
      checked = aggregationFault(target, evidence);
    let observed;
    try {
      old.replaceExactRejected(candidate, target, evidence);
    } catch (error) {
      observed = error;
    }
    checked();
    vi.restoreAllMocks();
    assert.equal(observed instanceof AggregateError, false);
    assert.equal(observed.code, 'EIO');
    assert.equal(observed.errors, undefined);
    assert.equal(
      String(observed).includes('review primary journal callback failure'),
      false,
    );
    const journal = JSON.parse(
      fs.readFileSync(path.join(evidence, 'transaction.json')),
    );
    validateExactRejected(journal.backup);
    console.log(
      'OLD_AGGREGATION_FAIL reproduced: raw EIO loses named primary and rollback causes',
    );
  }));
test('named primary plus indeterminate stage existence preserves complete aggregate and original bytes', () =>
  setup(({ target, candidate, evidence }) => {
    const checked = aggregationFault(target, evidence);
    let observed;
    try {
      replaceExactRejected(candidate, target, evidence);
    } catch (error) {
      observed = error;
    }
    checked();
    vi.restoreAllMocks();
    assert.ok(
      observed instanceof AggregateError,
      'Desired contract must aggregate stage-existence uncertainty',
    );
    assert.ok(
      observed.errors.some((error) =>
        String(error).includes('review primary journal callback failure'),
      ),
    );
    assert.ok(observed.errors.some((error) => error.code === 'EACCES'));
    assert.ok(observed.errors.some((error) => error.code === 'EIO'));
    const journal = JSON.parse(
      fs.readFileSync(path.join(evidence, 'transaction.json')),
    );
    validateExactRejected(journal.backup);
    assert.equal(fs.existsSync(journal.stage), true);
    assert.notEqual(journal.state, 'complete');
  }));
