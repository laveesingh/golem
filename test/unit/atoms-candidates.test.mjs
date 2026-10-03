// Synthetic tiny PNGs exercise validator controls only; never screenshot/baseline evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { test } from 'vitest';
import {
  assertObservedIdentity,
  assertProductionLineage,
  atomImageDigest,
  completeDockerCid,
  copyValidatedCandidates,
  expectedCandidates,
  pngCrc32,
  retainCandidates,
  validateCandidates,
} from '../integration/atoms-candidates.mjs';

test('Docker CID readiness refuses empty placeholder and accepts only complete identity', () => {
  for (const value of [
    '',
    '\n',
    'a'.repeat(63),
    'a'.repeat(65),
    'g'.repeat(64),
    undefined,
  ])
    assert.equal(completeDockerCid(value), false);
  assert.equal(completeDockerCid('a'.repeat(64)), true);
});
function png(width, height) {
  const chunk = (type, payload) => {
    const size = Buffer.alloc(4),
      body = Buffer.concat([Buffer.from(type), payload]),
      crc = Buffer.alloc(4);
    size.writeUInt32BE(payload.length);
    crc.writeUInt32BE(pngCrc32(body));
    return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 4)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
test('PNG end chunk checksum matches known format vector', () =>
  assert.equal(pngCrc32(Buffer.from('IEND')), 0xae426082));
function fixture(callback) {
  const root = fs.mkdtempSync('/tmp/gol501-candidate-control-'),
    images = path.join(root, 'images'),
    records = path.join(root, 'records');
  fs.mkdirSync(images);
  fs.mkdirSync(records);
  const provenance = {
    platform: 'linux/amd64',
    imageDigest: atomImageDigest,
    imageId: 'sha256:' + 'a'.repeat(64),
    imageObserved: true,
    executableObserved: true,
    playwright: '1.63.0',
    chromiumVersion: '153.0.8010.12',
    chromiumRevision: '1243',
    productionSources: {
      'dashboard/web/src/ui/atoms/Button.tsx': 'a'.repeat(64),
      'test/e2e/atoms.fixture.ts': 'b'.repeat(64),
    },
    sourceCommit: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    archiveSha256: 'c'.repeat(64),
    executableSha256: 'd'.repeat(64),
    registrySha256: 'e'.repeat(64),
    fontInventorySha256: 'f'.repeat(64),
    generation: 'g-' + 'a'.repeat(64),
    fonts: Array.from({ length: 7 }, (_, index) => ({
      file: `font-${index}.woff2`,
      sha256: 'a'.repeat(64),
      bytes: 1,
    })),
    clock: '2026-10-01T00:00:00Z',
    locale: 'en-US',
    timezone: 'UTC',
    scale: 1,
    functionalGreen: true,
  };
  for (const name of expectedCandidates()) {
    const [atom, theme, density, widthText] = name
        .replace('.png', '')
        .split('-'),
      width = Number(widthText);
    fs.writeFileSync(path.join(images, name), png(width, 4));
    fs.writeFileSync(
      path.join(records, name + '.json'),
      JSON.stringify({
        name,
        atom,
        theme,
        density,
        viewport: { width, height: 1200 },
        panel: { width, height: 4 },
        scale: 1,
        axeViolations: 0,
        fontsReady: true,
        browserVersion: '153.0.8010.12',
      }),
    );
  }
  try {
    callback({ root, images, records, provenance });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('exact40 validated inputs retained, source copy only fortynew PNGs+manifest, no overwrite', () =>
  fixture(({ root, images, records, provenance }) => {
    const manifest = validateCandidates(images, records, provenance);
    assert.equal(manifest.files.length, 40);
    const candidate = path.join(root, 'candidate');
    retainCandidates(images, records, candidate, provenance);
    assert.equal(fs.readdirSync(candidate).length, 41);
    const parent = path.join(root, 'test/e2e/__screenshots__');
    fs.mkdirSync(parent, { recursive: true });
    const destination = path.join(parent, 'atoms');
    copyValidatedCandidates(candidate, destination);
    assert.equal(fs.readdirSync(destination).length, 41);
    assert.throws(() => copyValidatedCandidates(candidate, destination));
  }));
for (const defect of [
  'missing',
  'extra',
  'symlink',
  'truncated',
  'geometry',
  'browser',
  'functional',
  'pin',
])
  test(`candidate ${defect} fails before publication`, () =>
    fixture(({ root, images, records, provenance }) => {
      const name = expectedCandidates()[0],
        file = path.join(images, name),
        recordFile = path.join(records, name + '.json');
      if (defect === 'missing') fs.unlinkSync(file);
      if (defect === 'extra')
        fs.writeFileSync(path.join(images, 'extra.png'), png(1, 1));
      if (defect === 'symlink') {
        fs.renameSync(file, path.join(root, 'outside.png'));
        fs.symlinkSync(path.join(root, 'outside.png'), file);
      }
      if (defect === 'truncated')
        fs.writeFileSync(file, png(320, 4).subarray(0, 30));
      if (['geometry', 'browser'].includes(defect)) {
        const record = JSON.parse(fs.readFileSync(recordFile));
        if (defect === 'geometry') record.panel.width = 99;
        else record.browserVersion = 'wrong';
        fs.writeFileSync(recordFile, JSON.stringify(record));
      }
      if (defect === 'functional') provenance.functionalGreen = false;
      if (defect === 'pin') provenance.imageDigest = 'sha256:' + '0'.repeat(64);
      assert.throws(() =>
        retainCandidates(
          images,
          records,
          path.join(root, 'candidate'),
          provenance,
        ),
      );
      assert.equal(fs.existsSync(path.join(root, 'candidate')), false);
    }));
test('normal comparison preserves original captured source and browser provenance', () => {
  const captured = {
    productionSources: {
      'atom.tsx': 'a'.repeat(64),
      'clock-fixture.ts': 'b'.repeat(64),
    },
    imageDigest: atomImageDigest,
    imageId: 'sha256:' + 'c'.repeat(64),
    platform: 'linux/amd64',
    playwright: '1.63.0',
    chromiumVersion: '153.0.8010.12',
    chromiumRevision: '1243',
    executableSha256: 'd'.repeat(64),
    registrySha256: 'e'.repeat(64),
    nodeVersion: 'observed-node',
  };
  assertProductionLineage(
    captured,
    { ...captured.productionSources },
    ['test/e2e/__screenshots__/atoms/button-light-cozy-320.png'],
    true,
  );
  assertObservedIdentity(captured, {
    ...captured,
    imageObserved: true,
    executableObserved: true,
  });
  assert.throws(() =>
    assertProductionLineage(
      captured,
      { ...captured.productionSources, 'clock-fixture.ts': '0'.repeat(64) },
      [],
      true,
    ),
  );
  assert.throws(() =>
    assertProductionLineage(
      captured,
      captured.productionSources,
      ['dashboard/web/src/ui/atoms/Button.tsx'],
      true,
    ),
  );
  assert.throws(() =>
    assertProductionLineage(captured, captured.productionSources, [], false),
  );
  assert.throws(() =>
    assertObservedIdentity(captured, {
      ...captured,
      imageId: 'wrong',
      imageObserved: true,
      executableObserved: true,
    }),
  );
  assert.throws(() =>
    assertObservedIdentity(captured, {
      ...captured,
      executableSha256: 'wrong',
      imageObserved: true,
      executableObserved: true,
    }),
  );
  assert.equal(captured.productionSources['clock-fixture.ts'], 'b'.repeat(64));
});
test('retained PNG tamper prevents any source copy', () =>
  fixture(({ root, images, records, provenance }) => {
    const candidate = path.join(root, 'candidate');
    const manifest = retainCandidates(images, records, candidate, provenance);
    const name = manifest.files[0].name;
    fs.appendFileSync(path.join(candidate, name), 'tamper');
    const parent = path.join(root, 'test/e2e/__screenshots__');
    fs.mkdirSync(parent, { recursive: true });
    assert.throws(() =>
      copyValidatedCandidates(candidate, path.join(parent, 'atoms')),
    );
    assert.equal(fs.existsSync(path.join(parent, 'atoms')), false);
    assert.ok(
      createHash('sha256')
        .update(fs.readFileSync(path.join(candidate, name)))
        .digest('hex') !== manifest.files[0].sha256,
    );
  }));
