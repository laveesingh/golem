import fs from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { sha256 } from './engine.js';
import type { BuildContext, RenderItem } from './render-types.ts';
import { runtimeSource } from './runtime-source.ts';

/** Bundle before planning: the content hash includes the entire dependency closure. */
export function channelBundle(repoRoot: string): RenderItem {
  const result = buildSync({
    absWorkingDir: repoRoot,
    entryPoints: [runtimeSource(repoRoot, 'mcp/channel/index.js')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    outfile: 'index.js',
    legalComments: 'inline',
    // CJS dependencies may require Node builtins; no packages remain external.
    banner: {
      js: "import { createRequire as __golemCreateRequire } from 'node:module'; const require = __golemCreateRequire(import.meta.url);",
    },
  });
  const code = result.outputFiles[0]?.text;
  if (!code) throw Error('channel bundle produced no output');
  return {
    key: 'mcp/channel/index.js',
    outputRelPath: 'mcp/channel/index.js',
    sourceSha256: sha256(code),
    build: () => code,
  };
}

/** Retire the untracked dependency tree written by the previous renderer. Runs only on a clean render so a tampered output is never partially mutated. */
export function pruneLegacyChannelDeps({
  outDir,
  tampered,
}: {
  outDir: string;
  tampered: unknown[];
}): void {
  if (tampered.length !== 0) return;
  fs.rmSync(path.join(outDir, 'mcp', 'channel', 'node_modules'), {
    recursive: true,
    force: true,
  });
}

export function channelManifest({ packageVersion }: BuildContext): RenderItem {
  const text = `${JSON.stringify({ private: true, type: 'module', version: packageVersion }, null, 2)}\n`;
  return {
    key: 'mcp/channel/package.json',
    outputRelPath: 'mcp/channel/package.json',
    sourceSha256: sha256(text),
    build: () => text,
  };
}
