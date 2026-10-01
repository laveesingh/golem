import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
export function writeHtmlMutant(fixture) {
  const source = fs.readFileSync(
    path.join(fixture.root, 'html-body.js'),
    'utf8',
  );
  assert.ok(source.includes('if (DROP_WITH_CONTENT.has(tag)) return null;'));
  const mutant = source
    .replace(
      'if (DROP_WITH_CONTENT.has(tag)) return null;',
      'if (false) return null;',
    )
    .replace(
      'if (UNWRAP.has(tag) || !ALLOWED_TAGS.has(tag)) {',
      "if (tag === 'script') { node.childNodes = node.childNodes ?? []; return node; }\n    if (UNWRAP.has(tag) || !ALLOWED_TAGS.has(tag)) {",
    );
  assert.notEqual(mutant, source);
  fs.writeFileSync(fixture.mutantPath, mutant, { flag: 'wx' });
}
export function createHtmlMutationFixture() {
  const owner = process.env.GOLEM_W2_SANDBOX;
  if (!owner || !fs.existsSync(owner))
    throw Error('HTML mutation requires an explicit owned adapter sandbox');
  const root = fs.mkdtempSync(path.join(owner, 'html-mutation-'));
  const fixture = { root, mutantPath: path.join(root, '.gol343-mutant.mjs') };
  try {
    // Complete module/dependency graph: html-body -> body-anchor + parse5 ->
    // entities. Copy parse5's nested dependencies too; never borrow checkout
    // imports or create mutation files next to production source.
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    for (const file of ['html-body.js', 'body-anchor.js'])
      fs.copyFileSync(
        path.join(sourceRoot, 'dashboard/server', file),
        path.join(root, file),
      );
    fs.mkdirSync(path.join(root, 'node_modules'));
    for (const dependency of ['parse5', 'entities'])
      fs.cpSync(
        path.join(sourceRoot, 'node_modules', dependency),
        path.join(root, 'node_modules', dependency),
        { recursive: true },
      );
    writeHtmlMutant(fixture);
    return fixture;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
