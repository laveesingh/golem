#!/usr/bin/env node
// One-off scrub of Codex/OpenCode historical records (GOL-365 R7/S2).
//
// Dry run by default: builds the scrubbed set from the JSON stores (read
// only), counts what would be deleted or nulled per store and table, prints a
// table, and changes nothing. `--apply` backs up every file it will touch,
// stops the dashboard (only if one is running for this golem home), deletes
// the records under the registries' own locks and in single SQLite
// transactions, restarts the dashboard only if it stopped one, and prints
// exact rollback commands.
//
// It is a script, not a CLI verb (design D1) and never runs automatically.
// The lead runs `--apply` after the code lands (D5).
//
// Usage:
//   node scripts/scrub-legacy-harnesses.mjs           # dry run
//   node scripts/scrub-legacy-harnesses.mjs --apply   # destructive, backs up first
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

import {
  channelsJsonPath,
  endpointLeasesJsonPath,
  journalsDir,
  renderDirFor,
  sessionFactsJsonPath,
  sessionsJsonPath,
  substrateLockPath,
  trackerDbPath,
  typedDeliveryTombstonesDbPath,
} from '../lib/golem-home.js';
import { withRegistryLock } from '../lib/session-facts.js';
import { countLegacyHarnessRows, purgeLegacyHarnessRows } from '../dashboard/server/tracker-db.js';
import {
  closeTypedDeliveryStores,
  countTypedDeliveryTombstonesFor,
  purgeTypedDeliveryTombstones,
} from '../lib/typed-delivery-tombstones.js';
import { startDashboardDetached, stopDashboard } from '../lib/dashboard-process.js';

const LEGACY_HARNESSES = new Set(['codex', 'opencode']);
const LEGACY_LOCK_TARGETS = new Set(['codex', 'codex-instructions', 'opencode', 'opencode-instructions']);
const LEGACY_FILES = ['codex-supervisors.json', 'opencode-bridges.json'];
const LEGACY_RENDER_DIRS = ['codex', 'opencode'];

const APPLY = process.argv.includes('--apply');

function log(line) {
  console.log(line);
}

function err(line) {
  console.error(line);
}

function fail(message) {
  err(`scrub-legacy-harnesses: ${message}`);
  process.exit(1);
}

function atomicWrite(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.scrub.${process.pid}.${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readRegistry(file, key) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed[key])) return { version: 1, [key]: [] };
    return { version: parsed.version ?? 1, [key]: parsed[key] };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, [key]: [] };
    throw error;
  }
}

function isLegacyRow(row) {
  return !!row && (LEGACY_HARNESSES.has(row.harness) || row.kind === 'codex-supervisor');
}

// --- 1. Build the scrubbed set (read only) ----------------------------------

function buildScrubSet() {
  const set = new Set();
  const sources = [
    [sessionsJsonPath(), 'sessions'],
    [sessionFactsJsonPath(), 'facts'],
    [endpointLeasesJsonPath(), 'leases'],
  ];
  for (const [file, key] of sources) {
    for (const row of readRegistry(file, key)[key]) {
      if (LEGACY_HARNESSES.has(row?.harness)) set.add(row.session_id ?? row.canonical_id);
    }
  }
  // channels: kind codex-supervisor OR harness codex/opencode
  try {
    const channels = readRegistry(channelsJsonPath(), 'channels').channels;
    for (const row of channels) {
      if (isLegacyRow(row)) set.add(row.session_id);
    }
  } catch { /* unreadable channels.json — nothing to add from it */ }
  const golemHomeDir = process.env.GOLEM_HOME || path.join(process.env.HOME || '', '.golem');
  try {
    const doc = JSON.parse(readFileSync(path.join(golemHomeDir, 'codex-supervisors.json'), 'utf8'));
    for (const id of Object.keys(doc?.supervisors ?? {})) set.add(id);
  } catch { /* absent */ }
  try {
    const doc = JSON.parse(readFileSync(path.join(golemHomeDir, 'opencode-bridges.json'), 'utf8'));
    for (const bridge of doc?.bridges ?? []) if (bridge?.session_id) set.add(bridge.session_id);
  } catch { /* absent */ }
  return new Set([...set].filter(Boolean));
}

// --- 2. Dry-run counts ------------------------------------------------------

function jsonStoreCounts(set) {
  const stores = [
    ['sessions.json', sessionsJsonPath(), 'sessions', (row) => set.has(row?.session_id)],
    ['session-facts.json', sessionFactsJsonPath(), 'facts', (row) => set.has(row?.canonical_id)],
    ['endpoint-leases.json', endpointLeasesJsonPath(), 'leases', (row) => set.has(row?.canonical_id ?? row?.session_id)],
    ['channels.json', channelsJsonPath(), 'channels', isLegacyRow],
  ];
  const counts = [];
  for (const [name, file, key, match] of stores) {
    try {
      const rows = readRegistry(file, key)[key];
      const hits = rows.filter(match).length;
      counts.push({ store: name, total: rows.length, matching: hits, action: hits ? 'delete rows' : '—' });
    } catch (error) {
      counts.push({ store: name, total: null, matching: null, action: `unreadable: ${error.message}` });
    }
  }
  return counts;
}

function fileCounts(set, home) {
  const counts = [];
  for (const name of LEGACY_FILES) {
    const file = path.join(home, name);
    if (!existsSync(file)) {
      counts.push({ store: name, total: null, matching: null, action: 'absent' });
      continue;
    }
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      const key = name === 'codex-supervisors.json' ? 'supervisors' : 'bridges';
      const rows = doc?.[key] ?? {};
      counts.push({ store: name, total: Object.keys(rows).length, matching: Object.keys(rows).length, action: 'delete file' });
    } catch (error) {
      counts.push({ store: name, total: null, matching: null, action: `unreadable: ${error.message}` });
    }
  }
  for (const dir of LEGACY_RENDER_DIRS) {
    const abs = path.join(home, 'renders', dir);
    counts.push({
      store: `renders/${dir}/`,
      total: existsSync(abs) ? readdirSync(abs).length : null,
      matching: existsSync(abs) ? 'dir' : null,
      action: existsSync(abs) ? 'delete dir' : 'absent',
    });
  }
  return counts;
}

function lockCounts(home) {
  const lockFile = substrateLockPath();
  if (!existsSync(lockFile)) return [{ store: 'substrate.lock', total: null, matching: null, action: 'absent' }];
  try {
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    const targets = lock?.targets ?? {};
    const keys = Object.keys(targets);
    const legacyKeys = keys.filter((key) => LEGACY_LOCK_TARGETS.has(key.split('::')[0]));
    return [{ store: 'substrate.lock', total: keys.length, matching: legacyKeys.length, action: 'delete sections' }];
  } catch (error) {
    return [{ store: 'substrate.lock', total: null, matching: null, action: `unreadable: ${error.message}` }];
  }
}

function journalCounts(set, home) {
  const journals = path.join(home, 'journals');
  let files = [];
  try {
    for (const project of readdirSync(journals)) {
      const dir = path.join(journals, project);
      if (!statSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        if (name.endsWith('.jsonl')) files.push(path.join(dir, name));
      }
    }
  } catch {
    return [{ store: 'journals/**/*.jsonl', total: null, matching: null, action: 'absent' }];
  }
  let matchingLines = 0;
  let affectedFiles = 0;
  for (const file of files) {
    let lines;
    try {
      lines = readFileSync(file, 'utf8').split('\n');
    } catch {
      continue;
    }
    let hits = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && set.has(parsed.session_id)) hits += 1;
      } catch { /* non-JSON line — keep */ }
    }
    if (hits > 0) {
      matchingLines += hits;
      affectedFiles += 1;
    }
  }
  return [{ store: 'journals/**/*.jsonl', total: files.length, matching: `${affectedFiles} files / ${matchingLines} lines`, action: affectedFiles ? 'filter lines' : '—' }];
}

// --- 3. Backup ---------------------------------------------------------------

function backupFiles(set, home) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(home, 'backups', `scrub-legacy-harnesses-${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  const copied = [];

  const copyIfExists = (abs, rel) => {
    if (!existsSync(abs)) return;
    mkdirSync(path.dirname(path.join(backupDir, rel)), { recursive: true });
    copyFileSync(abs, path.join(backupDir, rel));
    copied.push(rel);
  };

  for (const name of ['sessions.json', 'session-facts.json', 'endpoint-leases.json', 'channels.json', ...LEGACY_FILES, 'substrate.lock']) {
    copyIfExists(path.join(home, name), name);
  }
  for (const db of ['tracker.db', 'typed-delivery-tombstones.db']) {
    for (const suffix of ['', '-wal', '-shm']) {
      copyIfExists(path.join(home, `${db}${suffix}`), `${db}${suffix}`);
    }
  }
  // Affected journal files (relative path journals/<project>/<file>).
  const journals = path.join(home, 'journals');
  let projectDirs = [];
  try {
    projectDirs = readdirSync(journals).filter((entry) => statSync(path.join(journals, entry)).isDirectory());
  } catch { /* no journals dir */ }
  for (const project of projectDirs) {
    const dir = path.join(journals, project);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      let lines;
      try {
        lines = readFileSync(file, 'utf8').split('\n');
      } catch {
        continue;
      }
      const touched = lines.some((line) => {
        if (!line.trim()) return false;
        try {
          const parsed = JSON.parse(line);
          return parsed && set.has(parsed.session_id);
        } catch {
          return false;
        }
      });
      if (touched) copyIfExists(file, path.join('journals', project, name));
    }
  }
  return { backupDir, copied };
}

// --- 4. Apply ----------------------------------------------------------------

function applyJsonStores(set) {
  const removed = {};
  const filters = [
    ['sessions.json', sessionsJsonPath(), 'sessions', (row) => !set.has(row?.session_id)],
    ['session-facts.json', sessionFactsJsonPath(), 'facts', (row) => !set.has(row?.canonical_id)],
    ['endpoint-leases.json', endpointLeasesJsonPath(), 'leases', (row) => !set.has(row?.canonical_id ?? row?.session_id)],
    ['channels.json', channelsJsonPath(), 'channels', (row) => !isLegacyRow(row)],
  ];
  for (const [name, file, key, keep] of filters) {
    if (!existsSync(file)) continue;
    removed[name] = withRegistryLock(file, () => {
      const registry = readRegistry(file, key);
      const before = registry[key].length;
      registry[key] = registry[key].filter(keep);
      atomicWrite(file, registry);
      return before - registry[key].length;
    });
  }
  return removed;
}

function applyLegacyFiles(home) {
  const removed = {};
  for (const name of LEGACY_FILES) {
    const file = path.join(home, name);
    if (existsSync(file)) {
      rmSync(file);
      removed[name] = 'file deleted';
    }
  }
  for (const dir of LEGACY_RENDER_DIRS) {
    const abs = path.join(home, 'renders', dir);
    if (existsSync(abs)) {
      rmSync(abs, { recursive: true, force: true });
      removed[`renders/${dir}/`] = 'dir deleted';
    }
  }
  return removed;
}

function applyLock() {
  const lockFile = substrateLockPath();
  if (!existsSync(lockFile)) return {};
  const removed = {};
  withRegistryLock(lockFile, () => {
    let lock;
    try {
      lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    } catch {
      return;
    }
    const targets = lock?.targets ?? {};
    for (const key of Object.keys(targets)) {
      if (LEGACY_LOCK_TARGETS.has(key.split('::')[0])) {
        delete targets[key];
        removed[key] = 'section deleted';
      }
    }
    atomicWrite(lockFile, lock);
  });
  return removed;
}

function applyJournals(set, home) {
  const journals = path.join(home, 'journals');
  let projectDirs = [];
  try {
    projectDirs = readdirSync(journals).filter((entry) => statSync(path.join(journals, entry)).isDirectory());
  } catch {
    return {};
  }
  const removed = {};
  for (const project of projectDirs) {
    const dir = path.join(journals, project);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      let lines;
      try {
        lines = readFileSync(file, 'utf8').split('\n');
      } catch {
        continue;
      }
      const kept = lines.filter((line) => {
        if (!line.trim()) return true;
        try {
          const parsed = JSON.parse(line);
          return !(parsed && set.has(parsed.session_id));
        } catch {
          return true; // non-JSON line — keep
        }
      });
      if (kept.length !== lines.length) {
        mkdirSync(path.dirname(`${file}.tmp.scrub`), { recursive: true });
        const tmp = `${file}.tmp.scrub.${process.pid}`;
        writeFileSync(tmp, kept.join('\n'));
        fs.renameSync(tmp, file);
        removed[path.join('journals', project, name)] = lines.length - kept.length;
      }
    }
  }
  return removed;
}

// --- 5. Orchestration --------------------------------------------------------

function printCounts(rows) {
  log('');
  log('  store                          total      matching  action');
  log('  ---------------------------    -------    --------  --------------');
  for (const row of rows) {
    log(`  ${row.store.padEnd(28)}  ${String(row.total ?? '—').padEnd(8)}  ${String(row.matching ?? '—').padEnd(8)}  ${row.action}`);
  }
}

function printRollback(backupDir, copied) {
  log('');
  log('Rollback (dashboard stopped first; restore every file, then restart):');
  for (const rel of copied) {
    const home = path.dirname(substrateLockPath());
    log(`  cp -p "${path.join(backupDir, rel)}" "${path.join(home, rel)}"`);
  }
  log(`  # then: golem dashboard  (or restart the dashboard from the main checkout)`);
}

const home = process.env.GOLEM_HOME || path.join(process.env.HOME || '', '.golem');
if (home === path.join(process.env.HOME || '', '.golem') && !existsSync(home)) {
  fail(`golem home not found: ${home}`);
}

const set = buildScrubSet();
log(`scrub-legacy-harnesses — golem home: ${home}`);
log(`scrubbed set: ${set.size} session id(s) with harness codex/opencode (or codex-supervisor channel kind)`);

const rows = [
  ...jsonStoreCounts(set),
  ...fileCounts(set, home),
  ...lockCounts(home),
  ...journalCounts(set, home),
];

// Database counts (read only; missing tables/columns are skipped).
let trackerCounts = {};
let tombstoneCount = 0;
const trackerDb = trackerDbPath();
if (existsSync(trackerDb)) {
  try {
    trackerCounts = countLegacyHarnessRows(trackerDb, [...set]);
  } catch (error) {
    trackerCounts = { error: error.message };
  }
}
const tombstonesDb = typedDeliveryTombstonesDbPath();
if (existsSync(tombstonesDb)) {
  try {
    tombstoneCount = countTypedDeliveryTombstonesFor([...set], { file: tombstonesDb });
  } catch (error) {
    tombstoneCount = `unreadable: ${error.message}`;
  }
}

rows.push({ store: 'tracker.db', total: 'db', matching: 'db', action: 'see below' });
for (const [table, count] of Object.entries(trackerCounts)) {
  rows.push({ store: `  tracker.db ${table}`, total: null, matching: count, action: Number(count) > 0 ? (table.startsWith('tickets') ? 'set NULL' : 'delete rows') : '—' });
}
rows.push({ store: 'typed-delivery-tombstones.db', total: null, matching: tombstoneCount, action: Number(tombstoneCount) > 0 ? 'delete rows' : '—' });
printCounts(rows);

if (!APPLY) {
  log('');
  log('DRY RUN — nothing was changed. Pass --apply to back up, stop the dashboard,');
  log('delete these rows, and print rollback commands.');
  process.exit(0);
}

// --apply: backup → stop dashboard → scrub → restart → report.
const { backupDir, copied } = backupFiles(set, home);
if (!copied.length) {
  fail('backup wrote no files — nothing was changed. Refusing to continue.');
}
log('');
log(`OK backup written: ${backupDir} (${copied.length} files)`);

const stopped = await stopDashboard();
const wasRunning = stopped.length > 0;
log(wasRunning ? `OK dashboard stopped (${stopped.map(({ pid }) => `pid=${pid}`).join(', ')})` : 'dashboard was not running for this golem home');

const removed = {};
try {
  Object.assign(removed, applyJsonStores(set));
  Object.assign(removed, applyLegacyFiles(home));
  Object.assign(removed, applyLock());
  Object.assign(removed, applyJournals(set, home));
  if (existsSync(trackerDb) && set.size) {
    removed['tracker.db'] = purgeLegacyHarnessRows(trackerDb, [...set]);
  }
  if (existsSync(tombstonesDb) && set.size) {
    removed['typed-delivery-tombstones.db'] = purgeTypedDeliveryTombstones([...set], { file: tombstonesDb });
  }
} catch (error) {
  err(`FAILED during scrub: ${error.message}`);
  err('Backup is intact; restore it to roll back:');
  printRollback(backupDir, copied);
  process.exit(1);
}

log('');
log('Removed:');
for (const [key, value] of Object.entries(removed)) {
  log(`  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
}

if (wasRunning) {
  log('  restarting dashboard...');
  const started = await startDashboardDetached();
  if (started.ok) {
    log(`  OK dashboard responding on pid=${started.pid}`);
  } else {
    err(`  FAIL dashboard did not come back up. Log: ${started.logFile}`);
    if (started.tail) err(started.tail);
  }
}

log('');
log('Rollback — copy every backed-up file back, then start the dashboard:');
printRollback(backupDir, copied);

