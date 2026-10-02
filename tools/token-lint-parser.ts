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
/** Lex declarations with comments/quotes/functions/nested blocks; never regex file prose. */
export function cssDeclarations(text: string): Declaration[] {
  if (Buffer.byteLength(text) > 1_048_576) throw new TokenError('LINT_SIZE');
  const out: Declaration[] = [];
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
          ...location(text, start),
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
  return out;
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
  const out: Declaration[] = [],
    bindings = new Map<string, unknown>(),
    styleObjects = new Set<unknown>();
  let budget = 100_000;
  const walk = (
    value: unknown,
    callback: (n: Record<string, unknown>) => void,
  ): void => {
    if (--budget < 0) throw new TokenError('AST_BOUNDS');
    if (Array.isArray(value)) {
      for (const item of value) walk(item, callback);
      return;
    }
    const n = node(value);
    if (!n) return;
    callback(n);
    for (const [key, item] of Object.entries(n))
      if (!['loc', 'start', 'end', 'comments', 'extra'].includes(key))
        walk(item, callback);
  };
  walk(tree, (n) => {
    if (n.type === 'VariableDeclarator' && name(n.id)) {
      const key = name(n.id) ?? '';
      if (bindings.has(key)) bindings.set(key, null);
      else bindings.set(key, n.init);
    }
  });
  const scalar = (value: unknown): string | number | null => {
    const n = node(value);
    if (!n) return null;
    if (n.type === 'StringLiteral') return String(n.value);
    if (n.type === 'NumericLiteral') return Number(n.value);
    if (
      n.type === 'TemplateLiteral' &&
      Array.isArray(n.expressions) &&
      n.expressions.length === 0
    ) {
      const q = node((n.quasis as unknown[])?.[0]);
      return String(node(q?.value)?.cooked ?? '');
    }
    return null;
  };
  const extract = (value: unknown, seen = new Set<string>()): void => {
    const n = node(value);
    if (!n) {
      out.push({ property: 'style', value: null, line: 1, column: 0 });
      return;
    }
    if (n.type === 'Identifier') {
      const key = String(n.name);
      if (seen.has(key)) {
        out.push({ property: 'style', value: null, line: 1, column: 0 });
        return;
      }
      seen.add(key);
      extract(bindings.get(key), seen);
      return;
    }
    if (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression') {
      extract(n.expression, seen);
      return;
    }
    if (n.type !== 'ObjectExpression' || !Array.isArray(n.properties)) {
      const loc = node(node(n.loc)?.start);
      out.push({
        property: 'style',
        value: null,
        line: Number(loc?.line ?? 1),
        column: Number(loc?.column ?? 0),
      });
      return;
    }
    if (styleObjects.has(n)) return;
    styleObjects.add(n);
    for (const raw of n.properties) {
      const p = node(raw),
        property = p && !p.computed ? name(p.key) : null,
        loc = node(node(p?.loc)?.start);
      out.push({
        property: property ?? 'style',
        value: p?.type === 'ObjectProperty' ? scalar(p.value) : null,
        line: Number(loc?.line ?? 1),
        column: Number(loc?.column ?? 0),
      });
    }
  };
  budget = 100_000;
  walk(tree, (n) => {
    if (n.type === 'JSXAttribute' && name(n.name) === 'style')
      extract(node(n.value)?.expression);
    if (
      n.type === 'VariableDeclarator' &&
      /^(?:style|styles|[A-Za-z]+Style)$/.test(name(n.id) ?? '')
    )
      extract(n.init);
    if (n.type === 'AssignmentExpression') {
      const left = node(n.left),
        object = node(left?.object);
      if (
        left?.type === 'MemberExpression' &&
        object?.type === 'MemberExpression' &&
        name(object.property) === 'style'
      ) {
        const loc = node(node(n.loc)?.start);
        out.push({
          property: name(left.property) ?? 'style',
          value: scalar(n.right),
          line: Number(loc?.line ?? 1),
          column: Number(loc?.column ?? 0),
        });
      }
    }
  });
  return out;
}
