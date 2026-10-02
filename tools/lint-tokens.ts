#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenStyleRoot } from './token-defaults.ts';
import type { Declaration } from './token-lint-parser.ts';
import {
  cssDeclarations,
  cssStylesheetImports,
  importedStylesheets,
  inlineDeclarations,
  inlineEscapeLines,
} from './token-lint-parser.ts';
import { packagedTokenRoot } from './token-package.ts';
import type { TokenType } from './tokens-core.ts';
import { strictTokenJson, TokenError } from './tokens-core.ts';
import { checkTokenFreshness, tokenSnapshot } from './tokens-io.ts';

export interface LiteralIssue {
  file: string;
  line: number;
  column: number;
  property: string;
  code: string;
}
export interface LiteralException {
  file: string;
  property: string;
  value: string | number;
  rationale: string;
  owner: string;
}
const propertyName = (value: string) =>
  value.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const colorProperty = (p: string) =>
  /(?:color|background|fill|stroke|shadow)$/.test(p) ||
  p === 'background-image';
const fontProperty = (p: string) => /^(?:font(?:-.+)?|letter-spacing)$/.test(p);
const dimensionProperty = (p: string) =>
  /^(?:width|height|min-width|max-width|min-height|max-height|margin(?:-.+)?|padding(?:-.+)?|gap|row-gap|column-gap|border(?:-.+)?|outline(?:-.+)?|top|left|right|bottom|inset(?:-.+)?|transform|translate|border-radius)$/.test(
    p,
  );
const keywords = new Set([
  'auto',
  'none',
  'inherit',
  'initial',
  'unset',
  'normal',
  'block',
  'inline',
  'inline-block',
  'flex',
  'grid',
  'inline-flex',
  'inline-grid',
  'contents',
  'hidden',
  'visible',
  'scroll',
  'absolute',
  'relative',
  'fixed',
  'sticky',
  'static',
  'center',
  'start',
  'end',
  'stretch',
  'space-between',
  'space-around',
  'space-evenly',
  'row',
  'column',
  'row-reverse',
  'column-reverse',
  'wrap',
  'nowrap',
  'solid',
  'dashed',
  'dotted',
  'collapse',
  'separate',
  'border-box',
  'content-box',
]);
function functions(
  value: string,
  name: string,
): Array<{ start: number; end: number; args: string }> {
  const out = [];
  for (let i = 0; i < value.length; i++) {
    if (value.slice(i, i + name.length + 1).toLowerCase() !== name + '(')
      continue;
    const start = i;
    let depth = 1,
      quote = '';
    i += name.length + 1;
    const from = i;
    for (; i < value.length && depth; i++) {
      const c = value[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = '';
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === '(') depth++;
      if (c === ')') depth--;
    }
    if (depth) throw new TokenError('VALUE_SYNTAX');
    out.push({ start, end: i, args: value.slice(from, i - 1) });
    i--;
  }
  return out;
}
function checkValue(
  decl: Declaration,
  registry: Record<string, TokenType>,
): string | null {
  const p = propertyName(decl.property),
    value = decl.value;
  if (p === 'style' || value === null) return 'unanalyzable style expression';
  if (p.startsWith('--')) return 'HANDWRITTEN_ALIAS';
  if (typeof value === 'number') {
    if (value === 0 && dimensionProperty(p) && !fontProperty(p)) return null;
    if (p === 'opacity' && (value === 0 || value === 1)) return null;
    if (
      [
        'flex-grow',
        'flex-shrink',
        'order',
        'grid-column',
        'grid-row',
        'line-height',
      ].includes(p) &&
      Number.isFinite(value) &&
      value >= 0
    )
      return null;
    return fontProperty(p)
      ? 'FONT'
      : dimensionProperty(p)
        ? 'LENGTH'
        : 'unanalyzable style expression';
  }
  const raw = value.trim();
  if (!raw) return 'VALUE_SYNTAX';
  if (p === 'content' && /^(?:"[^"\\n]*"|'[^'\\n]*')$/.test(raw)) return null;
  let residual = raw;
  for (const item of functions(raw, 'var').reverse()) {
    const args = item.args.trim();
    if (args.includes(',')) return 'VAR_FALLBACK';
    if (!/^--g-(?:semantic|component)-[A-Za-z0-9-]+$/.test(args))
      return 'LAYER';
    if (!Object.hasOwn(registry, args)) return 'UNKNOWN_TOKEN';
    const type = registry[args];
    if (colorProperty(p) && type !== 'color') return 'TOKEN_TYPE';
    if (
      (p === 'font' || p === 'font-family' || p === 'font-weight') &&
      type !== 'typography'
    )
      return 'TOKEN_TYPE';
    if (
      (dimensionProperty(p) || p === 'font-size' || p === 'letter-spacing') &&
      type !== 'dimension' &&
      !['border', 'outline', 'transform'].includes(p)
    )
      return 'TOKEN_TYPE';
    residual =
      residual.slice(0, item.start) + ' TOKEN ' + residual.slice(item.end);
  }
  for (const item of functions(residual, 'url').reverse())
    residual =
      residual.slice(0, item.start) + ' URL ' + residual.slice(item.end);
  if (
    /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\(/i.test(
      residual,
    )
  )
    return 'COLOR';
  if (raw === 'transparent')
    return ['background', 'background-color', 'fill'].includes(p)
      ? null
      : 'COLOR';
  if (raw === 'currentColor')
    return ['fill', 'stroke'].includes(p) ? null : 'COLOR';
  if (raw === '100%' && ['width', 'height'].includes(p)) return null;
  if (
    /(?:^|[^\w-])(?:\d*\.\d+|\d+)(?:px|rem|em|vh|vw|vmin|vmax|ch|ex|pt|pc|cm|mm|in|%)(?=$|[^A-Za-z])/i.test(
      residual,
    )
  )
    return p.includes('radius')
      ? 'RADIUS'
      : fontProperty(p)
        ? 'FONT'
        : 'LENGTH';
  if (raw === '0' && dimensionProperty(p) && !fontProperty(p)) return null;
  if (p === 'opacity' && ['0', '1'].includes(raw)) return null;
  if (
    [
      'flex-grow',
      'flex-shrink',
      'order',
      'grid-column',
      'grid-row',
      'line-height',
    ].includes(p) &&
    /^\d+(?:\.\d+)?$/.test(raw)
  )
    return null;
  if (
    /^minmax\(\s*0\s*,\s*1fr\s*\)$/.test(raw) &&
    ['grid-template-columns', 'grid-template-rows'].includes(p)
  )
    return null;
  if (/^scale\(\s*\d+(?:\.\d+)?\s*\)$/.test(raw) && p === 'transform')
    return null;
  const words = residual
    .replace(/\b(?:calc|clamp|min|max)\s*\(/g, '(')
    .replace(/[\s()+*/,-]+/g, ' ')
    .trim()
    .split(/\s+/);
  if (
    words.every((word) => ['TOKEN', 'URL'].includes(word) || keywords.has(word))
  )
    return null;
  if (fontProperty(p)) return 'FONT';
  if (colorProperty(p)) return 'COLOR';
  return 'UNTYPED_LITERAL';
}
export function lintTokenSourceReport(
  file: string,
  text: string,
  registry: Record<string, TokenType>,
  exceptions: LiteralException[] = [],
): { issues: LiteralIssue[]; inlineEscapes: number; exactEscapes: number } {
  for (const exception of exceptions)
    if (
      !exception.file ||
      !exception.property ||
      !exception.rationale?.trim() ||
      !exception.owner?.trim() ||
      !['string', 'number'].includes(typeof exception.value)
    )
      throw new TokenError('EXCEPTION_RECORD');
  const declarations = file.endsWith('.css')
      ? cssDeclarations(text)
      : inlineDeclarations(text),
    issues: LiteralIssue[] = [],
    escapes = inlineEscapeLines(file, text),
    used = new Set<number>();
  let exactEscapes = 0;
  for (const decl of declarations) {
    const code = checkValue(decl, registry);
    if (!code) continue;
    if (
      exceptions.some(
        (e) =>
          e.file === file &&
          propertyName(e.property) === propertyName(decl.property) &&
          e.value === decl.value,
      )
    ) {
      exactEscapes++;
      continue;
    }
    if (escapes.has(decl.line)) {
      used.add(decl.line);
      continue;
    }
    issues.push({
      file,
      line: decl.line,
      column: decl.column + 1,
      property: decl.property,
      code,
    });
  }
  if ([...escapes.keys()].some((line) => !used.has(line)))
    throw new TokenError('INLINE_ESCAPE_ATTACHMENT');
  return { issues, inlineEscapes: used.size, exactEscapes };
}
export function lintTokenSource(
  file: string,
  text: string,
  registry: Record<string, TokenType>,
  exceptions: LiteralException[] = [],
): LiteralIssue[] {
  return lintTokenSourceReport(file, text, registry, exceptions).issues;
}
export function runTokenLint(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'lint-tokens [--root ABSOLUTE_STYLE_TREE]\nNative default: source repository. Emitted default: package dist/assets logical style tree. Explicit roots are used exactly; no instruction scan or legacy activation.',
    );
    return 0;
  }
  let root = tokenStyleRoot(import.meta.url);
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--root' || !path.isAbsolute(args[1]))
      throw new TokenError('ARGUMENT');
    root = args[1];
  }
  const ui = path.join(root, 'dashboard/web/src/ui'),
    tokenRoot = path.join(ui, 'tokens'),
    snapshot = packagedTokenRoot(tokenRoot)
      ? checkTokenFreshness(tokenRoot)
      : tokenSnapshot(tokenRoot),
    registry = strictTokenJson(snapshot.files['registry.json']) as Record<
      string,
      TokenType
    >;
  const scope = strictTokenJson(
    fs.readFileSync(path.join(root, 'tools/token-lint-scope.json'), 'utf8'),
  ) as { converted: string[]; exceptions: LiteralException[] };
  if (!Array.isArray(scope.converted) || !Array.isArray(scope.exceptions))
    throw new TokenError('LINT_SCOPE');
  const excluded = (relative: string) =>
    relative.startsWith('dashboard/web/src/ui/tokens/source/') ||
    relative.startsWith('dashboard/web/src/ui/tokens/.generations/') ||
    relative.startsWith('dashboard/web/src/ui/tokens/generated/') ||
    relative.startsWith('dashboard/web/src/ui/fonts/') ||
    relative === 'dashboard/web/extra.css';
  const files: string[] = [];
  const collect = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name),
        relative = path.relative(root, target).split(path.sep).join('/');
      if (
        excluded(relative) ||
        relative === 'dashboard/web/src/ui/tokens/generated'
      )
        continue;
      if (entry.isSymbolicLink()) throw new TokenError('LINT_SYMLINK');
      if (entry.isDirectory()) collect(target);
      else if (/\.(?:css|js|jsx|ts|tsx)$/.test(entry.name))
        files.push(relative);
    }
  };
  collect(ui);
  for (const relative of scope.converted) {
    if (
      typeof relative !== 'string' ||
      relative.startsWith('/') ||
      relative.split('/').includes('..') ||
      !relative.startsWith('dashboard/web/') ||
      !/\.(?:css|js|jsx|ts|tsx)$/.test(relative)
    )
      throw new TokenError('LINT_SCOPE');
    if (!excluded(relative)) files.push(relative);
  }
  // Resolve the full static stylesheet closure, including CSS -> CSS edges and cycles.
  const pending = [...new Set(files)],
    visited = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    if (pending.length > 10_000) throw new TokenError('LINT_IMPORT_BOUNDS');
    const file = pending[index];
    if (visited.has(file)) continue;
    visited.add(file);
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const css = file.endsWith('.css');
    for (const specifier of css
      ? cssStylesheetImports(text)
      : importedStylesheets(text)) {
      if (
        (!css && !specifier.startsWith('.')) ||
        !specifier.endsWith('.css') ||
        /[?#\\\s:*]/.test(specifier) ||
        path.isAbsolute(specifier)
      )
        throw new TokenError('LINT_IMPORT_PATH');
      const target = path.resolve(root, path.dirname(file), specifier);
      const relative = path.relative(root, target).split(path.sep).join('/');
      if (!relative.startsWith('dashboard/web/'))
        throw new TokenError('LINT_IMPORT_PATH');
      if (excluded(relative)) continue;
      const stat = fs.lstatSync(target);
      const real = path.relative(
        fs.realpathSync(path.join(root, 'dashboard/web')),
        fs.realpathSync(target),
      );
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        real.startsWith(`..${path.sep}`) ||
        path.isAbsolute(real)
      )
        throw new TokenError('LINT_IMPORT_PATH');
      if (!visited.has(relative) && !pending.includes(relative))
        pending.push(relative);
      files.push(relative);
    }
  }
  const reports = [...new Set(files)]
    .sort()
    .map((file) =>
      lintTokenSourceReport(
        file,
        fs.readFileSync(path.join(root, file), 'utf8'),
        registry,
        scope.exceptions,
      ),
    );
  const issues = reports.flatMap((report) => report.issues),
    inlineEscapes = reports.reduce(
      (sum, report) => sum + report.inlineEscapes,
      0,
    ),
    exactEscapes = reports.reduce(
      (sum, report) => sum + report.exactEscapes,
      0,
    );
  for (const issue of issues)
    console.error(
      `${issue.file}:${issue.line}:${issue.column}/${issue.property}/${issue.code}`,
    );
  console.log(
    `token literal lint: ${new Set(files).size} explicit files, ${issues.length} issues, ${inlineEscapes + exactEscapes} escapes (${inlineEscapes} inline, ${exactEscapes} exact)`,
  );
  return issues.length ? 1 : 0;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = runTokenLint(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof TokenError ? error.message : 'LINT_IO');
    process.exitCode =
      error instanceof TokenError && error.message === 'ARGUMENT' ? 2 : 1;
  }
}
