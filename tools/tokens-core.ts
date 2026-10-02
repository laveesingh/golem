import type { Node as JsonNode, ParseError } from 'jsonc-parser';
import { parseTree } from 'jsonc-parser';

export type TokenType = 'color' | 'dimension' | 'duration' | 'typography';
export interface Token {
  $type: TokenType;
  $value: unknown;
}
interface Pair {
  foreground: string;
  background: string;
  minimum: 3 | 4.5;
  usage: string;
}
export interface Sources {
  primitive: unknown;
  semantic: unknown;
  component: unknown;
  light: unknown;
  dark: unknown;
  cozy: unknown;
  compact: unknown;
  pairs: unknown;
}
export interface Output {
  css: string;
  types: string;
  report: string;
  registry: Record<string, TokenType>;
  combinations: Record<string, Map<string, Token>>;
}
export class TokenError extends Error {
  readonly token: string;
  readonly set: string;
  constructor(publicCode: string, token = '', set = '') {
    super(publicCode);
    this.name = 'TokenError';
    this.token = token;
    this.set = set;
  }
}
const fail = (code: string, token = '', set = ''): never => {
  throw new TokenError(code, token, set);
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('STRUCTURE');
  return value as Record<string, unknown>;
};
const keys = (
  value: Record<string, unknown>,
  allowed: string[],
  required = allowed,
): void => {
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    fail('UNSUPPORTED_STRUCTURE');
};
export function strictTokenJson(text: string): unknown {
  if (Buffer.byteLength(text) > 1_048_576) fail('INPUT_SIZE');
  const errors: ParseError[] = [],
    tree = parseTree(text, errors, {
      disallowComments: true,
      allowTrailingComma: false,
      allowEmptyContent: false,
    });
  if (errors.length || !tree) return fail('JSON_SYNTAX');
  let count = 0;
  const visit = (node: JsonNode, depth = 0): void => {
    if (++count > 100_000 || depth > 32) fail('JSON_BOUNDS');
    if (node.type === 'object') {
      const names = new Set<string>();
      for (const property of node.children ?? []) {
        const name = String(property.children?.[0]?.value);
        if (names.has(name)) fail('DUPLICATE_KEY');
        names.add(name);
      }
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(tree);
  return JSON.parse(text) as unknown;
}
const isAlias = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\{[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*\}$/.test(value);
export function flattenTokens(
  value: unknown,
  prefix = '',
  out = new Map<string, Token>(),
): Map<string, Token> {
  const data = object(value);
  for (const [key, node] of Object.entries(data)) {
    if (key === '$description') {
      if (typeof node !== 'string') fail('DESCRIPTION');
      continue;
    }
    if (key === '$extensions') {
      object(node);
      continue;
    }
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) fail('UNSUPPORTED_NAME', prefix);
    const name = prefix ? `${prefix}.${key}` : key,
      item = object(node);
    if (Object.hasOwn(item, '$value')) {
      keys(
        item,
        ['$type', '$value', '$description', '$extensions'],
        ['$type', '$value'],
      );
      if (
        !['color', 'dimension', 'duration', 'typography'].includes(
          String(item.$type),
        )
      )
        fail('UNSUPPORTED_TYPE', name);
      if (out.has(name)) fail('DUPLICATE_TOKEN', name);
      out.set(name, { $type: item.$type as TokenType, $value: item.$value });
    } else flattenTokens(item, name, out);
  }
  if (out.size > 10_000) fail('TOKEN_BOUNDS');
  return out;
}
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
function dimension(value: unknown): { value: number; unit: string } {
  const item = object(value);
  keys(item, ['value', 'unit']);
  if (
    !finite(item.value) ||
    item.value < 0 ||
    !['px', 'rem'].includes(String(item.unit))
  )
    return fail('DIMENSION');
  return { value: item.value, unit: String(item.unit) };
}
function validate(token: Token, name: string): void {
  const v = object(token.$value);
  if (token.$type === 'color') {
    keys(v, ['colorSpace', 'components', 'alpha']);
    if (
      v.colorSpace !== 'srgb' ||
      v.alpha !== 1 ||
      !Array.isArray(v.components) ||
      v.components.length !== 3 ||
      !v.components.every((n) => finite(n) && n >= 0 && n <= 1)
    )
      fail('COLOR', name);
  } else if (token.$type === 'dimension') dimension(v);
  else if (token.$type === 'duration') {
    keys(v, ['value', 'unit']);
    if (
      !finite(v.value) ||
      v.value < 0 ||
      !['ms', 's'].includes(String(v.unit))
    )
      fail('DURATION', name);
  } else {
    keys(v, [
      'fontFamily',
      'fontSize',
      'fontWeight',
      'lineHeight',
      'letterSpacing',
    ]);
    if (
      !Array.isArray(v.fontFamily) ||
      !v.fontFamily.length ||
      v.fontFamily.length > 8 ||
      !v.fontFamily.every(
        (f) => typeof f === 'string' && /^[A-Za-z][A-Za-z -]*$/.test(f),
      ) ||
      !Number.isInteger(v.fontWeight) ||
      Number(v.fontWeight) < 1 ||
      Number(v.fontWeight) > 1000 ||
      !finite(v.lineHeight) ||
      v.lineHeight <= 0
    )
      fail('TYPOGRAPHY', name);
    dimension(v.fontSize);
    dimension(v.letterSpacing);
  }
}
export function resolveTokens(tokens: Map<string, Token>): Map<string, Token> {
  const resolved = new Map<string, Token>(),
    visiting = new Set<string>();
  const visit = (name: string): Token => {
    const known = resolved.get(name);
    if (known) return known;
    if (visiting.has(name)) return fail('CYCLE', name);
    const token = tokens.get(name);
    if (!token) return fail('UNRESOLVED', name);
    visiting.add(name);
    let value = token.$value;
    if (isAlias(value)) {
      const target = value.slice(1, -1),
        next = visit(target);
      if (next.$type !== token.$type) fail('TYPE_MISMATCH', name);
      const from = name.split('.')[0],
        to = target.split('.')[0];
      if (
        !(
          (from === 'semantic' && to === 'primitive') ||
          (from === 'component' && to === 'semantic')
        )
      )
        fail('LAYER', name);
      value = next.$value;
    } else if (!name.startsWith('primitive.'))
      fail('LITERAL_OUTSIDE_PRIMITIVE', name);
    const result = { $type: token.$type, $value: value };
    validate(result, name);
    visiting.delete(name);
    resolved.set(name, result);
    return result;
  };
  for (const name of [...tokens.keys()].sort()) visit(name);
  return resolved;
}
function scoped(value: unknown, scope: string): Map<string, Token> {
  const tokens = flattenTokens(value);
  for (const name of tokens.keys())
    if (!name.startsWith(scope)) fail('SET_SCOPE', name);
  return tokens;
}
function merge(
  base: Map<string, Token>,
  extra: Map<string, Token>,
  allowOverride = false,
): Map<string, Token> {
  const result = new Map(base);
  for (const [name, token] of extra) {
    const prior = base.get(name);
    if (prior && !allowOverride) fail('DUPLICATE_TOKEN', name);
    if (prior && prior.$type !== token.$type) fail('OVERRIDE_TYPE', name);
    result.set(name, token);
  }
  return result;
}
// Locked GOL-438/GOL-485 accepted static overlay vocabulary (352fa05).
// These sets introduce names absent from base semantic; never derive this contract from candidates.
const themeNames = new Set([
  ...['page', 'panel', 'raised', 'hover', 'selected', 'disabled'].map(
    (name) => `semantic.surface.${name}`,
  ),
  ...['primary', 'secondary', 'muted', 'disabled'].map(
    (name) => `semantic.text.${name}`,
  ),
  ...['working', 'idle', 'review', 'blocked', 'done', 'triage', 'open'].map(
    (name) => `semantic.status.${name}`,
  ),
  'semantic.accent.fill',
  'semantic.accent.ink',
  'semantic.focus.color',
  'semantic.border.control',
]);
const acceptedDensityNames = new Set(
  ['control', 'target', 'gap', 'paddingX', 'paddingY', 'row', 'card'].map(
    (name) => `semantic.density.${name}`,
  ),
);
function overlayVocabulary(
  tokens: Map<string, Token>,
  names: Set<string>,
): void {
  for (const name of tokens.keys())
    if (!names.has(name)) fail('UNKNOWN_OVERRIDE', name);
  if (tokens.size !== names.size) fail('OVERLAY_COVERAGE');
}
const cssName = (name: string) => `--g-${name.replaceAll('.', '-')}`;
const families = (value: string[]) =>
  value
    .map((f) =>
      ['system-ui', 'ui-sans-serif', 'ui-monospace', 'monospace'].includes(f)
        ? f
        : JSON.stringify(f),
    )
    .join(', ');
function cssValue(token: Token): string {
  const v = object(token.$value);
  if (token.$type === 'color')
    return `#${(v.components as number[])
      .map((n) =>
        Math.round(n * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`;
  if (token.$type === 'dimension' || token.$type === 'duration')
    return `${v.value}${v.unit}`;
  const size = dimension(v.fontSize);
  return `${v.fontWeight} ${size.value}${size.unit}/${v.lineHeight} ${families(v.fontFamily as string[])}`;
}
const publicNames = (tokens: Map<string, Token>) =>
  [...tokens.keys()].filter((name) => !name.startsWith('primitive.')).sort();
const required = (tokens: Map<string, Token>, name: string): Token =>
  tokens.get(name) ?? fail('UNRESOLVED', name);
function declarations(
  tokens: Map<string, Token>,
  names = publicNames(tokens),
): string {
  return names
    .flatMap((name) => {
      const token = required(tokens, name),
        lines = [`  ${cssName(name)}: ${cssValue(token)};`];
      if (token.$type === 'typography') {
        const spacing = dimension(object(token.$value).letterSpacing);
        lines.push(
          `  ${cssName(name)}-letterSpacing: ${spacing.value}${spacing.unit};`,
        );
      }
      return lines;
    })
    .join('\n');
}
export function contrastRatio(a: number[], b: number[]): number {
  const luminance = (rgb: number[]) =>
    rgb.reduce(
      (sum, c, index) =>
        sum +
        (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) *
          [0.2126, 0.7152, 0.0722][index],
      0,
    );
  const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (light + 0.05) / (dark + 0.05);
}
function expectedPairs(): Set<string> {
  const out = new Set<string>(),
    surfaces = ['page', 'panel', 'raised', 'hover', 'selected', 'disabled'];
  const add = (fg: string, bg: string, min: number) =>
    out.add(`${fg}|${bg}|${min}`);
  for (const text of ['primary', 'secondary', 'muted', 'disabled'])
    for (const surface of surfaces)
      add(`semantic.text.${text}`, `semantic.surface.${surface}`, 4.5);
  for (const status of [
    'working',
    'idle',
    'review',
    'blocked',
    'done',
    'triage',
    'open',
  ])
    for (const surface of surfaces.slice(0, 3))
      add(`semantic.status.${status}`, `semantic.surface.${surface}`, 3);
  for (const marker of ['focus.color', 'border.control'])
    for (const surface of surfaces.slice(0, 5))
      add(`semantic.${marker}`, `semantic.surface.${surface}`, 3);
  add('semantic.accent.ink', 'semantic.accent.fill', 4.5);
  for (const state of [
    'default',
    'hover',
    'active',
    'focus',
    'busy',
    'disabled',
  ])
    add(
      `component.button.primary.${state}.foreground`,
      `component.button.primary.${state}.background`,
      4.5,
    );
  return out;
}
function pairs(value: unknown): Pair[] {
  if (!Array.isArray(value)) return fail('PAIR_STRUCTURE');
  const expected = expectedPairs(),
    seen = new Set<string>();
  const result = value.map((raw) => {
    const item = object(raw);
    keys(item, ['foreground', 'background', 'minimum', 'usage']);
    const key = `${item.foreground}|${item.background}|${item.minimum}`;
    if (
      !expected.has(key) ||
      seen.has(key) ||
      typeof item.usage !== 'string' ||
      !item.usage ||
      item.usage.length > 256
    )
      fail('PAIR_COVERAGE');
    seen.add(key);
    return item as unknown as Pair;
  });
  if (seen.size !== expected.size) fail('PAIR_COVERAGE');
  return result;
}
export function buildTokens(source: Sources): Output {
  let base = merge(
    scoped(source.primitive, 'primitive.'),
    scoped(source.semantic, 'semantic.'),
  );
  base = merge(base, scoped(source.component, 'component.'));
  const themes = {
      light: scoped(source.light, 'semantic.'),
      dark: scoped(source.dark, 'semantic.'),
    },
    densities = {
      cozy: scoped(source.cozy, 'semantic.density.'),
      compact: scoped(source.compact, 'semantic.density.'),
    };
  if (
    JSON.stringify([...themes.light.keys()].sort()) !==
      JSON.stringify([...themes.dark.keys()].sort()) ||
    JSON.stringify([...densities.cozy.keys()].sort()) !==
      JSON.stringify([...densities.compact.keys()].sort())
  )
    fail('OVERLAY_KEYS');
  for (const theme of Object.values(themes))
    overlayVocabulary(theme, themeNames);
  for (const density of Object.values(densities))
    overlayVocabulary(density, acceptedDensityNames);
  for (const theme of Object.values(themes))
    for (const [name, token] of theme)
      if (token.$type !== 'color') fail('THEME_TYPE', name);
  for (const density of Object.values(densities))
    for (const [name, token] of density)
      if (token.$type !== 'dimension') fail('DENSITY_TYPE', name);
  const combinations: Record<string, Map<string, Token>> = {},
    report: Array<Pair & { theme: string; ratio: number; cssRatio: number }> =
      [],
    usage = pairs(source.pairs);
  for (const theme of ['dark', 'light'] as const)
    for (const density of ['cozy', 'compact'] as const) {
      const tokens = resolveTokens(
        merge(merge(base, themes[theme], true), densities[density], true),
      );
      combinations[`${theme}/${density}`] = tokens;
      for (const pair of usage) {
        const fg = required(tokens, pair.foreground),
          bg = required(tokens, pair.background);
        if (fg.$type !== 'color' || bg.$type !== 'color')
          fail('PAIR_TYPE', pair.foreground);
        const a = object(fg.$value).components as number[],
          b = object(bg.$value).components as number[],
          ratio = contrastRatio(a, b),
          cssRatio = contrastRatio(
            a.map((n) => Math.round(n * 255) / 255),
            b.map((n) => Math.round(n * 255) / 255),
          );
        if (ratio < pair.minimum || cssRatio < pair.minimum)
          fail('CONTRAST', pair.foreground, `${theme}/${density}`);
        if (density === 'cozy')
          report.push({
            theme,
            ...pair,
            ratio: Number(ratio.toFixed(6)),
            cssRatio: Number(cssRatio.toFixed(6)),
          });
      }
    }
  const defaults = combinations['dark/cozy'],
    registry: Record<string, TokenType> = {},
    logical: Record<string, string> = {},
    logicalTypes: Record<string, TokenType> = {};
  for (const name of publicNames(defaults)) {
    const token = required(defaults, name),
      css = cssName(name);
    if (Object.hasOwn(registry, css)) fail('CSS_NAME_COLLISION', name);
    registry[css] = token.$type;
    logical[name] = `var(${css})`;
    logicalTypes[name] = token.$type;
    if (token.$type === 'typography') {
      const member = `${name}.letterSpacing`,
        memberCss = cssName(member);
      if (Object.hasOwn(registry, memberCss) || Object.hasOwn(logical, member))
        fail('CSS_NAME_COLLISION', member);
      registry[memberCss] = 'dimension';
      logical[member] = `var(${memberCss})`;
      logicalTypes[member] = 'dimension';
    }
  }
  const sections = [
    '/* Generated bounded token subset; do not edit. */',
    `:root {\n  color-scheme: dark;\n${declarations(defaults)}\n}`,
  ];
  for (const theme of ['light', 'dark']) {
    const tokens = combinations[`${theme}/cozy`];
    sections.push(
      `:root[data-theme="${theme}"] {\n  color-scheme: ${theme};\n${declarations(
        tokens,
        publicNames(tokens).filter(
          (n) => required(tokens, n).$type === 'color',
        ),
      )}\n}`,
    );
  }
  const densityNames = publicNames(defaults).filter(
    (n) =>
      n.startsWith('semantic.density.') ||
      (base.has(n) &&
        isAlias(required(base, n).$value) &&
        String(required(base, n).$value).startsWith('{semantic.density.')),
  );
  for (const density of ['cozy', 'compact'])
    sections.push(
      `:root[data-density="${density}"] {\n${declarations(combinations[`dark/${density}`], densityNames)}\n}`,
    );
  sections.push(
    `@media (prefers-reduced-motion: reduce) {\n  :root {\n${publicNames(
      defaults,
    )
      .filter((n) => required(defaults, n).$type === 'duration')
      .map((n) => `    ${cssName(n)}: 0ms;`)
      .join('\n')}\n  }\n}`,
  );
  let types = `/* Generated bounded token names. */\nexport const tokens = ${JSON.stringify(logical, null, 2)} as const;\nexport type TokenName = keyof typeof tokens;\n`;
  for (const type of [
    'color',
    'dimension',
    'duration',
    'typography',
  ] as const) {
    const names = Object.keys(logicalTypes)
      .filter((n) => logicalTypes[n] === type)
      .sort();
    types += `export type ${type[0].toUpperCase() + type.slice(1)}TokenName = ${names.map((n) => JSON.stringify(n)).join(' | ') || 'never'};\n`;
  }
  return {
    css: sections.join('\n\n') + '\n',
    types,
    report: JSON.stringify(report, null, 2) + '\n',
    registry,
    combinations,
  };
}
