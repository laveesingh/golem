// Explicit owned browser-stage launcher; no defaults for daemon, source pin or output facility.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomImageDigest,
  completeDockerCid,
  ownedDirectory,
  readRegular,
} from './atoms-candidates.mjs';
import { validateRetainedMolecules } from './molecules-candidates.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2),
  options = {};
assert.equal(args.length % 2, 0);
for (let i = 0; i < args.length; i += 2) {
  assert.ok(
    [
      '--docker-bin',
      '--docker-host',
      '--source-commit',
      '--mode',
      '--output',
      '--evidence',
    ].includes(args[i]),
  );
  assert.equal(Object.hasOwn(options, args[i]), false);
  options[args[i]] = args[i + 1];
}
const mode = options['--mode'],
  pin = options['--source-commit'],
  root = options['--output'],
  docker = options['--docker-bin'],
  host = options['--docker-host'];
assert.ok(['functional', 'baseline', 'visual'].includes(mode));
assert.match(pin, /^[a-f0-9]{40}$/);
assert.ok(path.isAbsolute(root));
const git = (...values) => {
  const result = spawnSync('git', values, {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
assert.equal(git('rev-parse', 'HEAD'), pin, 'Freeze exact source before stage');
assert.equal(
  git('status', '--porcelain'),
  '',
  'No code changes during browser stage',
);
assert.ok(
  path.isAbsolute(docker) &&
    path.basename(docker) === 'docker' &&
    fs.statSync(docker).isFile(),
);
assert.ok(host.startsWith('unix:///'));
assert.ok(
  fs.statSync(host.slice(7)).isSocket(),
  'Explicit local daemon facility required',
);
ownedDirectory(path.dirname(root));
assert.equal(fs.existsSync(root), false, 'New owned output root required');
fs.mkdirSync(root, { mode: 0o700 });
const config = path.join(root, 'docker'),
  source = path.join(root, 'source');
fs.mkdirSync(config, { mode: 0o700 });
fs.mkdirSync(source, { mode: 0o700 });
fs.writeFileSync(path.join(config, 'config.json'), '{}', { mode: 0o600 });
const env = {
  PATH: process.env.PATH,
  HOME: root,
  TMPDIR: root,
  DOCKER_CONFIG: config,
  DOCKER_HOST: host,
};
const image = `mcr.microsoft.com/playwright@${atomImageDigest}`,
  cidfiles = [];
const control = (...values) => {
  const receipt = spawnSync(
    docker,
    ['--config', config, '-H', host, ...values],
    { env, encoding: 'utf8', timeout: 300000, maxBuffer: 10 * 1024 * 1024 },
  );
  assert.equal(receipt.status, 0, receipt.stderr);
  return receipt.stdout;
};
const client = spawnSync(docker, ['--version'], {
  env,
  encoding: 'utf8',
  timeout: 10000,
});
assert.equal(client.status, 0);
assert.match(client.stdout, /^Docker version /);
let failure,
  interrupted = false;
const interrupt = () => {
  interrupted = true;
  for (const allocation of cidfiles) {
    try {
      if (!fs.existsSync(allocation.file)) continue;
      const cid = readRegular(allocation.file).toString().trim();
      if (!/^[a-f0-9]{64}$/.test(cid)) continue;
      const bound = spawnSync(
        docker,
        ['--config', config, '-H', host, 'inspect', cid],
        { env, encoding: 'utf8', timeout: 2000 },
      );
      if (
        bound.status === 0 &&
        JSON.parse(bound.stdout)[0].Config.Labels['golem.molecules.nonce'] ===
          allocation.nonce
      )
        spawnSync(
          docker,
          ['--config', config, '-H', host, 'rm', '--force', cid],
          { env, encoding: 'utf8', timeout: 3000 },
        );
    } catch {}
  }
};
process.on('SIGTERM', interrupt);
process.on('SIGINT', interrupt);
try {
  const archive = spawnSync('git', ['archive', '--format=tar', pin], {
    cwd: repo,
    timeout: 10000,
    maxBuffer: 100 * 1024 * 1024,
  });
  assert.equal(archive.status, 0);
  fs.writeFileSync(path.join(root, 'source.tar'), archive.stdout);
  const unpack = spawnSync(
    'tar',
    ['-xf', path.join(root, 'source.tar'), '-C', source],
    { timeout: 10000 },
  );
  assert.equal(unpack.status, 0);
  const owned = path.join(source, '.owned');
  fs.mkdirSync(owned, { mode: 0o700 });
  for (const dir of ['home', 'tmp', 'npm', 'swc', 'results'])
    fs.mkdirSync(path.join(owned, dir), { mode: 0o700 });
  for (const file of ['user.npmrc', 'global.npmrc'])
    fs.writeFileSync(path.join(owned, file), '', { mode: 0o600 });
  const productionSources = Object.fromEntries(
    git('ls-files')
      .split('\n')
      .filter(
        (file) =>
          (file.startsWith('dashboard/web/src/ui/') &&
            /\.(?:tsx?|css|json|woff2|txt)$/.test(file)) ||
          file === 'dashboard/web/src/ui/tokens/generated' ||
          [
            'package.json',
            'package-lock.json',
            '.ladle/config.mjs',
            '.ladle/vite.config.mjs',
            'test/e2e/atoms.fixture.ts',
            'test/e2e/atoms.spec.ts',
            'test/e2e/playwright.atoms.config.ts',
            'test/e2e/molecules.fixture.ts',
            'test/e2e/molecules.spec.ts',
            'test/e2e/playwright.molecules.config.ts',
            'test/integration/atoms-candidates.mjs',
            'test/integration/molecules-linux-entry.mjs',
            'test/integration/atoms-linux-probe.mjs',
            'test/integration/atoms-workshop-probe.mjs',
            'test/integration/molecules-candidates.mjs',
            'test/integration/molecules-linux-entry.mjs',
            'test/integration/molecules-linux-probe.mjs',
            'test/integration/molecules-workshop-probe.mjs',
          ].includes(file),
      )
      .sort()
      .map((file) => {
        const absolute = path.join(repo, file),
          bytes = fs.lstatSync(absolute).isSymbolicLink()
            ? Buffer.from('symlink:' + fs.readlinkSync(absolute))
            : fs.readFileSync(absolute);
        return [file, createHash('sha256').update(bytes).digest('hex')];
      }),
  );
  if (mode === 'visual') {
    const captured = validateRetainedMolecules(
      path.join(source, 'test/e2e/__screenshots__/molecules'),
    );
    const ancestor = spawnSync(
      'git',
      ['merge-base', '--is-ancestor', captured.provenance.sourceCommit, pin],
      { cwd: repo, timeout: 10000 },
    );
    assert.equal(
      ancestor.status,
      0,
      'Molecule baseline must descend from its captured source',
    );
    assert.deepEqual(
      productionSources,
      captured.provenance.productionSources,
      'All molecule production and renderer/test inputs must retain captured bytes',
    );
  }
  const sourceIdentity = {
    productionSources,
    sourceCommit: pin,
    sourceTree: git('rev-parse', `${pin}^{tree}`),
    archiveSha256: createHash('sha256').update(archive.stdout).digest('hex'),
  };
  fs.writeFileSync(
    path.join(owned, 'source.json'),
    JSON.stringify(sourceIdentity),
    { mode: 0o600 },
  );
  control('pull', '--platform', 'linux/amd64', image);
  const observed = JSON.parse(control('image', 'inspect', image))[0];
  assert.equal(observed.Os, 'linux');
  assert.equal(observed.Architecture, 'amd64');
  assert.ok(observed.RepoDigests.includes(image));
  fs.writeFileSync(
    path.join(root, 'image.json'),
    JSON.stringify(observed, null, 2),
  );
  const identity = '/work/golem/.owned/identity.json',
    candidate = '/work/golem/.owned/candidates';
  async function phase(stage, network) {
    assert.equal(
      interrupted,
      false,
      'Interrupted stage cannot allocate more containers',
    );
    const nonce = randomUUID(),
      cidfile = path.join(root, `cid-${stage}`),
      gate = path.join(owned, `gate-${nonce}`);
    cidfiles.push({ file: cidfile, nonce });
    fs.writeFileSync(
      path.join(root, `allocation-${stage}.json`),
      JSON.stringify({ nonce, imageId: observed.Id, cidfile }, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
    const run = spawn(
      docker,
      [
        '--config',
        config,
        '-H',
        host,
        'run',
        '--rm',
        '--init',
        '--platform',
        'linux/amd64',
        '--network',
        network,
        '--user',
        `${process.getuid()}:${process.getgid()}`,
        '--shm-size',
        '1g',
        '--cidfile',
        cidfile,
        '--name',
        `gol525-${nonce}`,
        '--label',
        `golem.molecules.nonce=${nonce}`,
        '--mount',
        `type=bind,src=${source},dst=/work/golem`,
        '--workdir',
        '/work/golem',
        '-e',
        'HOME=/work/golem/.owned/home',
        '-e',
        'TMPDIR=/work/golem/.owned/tmp',
        '-e',
        'NPM_CONFIG_USERCONFIG=/work/golem/.owned/user.npmrc',
        '-e',
        'NPM_CONFIG_GLOBALCONFIG=/work/golem/.owned/global.npmrc',
        '-e',
        'NPM_CONFIG_CACHE=/work/golem/.owned/npm',
        '-e',
        'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1',
        '-e',
        'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
        '-e',
        'SWC_NATIVE_BINDING_CACHE=/work/golem/.owned/swc',
        '-e',
        `GOLEM_MOLECULES_IMAGE_DIGEST=${atomImageDigest}`,
        '-e',
        `GOLEM_MOLECULES_IMAGE_ID=${observed.Id}`,
        '-e',
        `GOLEM_MOLECULES_NONCE=${nonce}`,
        image,
        'node',
        'test/integration/molecules-linux-entry.mjs',
        stage,
        `/work/golem/.owned/gate-${nonce}`,
        identity,
        candidate,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      startupError;
    run.stdout.on('data', (data) => {
      output = (output + String(data)).slice(-10 * 1024 * 1024);
    });
    run.stderr.on('data', (data) => {
      output = (output + String(data)).slice(-10 * 1024 * 1024);
    });
    const completed = new Promise((resolve) => {
      run.once('error', (error) => {
        startupError = error;
        resolve(null);
      });
      run.once('exit', (code) => resolve(code));
    });
    let cid = '';
    for (let tries = 0; tries < 150; tries++) {
      if (fs.existsSync(cidfile)) {
        const current = readRegular(cidfile).toString().trim();
        if (completeDockerCid(current)) {
          cid = current;
          break;
        }
      }
      if (interrupted || startupError || run.exitCode !== null) {
        fs.writeFileSync(path.join(root, `${stage}.log`), output);
        throw Error(
          `Container failed before authoritative CID: ${startupError ?? output}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    fs.writeFileSync(path.join(root, `${stage}.log`), output);
    assert.match(
      cid,
      /^[a-f0-9]{64}$/,
      'Docker CID contents must be complete, not an empty placeholder',
    );
    const binding = JSON.parse(control('inspect', cid))[0];
    assert.equal(binding.Image, observed.Id);
    assert.equal(binding.Config.Labels['golem.molecules.nonce'], nonce);
    fs.writeFileSync(
      path.join(root, `binding-${stage}.json`),
      JSON.stringify(binding, null, 2),
    );
    fs.writeFileSync(gate, nonce, { flag: 'wx', mode: 0o600 });
    let timer;
    const code = await Promise.race([
      completed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error(`Bounded ${stage} container timeout`)),
          600000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    fs.writeFileSync(path.join(root, `${stage}.log`), output);
    assert.equal(code, 0, output);
  }
  await phase('prepare', 'bridge');
  await phase('functional', 'none');
  if (mode === 'baseline') await phase('baseline', 'none');
  if (mode === 'visual') await phase('visual', 'none');
  fs.copyFileSync(
    path.join(owned, 'identity.json'),
    path.join(root, 'identity.json'),
  );
  fs.copyFileSync(
    path.join(owned, 'functional-green.json'),
    path.join(root, 'functional-green.json'),
  );
  if (mode === 'baseline') {
    const retained = path.join(root, 'candidates');
    fs.renameSync(path.join(owned, 'candidates'), retained);
    assert.equal(fs.existsSync(path.join(retained, 'manifest.json')), true);
  }
} catch (error) {
  failure = error;
}
const cleanup = [];
for (const allocation of cidfiles) {
  if (!fs.existsSync(allocation.file)) {
    cleanup.push('CID unavailable; root retained');
    continue;
  }
  try {
    const cid = readRegular(allocation.file).toString().trim();
    assert.match(cid, /^[a-f0-9]{64}$/);
    const check = spawnSync(
      docker,
      ['--config', config, '-H', host, 'inspect', cid],
      { env, encoding: 'utf8', timeout: 10000 },
    );
    if (check.status === 0) {
      const binding = JSON.parse(check.stdout)[0];
      if (binding.Config.Labels['golem.molecules.nonce'] !== allocation.nonce) {
        cleanup.push('Container incarnation mismatch; untouched');
        continue;
      }
      try {
        control('rm', '--force', cid);
      } catch (error) {
        cleanup.push(String(error));
      }
    } else if (
      check.status !== 1 ||
      !/No such (object|container)/i.test(check.stderr)
    )
      cleanup.push('Indeterminate container cleanup');
  } catch (error) {
    cleanup.push(String(error));
  }
}
process.off('SIGTERM', interrupt);
process.off('SIGINT', interrupt);
if (interrupted && !failure) failure = Error('Interrupted browser stage');
if (failure || cleanup.length) {
  fs.writeFileSync(
    path.join(root, 'failure.json'),
    JSON.stringify({ message: String(failure), cleanup }),
  );
  throw new AggregateError(
    [...(failure ? [failure] : []), ...cleanup],
    `Browser stage failed; owned artifacts retained at ${root}`,
  );
}
fs.rmSync(source, { recursive: true, force: true });
fs.rmSync(config, { recursive: true, force: true });
fs.writeFileSync(
  path.join(root, 'receipt.json'),
  JSON.stringify(
    {
      mode,
      pin,
      cleanupErrors: [],
      candidateStatus: mode === 'baseline' ? 'BASELINE' : 'none',
    },
    null,
    2,
  ),
);
console.log(
  `GOL525 molecule ${mode} stage PASS; actual receipts retained at ${root}; supplied pinned image preserved`,
);
