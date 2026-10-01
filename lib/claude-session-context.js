import fs from 'node:fs';
import { claudeConfigDir } from './claude-paths.js';
import path from 'node:path';

// Native Claude owns this logical/resumed identity. The per-run environment id
// is not interchangeable with it. Both CLI and MCP respect its configured home.
export function readClaudeSessionRecord(pid, { env = process.env } = {}) {
  const root = claudeConfigDir(env);
  const file = path.join(root, 'sessions', `${pid}.json`);
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid Claude native session record');
  return { ...value, recordMtimeMs: fs.statSync(file).mtimeMs };
}
