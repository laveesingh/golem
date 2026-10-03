import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  lintTokenSource,
  lintTokenSourceReport,
} from '../../tools/lint-tokens.ts';

import {
  cssStylesheetImports,
  importedStylesheets,
} from '../../tools/token-lint-parser.ts';

const registry = {
  '--g-semantic-density-gap': 'dimension',
  '--g-semantic-text-primary': 'color',
  '--g-semantic-type-body': 'typography',
};
for (const [decl, code] of [
  ['padding:12px', 'LENGTH'],
  ['border-radius:.5rem', 'RADIUS'],
  ['color:#fff', 'COLOR'],
  ['background:rgb(1 2 3)', 'COLOR'],
  ['font-family:Geist', 'FONT'],
  ['font-weight:600', 'FONT'],
  ['padding:100%', 'LENGTH'],
  ['color:transparent', 'COLOR'],
  ['outline-color:currentColor', 'COLOR'],
  ['padding:0px', 'LENGTH'],
  ['opacity:.5', 'UNTYPED_LITERAL'],
  ['padding:calc(var(--g-semantic-density-gap) + 2px)', 'LENGTH'],
  ['padding:var(--g-semantic-density-gap,8px)', 'VAR_FALLBACK'],
  ['padding:var(--g-primitive-space-n8)', 'LAYER'],
  ['padding:var(--g-unknown)', 'LAYER'],
  ['padding:var(--g-semantic-unknown)', 'UNKNOWN_TOKEN'],
  ['padding:var(--g-semantic-text-primary)', 'TOKEN_TYPE'],
  ['--custom:var(--g-semantic-density-gap)', 'HANDWRITTEN_ALIAS'],
])
  test(`parsed CSS rejects ${decl}`, () =>
    assert.equal(
      lintTokenSource('ui/button.css', `.a{${decl};}`, registry)[0]?.code,
      code,
    ));
for (const decl of [
  'padding:var(--g-semantic-density-gap)',
  'margin:0',
  'border-radius:0',
  'opacity:1',
  'line-height:1.2',
  'display:flex',
  'width:100%',
  'fill:currentColor',
  'background:transparent',
  'grid-template-columns:minmax(0,1fr)',
  'transform:scale(0.5)',
])
  test(`property-aware exception ${decl}`, () =>
    assert.deepEqual(
      lintTokenSource('ui/layout.css', `.a{${decl};}`, registry),
      [],
    ));
for (const text of [
  '.a{color #fff}',
  '.a{color #fff;}',
  '.a{color /* comment */ #fff}',
  '.a{123:12px}',
  '.a{color:#fff} dangling',
])
  test(`malformed CSS fails closed: ${text}`, () =>
    assert.throws(
      () => lintTokenSource('ui/a.css', text, registry),
      /CSS_SYNTAX/,
    ));
test('stylesheet imports come from parsed component syntax, not comments or prose', () => {
  assert.deepEqual(
    importedStylesheets(
      '/* import "./ignored.css" */ const prose="./also-ignored.css"; import "../outside.css"; import styles from "./module.css";',
    ),
    ['../outside.css', './module.css'],
  );
  assert.throws(() => importedStylesheets('import ;'), /JS_SYNTAX/);
});
test('CSS import parser recognizes only actual unconditional static dependencies', () => {
  assert.deepEqual(
    cssStylesheetImports(
      '/* @import "ignored.css"; */ @import "a.css"; @import url(\'b.css\'); @import URL(c.css); .a{content:"@import fake"}',
    ),
    ['a.css', 'b.css', 'c.css'],
  );
});
for (const text of [
  '@import;',
  '@import "a.css" screen;',
  '@import url("a.css") layer(x);',
  '@import url("a.css") supports(display:grid);',
  '@import "a.css"',
  '@import "a.css" {}',
  '@import "\\\\61.css";',
])
  test(`unsupported or malformed CSS import fails: ${text}`, () =>
    assert.throws(
      () => cssStylesheetImports(text),
      /CSS_(?:IMPORT_SYNTAX|SYNTAX)/,
    ));
for (const text of [
  'const A=()=> <div style={{padding:"var(--g-semantic-density-gap)",margin:0}}/>;',
  'const A=()=> <div {...{style:{color:"var(--g-semantic-text-primary)",margin:0},title:"raw #fff prose"}}/>;',
  'const A=()=> <div {...{title:"12px #fff",className:"red",onClick:handler}}/>;',
])
  test('small literal token/style and proved non-style props pass', () =>
    assert.deepEqual(lintTokenSource('ui/a.tsx', text, registry), []));
for (const text of [
  'const p={[`style`]:{color:"#fff",padding:12}}; const A=()=> <div {...p}/>;',
  'const key="style" as const; const p={[key]:{color:"#fff",padding:12}}; const A=()=> <div {...p}/>;',
  'const p={}; const alias=p; alias.style={color:"#fff",padding:12}; const A=()=> <div {...p}/>;',
  'const A=()=> <div {...{[`style`]:{margin:0}}}/>;',
  'const A=()=> <div {...{["style"]:{margin:0}}}/>;',
  'const p={style:{margin:0}}; const A=()=> <div {...p}/>;',
  'const A=()=> <div {...unknown}/>;',
  'const A=()=> <div {...{...{title:"safe"}}}/>;',
  'const A=()=> <div style={{...{margin:0}}}/>;',
  'const A=()=> <div style={object}/>;',
  'const A=()=> <div style={{margin:zero}}/>;',
  'const A=()=> <div style={{margin:0} as const}/>;',
  'const A=()=> <div style={{[key]:0}}/>;',
  'const A=(props)=> <div {...props}/>;',
])
  test('unproved computed alias mutated dynamic and unknown spread style positions fail closed', () =>
    assert.ok(
      lintTokenSource('ui/a.tsx', text, registry).some(
        (i) => i.code === 'unanalyzable style expression',
      ),
    ));
test('literal prop-spread paint and direct style paint retain literal diagnostics', () => {
  for (const text of [
    'const A=()=> <div {...{style:{color:"#fff",padding:12}}}/>;',
    'const A=()=> <div style={{color:"#fff",padding:12}}/>;',
  ]) {
    const issues = lintTokenSource('ui/a.tsx', text, registry);
    assert.ok(issues.some((i) => i.code === 'COLOR'));
    assert.ok(issues.some((i) => i.code === 'LENGTH'));
  }
});
test('comments/selectors/prose/URLs/SVG/aria are not style color or length values', () => {
  const css =
    '/* padding:12px;color:#fff */ .color-red::before {content:"12px #fff";background-image:url("data:image/svg+xml,%23fff");}';
  assert.deepEqual(lintTokenSource('ui/icon.css', css, registry), []);
  const js =
    'const prose="12px #fff"; const data={color:"#fff"}; const Icon=()=> <svg aria-level={3}><path d="M0 0 L12 0" /></svg>';
  assert.deepEqual(lintTokenSource('ui/icon.tsx', js, registry), []);
});
for (const text of [
  'const A=()=> <div style={{width:32}}/>',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source fixture exercises dynamic style rejection.
  'const A=()=> <div style={{padding:`${n}px`}}/>',
  'const A=()=> <div style={{color:userColor}}/>',
  'const styles={fontFamily:"Geist"};',
  'element.style.color="#fff";',
])
  test('Babel inline/object/assignment syntax rejects raw or untyped style values', () =>
    assert.ok(lintTokenSource('ui/card.tsx', text, registry).length));
test('reasoned same-line actual comments are counted and do not escape adjacent lines', () => {
  const js =
    'const A=()=> <div {...unknown}/>; // token-lint-disable-line: reviewed adapter owns dynamic props';
  assert.deepEqual(lintTokenSourceReport('ui/a.tsx', js, registry), {
    issues: [],
    inlineEscapes: 1,
    exactEscapes: 0,
  });
  const css =
    '.a{padding:12px;color:#fff} /* token-lint-disable-line: documented adapter geometry */\n.b{padding:13px}';
  const report = lintTokenSourceReport('ui/a.css', css, registry);
  assert.equal(report.inlineEscapes, 1);
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0].line, 2);
  const multiline =
    '.a{\n padding:12px; /* token-lint-disable-line: owned geometry */\n color:#fff;\n}';
  const attached = lintTokenSourceReport('ui/a.css', multiline, registry);
  assert.equal(attached.inlineEscapes, 1);
  assert.equal(attached.issues[0].line, 3);
});
for (const text of [
  'const A=()=> <div {...unknown}/>; // token-lint-disable-line:',
  'const A=()=> <div {...unknown}/>; // token-lint-disable',
  'const A=()=> <div {...unknown}/>; /* token-lint-disable-line: reason */',
  '// token-lint-disable-line: reason\nconst A=()=> <div {...unknown}/>;',
  'const A=()=> <div/>; // token-lint-disable-line: unused',
])
  test('missing malformed wrong-kind or unattached escapes fail', () =>
    assert.throws(
      () => lintTokenSourceReport('ui/a.tsx', text, registry),
      /INLINE_ESCAPE/,
    ));
for (const text of [
  '.a{padding:12px} /* token-lint-disable-line: */',
  '.a{padding:12px} /* token-lint-disable-line: one */ /* token-lint-disable-line: two */',
  '.a{padding:12px} /* token-lint-disable-line:\n reason */',
])
  test('CSS missing duplicate or multiline escape fails', () =>
    assert.throws(
      () => lintTokenSourceReport('ui/a.css', text, registry),
      /INLINE_ESCAPE/,
    ));
test('string prose cannot suppress issues and structural/import errors cannot be escaped', () => {
  const js =
    'const prose="// token-lint-disable-line: reason"; const A=()=> <div {...unknown}/>;';
  assert.equal(
    lintTokenSourceReport('ui/a.tsx', js, registry).inlineEscapes,
    0,
  );
  assert.equal(lintTokenSource('ui/a.tsx', js, registry).length, 1);
  assert.throws(
    () =>
      lintTokenSource(
        'a.css',
        '@import "a.css" screen; /* token-lint-disable-line: reason */',
        registry,
      ),
    /CSS_IMPORT_SYNTAX/,
  );
  assert.throws(
    () =>
      lintTokenSource(
        'a.css',
        '.a{padding 12px} /* token-lint-disable-line: reason */',
        registry,
      ),
    /CSS_SYNTAX/,
  );
});
test('exact owned exception records do not disable neighboring values/files and malformed syntax fails', () => {
  const exception = {
    file: 'ui/a.css',
    property: 'width',
    value: '32px',
    rationale: 'bounded adapter geometry',
    owner: 'layout-adapter',
  };
  assert.deepEqual(
    lintTokenSourceReport('ui/a.css', '.a{width:32px}', registry, [exception]),
    { issues: [], inlineEscapes: 0, exactEscapes: 1 },
  );
  assert.equal(
    lintTokenSource('ui/b.css', '.a{width:32px}', registry, [exception]).length,
    1,
  );
  assert.equal(
    lintTokenSource('ui/a.css', '.a{width:33px}', registry, [exception]).length,
    1,
  );
  assert.throws(() =>
    lintTokenSource('ui/a.css', '.a{}', registry, [
      { ...exception, owner: '' },
    ]),
  );
  assert.throws(
    () => lintTokenSource('ui/a.css', '.a{padding:12px', registry),
    /CSS_SYNTAX/,
  );
  assert.throws(() => lintTokenSource('ui/a.tsx', '<>', registry), /JS_SYNTAX/);
});
