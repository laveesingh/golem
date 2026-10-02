import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { strictTokenJson, TokenError } from './tokens-core.ts';

export const tokenOutputNames = [
  'tokens.css',
  'tokens.ts',
  'contrast.json',
  'registry.json',
] as const;
export interface Generation {
  id: string;
  directory: string;
  files: Record<string, string>;
}
const marker = 'token-package.json';
const sourceNames = [
  'primitive',
  'semantic',
  'component',
  'light',
  'dark',
  'cozy',
  'compact',
];

export function packagedTokenRoot(root: string): boolean {
  try {
    fs.lstatSync(path.join(root, marker));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** Read-only installed files need not be owned by the current invoking user. */
export function regularTokenDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022)
    throw new TokenError('PACKAGED_DIRECTORY');
}
export function regularTokenBytes(file: string): Buffer {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o022 || stat.size > 1_048_576)
      throw new TokenError('PACKAGED_FILE');
    const bytes = Buffer.alloc(1_048_577);
    let length = 0;
    while (length < bytes.length) {
      const n = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > 1_048_576) throw new TokenError('INPUT_SIZE');
    return bytes.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}
export function tokenGenerationId(data: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const file of tokenOutputNames) hash.update(`${file}\0${data[file]}\0`);
  return `g-${hash.digest('hex')}`;
}
const hashBytes = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');

/** Every path is fixed here or a single safe filename from the font inventory. */
function inputPaths(root: string): string[] {
  regularTokenDirectory(root);
  regularTokenDirectory(path.join(root, 'source'));
  regularTokenDirectory(path.dirname(root));
  const fonts = path.join(path.dirname(root), 'fonts');
  regularTokenDirectory(fonts);
  const inventory = strictTokenJson(
    regularTokenBytes(path.join(fonts, 'inventory.json')).toString('utf8'),
  );
  if (!Array.isArray(inventory) || inventory.length !== 7)
    throw new TokenError('FONT_INVENTORY');
  const names = new Set<string>();
  for (const item of inventory) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new TokenError('FONT_PATH');
    const font = item as { file: string; licenseFile: string };
    if (
      !/^[a-z0-9-]+\.woff2$/.test(font.file) ||
      !/^[-A-Za-z0-9]+\.txt$/.test(font.licenseFile)
    )
      throw new TokenError('FONT_PATH');
    names.add(`../fonts/${font.file}`);
    names.add(`../fonts/${font.licenseFile}`);
  }
  validateCssAssets(root, inventory);
  return [
    ...sourceNames.map((name) => `source/${name}.tokens.json`),
    'contrast-pairs.json',
    'provenance.json',
    'entry.css',
    '../fonts/inventory.json',
    '../fonts/fonts.css',
    ...[...names].sort(),
  ];
}
function validateCssAssets(root: string, inventory: unknown[]): void {
  const clean = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const entry = clean(
    regularTokenBytes(path.join(root, 'entry.css')).toString('utf8'),
  );
  if (
    !/^@import\s+(['"])\.\.\/fonts\/fonts\.css\1;\s*@import\s+(['"])\.\/generated\/tokens\.css\2;\s*$/.test(
      entry,
    )
  )
    throw new TokenError('ENTRY_PATH');
  const css = clean(
    regularTokenBytes(
      path.join(path.dirname(root), 'fonts/fonts.css'),
    ).toString('utf8'),
  );
  const faces = [...css.matchAll(/@font-face\s*\{([^{}]+)\}/g)];
  if (faces.length !== 7 || css.replace(/@font-face\s*\{[^{}]+\}/g, '').trim())
    throw new TokenError('FONT_CSS');
  const observed = new Set<string>();
  for (const face of faces) {
    const family = /font-family\s*:\s*(['"])([^'"]+)\1\s*;/.exec(face[1])?.[2];
    const weight = /font-weight\s*:\s*(\d+)\s*;/.exec(face[1])?.[1];
    const file = /url\(\s*(['"])\.\/([a-z0-9-]+\.woff2)\1\s*\)/.exec(
      face[1],
    )?.[2];
    if (
      !file ||
      observed.has(file) ||
      (face[1].match(/url\s*\(/g) ?? []).length !== 1 ||
      (face[1].match(/font-family\s*:/g) ?? []).length !== 1 ||
      (face[1].match(/font-weight\s*:/g) ?? []).length !== 1 ||
      (face[1].match(/(?:^|;)\s*src\s*:/g) ?? []).length !== 1 ||
      !/font-style\s*:\s*normal\s*;/.test(face[1]) ||
      !/src\s*:\s*url\(\s*(['"])\.\/[a-z0-9-]+\.woff2\1\s*\)\s*format\(\s*(['"])woff2\2\s*\)\s*;/.test(
        face[1],
      ) ||
      !inventory.some((value) => {
        const font = value as { file: string; family: string; weight: number };
        return (
          font.file === file &&
          font.family === family &&
          String(font.weight) === weight
        );
      })
    )
      throw new TokenError('FONT_CSS');
    observed.add(file);
  }
}
function inputHashes(root: string): Record<string, string> {
  return Object.fromEntries(
    inputPaths(root).map((file) => [
      file,
      hashBytes(regularTokenBytes(path.join(root, file))),
    ]),
  );
}
function sameKeys(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}
export function readPackagedTokenSnapshot(root: string): Generation {
  regularTokenDirectory(root);
  const raw = strictTokenJson(
    regularTokenBytes(path.join(root, marker)).toString('utf8'),
  );
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new TokenError('PACKAGED_MANIFEST');
  const manifest = raw as Record<string, unknown>;
  if (manifest.schema_version !== 1) throw new TokenError('PACKAGED_VERSION');
  if (
    !sameKeys(manifest, [
      'schema_version',
      'layout',
      'name',
      'generation_id',
      'outputs',
      'inputs',
    ]) ||
    manifest.layout !== 'regular' ||
    manifest.name !== '@laveesingh/golem' ||
    typeof manifest.generation_id !== 'string' ||
    !/^g-[a-f0-9]{64}$/.test(manifest.generation_id)
  )
    throw new TokenError('PACKAGED_MANIFEST');
  const directory = path.join(root, 'generated');
  regularTokenDirectory(directory);
  if (
    JSON.stringify(fs.readdirSync(directory).sort()) !==
    JSON.stringify([...tokenOutputNames].sort())
  )
    throw new TokenError('PACKAGED_CONTENTS');
  if (!sameKeys(manifest.outputs, [...tokenOutputNames]))
    throw new TokenError('PACKAGED_MANIFEST');
  const data = Object.fromEntries(
    tokenOutputNames.map((file) => [
      file,
      regularTokenBytes(path.join(directory, file)).toString('utf8'),
    ]),
  );
  for (const file of tokenOutputNames)
    if (manifest.outputs[file] !== hashBytes(data[file]))
      throw new TokenError('PACKAGED_HASH', file);
  if (tokenGenerationId(data) !== manifest.generation_id)
    throw new TokenError('GENERATION_HASH');
  const inputs = inputHashes(root);
  if (!sameKeys(manifest.inputs, Object.keys(inputs)))
    throw new TokenError('PACKAGED_MANIFEST');
  for (const [file, hash] of Object.entries(inputs))
    if (manifest.inputs[file] !== hash)
      throw new TokenError('PACKAGED_INPUT_HASH', file);
  return { id: manifest.generation_id, directory, files: data };
}
/** Called only inside a newly allocated owned package stage, never the source. */
export function writePackagedTokenManifest(
  root: string,
  snapshot: Generation,
): void {
  const stat = fs.lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o022
  )
    throw new TokenError('OUTPUT_OWNERSHIP');
  if (tokenGenerationId(snapshot.files) !== snapshot.id)
    throw new TokenError('GENERATION_HASH');
  const outputs = Object.fromEntries(
    tokenOutputNames.map((file) => [file, hashBytes(snapshot.files[file])]),
  );
  fs.writeFileSync(
    path.join(root, marker),
    `${JSON.stringify(
      {
        schema_version: 1,
        layout: 'regular',
        name: '@laveesingh/golem',
        generation_id: snapshot.id,
        outputs,
        inputs: inputHashes(root),
      },
      null,
      2,
    )}\n`,
    { flag: 'wx', mode: 0o644 },
  );
  readPackagedTokenSnapshot(root);
}
