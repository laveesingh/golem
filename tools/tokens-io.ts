import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Output, Sources } from './tokens-core.ts';
import { buildTokens, strictTokenJson, TokenError } from './tokens-core.ts';

const files = [
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
function ownedDirectory(dir: string): void {
  if (!process.getuid) throw new TokenError('SYMLINK_PLATFORM');
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o022
  )
    throw new TokenError('OUTPUT_OWNERSHIP');
}
function existsNoFollow(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function readBytes(file: string): Buffer {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.size > 1_048_576 ||
      stat.mode & 0o022
    )
      throw new TokenError('FILE_OWNERSHIP');
    const buffer = Buffer.alloc(1_048_577);
    let length = 0;
    while (length < buffer.length) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > 1_048_576) throw new TokenError('INPUT_SIZE');
    return buffer.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}
function readRegular(file: string): string {
  return readBytes(file).toString('utf8');
}
function verifyTokenFonts(root: string): number {
  const dir = path.join(path.dirname(root), 'fonts'),
    inventory = strictTokenJson(readRegular(path.join(dir, 'inventory.json')));
  if (!Array.isArray(inventory) || inventory.length !== 7)
    throw new TokenError('FONT_INVENTORY');
  const names = new Set<string>();
  for (const raw of inventory) {
    const font = raw as {
      file: string;
      bytes: number;
      sha256: string;
      licenseFile: string;
      family: string;
      weight: number;
    };
    if (
      !/^[a-z0-9-]+\.woff2$/.test(font.file) ||
      !/^[-A-Za-z0-9]+\.txt$/.test(font.licenseFile) ||
      names.has(font.file)
    )
      throw new TokenError('FONT_PATH');
    names.add(font.file);
    const bytes = readBytes(path.join(dir, font.file));
    if (
      bytes.subarray(0, 4).toString() !== 'wOF2' ||
      bytes.length !== font.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== font.sha256
    )
      throw new TokenError('FONT_HASH', font.file);
    if (
      !readRegular(path.join(dir, font.licenseFile)).includes(
        'SIL OPEN FONT LICENSE',
      )
    )
      throw new TokenError('FONT_LICENSE', font.file);
  }
  return inventory.length;
}
export function loadTokenSources(root: string): Sources {
  const result: Record<string, unknown> = {};
  for (const name of [
    'primitive',
    'semantic',
    'component',
    'light',
    'dark',
    'cozy',
    'compact',
  ])
    result[name] = strictTokenJson(
      readRegular(path.join(root, 'source', `${name}.tokens.json`)),
    );
  result.pairs = strictTokenJson(
    readRegular(path.join(root, 'contrast-pairs.json')),
  );
  return result as unknown as Sources;
}
function outputFiles(output: Output): Record<string, string> {
  return {
    'tokens.css': output.css,
    'tokens.ts': output.types,
    'contrast.json': output.report,
    'registry.json': JSON.stringify(output.registry, null, 2) + '\n',
  };
}
function generationId(data: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file + '\0' + data[file] + '\0');
  return `g-${hash.digest('hex')}`;
}
function readGeneration(root: string, id: string): Generation {
  if (!/^g-[a-f0-9]{64}$/.test(id)) throw new TokenError('GENERATION_TARGET');
  const parent = path.join(root, '.generations'),
    directory = path.join(parent, id);
  ownedDirectory(root);
  ownedDirectory(parent);
  ownedDirectory(directory);
  if (path.dirname(fs.realpathSync(directory)) !== fs.realpathSync(parent))
    throw new TokenError('GENERATION_TARGET');
  if (
    JSON.stringify(fs.readdirSync(directory).sort()) !==
    JSON.stringify([...files].sort())
  )
    throw new TokenError('GENERATION_CONTENTS');
  const data = Object.fromEntries(
    files.map((file) => [file, readRegular(path.join(directory, file))]),
  );
  if (generationId(data) !== id) throw new TokenError('GENERATION_HASH');
  return { id, directory, files: data };
}
/** Capture pointer exactly once, then read all files from the immutable target. */
export function tokenSnapshot(root: string): Generation {
  ownedDirectory(root);
  const pointer = path.join(root, 'generated'),
    stat = fs.lstatSync(pointer);
  if (!stat.isSymbolicLink() || stat.uid !== process.getuid?.())
    throw new TokenError('POINTER_OWNERSHIP');
  const target = fs.readlinkSync(pointer);
  if (!/^\.generations\/g-[a-f0-9]{64}$/.test(target))
    throw new TokenError('POINTER_TARGET');
  return readGeneration(root, target.slice('.generations/'.length));
}
export function checkTokenFreshness(
  root: string,
  output = buildTokens(loadTokenSources(root)),
): Generation {
  verifyTokenFonts(root);
  const snapshot = tokenSnapshot(root),
    expected = outputFiles(output);
  for (const file of files)
    if (snapshot.files[file] !== expected[file])
      throw new TokenError('STALE', file);
  return snapshot;
}
export function publishTokens(
  root: string,
  source = loadTokenSources(root),
): Generation {
  // All source/alias/type/contrast validation completes before any writes.
  const output = buildTokens(source);
  verifyTokenFonts(root);
  const data = outputFiles(output),
    id = generationId(data);
  for (const value of Object.values(data))
    if (Buffer.byteLength(value) > 1_048_576)
      throw new TokenError('OUTPUT_SIZE');
  ownedDirectory(root);
  const pointer = path.join(root, 'generated'),
    versions = path.join(root, '.generations');
  if (existsNoFollow(pointer)) tokenSnapshot(root);
  if (!fs.existsSync(versions)) fs.mkdirSync(versions, { mode: 0o755 });
  ownedDirectory(versions);
  const lock = path.join(root, '.token-publication.lock'),
    fd = fs.openSync(lock, 'wx', 0o600),
    identity = fs.fstatSync(fd);
  const stage = path.join(versions, `.stage-${randomUUID()}`),
    next = path.join(root, `.pointer-${randomUUID()}`);
  let stageIdentity: fs.Stats | undefined, nextIdentity: fs.Stats | undefined;
  try {
    const destination = path.join(versions, id);
    if (existsNoFollow(destination)) {
      const existing = readGeneration(root, id);
      if (
        Object.entries(data).some(
          ([key, value]) => existing.files[key] !== value,
        )
      )
        throw new TokenError('GENERATION_HASH');
    } else {
      fs.mkdirSync(stage, { mode: 0o755 });
      stageIdentity = fs.lstatSync(stage);
      for (const file of files) {
        const handle = fs.openSync(path.join(stage, file), 'wx', 0o644);
        try {
          fs.writeFileSync(handle, data[file]);
          fs.fsyncSync(handle);
        } finally {
          fs.closeSync(handle);
        }
      }
      fs.renameSync(stage, destination);
      stageIdentity = undefined;
      readGeneration(root, id);
    }
    fs.symlinkSync(`.generations/${id}`, next);
    nextIdentity = fs.lstatSync(next);
    // Revalidate the current path immediately before one atomic publication.
    if (existsNoFollow(pointer)) tokenSnapshot(root);
    fs.renameSync(next, pointer);
    nextIdentity = undefined;
    return readGeneration(root, id);
  } finally {
    if (nextIdentity) {
      const current = fs.lstatSync(next);
      if (
        current.isSymbolicLink() &&
        current.ino === nextIdentity.ino &&
        current.dev === nextIdentity.dev
      )
        fs.unlinkSync(next);
    }
    if (stageIdentity) {
      const current = fs.lstatSync(stage);
      if (
        current.isDirectory() &&
        !current.isSymbolicLink() &&
        current.ino === stageIdentity.ino &&
        current.dev === stageIdentity.dev
      )
        fs.rmSync(stage, { recursive: true });
    }
    fs.closeSync(fd);
    const current = fs.lstatSync(lock);
    if (
      current.isFile() &&
      current.ino === identity.ino &&
      current.dev === identity.dev
    )
      fs.unlinkSync(lock);
  }
}
/** W3 package/build staging: verified snapshot already pinned; regular copies only. */
export function materializeTokens(
  snapshot: Generation,
  destination: string,
): void {
  if (!path.isAbsolute(destination)) throw new TokenError('STAGING_PATH');
  if (generationId(snapshot.files) !== snapshot.id)
    throw new TokenError('GENERATION_HASH');
  ownedDirectory(path.dirname(destination));
  fs.mkdirSync(destination, { mode: 0o755 });
  const identity = fs.lstatSync(destination);
  try {
    for (const file of files)
      fs.writeFileSync(path.join(destination, file), snapshot.files[file], {
        flag: 'wx',
        mode: 0o644,
      });
  } catch (error) {
    const current = fs.lstatSync(destination);
    if (
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    )
      fs.rmSync(destination, { recursive: true });
    throw error;
  }
}
