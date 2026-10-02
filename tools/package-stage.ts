import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  cssStylesheetImports,
  importedStylesheets,
} from './token-lint-parser.ts';
import type { Generation } from './token-package.ts';
import {
  packagedTokenRoot,
  regularTokenBytes,
  regularTokenDirectory,
  writePackagedTokenManifest,
} from './token-package.ts';
import { strictTokenJson, TokenError } from './tokens-core.ts';
import { checkTokenFreshness, materializeTokens } from './tokens-io.ts';

function owned(dir: string): fs.Stats {
  regularTokenDirectory(dir);
  const stat = fs.lstatSync(dir);
  if (stat.uid !== process.getuid?.()) throw new TokenError('OUTPUT_OWNERSHIP');
  return stat;
}
function same(a: fs.Stats, b: fs.Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.isDirectory() === b.isDirectory() &&
    a.isFile() === b.isFile() &&
    !b.isSymbolicLink()
  );
}
function present(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function copyFile(source: string, target: string): void {
  const bytes = regularTokenBytes(source);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
}
function confinedFile(root: string, relative: string): string {
  if (
    !relative.startsWith('dashboard/web/') ||
    relative.split('/').includes('..') ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    path.isAbsolute(relative)
  )
    throw new TokenError('PACKAGE_INPUT_PATH');
  const parts = relative.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    regularTokenDirectory(current);
  }
  const file = path.join(root, relative);
  if (
    !fs
      .realpathSync(file)
      .startsWith(fs.realpathSync(path.join(root, 'dashboard/web')) + path.sep)
  )
    throw new TokenError('PACKAGE_INPUT_PATH');
  return file;
}
/** Copy only published UI inputs and the explicit confined stylesheet closure. */
export function stageTokenAssets(
  root: string,
  destination: string,
  snapshot: Generation,
): void {
  owned(destination);
  const ui = 'dashboard/web/src/ui',
    tokens = `${ui}/tokens`;
  const files: string[] = [];
  const walk = (relative: string) => {
    const source = path.join(root, relative);
    regularTokenDirectory(source);
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (
        name === `${tokens}/generated` ||
        name === `${tokens}/.generations` ||
        entry.name === 'README.md'
      )
        continue;
      if (entry.isSymbolicLink()) throw new TokenError('PACKAGE_INPUT_PATH');
      if (entry.isDirectory()) walk(name);
      else if (/\.(?:css|js|jsx|ts|tsx|json|woff2|txt|svg)$/.test(entry.name))
        files.push(name);
      else throw new TokenError('PACKAGE_INPUT_PATH');
      if (files.length > 10000) throw new TokenError('PACKAGE_INPUT_BOUNDS');
    }
  };
  walk(ui);
  const scopeFile = path.join(root, 'tools/token-lint-scope.json');
  const scope = strictTokenJson(
    regularTokenBytes(scopeFile).toString('utf8'),
  ) as {
    converted: string[];
    exceptions: unknown[];
  };
  if (!Array.isArray(scope.converted) || !Array.isArray(scope.exceptions))
    throw new TokenError('LINT_SCOPE');
  for (const file of scope.converted) {
    if (typeof file !== 'string' || !/\.(?:css|js|jsx|ts|tsx)$/.test(file))
      throw new TokenError('LINT_SCOPE');
    confinedFile(root, file);
    files.push(file);
  }
  const pending = [...new Set(files)];
  for (let i = 0; i < pending.length; i++) {
    if (pending.length > 10000) throw new TokenError('PACKAGE_INPUT_BOUNDS');
    const file = pending[i];
    if (
      !/\.(?:css|js|jsx|ts|tsx)$/.test(file) ||
      file.startsWith(`${tokens}/source/`) ||
      file.startsWith(`${ui}/fonts/`) ||
      file === 'dashboard/web/extra.css'
    )
      continue;
    const text = regularTokenBytes(confinedFile(root, file)).toString('utf8');
    for (const specifier of file.endsWith('.css')
      ? cssStylesheetImports(text)
      : importedStylesheets(text)) {
      if (
        (!file.endsWith('.css') && !specifier.startsWith('.')) ||
        !specifier.endsWith('.css') ||
        /[?#\\\s:*]/.test(specifier) ||
        path.isAbsolute(specifier)
      )
        throw new TokenError('LINT_IMPORT_PATH');
      const relative = path
        .relative(root, path.resolve(root, path.dirname(file), specifier))
        .split(path.sep)
        .join('/');
      if (!relative.startsWith('dashboard/web/'))
        throw new TokenError('LINT_IMPORT_PATH');
      if (relative.startsWith(`${tokens}/generated/`)) continue; // pinned bytes, not source pointer reads
      confinedFile(root, relative);
      if (!pending.includes(relative)) pending.push(relative);
    }
  }
  for (const file of pending) {
    if (file === 'dashboard/web/extra.css') continue;
    copyFile(confinedFile(root, file), path.join(destination, file));
  }
  copyFile(scopeFile, path.join(destination, 'tools/token-lint-scope.json'));
  const tokenRoot = path.join(destination, tokens);
  materializeTokens(snapshot, path.join(tokenRoot, 'generated'));
  writePackagedTokenManifest(tokenRoot, snapshot);
  checkTokenFreshness(tokenRoot);
}

function discardOwnedStage(
  stage: string,
  identity: fs.Stats | undefined,
  lock: string,
  lockIdentity: fs.Stats,
): void {
  if (!same(lockIdentity, fs.lstatSync(lock)))
    throw Error(`package lock identity changed; retain ${lock}`);
  if (identity && stage) {
    if (!same(identity, owned(stage)))
      throw Error(`package stage identity changed; retain ${stage}`);
    fs.rmSync(stage, { recursive: true });
  }
  if (!same(lockIdentity, fs.lstatSync(lock)))
    throw Error(`package lock identity changed; retain ${lock}`);
  fs.unlinkSync(lock);
}

/** No output publication occurs until all input/build/stage checks have passed. */
export function buildPackage(root: string): void {
  owned(root);
  const sourceTokens = path.join(root, 'dashboard/web/src/ui/tokens');
  if (packagedTokenRoot(sourceTokens))
    throw new TokenError('PACKAGED_BUILD_INPUT');
  const snapshot = checkTokenFreshness(sourceTokens); // ONE immutable source pointer capture
  const lock = path.join(root, '.golem-package.lock');
  const fd = fs.openSync(lock, 'wx', 0o600),
    lockIdentity = fs.fstatSync(fd);
  let stage = '',
    stageIdentity: fs.Stats | undefined;
  let retain = false;
  let failure: unknown;
  const published: Array<{
    target: string;
    previous: string;
    old?: fs.Stats;
    next: fs.Stats;
    movedOld: boolean;
    movedNext: boolean;
  }> = [];
  try {
    stage = fs.mkdtempSync(path.join(root, '.golem-package-stage-'));
    stageIdentity = owned(stage);
    const runtime = path.join(stage, 'runtime'),
      web = path.join(stage, 'web');
    fs.mkdirSync(runtime, { mode: 0o755 });
    const assets = path.join(runtime, 'assets');
    fs.mkdirSync(assets, { mode: 0o755 });
    stageTokenAssets(root, assets, snapshot);
    for (const [label, args] of [
      ['strict', ['node_modules/typescript/bin/tsc', '--noEmit']],
      [
        'emit',
        [
          'node_modules/typescript/bin/tsc',
          '-p',
          'tsconfig.emit.json',
          '--outDir',
          runtime,
        ],
      ],
      [
        'web',
        [
          'node_modules/vite/bin/vite.js',
          'build',
          '--config',
          'dashboard/vite.config.js',
          '--outDir',
          web,
        ],
      ],
    ] as const) {
      const result = childProcess.spawnSync(process.execPath, [...args], {
        cwd: root,
        stdio: 'inherit',
        timeout: 120000,
      });
      if (result.error || result.status !== 0) {
        // A deadline/signal leaves descendant cleanup indeterminate. Retain
        // stage+lock evidence rather than deleting a possibly active writer.
        if (
          (result.error as NodeJS.ErrnoException | undefined)?.code ===
            'ETIMEDOUT' ||
          result.signal
        )
          retain = true;
        throw Error(
          `package ${label} failed: ${result.error?.message ?? result.status}`,
        );
      }
    }
    fs.mkdirSync(path.join(runtime, 'mcp/channel'), {
      recursive: true,
      mode: 0o755,
    });
    for (const name of ['package.json', 'package-lock.json'])
      copyFile(
        path.join(root, 'mcp/channel', name),
        path.join(runtime, 'mcp/channel', name),
      );
    checkTokenFreshness(path.join(assets, 'dashboard/web/src/ui/tokens'));
    for (const [next, target, previousName] of [
      [runtime, path.join(root, 'dist'), 'previous-runtime'],
      [web, path.join(root, 'dashboard/dist'), 'previous-web'],
    ]) {
      owned(path.dirname(target));
      const row = {
        target,
        previous: path.join(stage, previousName),
        old: present(target) ? owned(target) : undefined,
        next: owned(next),
        movedOld: false,
        movedNext: false,
      };
      published.push(row);
      if (row.old) {
        if (!same(row.old, fs.lstatSync(target)))
          throw Error('package output identity changed before replacement');
        fs.renameSync(target, row.previous);
        row.movedOld = true;
      }
      fs.renameSync(next, target);
      row.movedNext = true;
    }
  } catch (error) {
    failure = error;
    try {
      for (const row of [...published].reverse()) {
        if (row.movedNext) {
          if (!same(row.next, fs.lstatSync(row.target)))
            throw Error('package rollback output identity changed');
          fs.renameSync(
            row.target,
            path.join(stage, `failed-${path.basename(row.previous)}`),
          );
        }
        if (row.movedOld) {
          if (
            !row.old ||
            !same(row.old, fs.lstatSync(row.previous)) ||
            present(row.target)
          )
            throw Error('package rollback prior identity changed');
          fs.renameSync(row.previous, row.target);
        }
      }
    } catch (rollback) {
      retain = true;
      failure = new AggregateError(
        [error, rollback],
        `package rollback indeterminate; retained ${stage}`,
      );
    }
  } finally {
    try {
      fs.closeSync(fd);
      if (!retain) discardOwnedStage(stage, stageIdentity, lock, lockIdentity);
    } catch (cleanup) {
      retain = true;
      failure = failure
        ? new AggregateError(
            [failure, cleanup],
            `package cleanup indeterminate; retained ${stage}`,
          )
        : cleanup;
    }
    if (retain) console.error(`Package evidence retained: ${stage}; ${lock}`);
  }
  if (failure) throw failure;
  console.log(
    `Package emitted: pinned regular ${snapshot.id}, mirrored JS/maps, MCP manifests and staged web assets`,
  );
}
