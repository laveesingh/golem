// golem-home — single source of truth for where golem's mutable workspace
// lives (ADR-4, TKT-0573). Every reader/writer of dashboard.json,
// channels.json, projects.json, sessions.json, workers.json, the tracker DB, journals/,
// gates/, and ideas/ resolves its base dir through here.
//
// Resolution order:
//   1. GOLEM_HOME env         — explicit override, highest precedence.
//   2. XDG_CONFIG_HOME env    — legacy override. Existing smoke tests and
//      isolation harnesses set this to redirect state into a temp dir; it
//      must keep outranking the ~/.golem auto-detect below, or an isolated
//      test run would silently start touching real production state the
//      moment this machine migrates to ~/.golem.
//   3. ~/.golem               — the post-migration workspace, once it
//      exists on disk (a real directory, not the compat symlink left at
//      the old location).
//   4. ~/.config/golem        — pre-migration default (ADR-4, before the
//      P1 cutover).
//
// `golem migrate-home` (cli/golem.js) performs the one-time move: back up,
// stop the dashboard, `mv ~/.config/golem ~/.golem`, symlink the old path to
// the new one, restart. The symlink means any caller that still resolves the
// old path keeps working transparently — this module exists so *new* code
// resolves the real, non-symlinked home going forward.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function isRealDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The golem workspace root. See module doc for resolution order. */
export function golemHome() {
  if (process.env.GOLEM_HOME) return process.env.GOLEM_HOME;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'golem');
  const migrated = path.join(os.homedir(), '.golem');
  if (isRealDir(migrated)) return migrated;
  return path.join(os.homedir(), '.config', 'golem');
}

/** Pre-migration default path, ignoring GOLEM_HOME/~/.golem — used by
 * `golem migrate-home` to find the source dir, and by `golem doctor`'s
 * split-brain check (real dir vs symlink) regardless of env overrides. */
export function legacyConfigDir() {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'golem');
}

/** The post-migration path golem-home resolves to once it's a real dir. */
export function migratedHomeDir() {
  return path.join(os.homedir(), '.golem');
}

export function trackerDbPath() {
  return process.env.GOLEM_TRACKER_DB ?? path.join(golemHome(), 'tracker.db');
}
export function journalsDir() {
  return path.join(golemHome(), 'journals');
}
export function journalDirFor(projectId) {
  return path.join(journalsDir(), projectId);
}
export function gatesDir() {
  return path.join(golemHome(), 'gates');
}
export function gatesDirFor(projectId) {
  return path.join(gatesDir(), projectId);
}
export function ideasDir() {
  return path.join(golemHome(), 'ideas');
}
export function ticketAssetsDir() {
  return process.env.GOLEM_ASSETS_DIR ?? path.join(golemHome(), 'ticket-assets');
}
export function projectsJsonPath() {
  return path.join(golemHome(), 'projects.json');
}
export function sessionsJsonPath() {
  return path.join(golemHome(), 'sessions.json');
}
export function channelsJsonPath() {
  return path.join(golemHome(), 'channels.json');
}
export function sessionFactsJsonPath() {
  return path.join(golemHome(), 'session-facts.json');
}
export function endpointLeasesJsonPath() {
  return path.join(golemHome(), 'endpoint-leases.json');
}
// One durable record per Golem-owned, headless Pi worker. It is separate from
// session-facts.json: facts are harness-owned liveness evidence, while this
// registry records the tmux/process identity Golem launched.
export function workersJsonPath() {
  return path.join(golemHome(), 'workers.json');
}
// This is intentionally separate from generic session facts: it holds the
// process/thread recovery mapping and must never be inferred from a hook.
// Compact replay identity for typed native-worker delivery. Rich adapter
// history remains bounded in its own registry; this SQLite file holds only
// durable idempotency tombstones until the tracker has a terminal,
// non-renewable lineage and explicitly retires the matching envelope.
export function typedDeliveryTombstonesDbPath() {
  return process.env.GOLEM_TYPED_DELIVERY_TOMBSTONES_DB ?? path.join(golemHome(), 'typed-delivery-tombstones.db');
}
export function dashboardJsonPath() {
  return path.join(golemHome(), 'dashboard.json');
}

// --- P2: compiler workspace paths (ADR-5) -----------------------------------

export function substrateLockPath() {
  return path.join(golemHome(), 'substrate.lock');
}
export function configJsonPath() {
  return path.join(golemHome(), 'config.json');
}
export function rendersDir() {
  return path.join(golemHome(), 'renders');
}
/** Render output dir for one harness target, e.g. renderDirFor('cc') -> <home>/renders/cc-plugin. */
export function renderDirFor(target) {
  const dirName = target === 'cc' ? 'cc-plugin' : target;
  return path.join(rendersDir(), dirName);
}
export function logsDir() {
  return path.join(golemHome(), 'logs');
}
