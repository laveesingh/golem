import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
for (const [label, argv] of [
  ['strict', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['emit', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.emit.json']],
  [
    'web',
    [
      'node_modules/vite/bin/vite.js',
      'build',
      '--config',
      'dashboard/vite.config.js',
    ],
  ],
]) {
  const result = spawnSync(process.execPath, argv, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    fs.rmSync(dist, { recursive: true, force: true });
    throw Error(
      `package ${label} failed: ${result.error?.message ?? result.status}`,
    );
  }
}
// The copied MCP render remains a separately installed package until W7.
// Its manifests sit beside the emitted code for private render generation.
for (const name of ['package.json', 'package-lock.json']) {
  fs.copyFileSync(
    path.join(root, 'mcp/channel', name),
    path.join(dist, 'mcp/channel', name),
  );
}
console.log(
  'Package emitted: mirrored JS/maps, MCP manifests and built web assets',
);
