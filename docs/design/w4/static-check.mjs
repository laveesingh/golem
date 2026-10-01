// Static design-artifact probes only; not a new production test runner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, flatten, resolve, contrast, verifyFonts } from './prototype.mjs';
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
const output = build();
assert.deepEqual(build(), output);
for (const [name, value] of Object.entries({ 'tokens.css': output.css, 'tokens.ts': output.typed, 'contrast.json': output.report })) assert.equal(fs.readFileSync(path.join(root, 'generated', name), 'utf8'), value);
for (const selector of [':root {', ':root[data-theme="light"] {', ':root[data-theme="dark"] {', ':root[data-density="cozy"] {', ':root[data-density="compact"] {', '@media (prefers-reduced-motion: reduce)']) assert.ok(output.css.includes(selector));
assert.ok(!output.css.includes('--g-primitive-'));
const reports = JSON.parse(output.report);
for (const theme of ['light', 'dark']) {
  assert.equal(reports.filter(p => p.theme === theme).length, 56);
  for (const minimum of [4.5, 3]) {
    const pair = reports.filter(p => p.theme === theme && p.minimum === minimum).sort((a, b) => a.ratio - b.ratio)[0];
    console.log(`${theme} minimum ${minimum}: ${pair.ratio} (${pair.foreground} / ${pair.background})`);
  }
}
console.log(`PASS: ${failures} negative mutations; repeat-build equality; committed-output equality; selectors; no primitive CSS; ${verifyFonts()} WOFF2 hashes/licenses`);
