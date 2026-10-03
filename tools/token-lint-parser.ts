import { parse } from '@babel/parser';
import { TokenError } from './tokens-core.ts';

export interface Declaration {
  property: string;
  value: string | number | null;
  line: number;
  column: number;
}
const location = (text: string, index: number) => {
  const lines = text.slice(0, index).split('\n');
  return { line: lines.length, column: lines.at(-1)?.length ?? 0 };
};
const declarationStart = (text: string, start: number, end: number): number => {
  while (start < end) {
    if (/\s/.test(text[start])) {
      start++;
      continue;
    }
    if (text.slice(start, start + 2) === '/*') {
      const close = text.indexOf('*/', start + 2);
      if (close < 0 || close >= end) break;
      start = close + 2;
      continue;
    }
    break;
  }
  return start;
};
/** Parse only unconditional static CSS imports; unsupported syntax never hides a dependency. */
function importPath(statement: string): string | null {
  const text = statement.replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  if (!text.startsWith('@')) return null;
  if (text.includes('\\')) throw new TokenError('CSS_IMPORT_SYNTAX');
  if (!/^@import(?:\s|\()/i.test(text)) {
    if (/^@import\b/i.test(text)) throw new TokenError('CSS_IMPORT_SYNTAX');
    return null;
  }
  const value = text.slice(7).trim();
  const match =
    /^(?:"([^"\n]+)"|'([^'\n]+)'|url\(\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^\s()"']+))\s*\))$/i.exec(
      value,
    );
  if (!match) throw new TokenError('CSS_IMPORT_SYNTAX');
  return match.slice(1).find((part) => part !== undefined) ?? null;
}
/** Lex declarations and top-level imports with comments/quotes/functions/nested blocks. */
interface SourceComment {
  text: string;
  line: number;
  endLine: number;
  kind: string;
}
function parsedCss(text: string): {
  declarations: Declaration[];
  imports: string[];
  comments: SourceComment[];
} {
  if (Buffer.byteLength(text) > 1_048_576) throw new TokenError('LINT_SIZE');
  const out: Declaration[] = [],
    imports: string[] = [],
    comments: SourceComment[] = [];
  let commentStart = 0;
  let depth = 0,
    paren = 0,
    quote = '',
    comment = false,
    start = 0,
    colon = -1,
    property = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i],
      next = text[i + 1];
    if (comment) {
      if (c === '*' && next === '/') {
        comments.push({
          text: text.slice(commentStart + 2, i),
          line: location(text, commentStart).line,
          endLine: location(text, i + 1).line,
          kind: 'css',
        });
        comment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && next === '*') {
      commentStart = i;
      comment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '(') {
      paren++;
      continue;
    }
    if (c === ')') {
      if (--paren < 0) throw new TokenError('CSS_SYNTAX');
      continue;
    }
    if (paren) continue;
    if (c === '{' && colon < 0) {
      if (
        /^\s*@import\b/i.test(
          text.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, ' '),
        )
      )
        throw new TokenError('CSS_IMPORT_SYNTAX');
      depth++;
      start = i + 1;
      continue;
    }
    if (c === ':' && depth && colon < 0) {
      const candidate = text
        .slice(start, i)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .trim();
      if (
        /^--?[A-Za-z][A-Za-z0-9-]*$|^[A-Za-z][A-Za-z0-9-]*$/.test(candidate)
      ) {
        property = candidate;
        colon = i;
      }
      continue;
    }
    if (c === ';' || c === '}') {
      if (c === ';' && depth === 0) {
        const dependency = importPath(text.slice(start, i));
        if (dependency !== null) imports.push(dependency);
      }
      if (
        depth &&
        colon < 0 &&
        text
          .slice(start, i)
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .trim()
      )
        throw new TokenError('CSS_SYNTAX');
      if (colon >= 0) {
        out.push({
          property,
          value: text
            .slice(colon + 1, i)
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .trim(),
          ...location(text, declarationStart(text, start, colon)),
        });
        colon = -1;
        property = '';
      }
      if (c === '}' && --depth < 0) throw new TokenError('CSS_SYNTAX');
      start = i + 1;
      continue;
    }
    if (c === '{' && colon >= 0) throw new TokenError('CSS_SYNTAX');
  }
  if (
    comment ||
    quote ||
    paren ||
    depth ||
    colon >= 0 ||
    text
      .slice(start)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .trim()
  )
    throw new TokenError('CSS_SYNTAX');
  return { declarations: out, imports, comments };
}
export function cssDeclarations(text: string): Declaration[] {
  return parsedCss(text).declarations;
}
export function cssStylesheetImports(text: string): string[] {
  return parsedCss(text).imports;
}
const node = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const name = (value: unknown): string | null => {
  const n = node(value);
  return n?.type === 'Identifier' || n?.type === 'JSXIdentifier'
    ? String(n.name)
    : n?.type === 'StringLiteral'
      ? String(n.value)
      : null;
};
/** Static stylesheet imports from the same Babel syntax used for converted components. */
export function importedStylesheets(text: string): string[] {
  if (Buffer.byteLength(text) > 1_048_576) throw new TokenError('LINT_SIZE');
  try {
    const tree = parse(text, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    });
    return tree.program.body.flatMap((statement) =>
      statement.type === 'ImportDeclaration' &&
      /\.css(?:[?#]|$)/i.test(statement.source.value)
        ? [statement.source.value]
        : [],
    );
  } catch (error) {
    if (error instanceof TokenError) throw error;
    throw new TokenError('JS_SYNTAX');
  }
}
/** Actual one-line comments only; attachment/usage is validated against issue lines by the caller. */
export function inlineEscapeLines(
  file: string,
  text: string,
): Map<number, string> {
  let comments: SourceComment[];
  if (file.endsWith('.css')) comments = parsedCss(text).comments;
  else {
    try {
      const tree = parse(text, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx'],
      });
      comments = (tree.comments ?? []).map((comment) => ({
        text: comment.value,
        line: comment.loc?.start.line ?? 1,
        endLine: comment.loc?.end.line ?? 1,
        kind: comment.type,
      }));
    } catch {
      throw new TokenError('JS_SYNTAX');
    }
  }
  const lines = new Map<number, string>();
  for (const comment of comments) {
    const value = comment.text.trim();
    if (!value.startsWith('token-lint-disable')) continue;
    const match = /^token-lint-disable-line:\s*(\S[^\r\n]*)$/.exec(value);
    if (
      !match ||
      comment.line !== comment.endLine ||
      !['css', 'CommentLine'].includes(comment.kind) ||
      lines.has(comment.line)
    )
      throw new TokenError('INLINE_ESCAPE');
    lines.set(comment.line, match[1].trim());
  }
  return lines;
}
/** Fail-closed literal object subset; see tools/token-lint.md. No binding/type/alias inference. */
export function inlineDeclarations(text: string): Declaration[] {
  if (Buffer.byteLength(text) > 1_048_576) throw new TokenError('LINT_SIZE');
  let tree: unknown;
  try {
    tree = parse(text, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    });
  } catch {
    throw new TokenError('JS_SYNTAX');
  }
  const out: Declaration[] = [];
  const issue = (value: unknown): void => {
    const loc = node(node(node(value)?.loc)?.start);
    out.push({
      property: 'style',
      value: null,
      line: Number(loc?.line ?? 1),
      column: Number(loc?.column ?? 0),
    });
  };
  const scalar = (value: unknown): string | number | null => {
    const n = node(value);
    return n?.type === 'StringLiteral'
      ? String(n.value)
      : n?.type === 'NumericLiteral'
        ? Number(n.value)
        : null;
  };
  const staticKey = (value: unknown): string | null => {
    const n = node(value);
    return n && !n.computed ? name(n.key) : null;
  };
  const styles = (value: unknown): void => {
    const n = node(value);
    if (n?.type !== 'ObjectExpression' || !Array.isArray(n.properties)) {
      issue(value);
      return;
    }
    for (const raw of n.properties) {
      const p = node(raw),
        key = staticKey(p),
        loc = node(node(p?.loc)?.start);
      if (p?.type !== 'ObjectProperty' || key === null) {
        issue(raw);
        continue;
      }
      out.push({
        property: key,
        value: scalar(p.value),
        line: Number(loc?.line ?? 1),
        column: Number(loc?.column ?? 0),
      });
    }
  };
  const props = (value: unknown): void => {
    const n = node(value);
    if (n?.type !== 'ObjectExpression' || !Array.isArray(n.properties)) {
      issue(value);
      return;
    }
    for (const raw of n.properties) {
      const p = node(raw),
        key = staticKey(p);
      if (key === null || p?.type === 'SpreadElement') {
        issue(raw);
        continue;
      }
      if (key === 'style') {
        if (p?.type !== 'ObjectProperty') issue(raw);
        else styles(p.value);
      }
    }
  };
  let budget = 100_000;
  const walk = (value: unknown): void => {
    if (--budget < 0) throw new TokenError('AST_BOUNDS');
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const n = node(value);
    if (!n) return;
    if (n.type === 'JSXAttribute' && name(n.name) === 'style') {
      const expression = node(n.value)?.expression;
      if (expression) styles(expression);
      else issue(n);
    }
    if (n.type === 'JSXSpreadAttribute') props(n.argument);
    if (
      n.type === 'VariableDeclarator' &&
      /^(?:style|styles|[A-Za-z]+Style)$/.test(name(n.id) ?? '')
    )
      styles(n.init);
    if (n.type === 'AssignmentExpression') {
      const left = node(n.left),
        object = node(left?.object);
      if (
        left?.type === 'MemberExpression' &&
        object?.type === 'MemberExpression' &&
        name(object.property) === 'style'
      ) {
        const loc = node(node(n.loc)?.start),
          key = !left.computed ? name(left.property) : null;
        out.push({
          property: key ?? 'style',
          value: scalar(n.right),
          line: Number(loc?.line ?? 1),
          column: Number(loc?.column ?? 0),
        });
      }
    }
    for (const [key, item] of Object.entries(n))
      if (!['loc', 'start', 'end', 'comments', 'extra'].includes(key))
        walk(item);
  };
  walk(tree);
  return out;
}
