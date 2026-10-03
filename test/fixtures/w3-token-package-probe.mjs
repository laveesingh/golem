import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'vite';
import { createSandbox } from '../support/sandbox.mjs';

// Actual Golem physical installation only. Dev Vite is the consumer harness,
// never an installed token CLI dependency or a fixture package replacement.
const source = fs.realpathSync(process.argv[2]);
const installed = fs.realpathSync(process.argv[3]);
assert.ok(installed.split(path.sep).includes('node_modules'));
assert.equal(
  JSON.parse(fs.readFileSync(path.join(installed, 'package.json'))).name,
  '@laveesingh/golem',
);
const sandbox = createSandbox();
const empty = path.join(sandbox.root, 'empty');
fs.mkdirSync(empty);
const assets = path.join(installed, 'dist/assets');
const tokenRoot = path.join(assets, 'dashboard/web/src/ui/tokens');
const original = path.join(source, 'dashboard/web/src/ui/tokens');
const pointer = fs.readlinkSync(path.join(original, 'generated'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const names = ['tokens.css', 'tokens.ts', 'contrast.json', 'registry.json'];
const env = {
  ...sandbox.env,
  GOLEM_ROOT: '/invalid/root',
  GOLEM_RENDER_ROOT: '/invalid/render',
};
const cli = (name, args, status = 0, match) => {
  const result = spawnSync(
    process.execPath,
    [path.join(installed, 'dist/tools', name), ...args],
    {
      cwd: empty,
      env,
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
  if (match) assert.match(result.stdout + result.stderr, match);
  return result.stdout;
};
function digestTree(directory) {
  const result = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      assert.ok(!entry.isSymbolicLink(), file);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(directory, file)] = sha(fs.readFileSync(file));
    }
  };
  walk(directory);
  return result;
}
async function viteFontConsumer(root, label) {
  const allocated = path.join(sandbox.root, `app-${label}`);
  fs.mkdirSync(allocated);
  const app = fs.realpathSync(allocated);
  const tokens = path.join(root, 'dashboard/web/src/ui/tokens');
  fs.writeFileSync(
    path.join(app, 'index.html'),
    '<html><head><title>owned token asset proof</title></head><body><script type="module" src="/entry.js"></script></body></html>',
  );
  fs.writeFileSync(
    path.join(app, 'entry.js'),
    `import ${JSON.stringify(path.join(tokens, 'entry.css'))}; import {tokens} from ${JSON.stringify(path.join(tokens, 'generated/tokens.ts'))}; document.body.textContent=JSON.stringify(tokens);`,
  );
  const out = path.join(app, 'out');
  await build({
    configFile: false,
    root: app,
    logLevel: 'error',
    build: { outDir: out, assetsInlineLimit: 0, emptyOutDir: true },
  });
  const cssFile = fs
    .readdirSync(path.join(out, 'assets'))
    .find((file) => file.endsWith('.css'));
  assert.ok(cssFile, label);
  const css = fs.readFileSync(path.join(out, 'assets', cssFile), 'utf8');
  const server = http.createServer((request, response) => {
    const target = path.resolve(
      out,
      `.${new URL(request.url, 'http://owned.invalid').pathname}`,
    );
    if (
      !target.startsWith(out + path.sep) ||
      !fs.existsSync(target) ||
      !fs.statSync(target).isFile()
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.end(fs.readFileSync(target));
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    assert.ok(![7420, 7421].includes(port));
    const servedCss = await fetch(`http://127.0.0.1:${port}/assets/${cssFile}`);
    assert.equal(servedCss.status, 200);
    assert.equal(await servedCss.text(), css);
    const fontHashes = [];
    for (const match of css.matchAll(/url\(([^)]+\.woff2)\)/g)) {
      const url = new URL(
        match[1].replace(/^['"]|['"]$/g, ''),
        `http://127.0.0.1:${port}/assets/${cssFile}`,
      );
      const response = await fetch(url);
      assert.equal(response.status, 200, url.href);
      fontHashes.push(sha(Buffer.from(await response.arrayBuffer())));
    }
    assert.equal(fontHashes.length, 7, label);
    return { css, hashes: fontHashes.sort() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
try {
  const before = digestTree(assets);
  assert.equal(
    fs.lstatSync(path.join(tokenRoot, 'generated')).isDirectory(),
    true,
  );
  assert.equal(fs.existsSync(path.join(tokenRoot, '.generations')), false);
  for (const name of names)
    assert.deepEqual(
      fs.readFileSync(path.join(tokenRoot, 'generated', name)),
      fs.readFileSync(path.join(original, 'generated', name)),
    );
  for (const name of fs.readdirSync(
    path.join(source, 'dashboard/web/src/ui/fonts'),
  ))
    assert.deepEqual(
      fs.readFileSync(path.join(assets, 'dashboard/web/src/ui/fonts', name)),
      fs.readFileSync(path.join(source, 'dashboard/web/src/ui/fonts', name)),
    );
  cli('tokens-build.js', ['--help'], 0, /Packaged --write is read-only/);
  cli('tokens-build.js', ['--check'], 0, /tokens fresh g-/);
  cli('tokens-build.js', ['--root', tokenRoot, '--check'], 0);
  const materialized = path.join(sandbox.root, 'materialized');
  cli('tokens-build.js', ['--materialize', materialized], 0);
  for (const name of names)
    assert.deepEqual(
      fs.readFileSync(path.join(materialized, name)),
      fs.readFileSync(path.join(tokenRoot, 'generated', name)),
    );
  cli('tokens-build.js', ['--materialize', materialized], 1);
  cli('tokens-build.js', ['--write'], 1, /PACKAGED_READ_ONLY/);
  cli('tokens-build.js', ['--root', 'relative', '--check'], 2, /ARGUMENT/);
  cli('lint-tokens.js', ['--help'], 0, /ABSOLUTE_STYLE_TREE/);
  cli('lint-tokens.js', [], 0, /0 issues/);
  cli('lint-tokens.js', ['--root', assets], 0);
  cli('lint-tokens.js', ['--root', 'relative'], 2, /ARGUMENT/);
  assert.deepEqual(
    digestTree(assets),
    before,
    'installed read/materialize/refused-write paths must not mutate packaged assets',
  );
  const copy = path.join(sandbox.root, 'explicit-assets');
  fs.cpSync(assets, copy, { recursive: true });
  const copiedTokens = path.join(copy, 'dashboard/web/src/ui/tokens');
  const markerFile = path.join(copiedTokens, 'token-package.json'),
    marker = fs.readFileSync(markerFile);
  const changed = JSON.parse(marker);
  changed.schema_version = 99;
  fs.writeFileSync(markerFile, JSON.stringify(changed));
  cli(
    'tokens-build.js',
    ['--root', copiedTokens, '--check'],
    1,
    /PACKAGED_VERSION/,
  );
  fs.writeFileSync(markerFile, marker);
  const probe = path.join(copy, 'dashboard/web/src/ui/probe.css');
  fs.writeFileSync(probe, '.probe { color: #fff; }');
  cli('lint-tokens.js', ['--root', copy], 1, /\/color\/COLOR/);
  fs.writeFileSync(
    probe,
    '.probe { color: #fff; } /* token-lint-disable-line: owned declaration escape proof */',
  );
  cli('lint-tokens.js', ['--root', copy], 0, /1 escapes \(1 inline, 0 exact\)/);
  fs.unlinkSync(probe);
  fs.writeFileSync(
    path.join(copy, 'dashboard/web/src/ui/probe.tsx'),
    "const Alias=()=> <div style={{['color']:'#fff'}}/>;",
  );
  cli('lint-tokens.js', ['--root', copy], 1, /unanalyzable style expression/);
  const runtimeRequire = createRequire(
    path.join(installed, 'dist/tools/lint-tokens.js'),
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(runtimeRequire.resolve('@babel/parser/package.json')),
    ).version,
    '7.29.9',
  );
  for (const dependency of ['typescript', 'vitest'])
    assert.throws(() => runtimeRequire.resolve(dependency), {
      code: 'MODULE_NOT_FOUND',
    });
  const native = await viteFontConsumer(source, 'source'),
    packaged = await viteFontConsumer(assets, 'installed');
  assert.deepEqual(
    packaged,
    native,
    'actual installed regular imports must produce byte-identical Vite CSS/local-font responses',
  );
  const inventory = JSON.parse(
    fs.readFileSync(
      path.join(source, 'dashboard/web/src/ui/fonts/inventory.json'),
    ),
  );
  assert.deepEqual(
    packaged.hashes,
    inventory.map((font) => font.sha256).sort(),
  );
  assert.equal(fs.readlinkSync(path.join(original, 'generated')), pointer);
  console.log(
    'ACTUAL GOLEM TOKEN PACKAGE PASS: regular pinned bytes/fonts/CLI defaults+overrides/read-only errors/lint escapes/runtime parser/no dev compiler/Vite CSS+7 HTTP font hashes/source pointer preserved',
  );
} finally {
  sandbox.cleanup();
}
