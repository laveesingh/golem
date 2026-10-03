import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  archiveTicket,
  createScratchTicket,
} from '../../dashboard/scripts/_scratch.mjs';
import { captureProcessGroup } from '../../lib/process-group.js';
import { stopMainGroup } from '../support/main-group.mjs';
import { createSandbox, repo } from '../support/sandbox.mjs';

// Run after a physical npm installation, never against a fake package fixture.
const installed = fs.realpathSync(process.argv[2]);
assert.ok(installed.split(path.sep).includes('node_modules'));
assert.equal(
  JSON.parse(fs.readFileSync(path.join(installed, 'package.json'))).name,
  '@laveesingh/golem',
);
assert.ok(!fs.existsSync(path.join(installed, 'cli/bootstrap.ts')));
const sandbox = createSandbox();
const bin = path.join(installed, 'cli/golem-bin.js');
// Invoke the real npm script through Node, with no inherited agent environment
// or reliance on an npm executable inside the sandbox's deliberately short PATH.
const npmCli = fs.realpathSync(
  process.argv[3] ??
    process.env.npm_execpath ??
    path.resolve(
      path.dirname(process.execPath),
      '../lib/node_modules/npm/bin/npm-cli.js',
    ),
);
const dashboardScript = ['--prefix', installed, 'run', 'dashboard', '--'];
const empty = path.join(sandbox.root, 'empty');
fs.mkdirSync(empty);
const env = {
  ...sandbox.env,
  GOLEM_ROOT: '/invalid/inherited/root',
  GOLEM_RENDER_ROOT: '/invalid/render',
};
function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: empty,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
let child, closed, ownership;
const tickets = [];
const prior = process.env.GOLEM_SMOKE_API;
try {
  assert.match(run([bin, '--help']), /Usage:/);
  run([
    '--input-type=module',
    '-e',
    `import assert from 'node:assert/strict'; import {readRoleCard} from ${JSON.stringify(pathToFileURL(path.join(installed, 'dist/lib/session-role.js')).href)}; assert.ok(readRoleCard('lead'));`,
  ]);
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  assert.ok(![7420, 7421].includes(port));
  child = spawn(
    process.execPath,
    [
      npmCli,
      ...dashboardScript,
      '--profile',
      'artefact',
      '--port',
      String(port),
    ],
    { cwd: empty, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  closed = once(child, 'close');
  await once(child, 'spawn');
  ownership = captureProcessGroup(child.pid);
  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk;
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk;
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 200; i++) {
    assert.equal(child.exitCode, null, logs);
    try {
      const response = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        assert.equal((await response.json()).ok, true);
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, logs);
  const profileFile = path.join(
    env.HOME,
    '.golem-profiles/artefact/profile.json',
  );
  const profileBefore = fs.readFileSync(profileFile, 'utf8');
  assert.equal(JSON.parse(profileBefore).port, port);
  const occupied = spawnSync(
    process.execPath,
    [npmCli, ...dashboardScript, '--profile=artefact', `--port=${port}`],
    { cwd: empty, env, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(occupied.error, undefined);
  assert.equal(occupied.status, 2, `${occupied.stdout}\n${occupied.stderr}`);
  assert.match(occupied.stderr, /occupied or unavailable/);
  assert.equal(fs.readFileSync(profileFile, 'utf8'), profileBefore);
  assert.equal(
    (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) }))
      .status,
    200,
  );
  const invalid = spawnSync(
    process.execPath,
    [npmCli, ...dashboardScript, '--profile', 'INVALID'],
    { cwd: empty, env, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(invalid.error, undefined);
  assert.equal(invalid.status, 2, `${invalid.stdout}\n${invalid.stderr}`);
  assert.match(invalid.stderr, /invalid profile name/);
  assert.ok(!fs.existsSync(path.join(env.HOME, '.golem-profiles/INVALID')));
  // No named profile: exercise the real server-child startup failure, rather
  // than bootstrap's pre-spawn profile port guard. Both consumers must fail1.
  for (const args of [
    [path.join(installed, 'dist/dashboard/server/index.js')],
    [npmCli, '--prefix', installed, 'run', 'dashboard'],
  ]) {
    const refused = spawnSync(process.execPath, args, {
      cwd: empty,
      env: { ...env, PORT: String(port) },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(refused.error, undefined);
    assert.equal(refused.status, 1, `${refused.stdout}\n${refused.stderr}`);
    assert.match(refused.stderr, /refusing to start another dashboard/);
  }
  assert.equal(
    (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) }))
      .status,
    200,
  );
  assert.equal(fs.readFileSync(profileFile, 'utf8'), profileBefore);
  process.env.GOLEM_SMOKE_API = base;
  tickets.push(
    (await createScratchTicket({ title: 'installed emitted contract' })).id,
  );
  const bad = await fetch(`${base}/api/tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 3 }),
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(bad.status, 400);
  for (const route of ['/api/templates', '/']) {
    const response = await fetch(base + route, {
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200, route);
    const text = await response.text();
    assert.ok(text.length > 100, route);
    if (route === '/') {
      for (const asset of text.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
        assert.equal(
          (await fetch(base + asset[1], { signal: AbortSignal.timeout(3000) }))
            .status,
          200,
          asset[1],
        );
      }
    }
  }
  const out = path.join(sandbox.root, 'private-cc');
  run([
    bin,
    '--profile',
    'artefact',
    '--port',
    String(port),
    'sync',
    '--target',
    'cc',
    '--out',
    out,
    '--force',
  ]);
  assert.ok(fs.existsSync(path.join(out, '.golem-render.json')));
  assert.ok(
    fs.existsSync(
      path.join(
        out,
        'mcp/channel/node_modules/@modelcontextprotocol/sdk/package.json',
      ),
    ),
  );
  assert.ok(fs.existsSync(path.join(out, 'lib/package-root.js')));
  // A render-hosted parent must not make its child select the render's assets.
  const parent = path.join(out, 'parent.mjs');
  fs.writeFileSync(
    parent,
    `import assert from 'node:assert/strict';\nimport {spawnSync} from 'node:child_process';\nimport {packageRoot} from './lib/package-root.js';\nimport {readRoleCard} from './lib/session-role.js';\nassert.equal(packageRoot(import.meta.url), ${JSON.stringify(fs.realpathSync(out))});\nassert.ok(readRoleCard('lead'));\nconst r=spawnSync(process.execPath,[${JSON.stringify(bin)},'--help'],{env:{...process.env,GOLEM_ROOT:${JSON.stringify(out)},GOLEM_RENDER_ROOT:${JSON.stringify(out)}},encoding:'utf8'});\nassert.equal(r.status,0,r.stderr);\nassert.match(r.stdout,/Usage:/);\n`,
  );
  run([parent]);
  run([
    '--input-type=module',
    '-e',
    `import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(pathToFileURL(path.join(installed, 'dist/mcp/channel/index.js')).href)}); assert.ok(require.resolve('@modelcontextprotocol/sdk/server/index.js').includes('/dist/mcp/channel/node_modules/')); assert.throws(() => require.resolve('typescript'), {code:'MODULE_NOT_FOUND'});`,
  ]);
  console.log(
    run([
      path.join(repo, 'test/fixtures/w3-config-consumers.mjs'),
      installed,
    ]).trim(),
  );
  console.log(
    'INSTALLED PACKAGE PASS: CLI/npm dashboard/profile/occupied-port refusal/invalid-profile refusal/no-profile child failure1/body400/roles/templates/web/private CC generation/dist deps/render parent child; no dev compiler',
  );
  console.log(`Checkout source untouched by installed resolution: ${repo}`);
} finally {
  try {
    for (const id of tickets) await archiveTicket(id);
  } finally {
    if (prior === undefined) delete process.env.GOLEM_SMOKE_API;
    else process.env.GOLEM_SMOKE_API = prior;
    if (child) {
      await stopMainGroup(ownership, sandbox.root);
      await closed;
    }
    // Profile manifests use the W1 short namespace. Delete only the exact link
    // into this disposable sandbox, after the dashboard has fully exited.
    const { profileNamespaceAlias } = await import('../../cli/bootstrap.ts');
    const alias = profileNamespaceAlias(
      path.join(env.HOME, '.golem-profiles/artefact'),
    );
    fs.unlinkSync(alias);
    fs.rmdirSync(path.dirname(alias));
    sandbox.cleanup();
  }
}
