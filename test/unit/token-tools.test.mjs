import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  buildTokens,
  contrastRatio,
  flattenTokens,
  resolveTokens,
  strictTokenJson,
} from '../../tools/tokens-core.ts';
import { loadTokenSources } from '../../tools/tokens-io.ts';

const root = fileURLToPath(
  new URL('../../dashboard/web/src/ui/tokens', import.meta.url),
);
const source = () => loadTokenSources(root);
const leaf = ($type, $value) => ({ $type, $value });
const black = leaf('color', {
  colorSpace: 'srgb',
  components: [0, 0, 0],
  alpha: 1,
});

test('production subset composes all4 approved themes/densities and deterministic typed public outputs', () => {
  const a = buildTokens(source()),
    b = buildTokens(source());
  assert.equal(a.css, b.css);
  assert.equal(a.types, b.types);
  assert.equal(a.report, b.report);
  assert.equal(Object.keys(a.combinations).length, 4);
  assert.equal(Object.keys(a.registry).length, 289);
  assert.equal(JSON.parse(a.report).length, 124);
  assert.equal(a.css.includes('--g-primitive-'), false);
  assert.match(a.types, /ColorTokenName/);
  assert.match(a.types, /DimensionTokenName/);
  assert.match(a.css, /prefers-reduced-motion/);
  for (const [key, tokens] of Object.entries(a.combinations)) {
    assert.equal(tokens.get('semantic.type.body').$value.fontSize.value, 14);
    assert.equal(
      tokens.get('semantic.density.target').$value.value,
      key.endsWith('compact') ? 32 : 44,
    );
  }
  for (const pair of JSON.parse(a.report)) {
    assert.ok(pair.ratio >= pair.minimum);
    assert.ok(pair.cssRatio >= pair.minimum);
  }
  assert.equal(contrastRatio([0, 0, 0], [1, 1, 1]), 21);
});

for (const [text, code] of [
  ['{"x":1,"x":2}', 'DUPLICATE_KEY'],
  ['{"x":1,}', 'JSON_SYNTAX'],
  ['{/*comment*/"x":1}', 'JSON_SYNTAX'],
  ['', 'JSON_SYNTAX'],
])
  test(`strict JSON rejects ${code}`, () =>
    assert.throws(() => strictTokenJson(text), new RegExp(code)));
for (const [tokens, code] of [
  [
    new Map([['semantic.x', leaf('color', '{primitive.missing}')]]),
    'UNRESOLVED',
  ],
  [
    new Map([
      ['semantic.x', leaf('color', '{component.x}')],
      ['component.x', leaf('color', '{semantic.x}')],
    ]),
    'CYCLE',
  ],
  [
    new Map([
      ['primitive.x', leaf('dimension', { value: 4, unit: 'px' })],
      ['semantic.x', leaf('color', '{primitive.x}')],
    ]),
    'TYPE_MISMATCH',
  ],
  [
    new Map([
      ['primitive.x', black],
      ['component.x', leaf('color', '{primitive.x}')],
    ]),
    'LAYER',
  ],
  [new Map([['semantic.x', black]]), 'LITERAL_OUTSIDE_PRIMITIVE'],
  [
    new Map([['primitive.x', leaf('dimension', { value: -1, unit: 'px' })]]),
    'DIMENSION',
  ],
  [
    new Map([
      [
        'primitive.x',
        leaf('color', {
          colorSpace: 'srgb',
          components: [0, 0, 0],
          alpha: 0.5,
        }),
      ],
    ]),
    'COLOR',
  ],
])
  test(`resolver rejects ${code}`, () =>
    assert.throws(() => resolveTokens(tokens), new RegExp(code)));
for (const value of [
  { 'bad.name': black },
  { primitive: { $extends: 'x', x: black } },
  { primitive: { x: leaf('shadow', {}) } },
  { primitive: { $type: 'color', x: black } },
])
  test('unsupported names/structures/types are explicit failures', () =>
    assert.throws(() => flattenTokens(value)));

for (const state of ['default', 'hover', 'active', 'focus', 'busy', 'disabled'])
  test(`primary ${state} paint pairing and declared coverage cannot weaken`, () => {
    const a = source();
    a.component.component.button.primary[state].background.$value =
      a.component.component.button.primary[state].foreground.$value;
    assert.throws(() => buildTokens(a), /CONTRAST/);
    const b = source();
    b.pairs = b.pairs.filter(
      (p) => p.foreground !== `component.button.primary.${state}.foreground`,
    );
    assert.throws(() => buildTokens(b), /PAIR_COVERAGE/);
  });
test('theme/density scope/type/keys, literal semantic values and duplicate leaves fail', () => {
  const a = source();
  a.light.semantic.type = { body: leaf('typography', '{primitive.type.body}') };
  assert.throws(() => buildTokens(a));
  const b = source();
  b.compact.semantic.density.target.$type = 'color';
  assert.throws(() => buildTokens(b));
  const c = source();
  c.semantic.semantic.extra = leaf('color', {
    colorSpace: 'srgb',
    components: [0, 0, 0],
    alpha: 1,
  });
  assert.throws(() => buildTokens(c), /LITERAL_OUTSIDE_PRIMITIVE/);
  assert.throws(
    () =>
      flattenTokens(
        { primitive: { x: black } },
        '',
        new Map([['primitive.x', black]]),
      ),
    /DUPLICATE_TOKEN/,
  );
});
test('theme and density overlays cannot introduce unknown names even when their keys match', () => {
  const theme = source();
  for (const mode of ['light', 'dark'])
    theme[mode].semantic.unknown = leaf('color', '{primitive.color.ink}');
  assert.throws(() => buildTokens(theme), /UNKNOWN_OVERRIDE/);
  const density = source();
  for (const mode of ['cozy', 'compact'])
    density[mode].semantic.density.unknown = leaf(
      'dimension',
      '{primitive.space.n8}',
    );
  assert.throws(() => buildTokens(density), /UNKNOWN_OVERRIDE/);
});
test('both paired overlays must retain every accepted name and declared type', () => {
  const theme = source();
  for (const mode of ['light', 'dark']) delete theme[mode].semantic.status.open;
  assert.throws(() => buildTokens(theme), /OVERLAY_COVERAGE/);
  const density = source();
  for (const mode of ['cozy', 'compact'])
    delete density[mode].semantic.density.card;
  assert.throws(() => buildTokens(density), /OVERLAY_COVERAGE/);
  const type = source();
  for (const mode of ['light', 'dark'])
    type[mode].semantic.status.open.$type = 'dimension';
  assert.throws(() => buildTokens(type), /THEME_TYPE/);
});
test('source token files are still byte-identical to accepted static data', () => {
  for (const name of [
    'primitive',
    'semantic',
    'component',
    'light',
    'dark',
    'cozy',
    'compact',
  ])
    assert.deepEqual(
      fs.readFileSync(
        new URL(
          `../../dashboard/web/src/ui/tokens/source/${name}.tokens.json`,
          import.meta.url,
        ),
      ),
      fs.readFileSync(
        new URL(
          `../../docs/design/w4/tokens/${name}.tokens.json`,
          import.meta.url,
        ),
      ),
    );
});
