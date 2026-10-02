import assert from 'node:assert/strict';
import { test } from 'vitest';
import { lintTokenSource } from '../../tools/lint-tokens.ts';

import { importedStylesheets } from '../../tools/token-lint-parser.ts';

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
test('literal var style aliases and zero geometry pass, no arbitrary spread/dynamic style escape', () => {
  assert.deepEqual(
    lintTokenSource(
      'ui/a.tsx',
      'const styles={padding:"var(--g-semantic-density-gap)",margin:0}; const A=()=> <div style={styles}/>;',
      registry,
    ),
    [],
  );
  assert.ok(
    lintTokenSource(
      'ui/a.tsx',
      'const A=()=> <div style={{...unknown}}/>;',
      registry,
    ).some((i) => i.code === 'DYNAMIC_STYLE'),
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
    lintTokenSource('ui/a.css', '.a{width:32px}', registry, [exception]),
    [],
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
