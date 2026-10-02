import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

export const atomImageDigest =
  'sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7';
export const expectedCandidates = () =>
  ['button', 'iconbutton', 'input', 'pill', 'badge']
    .flatMap((atom) =>
      ['light', 'dark'].flatMap((theme) =>
        ['cozy', 'compact'].flatMap((density) =>
          [320, 640].map((width) => `${atom}-${theme}-${density}-${width}.png`),
        ),
      ),
    )
    .sort();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export const completeDockerCid = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function assertProductionLineage(
  captured,
  productionSources,
  changedPaths,
  ancestor,
) {
  assert.equal(
    ancestor,
    true,
    'Candidate must descend from original captured source',
  );
  assert.deepEqual(
    productionSources,
    captured.productionSources,
    'All production and renderer/test inputs must retain original bytes',
  );
  assert.ok(
    changedPaths.every((file) =>
      file.startsWith('test/e2e/__screenshots__/atoms/'),
    ),
    'Only validated candidate artifact paths may differ',
  );
}
export function assertObservedIdentity(captured, observed) {
  for (const field of [
    'imageDigest',
    'imageId',
    'platform',
    'playwright',
    'chromiumVersion',
    'chromiumRevision',
    'executableSha256',
    'registrySha256',
    'nodeVersion',
  ])
    assert.equal(
      observed[field],
      captured[field],
      `Original captured ${field} must match observed comparison identity`,
    );
  assert.equal(observed.imageObserved, true);
  assert.equal(observed.executableObserved, true);
}
export function ownedDirectory(directory) {
  const stat = fs.lstatSync(directory);
  assert.ok(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid?.() &&
      !(stat.mode & 0o022),
    'Candidate facility must be an owned regular directory',
  );
  return stat;
}
export function readRegular(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    assert.ok(
      stat.isFile() &&
        stat.uid === process.getuid?.() &&
        stat.size <= 20 * 1024 * 1024,
      'Candidate file ownership/type/size',
    );
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function validateCandidates(images, records, provenance) {
  ownedDirectory(images);
  ownedDirectory(records);
  const names = expectedCandidates();
  assert.deepEqual(
    fs.readdirSync(images).sort(),
    names,
    'Exactly the named40 PNGs required',
  );
  assert.deepEqual(
    fs.readdirSync(records).sort(),
    names.map((name) => name + '.json').sort(),
    'Exactly40 capture records required',
  );
  assert.equal(provenance.platform, 'linux/amd64');
  assert.equal(provenance.playwright, '1.63.0');
  assert.equal(provenance.chromiumVersion, '153.0.8010.12');
  assert.equal(provenance.chromiumRevision, '1243');
  for (const field of [
    'imageDigest',
    'imageId',
    'executableSha256',
    'registrySha256',
    'sourceCommit',
    'sourceTree',
    'archiveSha256',
    'generation',
    'fontInventorySha256',
  ])
    assert.ok(
      typeof provenance[field] === 'string' && provenance[field],
      `Missing provenance ${field}`,
    );
  assert.equal(provenance.imageDigest, atomImageDigest);
  assert.equal(provenance.imageObserved, true);
  assert.equal(provenance.executableObserved, true);
  for (const field of [
    'executableSha256',
    'registrySha256',
    'archiveSha256',
    'fontInventorySha256',
  ])
    assert.match(provenance[field], /^[a-f0-9]{64}$/);
  assert.match(provenance.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.match(provenance.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(provenance.sourceTree, /^[a-f0-9]{40}$/);
  assert.ok(
    provenance.productionSources &&
      Object.keys(provenance.productionSources).length > 0,
    'Original render-input hashes required',
  );
  for (const value of Object.values(provenance.productionSources))
    assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal(provenance.fonts.length, 7);
  assert.equal(provenance.clock, '2026-10-01T00:00:00Z');
  assert.equal(provenance.locale, 'en-US');
  assert.equal(provenance.timezone, 'UTC');
  assert.equal(provenance.scale, 1);
  for (const font of provenance.fonts) {
    assert.match(font.file, /^[a-z0-9-]+\.woff2$/);
    assert.match(font.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(font.bytes) && font.bytes > 0);
  }
  assert.equal(
    provenance.functionalGreen,
    true,
    'No candidates before actual functional green',
  );
  const files = names.map((name) => {
    const bytes = readRegular(path.join(images, name));
    assert.ok(
      bytes.length > 24 &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        bytes.subarray(12, 16).toString() === 'IHDR',
      'Actual PNG/IHDR required',
    );
    assert.equal(bytes.readUInt32BE(8), 13);
    assert.equal(bytes[24], 8);
    assert.ok([2, 6].includes(bytes[25]));
    assert.equal(bytes[28], 0, 'Noninterlaced browser PNG required');
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    let offset = 8;
    const idat = [];
    let ended = false;
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset),
        type = bytes.subarray(offset + 4, offset + 8).toString();
      assert.ok(offset + 12 + size <= bytes.length, 'Truncated PNG chunk');
      assert.equal(
        bytes.readUInt32BE(offset + 8 + size),
        pngCrc32(bytes.subarray(offset + 4, offset + 8 + size)),
        'PNG chunk checksum',
      );
      if (type === 'IDAT')
        idat.push(bytes.subarray(offset + 8, offset + 8 + size));
      offset += 12 + size;
      if (type === 'IEND') {
        assert.equal(size, 0);
        ended = true;
        break;
      }
    }
    assert.ok(
      ended && offset === bytes.length && idat.length,
      'Complete PNG image data and end marker required',
    );
    const pixels = inflateSync(Buffer.concat(idat), {
      maxOutputLength: 64 * 1024 * 1024,
    });
    assert.equal(
      pixels.length,
      height * (1 + width * (bytes[25] === 6 ? 4 : 3)),
      'Actual nonempty pixel rows required',
    );
    const record = JSON.parse(
      readRegular(path.join(records, name + '.json')).toString('utf8'),
    );
    assert.equal(record.name, name);
    assert.ok(
      [320, 640].includes(record.viewport.width) &&
        record.viewport.height === 1200 &&
        record.scale === 1,
    );
    assert.ok(
      width > 0 &&
        height > 0 &&
        Number.isFinite(record.panel.width) &&
        Number.isFinite(record.panel.height),
    );
    assert.ok(
      Math.abs(width - record.panel.width) <= 1 &&
        Math.abs(height - record.panel.height) <= 1,
      'PNG footprint must match actual panel capture geometry at scale1',
    );
    assert.equal(
      name,
      `${record.atom}-${record.theme}-${record.density}-${record.viewport.width}.png`,
    );
    assert.equal(record.axeViolations, 0);
    assert.equal(record.fontsReady, true);
    assert.equal(record.browserVersion, provenance.chromiumVersion);
    return { name, width, height, sha256: hash(bytes), record };
  });
  return {
    schema: 1,
    kind: 'initial-atom-baseline-candidates-NOT-ACCEPTED',
    provenance,
    files,
  };
}
export function retainCandidates(images, records, destination, provenance) {
  const manifest = validateCandidates(images, records, provenance);
  assert.ok(path.isAbsolute(destination));
  ownedDirectory(path.dirname(destination));
  assert.equal(
    fs.existsSync(destination),
    false,
    'Never overwrite old candidate/baseline paths',
  );
  fs.mkdirSync(destination, { mode: 0o700 });
  const identity = fs.lstatSync(destination);
  try {
    for (const file of manifest.files)
      fs.writeFileSync(
        path.join(destination, file.name),
        readRegular(path.join(images, file.name)),
        { flag: 'wx', mode: 0o644 },
      );
    fs.writeFileSync(
      path.join(destination, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      { flag: 'wx', mode: 0o644 },
    );
  } catch (error) {
    const current = fs.lstatSync(destination);
    if (current.ino === identity.ino && current.dev === identity.dev)
      fs.rmSync(destination, { recursive: true });
    throw error;
  }
  return manifest;
}
function validateRetainedCandidates(candidate) {
  ownedDirectory(candidate);
  const manifest = JSON.parse(
    readRegular(path.join(candidate, 'manifest.json')).toString('utf8'),
  );
  const names = expectedCandidates();
  assert.deepEqual(
    fs.readdirSync(candidate).sort(),
    [...names, 'manifest.json'].sort(),
  );
  assert.deepEqual(manifest.files.map((file) => file.name).sort(), names);
  assert.equal(manifest.kind, 'initial-atom-baseline-candidates-NOT-ACCEPTED');
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.provenance.imageDigest, atomImageDigest);
  assert.equal(manifest.provenance.platform, 'linux/amd64');
  assert.equal(manifest.provenance.playwright, '1.63.0');
  assert.equal(manifest.provenance.chromiumVersion, '153.0.8010.12');
  assert.equal(manifest.provenance.chromiumRevision, '1243');
  assert.equal(manifest.provenance.imageObserved, true);
  assert.equal(manifest.provenance.executableObserved, true);
  assert.equal(manifest.provenance.functionalGreen, true);
  for (const file of manifest.files) {
    const bytes = readRegular(path.join(candidate, file.name));
    assert.equal(hash(bytes), file.sha256);
    assert.equal(bytes.readUInt32BE(16), file.width);
    assert.equal(bytes.readUInt32BE(20), file.height);
    assert.equal(file.record.name, file.name);
    assert.equal(file.record.axeViolations, 0);
    assert.equal(file.record.fontsReady, true);
    assert.equal(
      file.record.browserVersion,
      manifest.provenance.chromiumVersion,
    );
  }
  return manifest;
}
export function copyValidatedCandidates(candidate, destination) {
  const manifest = validateRetainedCandidates(candidate),
    names = expectedCandidates();
  assert.ok(path.isAbsolute(destination));
  ownedDirectory(path.dirname(destination));
  assert.equal(
    fs.existsSync(destination),
    false,
    'Initial baseline destination must be absent',
  );
  assert.ok(
    destination.endsWith(path.join('test', 'e2e', '__screenshots__', 'atoms')),
    'Only the named initial atom baseline destination is supported',
  );
  fs.mkdirSync(destination, { mode: 0o755 });
  const identity = fs.lstatSync(destination);
  try {
    for (const name of [...names, 'manifest.json'])
      fs.writeFileSync(
        path.join(destination, name),
        readRegular(path.join(candidate, name)),
        { flag: 'wx', mode: 0o644 },
      );
  } catch (error) {
    const current = fs.lstatSync(destination);
    if (current.ino === identity.ino && current.dev === identity.dev)
      fs.rmSync(destination, { recursive: true });
    throw error;
  }
  return manifest;
}

export const rejectedInitialTuple = Object.freeze({
  candidateCommit: '14f44e418f4297d6e67ff82c506329b723f635d8',
  sourceCommit: 'fb13de1e2f66e0e931224c82251d4aa4f25795f6',
  manifestSha256:
    '3e3917bacf4b044e50fee66141e4d0245209238560e2dd8508a633e9b30100f5',
  kind: 'initial-atom-baseline-candidates-NOT-ACCEPTED',
});
function pathPresent(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function directoryIdentity(folder) {
  const stat = ownedDirectory(folder);
  return { device: stat.dev, inode: stat.ino, uid: stat.uid };
}
function fence(folder, expected) {
  assert.deepEqual(
    directoryIdentity(folder),
    expected,
    'Directory incarnation changed; leave unknown path untouched',
  );
}
export function validateExactRejected(folder) {
  const manifest = validateRetainedCandidates(folder),
    bytes = readRegular(path.join(folder, 'manifest.json'));
  assert.equal(
    hash(bytes),
    rejectedInitialTuple.manifestSha256,
    'Only explicitly rejected initial manifest may supersede',
  );
  assert.equal(manifest.kind, rejectedInitialTuple.kind);
  assert.equal(
    manifest.provenance.sourceCommit,
    rejectedInitialTuple.sourceCommit,
  );
  return {
    manifest,
    identity: directoryIdentity(folder),
    manifestSha256: hash(bytes),
  };
}
function copySet(source, destination) {
  const manifest = validateRetainedCandidates(source);
  assert.equal(pathPresent(destination), false);
  fs.mkdirSync(destination, { mode: 0o700 });
  const identity = directoryIdentity(destination);
  for (const name of [...expectedCandidates(), 'manifest.json']) {
    fence(destination, identity);
    fs.writeFileSync(
      path.join(destination, name),
      readRegular(path.join(source, name)),
      { flag: 'wx', mode: 0o644 },
    );
  }
  validateRetainedCandidates(destination);
  return { manifest, identity };
}
export function retireRejectedPrivate(privateCopy, folder, backup) {
  const sandbox = process.env.GOLEM_W2_SANDBOX;
  assert.ok(sandbox && path.isAbsolute(sandbox));
  const privateRelative = path.relative(
    fs.realpathSync(sandbox),
    fs.realpathSync(privateCopy),
  );
  assert.ok(
    privateRelative &&
      !privateRelative.startsWith('..' + path.sep) &&
      !path.isAbsolute(privateRelative),
    'Retirement only within allocated W2 private copy',
  );
  assert.equal(
    path.resolve(folder),
    path.join(path.resolve(privateCopy), 'test/e2e/__screenshots__/atoms'),
  );
  assert.ok(path.isAbsolute(backup));
  const parent = path.dirname(folder),
    parentId = directoryIdentity(parent),
    old = validateExactRejected(folder);
  ownedDirectory(path.dirname(backup));
  assert.equal(pathPresent(backup), false);
  fence(parent, parentId);
  fence(folder, old.identity);
  validateExactRejected(folder);
  fs.renameSync(folder, backup);
  fence(backup, old.identity);
  validateExactRejected(backup);
  return old;
}
export function replaceExactRejected(candidate, target, evidence) {
  assert.ok(
    path.isAbsolute(target) &&
      target.endsWith(path.join('test', 'e2e', '__screenshots__', 'atoms')),
  );
  const fresh = validateRetainedCandidates(candidate);
  assert.deepEqual(
    fresh.provenance.supersedes,
    rejectedInitialTuple,
    'New provenance must explicitly name rejected tuple',
  );
  const parent = path.dirname(target),
    parentId = directoryIdentity(parent),
    old = validateExactRejected(target);
  assert.ok(path.isAbsolute(evidence));
  ownedDirectory(path.dirname(evidence));
  assert.equal(pathPresent(evidence), false);
  fs.mkdirSync(evidence, { mode: 0o700 });
  const evidenceId = directoryIdentity(evidence),
    nonce = String(Date.now()) + '-' + process.pid,
    stage = target + '.stage-' + nonce,
    backup = target + '.rejected-' + nonce;
  let stageId,
    oldMoved = false,
    newMoved = false;
  const journal = {
    schema: 1,
    operation: 'EXACT_REJECTED_INITIAL_SUPERSESSION',
    oldTuple: rejectedInitialTuple,
    parentIdentity: parentId,
    oldIdentity: old.identity,
    newManifestSha256: hash(readRegular(path.join(candidate, 'manifest.json'))),
    state: 'intent',
    stage,
    backup,
    target,
  };
  const record = (state) => {
    fence(evidence, evidenceId);
    journal.state = state;
    fs.writeFileSync(
      path.join(evidence, 'transaction.json'),
      JSON.stringify(journal, null, 2) + '\n',
    );
  };
  record('intent');
  try {
    fence(parent, parentId);
    fence(target, old.identity);
    validateExactRejected(target);
    const staged = copySet(candidate, stage);
    stageId = staged.identity;
    journal.stageIdentity = stageId;
    record('stage-verified-before-moves');
    fence(parent, parentId);
    fence(target, old.identity);
    validateExactRejected(target);
    fence(stage, stageId);
    validateRetainedCandidates(stage);
    assert.equal(pathPresent(backup), false);
    fs.renameSync(target, backup);
    oldMoved = true;
    fence(parent, parentId);
    fence(backup, old.identity);
    validateExactRejected(backup);
    record('old-backed-up');
    fence(parent, parentId);
    fence(backup, old.identity);
    fence(stage, stageId);
    assert.equal(pathPresent(target), false);
    fs.renameSync(stage, target);
    newMoved = true;
    fence(parent, parentId);
    fence(target, stageId);
    assert.equal(
      hash(readRegular(path.join(target, 'manifest.json'))),
      journal.newManifestSha256,
    );
    validateRetainedCandidates(target);
    record('new-target-verified');
    fence(parent, parentId);
    fence(backup, old.identity);
    validateExactRejected(backup);
    copySet(backup, path.join(evidence, 'old-rejected'));
    record('old-evidence-verified');
    fence(parent, parentId);
    fence(backup, old.identity);
    validateExactRejected(backup);
    fs.rmSync(backup, { recursive: true });
    record('complete');
    return { manifest: fresh, journal, evidence };
  } catch (error) {
    record('failure-evidence-retained');
    if (oldMoved && !newMoved) {
      fence(parent, parentId);
      fence(backup, old.identity);
      validateExactRejected(backup);
      assert.equal(
        pathPresent(target),
        false,
        'Unknown replacement target untouched',
      );
      fs.renameSync(backup, target);
      fence(target, old.identity);
      validateExactRejected(target);
      record('known-old-restored');
    }
    if (stageId && pathPresent(stage)) {
      fence(parent, parentId);
      fence(stage, stageId);
      validateRetainedCandidates(stage);
      assert.equal(
        hash(readRegular(path.join(stage, 'manifest.json'))),
        journal.newManifestSha256,
      );
      fs.rmSync(stage, { recursive: true });
    }
    throw error;
  }
}
