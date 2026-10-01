import os from 'node:os';
import path from 'node:path';

/** The native Claude config/install/session root, including profile overrides. */
export function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
}
