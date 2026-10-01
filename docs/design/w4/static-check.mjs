// Static design-artifact probes only; not a new production test runner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, flatten, resolve, contrast, verifyFonts, primaryStates, validatePrimaryPairs } from './prototype.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const token = ($type, $value) => ({ $type, $value });
const color = components => token('color', { colorSpace: 'srgb', components, alpha: 1 });
let failures = 0;
function rejects(code, fn) { assert.throws(fn, new RegExp(`^Error: ${code}:`)); failures++; }
rejects('UNRESOLVED', () => resolve({ 'semantic.x': token('color', '{primitive.missing}') }));
rejects('CYCLE', () => resolve({ 'semantic.x': token('color', '{component.x}'), 'component.x': token('color', '{semantic.x}') }));
rejects('TYPE_MISMATCH', () => resolve({ 'primitive.x': token('dimension', { value: 4, unit: 'px' }), 'semantic.x': token('color', '{primitive.x}') }));
rejects('LAYER', () => resolve({ 'primitive.x': color([0, 0, 0]), 'component.x': token('color', '{primitive.x}') }));
rejects('LITERAL_OUTSIDE_PRIMITIVE', () => resolve({ 'semantic.x': color([0, 0, 0]) }));
rejects('DIMENSION', () => resolve({ 'primitive.x': token('dimension', { value: -1, unit: 'px' }) }));
rejects('UNSUPPORTED_TYPE', () => resolve({ 'primitive.x': token('shadow', {}) }));
rejects('NAME', () => flatten({ 'bad.name': token('dimension', { value: 1, unit: 'px' }) }));
rejects('COLOR', () => resolve({ 'primitive.x': token('color', { colorSpace: 'srgb', components: [0, 0, 0], alpha: .5 }) }));
rejects('CONTRAST', () => contrast({ fg: color([.5, .5, .5]), bg: color([.5, .5, .5]) }, [{ foreground: 'fg', background: 'bg', minimum: 4.5 }], 'mutation'));
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const pairs = read('contrast-pairs.json'), source = read('tokens/component.tokens.json');
const primaryPairs = pairs.filter(p => p.foreground.startsWith('component.button.primary.'));
assert.equal(primaryPairs.length, 6);
rejects('PRIMARY_PAIR_COVERAGE', () => build({ pairs: pairs.filter(p => p !== primaryPairs[1]) }));
rejects('PRIMARY_PAIR_COVERAGE', () => validatePrimaryPairs([...pairs, primaryPairs[0]]));
rejects('PRIMARY_PAIR_COVERAGE', () => validatePrimaryPairs(pairs.map(p => p === primaryPairs[5] ? { ...p, minimum: 3 } : p)));
for (const state of primaryStates) {
  const mutation = structuredClone(source);
  mutation.component.button.primary[state].background.$value = mutation.component.button.primary[state].foreground.$value;
  rejects('CONTRAST', () => build({ component: mutation }));
}
let stateChecks = 0;
for (const theme of ['light', 'dark']) for (const density of ['cozy', 'compact']) {
  const sets = ['primitive', 'semantic', theme, density, 'component'];
  const tokens = resolve(Object.assign({}, ...sets.map(set => flatten(read(`tokens/${set}.tokens.json`)))));
  contrast(tokens, primaryPairs, `${theme}/${density}`);
  for (const state of primaryStates) {
    const prefix = `component.button.primary.${state}`;
    const expected = state === 'disabled' ? ['semantic.surface.disabled', 'semantic.text.disabled'] : ['semantic.accent.fill', 'semantic.accent.ink'];
    for (const [i, paint] of ['background', 'foreground'].entries()) assert.deepEqual(tokens[`${prefix}.${paint}`], tokens[expected[i]]);
    stateChecks++;
  }
  if (density === 'cozy') for (const state of ['hover', 'active']) {
    const mixed = { ...tokens, [`component.button.primary.${state}.background`]: tokens[`component.button.${state}`] };
    rejects('CONTRAST', () => contrast(mixed, primaryPairs, theme));
  }
}
const output = build();
assert.deepEqual(build(), output);
for (const [name, value] of Object.entries({ 'tokens.css': output.css, 'tokens.ts': output.typed, 'contrast.json': output.report })) assert.equal(fs.readFileSync(path.join(root, 'generated', name), 'utf8'), value);
for (const selector of [':root {', ':root[data-theme="light"] {', ':root[data-theme="dark"] {', ':root[data-density="cozy"] {', ':root[data-density="compact"] {', '@media (prefers-reduced-motion: reduce)']) assert.ok(output.css.includes(selector));
assert.ok(!output.css.includes('--g-primitive-'));
const reports = JSON.parse(output.report);
for (const theme of ['light', 'dark']) {
  assert.equal(reports.filter(p => p.theme === theme).length, 62);
  for (const minimum of [4.5, 3]) {
    const pair = reports.filter(p => p.theme === theme && p.minimum === minimum).sort((a, b) => a.ratio - b.ratio)[0];
    console.log(`${theme} minimum ${minimum}: ${pair.ratio} (${pair.foreground} / ${pair.background})`);
  }
}
console.log(`PASS: ${failures} negative mutations; ${stateChecks} primary state/theme/density checks; repeat-build equality; committed-output equality; selectors; no primitive CSS; ${verifyFonts()} WOFF2 hashes/licenses`);
