import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { buildPackage, stageTokenAssets } from '../../tools/package-stage.ts';
import {
  defaultTokenRoot,
  tokenStyleRoot,
} from '../../tools/token-defaults.ts';
import { readPackagedTokenSnapshot } from '../../tools/token-package.ts';
import {
  checkTokenFreshness,
  materializeTokens,
  publishTokens,
  tokenSnapshot,
} from '../../tools/tokens-io.ts';

const source = fileURLToPath(new URL('../../', import.meta.url));
let parent, root, assets, tokens;
beforeEach(() => {
  parent = fs.mkdtempSync('/tmp/gol500-unit-');
  root = path.join(parent, 'repo');
  fs.mkdirSync(path.join(root, 'dashboard/web/src'), { recursive: true });
  fs.cpSync(
    path.join(source, 'dashboard/web/src/ui'),
    path.join(root, 'dashboard/web/src/ui'),
    {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    },
  );
  fs.mkdirSync(path.join(root, 'tools'));
  fs.copyFileSync(
    path.join(source, 'tools/token-lint-scope.json'),
    path.join(root, 'tools/token-lint-scope.json'),
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    '{"name":"@laveesingh/golem","version":"5.26.1","type":"module"}',
  );
  fs.mkdirSync(path.join(root, 'mcp/channel'), { recursive: true });
  for (const name of ['package.json', 'package-lock.json'])
    fs.writeFileSync(path.join(root, 'mcp/channel', name), '{}');
  assets = path.join(parent, 'assets');
  fs.mkdirSync(assets);
  tokens = path.join(root, 'dashboard/web/src/ui/tokens');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(parent, { recursive: true, force: true });
});
function staged() {
  stageTokenAssets(root, assets, checkTokenFreshness(tokens));
  return path.join(assets, 'dashboard/web/src/ui/tokens');
}
function mockCompiler() {
  return vi
    .spyOn(childProcess, 'spawnSync')
    .mockImplementation((_node, args) => {
      const index = args.indexOf('--outDir');
      if (index >= 0) {
        const out = args[index + 1];
        fs.mkdirSync(out, { recursive: true });
        if (args.includes('tsconfig.emit.json'))
          fs.writeFileSync(path.join(out, 'runtime-ok'), 'new runtime');
        else fs.writeFileSync(path.join(out, 'index.html'), 'new web');
      }
      return { status: 0, signal: null };
    });
}
function previous() {
  fs.mkdirSync(path.join(root, 'dist'));
  fs.mkdirSync(path.join(root, 'dashboard/dist'));
  fs.writeFileSync(path.join(root, 'dist/good'), 'old runtime');
  fs.writeFileSync(path.join(root, 'dashboard/dist/index.html'), 'old web');
}
function assertPrevious() {
  assert.equal(
    fs.readFileSync(path.join(root, 'dist/good'), 'utf8'),
    'old runtime',
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'dashboard/dist/index.html'), 'utf8'),
    'old web',
  );
}

test('stages a pinned regular snapshot and exact asset bytes without reading source pointer again', () => {
  const snapshot = checkTokenFreshness(tokens),
    pointer = fs.readlinkSync(path.join(tokens, 'generated'));
  const spy = vi.spyOn(fs, 'readlinkSync');
  stageTokenAssets(root, assets, snapshot);
  assert.equal(spy.mock.calls.length, 0);
  const target = path.join(assets, 'dashboard/web/src/ui/tokens');
  assert.equal(
    fs.lstatSync(path.join(target, 'generated')).isDirectory(),
    true,
  );
  assert.equal(fs.existsSync(path.join(target, '.generations')), false);
  assert.deepEqual(checkTokenFreshness(target).files, snapshot.files);
  assert.equal(fs.readlinkSync(path.join(tokens, 'generated')), pointer);
  for (const file of fs.readdirSync(
    path.join(root, 'dashboard/web/src/ui/fonts'),
  ))
    assert.deepEqual(
      fs.readFileSync(path.join(assets, 'dashboard/web/src/ui/fonts', file)),
      fs.readFileSync(path.join(root, 'dashboard/web/src/ui/fonts', file)),
    );
});
test('packaged snapshot checks hash/freshness and supports new regular materialization but forbids publication', () => {
  const target = staged(),
    snapshot = checkTokenFreshness(target);
  assert.throws(() => publishTokens(target), /PACKAGED_READ_ONLY/);
  const dest = path.join(parent, 'materialized');
  materializeTokens(snapshot, dest);
  assert.deepEqual(
    fs.readFileSync(path.join(dest, 'tokens.css'), 'utf8'),
    snapshot.files['tokens.css'],
  );
  assert.throws(() => materializeTokens(snapshot, dest));
  fs.appendFileSync(path.join(target, 'generated/tokens.css'), 'tamper');
  assert.throws(() => readPackagedTokenSnapshot(target), /PACKAGED_HASH/);
});
for (const kind of [
  'version',
  'missing',
  'directory-link',
  'file-link',
  'input',
  'font',
  'entry',
  'font-css',
])
  test(`packaged ${kind} fails closed without converting regular output into source pointer`, () => {
    const target = staged();
    if (kind === 'version') {
      const marker = path.join(target, 'token-package.json'),
        data = JSON.parse(fs.readFileSync(marker));
      data.schema_version = 99;
      fs.writeFileSync(marker, JSON.stringify(data));
    } else if (kind === 'missing')
      fs.unlinkSync(path.join(target, 'generated/tokens.css'));
    else if (kind === 'directory-link') {
      fs.renameSync(
        path.join(target, 'generated'),
        path.join(parent, 'outside'),
      );
      fs.symlinkSync(
        path.join(parent, 'outside'),
        path.join(target, 'generated'),
      );
    } else if (kind === 'file-link') {
      fs.unlinkSync(path.join(target, 'generated/tokens.css'));
      fs.symlinkSync(
        path.join(tokens, 'generated/tokens.css'),
        path.join(target, 'generated/tokens.css'),
      );
    } else if (kind === 'input')
      fs.appendFileSync(path.join(target, 'source/primitive.tokens.json'), ' ');
    else if (kind === 'font')
      fs.appendFileSync(
        path.join(
          assets,
          'dashboard/web/src/ui/fonts/geist-latin-400-normal.woff2',
        ),
        'tamper',
      );
    else if (kind === 'entry')
      fs.writeFileSync(
        path.join(target, 'entry.css'),
        '@import "../../../../outside.css";',
      );
    else
      fs.writeFileSync(
        path.join(assets, 'dashboard/web/src/ui/fonts/fonts.css'),
        '@import "https://invalid/font.css";',
      );
    assert.throws(() => checkTokenFreshness(target));
    assert.throws(() => publishTokens(target), /PACKAGED_READ_ONLY/);
  });
test('defaults bind caller package and emitted asset view, never cwd or inherited root selectors', () => {
  const native = path.join(root, 'tools/tokens-build.ts'),
    emitted = path.join(root, 'dist/tools/tokens-build.js');
  fs.writeFileSync(native, '');
  fs.mkdirSync(path.dirname(emitted), { recursive: true });
  fs.writeFileSync(emitted, '');
  vi.stubEnv('GOLEM_ROOT', '/invalid/root');
  vi.stubEnv('GOLEM_RENDER_ROOT', '/invalid/render');
  try {
    assert.equal(defaultTokenRoot(pathToFileURL(native)), tokens);
    assert.equal(
      tokenStyleRoot(pathToFileURL(emitted)),
      path.join(root, 'dist/assets'),
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
test('package input validation fails before compiler/publication and preserves old good trees', () => {
  previous();
  const compiler = mockCompiler();
  fs.appendFileSync(path.join(tokens, 'generated/tokens.css'), 'tamper');
  assert.throws(() => buildPackage(root), /GENERATION_HASH/);
  assert.equal(compiler.mock.calls.length, 0);
  assertPrevious();
  assert.equal(fs.existsSync(path.join(root, '.golem-package.lock')), false);
});
test('package builds publish only complete regular runtime/web stage and preserve source generation', () => {
  previous();
  mockCompiler();
  const before = tokenSnapshot(tokens);
  buildPackage(root);
  assert.equal(
    fs.readFileSync(path.join(root, 'dist/runtime-ok'), 'utf8'),
    'new runtime',
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'dashboard/dist/index.html'), 'utf8'),
    'new web',
  );
  assert.equal(
    checkTokenFreshness(
      path.join(root, 'dist/assets/dashboard/web/src/ui/tokens'),
    ).id,
    before.id,
  );
  assert.deepEqual(tokenSnapshot(tokens).files, before.files);
  assert.equal(fs.existsSync(path.join(root, '.golem-package.lock')), false);
});
test('failed second-directory publication rolls back both previous good trees by captured identities', () => {
  previous();
  mockCompiler();
  const original = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (
      path.basename(from) === 'web' &&
      to === path.join(root, 'dashboard/dist')
    )
      throw Error('synthetic web publication failure');
    return original(from, to);
  });
  assert.throws(() => buildPackage(root), /synthetic web publication failure/);
  assertPrevious();
  assert.equal(fs.existsSync(path.join(root, '.golem-package.lock')), false);
  assert.equal(
    fs
      .readdirSync(root)
      .some((file) => file.startsWith('.golem-package-stage-')),
    false,
  );
});
test('indeterminate rollback retains owned evidence/lock and never guesses a replacement deletion', () => {
  previous();
  mockCompiler();
  const original = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (
      path.basename(from) === 'web' &&
      to === path.join(root, 'dashboard/dist')
    )
      throw Error('synthetic publication failure');
    if (path.basename(from) === 'previous-web')
      throw Error('synthetic rollback failure');
    return original(from, to);
  });
  assert.throws(() => buildPackage(root), /rollback indeterminate/);
  assert.equal(fs.existsSync(path.join(root, '.golem-package.lock')), true);
  const stage = fs
    .readdirSync(root)
    .find((file) => file.startsWith('.golem-package-stage-'));
  assert.equal(
    fs.readFileSync(path.join(root, stage, 'previous-web/index.html'), 'utf8'),
    'old web',
  );
});
