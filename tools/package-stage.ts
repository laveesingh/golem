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
  const rootIdentity = owned(root);
  const dashboard = path.join(root, 'dashboard');
  const dashboardIdentity = owned(dashboard);
  const originalOutputs = [
    {
      target: path.join(root, 'dist'),
      old: present(path.join(root, 'dist'))
        ? owned(path.join(root, 'dist'))
        : undefined,
    },
    {
      target: path.join(dashboard, 'dist'),
      old: present(path.join(dashboard, 'dist'))
        ? owned(path.join(dashboard, 'dist'))
        : undefined,
    },
  ];
  const sourceTokens = path.join(root, 'dashboard/web/src/ui/tokens');
  if (packagedTokenRoot(sourceTokens))
    throw new TokenError('PACKAGED_BUILD_INPUT');
  const snapshot = checkTokenFreshness(sourceTokens);
  const lock = path.join(root, '.golem-package.lock');
  const fd = fs.openSync(lock, 'wx', 0o600),
    lockIdentity = fs.fstatSync(fd);
  let stage = '',
    stageIdentity: fs.Stats | undefined;
  let retain = false;
  let failure: unknown;
  const outputs: Array<{
    source: string;
    target: string;
    previous: string;
    old?: fs.Stats;
    next: fs.Stats;
    movedOld: boolean;
    movedNext: boolean;
  }> = [];
  const captured = (
    file: string,
    identity: fs.Stats | undefined,
    label: string,
  ) => {
    if (!identity) {
      if (present(file))
        throw Error(
          `package ${label} identity changed: expected absence; retain ${file}`,
        );
      return;
    }
    const current = identity.isDirectory() ? owned(file) : fs.lstatSync(file);
    if (
      !same(identity, current) ||
      current.uid !== process.getuid?.() ||
      current.mode & 0o022
    )
      throw Error(`package ${label} identity changed; retain ${file}`);
  };
  const governing = () => {
    captured(root, rootIdentity, 'root');
    captured(dashboard, dashboardIdentity, 'dashboard parent');
    captured(lock, lockIdentity, 'lock');
    if (stageIdentity) captured(stage, stageIdentity, 'stage');
  };
  const states = () => {
    for (const row of outputs) {
      captured(
        row.source,
        row.movedNext ? undefined : row.next,
        'staged output',
      );
      captured(
        row.target,
        row.movedNext ? row.next : row.movedOld ? undefined : row.old,
        'prior/output destination',
      );
      captured(
        row.previous,
        row.movedOld ? row.old : undefined,
        'prior backup',
      );
    }
  };
  // Fences use only allocated/captured identities and known path transitions.
  // They never fresh-stat a replacement and turn it into publication authority.
  const fence = () => {
    try {
      governing();
      states();
    } catch (error) {
      retain = true;
      throw error;
    }
  };
  try {
    governing();
    stage = fs.mkdtempSync(path.join(root, '.golem-package-stage-'));
    stageIdentity = owned(stage);
    const runtime = path.join(stage, 'runtime'),
      web = path.join(stage, 'web');
    fs.mkdirSync(runtime, { mode: 0o755 });
    fs.mkdirSync(web, { mode: 0o755 });
    outputs.push(
      {
        ...originalOutputs[0],
        source: runtime,
        previous: path.join(stage, 'previous-runtime'),
        next: owned(runtime),
        movedOld: false,
        movedNext: false,
      },
      {
        ...originalOutputs[1],
        source: web,
        previous: path.join(stage, 'previous-web'),
        next: owned(web),
        movedOld: false,
        movedNext: false,
      },
    );
    fence();
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
      fence();
      const result = childProcess.spawnSync(process.execPath, [...args], {
        cwd: root,
        stdio: 'inherit',
        timeout: 120000,
      });
      if (result.error || result.status !== 0) {
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
      fence();
    }
    fence();
    fs.mkdirSync(path.join(runtime, 'mcp/channel'), {
      recursive: true,
      mode: 0o755,
    });
    for (const name of ['package.json', 'package-lock.json']) {
      fence();
      copyFile(
        path.join(root, 'mcp/channel', name),
        path.join(runtime, 'mcp/channel', name),
      );
    }
    checkTokenFreshness(path.join(assets, 'dashboard/web/src/ui/tokens'));
    for (const row of outputs) {
      if (row.old) {
        fence();
        fs.renameSync(row.target, row.previous);
        row.movedOld = true;
      }
      fence();
      fs.renameSync(row.source, row.target);
      row.movedNext = true;
    }
    fence();
  } catch (error) {
    failure = error;
    // No transition means no rollback side effect is needed or authorized.
    // Compiler+cleanup aggregation remains intact for lost prepublication scope.
    if (outputs.some((row) => row.movedOld || row.movedNext)) {
      try {
        for (const row of [...outputs].reverse()) {
          if (row.movedNext) {
            fence();
            fs.renameSync(row.target, row.source);
            row.movedNext = false;
          }
          if (row.movedOld) {
            fence();
            fs.renameSync(row.previous, row.target);
            row.movedOld = false;
          }
        }
      } catch (rollback) {
        retain = true;
        failure = new AggregateError(
          [error, rollback],
          `package rollback indeterminate; retained ${stage}`,
        );
      }
    }
  } finally {
    try {
      fs.closeSync(fd);
      if (!retain) {
        fence();
        discardOwnedStage(stage, stageIdentity, lock, lockIdentity);
      }
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
