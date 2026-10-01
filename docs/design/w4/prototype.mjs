// Isolated design executable. Not production tooling or a DTCG-conformance claim.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const fail = (code, name) => { throw new Error(`${code}: ${name}`); };
const alias = value => typeof value === 'string' && /^\{[^{}]+\}$/.test(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function flatten(object, prefix = '', result = {}) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) fail('STRUCTURE', prefix);
  for (const [key, node] of Object.entries(object)) {
    if (key.startsWith('$')) {
      if (!['$description', '$extensions'].includes(key)) fail('UNSUPPORTED', `${prefix}.${key}`);
      continue;
    }
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) fail('NAME', `${prefix}.${key}`);
    const name = prefix ? `${prefix}.${key}` : key;
    if (node && Object.hasOwn(node, '$value')) {
      if (!node.$type || Object.keys(node).some(k => !['$value', '$type', '$description', '$extensions'].includes(k))) fail('TOKEN', name);
      if (result[name]) fail('DUPLICATE', name);
      result[name] = node;
    } else flatten(node, name, result);
  }
  return result;
}
export function resolve(tokens) {
  const cache = {}, visiting = new Set();
  const visit = name => {
    if (cache[name]) return cache[name];
    if (visiting.has(name)) fail('CYCLE', name);
    const token = tokens[name];
    if (!token) fail('UNRESOLVED', name);
    visiting.add(name);
    let value = token.$value;
    if (alias(value)) {
      const target = value.slice(1, -1), next = visit(target);
      if (next.$type !== token.$type) fail('TYPE_MISMATCH', `${name} -> ${target}`);
      const from = name.split('.')[0], to = target.split('.')[0];
      if (!((from === 'semantic' && to === 'primitive') || (from === 'component' && to === 'semantic'))) fail('LAYER', `${name} -> ${target}`);
      value = next.$value;
    } else if (!name.startsWith('primitive.')) fail('LITERAL_OUTSIDE_PRIMITIVE', name);
    const resolved = { $type: token.$type, $value: value };
    validate(resolved, name);
    visiting.delete(name);
    cache[name] = resolved;
    return resolved;
  };
  for (const name of Object.keys(tokens).sort(compare)) visit(name);
  return cache;
}
function validate({ $type: type, $value: v }, name) {
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const dimension = n => n && finite(n.value) && n.value >= 0 && ['px', 'rem'].includes(n.unit);
  switch (type) {
    case 'color':
      if (v?.colorSpace !== 'srgb' || !Array.isArray(v.components) || v.components.length !== 3 || !v.components.every(n => finite(n) && n >= 0 && n <= 1) || v.alpha !== 1) fail('COLOR', name);
      break;
    case 'dimension': if (!dimension(v)) fail('DIMENSION', name); break;
    case 'duration': if (!v || !finite(v.value) || v.value < 0 || !['ms', 's'].includes(v.unit)) fail('DURATION', name); break;
    case 'typography':
      if (!v || !Array.isArray(v.fontFamily) || !v.fontFamily.length || !v.fontFamily.every(f => typeof f === 'string' && /^[a-zA-Z -]+$/.test(f)) || !dimension(v.fontSize) || !dimension(v.letterSpacing) || !Number.isInteger(v.fontWeight) || v.fontWeight < 1 || v.fontWeight > 1000 || !finite(v.lineHeight) || v.lineHeight <= 0) fail('TYPOGRAPHY', name);
      break;
    default: fail('UNSUPPORTED_TYPE', name);
  }
}
const family = v => v.map(f => ['system-ui', 'ui-sans-serif', 'ui-monospace', 'monospace'].includes(f) ? f : JSON.stringify(f)).join(', ');
const valueCSS = token => {
  const v = token.$value;
  if (token.$type === 'color') return '#' + v.components.map(n => Math.round(n * 255).toString(16).padStart(2, '0')).join('');
  if (['dimension', 'duration'].includes(token.$type)) return `${v.value}${v.unit}`;
  if (token.$type === 'typography') return `${v.fontWeight} ${v.fontSize.value}${v.fontSize.unit}/${v.lineHeight} ${family(v.fontFamily)}`;
  fail('UNSUPPORTED_TYPE', token.$type);
};
const cssName = name => '--g-' + name.replaceAll('.', '-');
const publicNames = tokens => Object.keys(tokens).filter(n => !n.startsWith('primitive.')).sort(compare);
function declarations(tokens, names = publicNames(tokens)) {
  return names.flatMap(name => {
    const t = tokens[name], v = t.$value;
    const lines = [`  ${cssName(name)}: ${valueCSS(t)};`];
    if (t.$type === 'typography') lines.push(`  ${cssName(name)}-letterSpacing: ${v.letterSpacing.value}${v.letterSpacing.unit};`);
    return lines;
  }).join('\n');
}
const luminance = token => token.$value.components.map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
export function contrast(tokens, pairs, theme) {
  return pairs.map(p => {
    const fg = tokens[p.foreground], bg = tokens[p.background];
    if (fg?.$type !== 'color' || bg?.$type !== 'color') fail('PAIR_TYPE', p.foreground);
    const [a, b] = [luminance(fg), luminance(bg)].sort((a, b) => a - b);
    const ratio = (b + .05) / (a + .05);
    if (ratio < p.minimum) fail('CONTRAST', `${theme} ${p.foreground} / ${p.background} ${ratio.toFixed(6)} < ${p.minimum}`);
    return { theme, ...p, ratio: Number(ratio.toFixed(6)) };
  });
}
function overlay(base, data, scope) {
  const next = flatten(data);
  for (const [name, token] of Object.entries(next)) {
    if (!name.startsWith(scope)) fail('OVERLAY_SCOPE', name);
    if (base[name] && base[name].$type !== token.$type) fail('OVERRIDE_TYPE', name);
  }
  return { ...base, ...next };
}
export const primaryStates = ['default', 'hover', 'active', 'focus', 'busy', 'disabled'];
export function validatePrimaryPairs(pairs) {
  for (const state of primaryStates) {
    const prefix = `component.button.primary.${state}`;
    const matches = pairs.filter(p => p.foreground === `${prefix}.foreground` && p.background === `${prefix}.background`);
    if (matches.length !== 1 || matches[0].minimum !== 4.5) fail('PRIMARY_PAIR_COVERAGE', state);
  }
}
export function build(overrides = {}) {
  const sets = read('sets.json'), pairs = overrides.pairs ?? read('contrast-pairs.json');
  validatePrimaryPairs(pairs);
  let base = flatten(read(sets.primitive));
  base = overlay(base, read(sets.semantic), 'semantic.');
  base = overlay(base, overrides.component ?? read(sets.component), 'component.');
  const combinations = {}, report = [];
  for (const theme of ['dark', 'light']) for (const density of ['cozy', 'compact']) {
    let tokens = overlay(base, read(sets.themes[theme]), 'semantic.');
    tokens = overlay(tokens, read(sets.densities[density]), 'semantic.density.');
    tokens = resolve(tokens);
    const names = publicNames(tokens), mapped = names.map(cssName);
    if (new Set(mapped).size !== mapped.length) fail('CSS_NAME_COLLISION', theme);
    combinations[`${theme}/${density}`] = tokens;
    // Colors do not vary by density; one report per theme.
    if (density === 'cozy') report.push(...contrast(tokens, pairs, theme));
  }
  const defaults = combinations['dark/cozy'];
  const sections = ['/* Isolated design output; resolved values, not production output. */', `:root {\n  color-scheme: dark;\n${declarations(defaults)}\n}`];
  for (const theme of ['light', 'dark']) {
    const tokens = combinations[`${theme}/cozy`];
    sections.push(`:root[data-theme="${theme}"] {\n  color-scheme: ${theme};\n${declarations(tokens, publicNames(tokens).filter(n => tokens[n].$type === 'color'))}\n}`);
  }
  const densityNames = publicNames(defaults).filter(n => n.startsWith('semantic.density.') || (base[n] && alias(base[n].$value) && base[n].$value.startsWith('{semantic.density.')));
  for (const density of ['cozy', 'compact']) sections.push(`:root[data-density="${density}"] {\n${declarations(combinations[`dark/${density}`], densityNames)}\n}`);
  sections.push('@media (prefers-reduced-motion: reduce) {\n  :root {\n' + publicNames(defaults).filter(n => defaults[n].$type === 'duration').map(n => `    ${cssName(n)}: 0ms;`).join('\n') + '\n  }\n}');
  const names = publicNames(defaults).flatMap(n => defaults[n].$type === 'typography' ? [n, `${n}.letterSpacing`] : [n]);
  const typed = '/* Isolated generated names. */\nexport const tokens = ' + JSON.stringify(Object.fromEntries(names.map(n => [n, `var(${cssName(n)})`])), null, 2) + ' as const;\nexport type TokenName = keyof typeof tokens;\n';
  return { css: sections.join('\n\n') + '\n', typed, report: JSON.stringify(report, null, 2) + '\n', count: publicNames(combinations['dark/cozy']).length };
}
export function verifyFonts() {
  const inventory = read('fonts/inventory.json');
  for (const f of inventory) {
    const bytes = fs.readFileSync(path.join(root, 'fonts', f.file));
    if (bytes.subarray(0, 4).toString() !== 'wOF2' || bytes.length !== f.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== f.sha256) fail('FONT_HASH', f.file);
    if (!fs.readFileSync(path.join(root, 'fonts', f.licenseFile), 'utf8').includes('SIL OPEN FONT LICENSE')) fail('FONT_LICENSE', f.file);
  }
  return inventory.length;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const out = build(), count = verifyFonts();
    const files = { 'tokens.css': out.css, 'tokens.ts': out.typed, 'contrast.json': out.report };
    if (process.argv.includes('--write')) {
      fs.mkdirSync(path.join(root, 'generated'), { recursive: true });
      for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(root, 'generated', name), value);
    } else for (const [name, value] of Object.entries(files)) if (fs.readFileSync(path.join(root, 'generated', name), 'utf8') !== value) fail('STALE', name);
    console.log(`PASS: 4 combinations; ${out.count} public tokens; ${JSON.parse(out.report).length} contrast pairs; ${count} font hashes/licenses; deterministic outputs`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
