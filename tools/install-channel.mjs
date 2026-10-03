import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Install beside the executable child, not beside unused source metadata.
const channel = path.join(
  root,
  fs.existsSync(path.join(root, 'mcp/channel/index.js'))
    ? 'mcp/channel'
    : 'dist/mcp/channel',
);
if (
  !fs.existsSync(path.join(channel, 'index.js')) ||
  !fs.existsSync(path.join(channel, 'package-lock.json'))
)
  throw Error(`MCP channel install graph missing: ${channel}`);
const result = spawnSync(
  process.execPath,
  [process.env.npm_execpath, 'ci', '--omit=dev', '--prefix', channel],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
