// Native token tool consumers under W2-owned isolation; no browser/legacy activation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build, transformWithEsbuild } from 'vite';
import {
  checkTokenFreshness,
  materializeTokens,
  tokenSnapshot,
} from '../../tools/tokens-io.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url)),
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(process.env.TMPDIR, 'token-consumer-')),
  ),
  ui = path.join(root, 'dashboard/web/src/ui');
let server;
fs.mkdirSync(ui, { recursive: true });
fs.cpSync(
  path.join(repo, 'dashboard/web/src/ui/tokens'),
  path.join(ui, 'tokens'),
  { recursive: true, dereference: false, verbatimSymlinks: true },
);
fs.cpSync(
  path.join(repo, 'dashboard/web/src/ui/fonts'),
  path.join(ui, 'fonts'),
  { recursive: true },
);
fs.mkdirSync(path.join(root, 'tools'));
fs.copyFileSync(
  path.join(repo, 'tools/token-lint-scope.json'),
  path.join(root, 'tools/token-lint-scope.json'),
);
const tool = (file, args) =>
  spawnSync(process.execPath, [path.join(repo, 'tools', file), ...args], {
    env: process.env,
    encoding: 'utf8',
    timeout: 10000,
  });
try {
  const mode = process.argv[2],
    tokens = path.join(ui, 'tokens');
  if (mode === 'cli') {
    const before = fs.readlinkSync(path.join(tokens, 'generated'));
    let result = tool('tokens-build.ts', ['--root', tokens, '--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readlinkSync(path.join(tokens, 'generated')), before);
    result = tool('tokens-build.ts', ['--root', tokens, '--write']);
    assert.equal(result.status, 0, result.stderr);
    checkTokenFreshness(tokens);
    const candidate = path.join(root, 'regular-output');
    result = tool('tokens-build.ts', [
      '--root',
      tokens,
      '--materialize',
      candidate,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.lstatSync(candidate).isSymbolicLink(), false);
    assert.equal(
      fs.readFileSync(path.join(candidate, 'tokens.css'), 'utf8'),
      tokenSnapshot(tokens).files['tokens.css'],
    );
    const mutation = path.join(tokens, 'source/component.tokens.json'),
      component = JSON.parse(fs.readFileSync(mutation, 'utf8'));
    component.component.button.primary.hover.background.$value =
      component.component.button.primary.hover.foreground.$value;
    fs.writeFileSync(mutation, JSON.stringify(component));
    result = tool('tokens-build.ts', ['--root', tokens, '--write']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CONTRAST/);
    assert.equal(fs.readlinkSync(path.join(tokens, 'generated')), before);
  } else if (mode === 'lint') {
    let result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 0, result.stderr);
    const file = path.join(ui, 'bad.css');
    fs.writeFileSync(file, '.a{padding:12px;color:#fff}');
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /LENGTH/);
    assert.match(result.stderr, /COLOR/);
    fs.writeFileSync(
      file,
      '.a{padding:var(--g-semantic-density-gap);color:var(--g-semantic-text-primary)}',
    );
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 0, result.stderr);
    const converted = path.join(root, 'dashboard/web/converted.css');
    fs.writeFileSync(converted, '.a{border-radius:8px}');
    fs.writeFileSync(
      path.join(root, 'tools/token-lint-scope.json'),
      JSON.stringify({
        converted: ['dashboard/web/converted.css'],
        exceptions: [],
      }),
    );
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RADIUS/);
    const legacy = path.join(root, 'dashboard/web/extra.css');
    fs.writeFileSync(legacy, '.a{padding:99px}');
    fs.writeFileSync(
      path.join(root, 'tools/token-lint-scope.json'),
      JSON.stringify({
        converted: ['dashboard/web/extra.css'],
        exceptions: [],
      }),
    );
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 0, result.stderr);
    fs.writeFileSync(
      path.join(ui, 'bad.tsx'),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source fixture exercises dynamic style rejection.
      'const A=()=> <div style={{color:raw,padding:`${n}px`}}/>',
    );
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unanalyzable style expression/);
    fs.rmSync(path.join(ui, 'bad.tsx'));
    const component = path.join(root, 'dashboard/web/converted.tsx');
    fs.writeFileSync(
      component,
      'import "./outside.css"; export const A=()=> <div/>;',
    );
    fs.writeFileSync(
      path.join(root, 'tools/token-lint-scope.json'),
      JSON.stringify({
        converted: ['dashboard/web/converted.tsx'],
        exceptions: [],
      }),
    );
    const outside = path.join(root, 'dashboard/web/outside.css');
    fs.writeFileSync(outside, '.a{padding:12px}');
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside\.css.*LENGTH/);
    fs.writeFileSync(outside, '.a{padding:var(--g-semantic-density-gap)}');
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 0, result.stderr);
    fs.writeFileSync(component, 'import "./extra.css";');
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 0, result.stderr);
    fs.writeFileSync(component, 'import "../../outside.css";');
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /LINT_IMPORT_PATH/);
    fs.writeFileSync(component, 'import "./outside.css";');
    fs.writeFileSync(outside, '.a{padding 12px}');
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CSS_SYNTAX/);
    fs.writeFileSync(component, 'export const A=()=> <div/>;');
    const reviewCss = path.join(ui, 'review.css');
    fs.writeFileSync(reviewCss, '@import "../../outside.css";');
    fs.writeFileSync(outside, '.fixture{padding:12px;color:#fff}');
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside\.css.*LENGTH/);
    assert.match(result.stderr, /outside\.css.*COLOR/);
    const reachable = path.join(root, 'reachable-consumer');
    fs.mkdirSync(reachable);
    fs.writeFileSync(
      path.join(reachable, 'index.html'),
      '<script type="module" src="/entry.js"></script>',
    );
    fs.writeFileSync(
      path.join(reachable, 'entry.js'),
      `import ${JSON.stringify(reviewCss)};`,
    );
    const emitted = path.join(root, 'reachable-build');
    await build({
      configFile: false,
      root: reachable,
      base: './',
      build: { outDir: emitted, emptyOutDir: true },
      logLevel: 'error',
    });
    const emittedCss = fs
      .readdirSync(path.join(emitted, 'assets'))
      .filter((n) => n.endsWith('.css'))
      .map((n) => fs.readFileSync(path.join(emitted, 'assets', n), 'utf8'))
      .join('');
    assert.match(emittedCss, /padding:12px/);
    assert.match(emittedCss, /color:#fff/);
    fs.writeFileSync(reviewCss, '.fixture{padding:12px;color:#fff}');
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /review\.css.*LENGTH/);
    assert.match(result.stderr, /review\.css.*COLOR/);
    fs.writeFileSync(reviewCss, '@import url("../../outside.css");');
    const nested = path.join(root, 'dashboard/web/nested.css');
    fs.writeFileSync(outside, '@import "./nested.css";');
    fs.writeFileSync(nested, '@import "./outside.css"; .fixture{padding:12px}');
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /nested\.css.*LENGTH/);
    fs.writeFileSync(
      nested,
      '@import "./outside.css"; .fixture{padding:var(--g-semantic-density-gap)}',
    );
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 0, result.stderr);
    fs.writeFileSync(reviewCss, '@import "../../extra.css";');
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 0, result.stderr);
    for (const dependency of [
      '../../../outside.css',
      'https://example.invalid/a.css',
      '../../outside.css?inline',
    ]) {
      fs.writeFileSync(reviewCss, `@import "${dependency}";`);
      result = tool('lint-tokens.ts', ['--root', root]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /LINT_IMPORT_PATH/);
    }
    fs.writeFileSync(reviewCss, '@import "../../outside.css" screen;');
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CSS_IMPORT_SYNTAX/);
    fs.rmSync(reviewCss);
    for (const jsx of [
      'export const A=()=> <div {...{style:{color:"#fff",padding:12}}}/>;',
      'export const A=()=> <div style={{color:"#fff",padding:12}}/>;',
    ]) {
      fs.writeFileSync(path.join(ui, 'review.tsx'), jsx);
      result = tool('lint-tokens.ts', ['--root', root]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /COLOR/);
      assert.match(result.stderr, /LENGTH/);
    }
    const rawFixtures = [
      'const p={[TEMPLATE_STYLE]:{color:"#fff",padding:12}}; export const A=()=> <div {...p}/>;'.replace(
        'TEMPLATE_STYLE',
        String.fromCharCode(96) + 'style' + String.fromCharCode(96),
      ),
      'const key="style" as const; const p={[key]:{color:"#fff",padding:12}}; export const A=()=> <div {...p}/>;',
      'const p={}; const alias=p; alias.style={color:"#fff",padding:12}; export const A=()=> <div {...p}/>;',
      'const p={}; p.style={color:"#fff",padding:12}; export const A=()=> <div {...p}/>;',
      'const p={["style"]:{color:"#fff",padding:12}}; export const A=()=> <div {...p}/>;',
    ];
    for (const jsx of rawFixtures) {
      fs.writeFileSync(path.join(ui, 'review.tsx'), jsx);
      result = tool('lint-tokens.ts', ['--root', root]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /unanalyzable style expression/);
      const transformed = await transformWithEsbuild(
        jsx.replace('export const A', 'const A'),
        'review.tsx',
        { jsxFactory: 'React.createElement' },
      );
      const Component = new Function('React', transformed.code + '; return A;')(
        React,
      );
      const html = renderToStaticMarkup(React.createElement(Component));
      assert.match(html, /color:#fff/);
      assert.match(html, /padding:12px/);
    }
    const reviewJs = path.join(ui, 'review.tsx');
    fs.writeFileSync(reviewJs, 'export const A=(props)=> <div {...props}/>;');
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unanalyzable style expression/);
    for (const jsx of [
      'export const A=()=> <div {...{style:{padding:"var(--g-semantic-density-gap)"},title:"safe"}}/>;',
      'export const A=()=> <div {...{title:"safe",className:"red"}}/>;',
    ]) {
      fs.writeFileSync(reviewJs, jsx);
      result = tool('lint-tokens.ts', ['--root', root]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /0 escapes/);
    }
    for (const suffix of [
      ' // token-lint-disable-line:',
      ' // token-lint-disable',
      ' /* token-lint-disable-line: reason */',
    ]) {
      fs.writeFileSync(
        reviewJs,
        'export const A=(props)=> <div {...props}/>;' + suffix,
      );
      result = tool('lint-tokens.ts', ['--root', root]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /INLINE_ESCAPE/);
    }
    fs.writeFileSync(
      reviewJs,
      'export const A=(props)=> <div {...props}/>; // token-lint-disable-line: adapter owns runtime props',
    );
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 escapes \(1 inline, 0 exact\)/);
    fs.writeFileSync(
      reviewCss,
      '.adapter{padding:12px} /* token-lint-disable-line: external adapter geometry */',
    );
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 escapes \(2 inline, 0 exact\)/);
    fs.writeFileSync(
      reviewCss,
      '@import "../../outside.css" screen; /* token-lint-disable-line: cannot hide import failure */',
    );
    result = tool('lint-tokens.ts', ['--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CSS_IMPORT_SYNTAX/);
    console.log(
      'CSS Vite-reachable raw bytes and React-rendered prior JSX repros rejected; unknown spread1/proved nonstyle0/inline counted controls PASS',
    );
  } else if (mode === 'build-package') {
    const pinned = checkTokenFreshness(tokens),
      pkg = path.join(root, 'package-source'),
      prefix = path.join(root, 'installed');
    const checkout = path.join(root, 'checkout-consumer');
    fs.mkdirSync(checkout);
    fs.writeFileSync(
      path.join(checkout, 'index.html'),
      '<script type="module" src="/entry.js"></script>',
    );
    fs.writeFileSync(
      path.join(checkout, 'entry.js'),
      `import ${JSON.stringify(path.join(tokens, 'entry.css'))};`,
    );
    const checkoutOut = path.join(root, 'checkout-build');
    await build({
      configFile: false,
      root: checkout,
      base: './',
      build: { outDir: checkoutOut, emptyOutDir: true, assetsInlineLimit: 0 },
      logLevel: 'error',
    });
    assert.equal(
      fs
        .readdirSync(path.join(checkoutOut, 'assets'))
        .filter((n) => n.endsWith('.woff2')).length,
      7,
    );
    fs.mkdirSync(path.join(pkg, 'ui/tokens'), { recursive: true });
    fs.cpSync(path.join(ui, 'fonts'), path.join(pkg, 'ui/fonts'), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(tokens, 'entry.css'),
      path.join(pkg, 'ui/tokens/entry.css'),
    );
    materializeTokens(pinned, path.join(pkg, 'ui/tokens/generated'));
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({
        name: '@golem/w4-token-probe',
        version: '0.0.0',
        private: true,
        type: 'module',
        files: ['ui'],
      }),
    );
    const npm = path.resolve(
        path.dirname(process.execPath),
        '../lib/node_modules/npm/bin/npm-cli.js',
      ),
      npmrc = path.join(root, 'empty.npmrc');
    fs.writeFileSync(npmrc, '');
    const globalNpmrc = path.join(root, 'global-empty.npmrc');
    fs.writeFileSync(globalNpmrc, '');
    const env = {
      ...process.env,
      NPM_CONFIG_USERCONFIG: npmrc,
      NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
      NPM_CONFIG_CACHE: path.join(root, 'npm-cache'),
    };
    let result = spawnSync(
      process.execPath,
      [npm, 'pack', '--ignore-scripts', '--pack-destination', root],
      { cwd: pkg, env, encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const archive = path.join(root, result.stdout.trim().split('\n').at(-1));
    result = spawnSync(
      process.execPath,
      [
        npm,
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--prefix',
        prefix,
        archive,
      ],
      { env, encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const installed = path.join(prefix, 'node_modules/@golem/w4-token-probe');
    assert.equal(
      fs
        .lstatSync(path.join(installed, 'ui/tokens/generated'))
        .isSymbolicLink(),
      false,
    );
    for (const [name, bytes] of Object.entries(pinned.files))
      assert.equal(
        fs.readFileSync(
          path.join(installed, 'ui/tokens/generated', name),
          'utf8',
        ),
        bytes,
      );
    const consumer = path.join(root, 'consumer');
    fs.mkdirSync(consumer);
    fs.writeFileSync(
      path.join(consumer, 'index.html'),
      '<div class="fixture">fixture</div><script type="module" src="/entry.js"></script>',
    );
    fs.writeFileSync(
      path.join(consumer, 'entry.js'),
      `import ${JSON.stringify(path.join(installed, 'ui/tokens/entry.css'))};`,
    );
    const out = path.join(root, 'build');
    await build({
      configFile: false,
      root: consumer,
      base: './',
      build: { outDir: out, emptyOutDir: true, assetsInlineLimit: 0 },
      logLevel: 'error',
    });
    const assetDir = path.join(out, 'assets'),
      cssFiles = fs.readdirSync(assetDir).filter((n) => n.endsWith('.css'));
    assert.equal(cssFiles.length, 1);
    const css = fs.readFileSync(path.join(assetDir, cssFiles[0]), 'utf8');
    assert.equal(css.includes('fonts.googleapis'), false);
    assert.equal(css.includes('https://'), false);
    assert.ok(css.includes('--g-semantic-density-gap'));
    const originalCss = fs
      .readdirSync(path.join(checkoutOut, 'assets'))
      .find((n) => n.endsWith('.css'));
    assert.equal(
      css,
      fs.readFileSync(path.join(checkoutOut, 'assets', originalCss), 'utf8'),
    );
    const fonts = fs.readdirSync(assetDir).filter((n) => n.endsWith('.woff2'));
    assert.equal(fonts.length, 7);
    server = http.createServer((req, res) => {
      const requested = new URL(req.url, 'http://127.0.0.1').pathname,
        relative = requested.replace(/^\//, '');
      if (relative.includes('..')) {
        res.writeHead(400);
        res.end();
        return;
      }
      const file = path.join(out, relative);
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(),
      base = `http://127.0.0.1:${address.port}/assets/`;
    for (const font of fonts) {
      assert.ok(css.includes(font));
      const response = await fetch(base + font);
      assert.equal(response.status, 200);
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        fs.readFileSync(path.join(assetDir, font)),
      );
    }
    console.log(
      `regular package installed + private Vite build: pinned ${pinned.id}, local7 font URL bytes PASS; no browser/glyph/legacy activation`,
    );
  } else throw Error('unknown token probe mode');
  console.log(`GOL485 ${mode} isolated native consumer PASS`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false);
}
