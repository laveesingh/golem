// S5 molecule baseline validation. Reuses the GOL-501 file/ownership
// primitives without touching the atom candidate machinery.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import {
  atomImageDigest,
  ownedDirectory,
  pngCrc32,
  readRegular,
} from './atoms-candidates.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const expectedMolecules = () =>
  ['card', 'listrow', 'menu', 'emptystate']
    .flatMap((molecule) =>
      ['light', 'dark'].flatMap((theme) =>
        ['cozy', 'compact'].flatMap((density) =>
          [320, 640].map(
            (width) => `${molecule}-${theme}-${density}-${width}.png`,
          ),
        ),
      ),
    )
    .sort();
export function validateMolecules(images, records, provenance) {
  ownedDirectory(images);
  ownedDirectory(records);
  const names = expectedMolecules();
  assert.deepEqual(
    fs.readdirSync(images).sort(),
    names,
    'Exactly the named32 molecule PNGs required',
  );
  assert.deepEqual(
    fs.readdirSync(records).sort(),
    names.map((name) => name + '.json').sort(),
    'Exactly32 molecule capture records required',
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
      `Missing molecule provenance ${field}`,
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
    'Original molecule render-input hashes required',
  );
  for (const value of Object.values(provenance.productionSources))
    assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal(provenance.fonts.length, 7);
  assert.equal(provenance.clock, '2026-10-01T00:00:00Z');
  assert.equal(provenance.locale, 'en-US');
  assert.equal(provenance.timezone, 'UTC');
  assert.equal(provenance.scale, 1);
  assert.equal(
    provenance.functionalGreen,
    true,
    'No molecule candidates before actual functional green',
  );
  const files = names.map((name) => {
    const bytes = readRegular(path.join(images, name));
    assert.ok(
      bytes.length > 24 &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        bytes.subarray(12, 16).toString() === 'IHDR',
      'Actual molecule PNG/IHDR required',
    );
    assert.equal(bytes.readUInt32BE(8), 13);
    assert.equal(bytes[24], 8);
    assert.ok([2, 6].includes(bytes[25]));
    assert.equal(bytes[28], 0, 'Noninterlaced molecule PNG required');
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
      'Complete molecule PNG image data and end marker required',
    );
    const pixels = inflateSync(Buffer.concat(idat), {
      maxOutputLength: 64 * 1024 * 1024,
    });
    assert.equal(
      pixels.length,
      height * (1 + width * (bytes[25] === 6 ? 4 : 3)),
      'Actual nonempty molecule pixel rows required',
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
      'Molecule PNG footprint must match actual panel capture geometry at scale1',
    );
    assert.equal(
      name,
      `${record.molecule}-${record.theme}-${record.density}-${record.viewport.width}.png`,
    );
    assert.equal(record.axeViolations, 0);
    assert.equal(record.fontsReady, true);
    assert.equal(record.browserVersion, provenance.chromiumVersion);
    return { name, width, height, sha256: hash(bytes), record };
  });
  return {
    schema: 1,
    kind: 's5-molecule-baseline-candidates',
    provenance,
    files,
  };
}
export function retainMolecules(images, records, destination, provenance) {
  const manifest = validateMolecules(images, records, provenance);
  assert.ok(path.isAbsolute(destination));
  ownedDirectory(path.dirname(destination));
  assert.equal(
    fs.existsSync(destination),
    false,
    'Never overwrite old molecule candidate/baseline paths',
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
export function validateRetainedMolecules(candidate) {
  ownedDirectory(candidate);
  const manifest = JSON.parse(
    readRegular(path.join(candidate, 'manifest.json')).toString('utf8'),
  );
  const names = expectedMolecules();
  assert.deepEqual(
    fs.readdirSync(candidate).sort(),
    [...names, 'manifest.json'].sort(),
  );
  assert.deepEqual(manifest.files.map((file) => file.name).sort(), names);
  assert.equal(manifest.kind, 's5-molecule-baseline-candidates');
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
  }
  return manifest;
}
