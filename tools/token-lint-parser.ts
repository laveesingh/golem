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
function parsedCss(text: string): {
  declarations: Declaration[];
  imports: string[];
} {
  if (Buffer.byteLength(text) > 1_048_576) throw new TokenError('LINT_SIZE');
  const out: Declaration[] = [],
    imports: string[] = [];
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
  return { declarations: out, imports };
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
    bindings = new Map<string, unknown[]>(),
    unsafeBindings = new Set<string>(),
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
    if (Array.isArray(n.params))
      for (const parameter of n.params) {
        const parameterName = name(parameter);
        if (parameterName) unsafeBindings.add(parameterName);
      }
    if (n.type !== 'VariableDeclaration' || !Array.isArray(n.declarations))
      return;
    for (const item of n.declarations) {
      const declaration = node(item),
        key = name(declaration?.id);
      if (!key) continue;
      if (n.kind !== 'const' || bindings.has(key)) unsafeBindings.add(key);
      bindings.set(key, [...(bindings.get(key) ?? []), declaration?.init]);
    }
  });
  const rootBinding = (value: unknown): string | null => {
    const n = node(value);
    return n?.type === 'Identifier'
      ? String(n.name)
      : n?.type === 'MemberExpression'
        ? rootBinding(n.object)
        : null;
  };
  budget = 100_000;
  walk(tree, (n) => {
    const target =
      n.type === 'AssignmentExpression'
        ? n.left
        : n.type === 'UpdateExpression'
          ? n.argument
          : n.type === 'UnaryExpression' && n.operator === 'delete'
            ? n.argument
            : null;
    const key = rootBinding(target);
    if (key) {
      unsafeBindings.add(key);
      const left = node(target);
      if (n.type === 'AssignmentExpression' && left?.type === 'Identifier')
        bindings.set(key, [...(bindings.get(key) ?? []), n.right]);
      let member = left;
      while (member?.type === 'MemberExpression') {
        if (name(member.property) === 'style') {
          bindings.set(key, [
            ...(bindings.get(key) ?? []),
            {
              type: 'ObjectExpression',
              properties: [
                {
                  type: 'ObjectProperty',
                  key: { type: 'Identifier', name: 'style' },
                  value: null,
                },
              ],
            },
          ]);
          break;
        }
        member = node(member.object);
      }
    }
    if (n.type === 'CallExpression' && Array.isArray(n.arguments))
      for (const argument of n.arguments) {
        const argumentKey = rootBinding(argument);
        if (argumentKey) unsafeBindings.add(argumentKey);
      }
  });
  // A direct alias does not make a mutable object immutable.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, candidates] of bindings)
      for (const candidate of candidates) {
        const alias =
          node(candidate)?.type === 'Identifier' ? name(candidate) : null;
        if (alias && (unsafeBindings.has(key) || unsafeBindings.has(alias))) {
          for (const target of [key, alias])
            if (!unsafeBindings.has(target)) {
              unsafeBindings.add(target);
              changed = true;
            }
        }
      }
  }
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
  const propertyKey = (
    key: unknown,
    computed: unknown,
  ): { name: string | null; known: boolean } => {
    if (!computed || node(key)?.type === 'StringLiteral')
      return { name: name(key), known: true };
    const identifier = name(key),
      candidates = identifier ? bindings.get(identifier) : undefined;
    const value = candidates?.length === 1 ? scalar(candidates[0]) : null;
    return {
      name:
        typeof value === 'string'
          ? value
          : identifier === 'style'
            ? 'style'
            : null,
      known: typeof value === 'string' && !unsafeBindings.has(identifier ?? ''),
    };
  };
  const members = (
    value: unknown,
    key: string,
    seen = new Set<unknown>(),
    depth = 0,
  ): unknown[] => {
    if (depth > 64) throw new TokenError('AST_BOUNDS');
    const n = node(value);
    if (!n || seen.has(n)) return [];
    seen = new Set(seen);
    seen.add(n);
    if (n.type === 'Identifier')
      return (bindings.get(String(n.name)) ?? []).flatMap((candidate) =>
        members(candidate, key, seen, depth + 1),
      );
    if (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression')
      return members(n.expression, key, seen, depth + 1);
    if (n.type === 'MemberExpression') {
      const selected = propertyKey(n.property, n.computed).name;
      return selected
        ? members(n.object, selected, seen, depth + 1).flatMap((candidate) =>
            members(candidate, key, seen, depth + 1),
          )
        : [];
    }
    if (n.type !== 'ObjectExpression' || !Array.isArray(n.properties))
      return [];
    return n.properties.flatMap((raw) => {
      const p = node(raw);
      if (p?.type === 'SpreadElement')
        return members(p.argument, key, seen, depth + 1);
      return propertyKey(p?.key, p?.computed).name === key &&
        p?.type === 'ObjectProperty'
        ? [p.value]
        : [];
    });
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
      const candidates = bindings.get(key);
      if (unsafeBindings.has(key) || candidates?.length !== 1) {
        out.push({ property: 'style', value: null, line: 1, column: 0 });
      } else extract(candidates[0], seen);
      return;
    }
    if (n.type === 'MemberExpression') {
      const selected = propertyKey(n.property, n.computed),
        key = rootBinding(n),
        values = selected.name ? members(n.object, selected.name) : [];
      if (
        !selected.known ||
        !key ||
        unsafeBindings.has(key) ||
        values.length !== 1
      )
        out.push({ property: 'style', value: null, line: 1, column: 0 });
      else extract(values[0], seen);
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
      const spread = node(raw);
      if (spread?.type === 'SpreadElement') {
        extract(spread.argument, new Set(seen));
        continue;
      }
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
  // Inspect only visible style-bearing props. Opaque ordinary prop spreads are not a style policy.
  let visibleStyles = 0,
    cyclicProps = 0;
  const props = (
    value: unknown,
    seen = new Set<unknown>(),
    depth = 0,
  ): void => {
    if (depth > 64) throw new TokenError('AST_BOUNDS');
    const n = node(value);
    if (!n) return;
    if (seen.has(n)) {
      cyclicProps++;
      return;
    }
    seen = new Set(seen);
    seen.add(n);
    if (n.type === 'Identifier') {
      const key = String(n.name),
        before = visibleStyles;
      for (const candidate of bindings.get(key) ?? [])
        props(candidate, seen, depth + 1);
      if (unsafeBindings.has(key) && visibleStyles > before)
        out.push({ property: 'style', value: null, line: 1, column: 0 });
      return;
    }
    if (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression') {
      props(n.expression, seen, depth + 1);
      return;
    }
    if (n.type === 'MemberExpression') {
      const selected = propertyKey(n.property, n.computed),
        key = rootBinding(n),
        before = visibleStyles;
      for (const candidate of selected.name
        ? members(n.object, selected.name)
        : [])
        props(candidate, seen, depth + 1);
      if (
        visibleStyles > before &&
        (!selected.known || (key && unsafeBindings.has(key)))
      )
        out.push({ property: 'style', value: null, line: 1, column: 0 });
      return;
    }
    if (n.type === 'ConditionalExpression') {
      props(n.consequent, seen, depth + 1);
      props(n.alternate, seen, depth + 1);
      return;
    }
    if (n.type === 'LogicalExpression') {
      props(n.left, seen, depth + 1);
      props(n.right, seen, depth + 1);
      return;
    }
    if (n.type !== 'ObjectExpression' || !Array.isArray(n.properties)) return;
    for (const raw of n.properties) {
      const p = node(raw);
      if (p?.type === 'SpreadElement') props(p.argument, seen, depth + 1);
      else if (propertyKey(p?.key, p?.computed).name === 'style') {
        visibleStyles++;
        const computedUnknown = !propertyKey(p?.key, p?.computed).known;
        extract(
          p?.type === 'ObjectProperty' && !computedUnknown ? p.value : null,
        );
      }
    }
  };
  budget = 100_000;
  walk(tree, (n) => {
    if (n.type === 'JSXSpreadAttribute') {
      const visible = visibleStyles,
        cycles = cyclicProps;
      props(n.argument);
      if (visibleStyles > visible && cyclicProps > cycles)
        out.push({ property: 'style', value: null, line: 1, column: 0 });
    }
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
