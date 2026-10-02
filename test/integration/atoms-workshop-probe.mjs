import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkTokenFreshness,
  materializeTokens,
} from '../../tools/tokens-io.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url)),
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(process.env.TMPDIR, 'gol501-workshop-')),
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
      'Owned workshop child cleanup failed',
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
    out = path.join(source, '.atoms-build'),
    configArgs = [
      '--config',
      '.ladle',
      '--viteConfig',
      '.ladle/vite.config.mjs',
      '--outDir',
      '.atoms-build',
    ];
  const built = spawnSync(
    process.execPath,
    [
      cli,
      'build',
      ...configArgs,
      '--stories',
      'dashboard/web/src/ui/atoms/*.stories.tsx',
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
    'Ladle exit alone does not prove build',
  );
  assert.ok(
    fs.readdirSync(path.join(out, 'assets')).length > 0,
    'Ladle fresh assets required',
  );
  const metaFile = path.join(out, 'meta.json');
  assert.equal(fs.existsSync(metaFile), true, 'Ladle fresh metadata required');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  for (const story of [
    'button--states',
    'icon-button--states',
    'input--states',
    'pill--states',
    'badge--states',
  ])
    assert.ok(
      Object.hasOwn(meta.stories, story),
      `Missing actual story membership: ${story}`,
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
      throw Error(`Owned preview exited before readiness: ${log}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/meta.json`);
      lastProbe = `meta status ${response.status}`;
      if (
        response.ok &&
        JSON.stringify(await response.json())
          .toLowerCase()
          .includes('button')
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
    `Actual owned preview readiness required, not Ladle exit/log alone; ${lastProbe}; child log: ${log}`,
  );
  const index = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(index.status, 200);
  assert.ok((await index.text()).includes('<html'));
  // Real negative runner: metadata can be loaded, but missing facilities must refuse before Chromium.
  const beforeProfiles = fs
    .readdirSync(process.env.TMPDIR)
    .filter((name) => name.startsWith('gol501-chrome-'));
  const missing = spawnSync(
    process.execPath,
    [
      path.join(source, 'node_modules/@playwright/test/cli.js'),
      'test',
      '--config',
      'test/e2e/playwright.atoms.config.ts',
      '--project',
      'atoms-functional',
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
    /Atom browser checks require owned TMPDIR\/results and explicit private base URL/,
  );
  assert.deepEqual(
    fs
      .readdirSync(process.env.TMPDIR)
      .filter((name) => name.startsWith('gol501-chrome-')),
    beforeProfiles,
    'Missing env cannot allocate or leak a browser profile',
  );
  const mode = process.argv[2] ?? 'build';
  if (mode === 'functional' || mode === 'visual' || mode === 'baseline') {
    const results = path.join(root, 'results');
    fs.mkdirSync(results);
    const env = {
      ...childEnv,
      GOLEM_ATOMS_BASE_URL: `http://127.0.0.1:${port}`,
      GOLEM_ATOMS_RESULTS_ROOT: results,
    };
    const args = [
      'test',
      '--config',
      'test/e2e/playwright.atoms.config.ts',
      '--project',
      mode === 'functional' ? 'atoms-functional' : 'atoms-visual',
    ];
    if (mode === 'baseline') args.push('--update-snapshots');
    const browser = spawnSync(
      process.execPath,
      [path.join(source, 'node_modules/@playwright/test/cli.js'), ...args],
      {
        cwd: source,
        env,
        encoding: 'utf8',
        timeout: 240000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    process.stdout.write(browser.stdout ?? '');
    process.stderr.write(browser.stderr ?? '');
    assert.equal(browser.status, 0, 'Actual browser suite failed');
    if (mode === 'baseline')
      throw Error(
        'Baseline output is owned private candidate; explicit reviewed copy path must be supplied, never silently published',
      );
  } else assert.equal(mode, 'build');
  await stop(server);
  assert.notEqual(server.exitCode === null && server.signalCode === null, true);
  console.log(
    'GOL501 owned Ladle build+actual preview PASS: five story membership, fresh assets/meta, no legacy app activation',
  );
} finally {
  await stop(server);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false);
}
