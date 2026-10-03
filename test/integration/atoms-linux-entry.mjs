// Container-side payload. Host releases a per-container gate only after inspecting immutable identity.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from '../support/run-script.mjs';
import { atomImageDigest, readRegular } from './atoms-candidates.mjs';

const mode = process.argv[2],
  gate = process.argv[3],
  identityFile = process.argv[4],
  candidate = process.argv[5];
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.equal(process.env.GOLEM_ATOMS_IMAGE_DIGEST, atomImageDigest);
let authorized = false;
for (let n = 0; n < 300; n++) {
  try {
    authorized = readRegular(gate).toString() === process.env.GOLEM_ATOMS_NONCE;
    if (authorized) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(
  authorized,
  true,
  'No payload before actual container/image binding proof',
);
const root = process.cwd(),
  owned = path.join(root, '.owned');
const digest = (file) =>
  createHash('sha256').update(readRegular(file)).digest('hex');
if (mode === 'prepare') {
  const install = spawnSync(
    'npm',
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 240000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  assert.equal(install.status, 0, install.stderr);
  const { chromium } = await import('@playwright/test');
  const manifest = JSON.parse(
      readRegular(
        path.join(root, 'node_modules/playwright-core/browsers.json'),
      ).toString(),
    ),
    registry = manifest.browsers.find((browser) => browser.name === 'chromium');
  assert.equal(
    JSON.parse(
      readRegular(
        path.join(root, 'node_modules/@playwright/test/package.json'),
      ).toString(),
    ).version,
    '1.63.0',
  );
  assert.equal(
    JSON.parse(
      readRegular(
        path.join(root, 'node_modules/playwright-core/package.json'),
      ).toString(),
    ).version,
    '1.63.0',
  );
  assert.equal(registry.revision, '1243');
  assert.equal(registry.browserVersion, '153.0.8010.12');
  const executable = chromium.executablePath(),
    stat = fs.statSync(executable);
  assert.ok(
    stat.isFile() && stat.mode & 0o111,
    'Actual bundled Chromium executable required',
  );
  const version = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(version.status, 0, version.stderr);
  const observed = /\d+\.\d+\.\d+\.\d+/.exec(version.stdout)?.[0];
  assert.equal(observed, registry.browserVersion);
  const executableHash = createHash('sha256');
  for await (const chunk of fs.createReadStream(executable))
    executableHash.update(chunk);
  const source = JSON.parse(
    readRegular(path.join(owned, 'source.json')).toString(),
  );
  const identity = {
    ...source,
    platform: 'linux/amd64',
    imageDigest: atomImageDigest,
    imageId: process.env.GOLEM_ATOMS_IMAGE_ID,
    imageObserved: true,
    playwright: '1.63.0',
    chromiumRevision: registry.revision,
    chromiumVersion: observed,
    executable,
    executableSha256: executableHash.digest('hex'),
    executableObserved: true,
    registrySha256: digest(
      path.join(root, 'node_modules/playwright-core/browsers.json'),
    ),
    nodeVersion: process.version,
    browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
  };
  fs.writeFileSync(identityFile, JSON.stringify(identity, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log('Actual pinned Linux dependency/image/executable identity PASS');
} else {
  const identity = JSON.parse(readRegular(identityFile).toString());
  assert.equal(identity.imageId, process.env.GOLEM_ATOMS_IMAGE_ID);
  assert.equal(identity.imageDigest, atomImageDigest);
  assert.equal(identity.imageObserved, true);
  assert.equal(identity.executableObserved, true);
  const green = path.join(owned, 'functional-green.json');
  if (mode === 'capture' || mode === 'recapture' || mode === 'compare')
    assert.equal(
      readRegular(green).toString().trim(),
      digest(identityFile),
      'Functional green must bind to exact observed identity',
    );
  const args = [
    mode === 'capture'
      ? 'baseline'
      : mode === 'recapture'
        ? 'baseline-rejected-14f44'
        : mode === 'compare'
          ? 'visual'
          : 'functional',
    identityFile,
  ];
  if (candidate) args.push(candidate);
  const receipt = await runScript('test/integration/atoms-workshop-probe.mjs', {
    timeout: 480000,
    args,
  });
  assert.equal(receipt.code, 0);
  assert.equal(receipt.timedOut, false);
  assert.equal(receipt.pipeDrainTimedOut, false);
  assert.deepEqual(receipt.cleanupErrors, []);
  if (mode === 'functional')
    fs.writeFileSync(green, digest(identityFile) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  else
    assert.ok(
      ['capture', 'recapture', 'compare'].includes(mode),
      'Unknown browser stage',
    );
  console.log(`GOL501 actual pinned ${mode} PASS with owned cleanup`);
}
