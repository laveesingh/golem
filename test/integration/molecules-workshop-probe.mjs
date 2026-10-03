// S5 molecule workshop probe: owned Ladle build of the four molecule
// stories, actual preview readiness, then functional/visual/capture runs.
// Mirrors the GOL-501 atom probe shape without its rejected-candidate path.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkTokenFreshness,
  materializeTokens,
} from '../../tools/tokens-io.ts';
import {
  atomImageDigest,
  ownedDirectory,
  readRegular,
} from './atoms-candidates.mjs';
import {
  retainMolecules,
  validateRetainedMolecules,
} from './molecules-candidates.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url)),
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(process.env.TMPDIR, 'gol525-workshop-')),
  ),
  source = path.join(root, 'source');
const nativeCache = path.join(root, 'native-cache');
fs.mkdirSync(nativeCache, { mode: 0o700 });
const childEnv = { ...process.env, SWC_NATIVE_BINDING_CACHE: nativeCache };
let server;
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) =>
    child.once('exit', () => resolve(true)),
  );
  child.kill('SIGTERM');
  if (
    !(await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]))
  ) {
    child.kill('SIGKILL');
    assert.equal(
      await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
      ]),
      true,
      'Owned molecule workshop child cleanup failed',
    );
  }
}
try {
  fs.mkdirSync(source);
  const pinned = checkTokenFreshness(
    path.join(repo, 'dashboard/web/src/ui/tokens'),
  );
  for (const file of ['package.json', 'package-lock.json'])
    fs.copyFileSync(path.join(repo, file), path.join(source, file));
  for (const folder of ['.ladle', 'dashboard/web/src/ui', 'test/e2e'])
    fs.cpSync(path.join(repo, folder), path.join(source, folder), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  const copiedPointer = path.join(
    source,
    'dashboard/web/src/ui/tokens/generated',
  );
  assert.equal(fs.lstatSync(copiedPointer).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(copiedPointer), `.generations/${pinned.id}`);
  fs.unlinkSync(copiedPointer);
  materializeTokens(pinned, copiedPointer);
  fs.cpSync(
    path.join(repo, 'node_modules'),
    path.join(source, 'node_modules'),
    {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      mode: fs.constants.COPYFILE_FICLONE,
    },
  );
  const cli = path.join(source, 'node_modules/@ladle/react/lib/cli/cli.js'),
    out = path.join(source, '.molecules-build'),
    configArgs = [
      '--config',
      '.ladle',
      '--viteConfig',
      '.ladle/vite.config.mjs',
      '--outDir',
      '.molecules-build',
    ];
  const built = spawnSync(
    process.execPath,
    [
      cli,
      'build',
      ...configArgs,
      '--stories',
      'dashboard/web/src/ui/molecules/*.stories.tsx',
    ],
    {
      cwd: source,
      env: childEnv,
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  assert.equal(built.status, 0, built.stderr);
  assert.equal(
    fs.existsSync(path.join(out, 'index.html')),
    true,
    'Ladle exit alone does not prove molecule build',
  );
  assert.ok(
    fs.readdirSync(path.join(out, 'assets')).length > 0,
    'Ladle fresh molecule assets required',
  );
  const metaFile = path.join(out, 'meta.json');
  assert.equal(fs.existsSync(metaFile), true, 'Ladle fresh metadata required');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  for (const story of [
    'card--states',
    'list-row--states',
    'menu--states',
    'empty-state--states',
  ])
    assert.ok(
      Object.hasOwn(meta.stories, story),
      `Missing actual molecule story membership: ${story}`,
    );
  const previewIdentity = randomUUID();
  fs.writeFileSync(path.join(out, 'owned-preview.txt'), previewIdentity);
  const allocation = net.createServer();
  await new Promise((resolve) => allocation.listen(0, '127.0.0.1', resolve));
  const port = allocation.address().port;
  await new Promise((resolve) => allocation.close(resolve));
  assert.equal([7420, 7421].includes(port), false);
  let log = '';
  server = spawn(
    process.execPath,
    [
      cli,
      'preview',
      ...configArgs,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    { cwd: source, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  server.stdout.on('data', (data) => {
    log += String(data);
  });
  server.stderr.on('data', (data) => {
    log += String(data);
  });
  let ready = false,
    lastProbe = 'not attempted';
  for (let attempts = 0; attempts < 150; attempts++) {
    if (server.exitCode !== null || server.signalCode !== null)
      throw Error(`Owned molecule preview exited before readiness: ${log}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/meta.json`);
      lastProbe = `meta status ${response.status}`;
      if (
        response.ok &&
        JSON.stringify(await response.json())
          .toLowerCase()
          .includes('menu')
      ) {
        const identity = await fetch(
          `http://127.0.0.1:${port}/owned-preview.txt`,
        );
        const identityText = await identity.text();
        lastProbe += `; identity status ${identity.status}, match ${identityText === previewIdentity}`;
        if (identity.ok && identityText === previewIdentity) {
          ready = true;
          break;
        }
      }
    } catch (error) {
      lastProbe = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    ready,
    true,
    `Actual owned molecule preview readiness required, not Ladle exit/log alone; ${lastProbe}; child log: ${log}`,
  );
  const index = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(index.status, 200);
  assert.ok((await index.text()).includes('<html'));
  // Real negative runner: metadata can be loaded, but missing facilities must refuse before Chromium.
  const beforeProfiles = fs
    .readdirSync(process.env.TMPDIR)
    .filter((name) => name.startsWith('gol525-chrome-'));
  const missing = spawnSync(
    process.execPath,
    [
      path.join(source, 'node_modules/@playwright/test/cli.js'),
      'test',
      '--config',
      'test/e2e/playwright.molecules.config.ts',
      '--project',
      'molecules-functional',
    ],
    {
      cwd: source,
      env: childEnv,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(missing.status, 1);
  assert.match(
    (missing.stdout ?? '') + (missing.stderr ?? ''),
    /Molecule browser checks require owned TMPDIR\/results and explicit private base URL/,
  );
  assert.deepEqual(
    fs
      .readdirSync(process.env.TMPDIR)
      .filter((name) => name.startsWith('gol525-chrome-')),
    beforeProfiles,
    'Missing env cannot allocate or leak a molecule browser profile',
  );
  const mode = process.argv[2] ?? 'build';
  const captureMode = mode === 'baseline' || mode === 'rebaseline';
  if (mode === 'functional' || mode === 'visual' || captureMode) {
    const identityFile = process.argv[3],
      destination = process.argv[4];
    assert.ok(
      identityFile && path.isAbsolute(identityFile),
      'Observed browser identity facility required',
    );
    const identityBytes = readRegular(identityFile),
      identity = JSON.parse(identityBytes.toString());
    assert.equal(identity.platform, 'linux/amd64');
    assert.equal(identity.imageDigest, atomImageDigest);
    assert.equal(identity.imageObserved, true);
    assert.equal(identity.executableObserved, true);
    assert.equal(identity.playwright, '1.63.0');
    assert.equal(identity.chromiumVersion, '153.0.8010.12');
    assert.equal(identity.chromiumRevision, '1243');
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, 'x64');
    if (mode !== 'functional')
      assert.equal(
        readRegular(
          path.join(path.dirname(identityFile), 'functional-green.json'),
        )
          .toString()
          .trim(),
        createHash('sha256').update(identityBytes).digest('hex'),
        'Actual molecule functional green must precede candidate/comparison',
      );
    const results = path.join(root, 'results'),
      records = path.join(results, 'capture-records');
    fs.mkdirSync(results, { mode: 0o700 });
    fs.mkdirSync(records, { mode: 0o700 });
    const images = path.join(source, 'test/e2e/__screenshots__/molecules');
    let previous = null;
    if (mode === 'rebaseline') {
      previous = validateRetainedMolecules(images);
      fs.renameSync(images, path.join(root, 'previous-molecules'));
    }
    if (captureMode) {
      assert.ok(destination && path.isAbsolute(destination));
      ownedDirectory(path.dirname(destination));
      assert.equal(fs.existsSync(destination), false);
      assert.equal(
        fs.existsSync(images),
        false,
        'Initial molecule capture cannot overwrite old baselines',
      );
    }
    const resultParent = fs.lstatSync(root);
    const env = {
      ...childEnv,
      PLAYWRIGHT_BROWSERS_PATH: identity.browsersPath,
      GOLEM_MOLECULES_BASE_URL: `http://127.0.0.1:${port}`,
      GOLEM_MOLECULES_RESULTS_ROOT: results,
      GOLEM_MOLECULES_RESULTS_PARENT_IDENTITY: JSON.stringify({
        device: resultParent.dev,
        inode: resultParent.ino,
        uid: resultParent.uid,
        canonical: fs.realpathSync(root),
      }),
      GOLEM_MOLECULES_IMAGE_DIGEST: identity.imageDigest,
      GOLEM_MOLECULES_BROWSER_VERSION: identity.chromiumVersion,
      GOLEM_MOLECULES_IDENTITY_FILE: identityFile,
    };
    if (captureMode) {
      env.GOLEM_MOLECULES_CAPTURE = 'initial';
      env.GOLEM_MOLECULES_CAPTURE_RECORDS = records;
    }
    const args = [
      'test',
      '--config',
      'test/e2e/playwright.molecules.config.ts',
      '--project',
      mode === 'functional' ? 'molecules-functional' : 'molecules-visual',
    ];
    if (captureMode) args.push('--update-snapshots');
    const browser = spawnSync(
      process.execPath,
      [path.join(source, 'node_modules/@playwright/test/cli.js'), ...args],
      {
        cwd: source,
        env,
        encoding: 'utf8',
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    process.stdout.write(browser.stdout ?? '');
    process.stderr.write(browser.stderr ?? '');
    if (browser.status !== 0) {
      const retained = path.join(
        path.dirname(identityFile),
        'failed-molecule-browser-' + randomUUID(),
      );
      ownedDirectory(path.dirname(retained));
      fs.mkdirSync(retained, { mode: 0o700 });
      fs.cpSync(results, path.join(retained, 'results'), {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      fs.writeFileSync(
        path.join(retained, 'browser.log'),
        (browser.stdout ?? '') + (browser.stderr ?? ''),
      );
      throw Error(
        `Actual molecule browser suite failed; private failure artifacts retained at ${retained}`,
      );
    }
    if (captureMode) {
      const inventory = path.join(
          repo,
          'dashboard/web/src/ui/fonts/inventory.json',
        ),
        fonts = JSON.parse(readRegular(inventory).toString());
      const provenance = {
        ...identity,
        functionalGreen: true,
        generation: pinned.id,
        fontInventorySha256: createHash('sha256')
          .update(readRegular(inventory))
          .digest('hex'),
        fonts: fonts.map((font) => ({
          file: font.file,
          sha256: createHash('sha256')
            .update(readRegular(path.join(path.dirname(inventory), font.file)))
            .digest('hex'),
          bytes: font.bytes,
        })),
        clock: '2026-10-01T00:00:00Z',
        locale: 'en-US',
        timezone: 'UTC',
        scale: 1,
      };
      const fresh = retainMolecules(images, records, destination, provenance);
      if (previous) {
        const old = new Map(
          previous.files.map((file) => [file.name, file.sha256]),
        );
        assert.equal(fresh.files.length, previous.files.length);
        for (const file of fresh.files)
          assert.equal(
            file.sha256,
            old.get(file.name),
            `Rebased re-capture must stay pixel-identical: ${file.name}`,
          );
        console.log(
          'GOL525 molecule rebaseline PASS: 32 PNGs byte-identical across rebase; provenance rebound',
        );
      }
    }
  } else assert.equal(mode, 'build');
  await stop(server);
  assert.notEqual(server.exitCode === null && server.signalCode === null, true);
  console.log(
    'GOL525 owned Ladle build+actual molecule preview PASS: four story membership, fresh assets/meta, no legacy app activation',
  );
} finally {
  await stop(server);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false);
}
