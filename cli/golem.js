#!/usr/bin/env node
// golem — minimal Node CLI for the v4 harness.
//
// v3 subcommands removed:
//   install, cleanup, reinstall, project, dispatch, ack
//   The old session commands are replaced by session list/notify.
//
// Surviving subcommands:
//   dashboard    Start the admin dashboard (node dashboard/server/index.js).
//   dashboard:restart
//                Stop and restart the admin dashboard detached.
//   claude / cc  Open Claude Code as a Golem channel consumer, optionally via Ollama.
//   pi           Open native Pi with Golem's rendered bridge extension.
//   agent        One toolkit for every agent (list/create/read/attach/stop).
//   doctor       Sanity-check the environment.
//   status       Dashboard health + canonical URL.
//   help         Show this message.

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { golemHome, legacyConfigDir, migratedHomeDir, trackerDbPath, renderDirFor, projectsJsonPath } from '../lib/golem-home.js';
import { projectIdFor } from '../lib/project-id.js';
import { updateProjectLsp } from '../lib/lsp.js';
import * as compiler from '../lib/compiler/engine.js';
import { lintSubstrate } from '../lib/compiler/lint.js';
import * as ccAdapter from '../lib/compiler/adapters/cc.js';
import * as piAdapter from '../lib/compiler/adapters/pi.js';
import { isHarnessEnabled, loadConfig, saveConfig } from '../lib/golem-config.js';
import { dashboardUrl, probeDashboard, startDashboardDetached, stopDashboard } from '../lib/dashboard-process.js';
import { MIN_PI_NODE, SUPPORTED_PI_VERSION, piNodeSupported } from '../lib/pi-compatibility.js';
import { resolveRolePreset } from '../lib/role-preset.js';
import { getProfile, listProfileNames } from '../lib/model-profiles.js';
import { HERDR_SUPPORTED_VERSION, herdrSessionForProject, herdrVersion } from '../lib/herdr-driver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GOLEM_ROOT = resolve(__dirname, '..');
const DASHBOARD_DIR = resolve(GOLEM_ROOT, 'dashboard');
function dashboardPortFromArgs(args) {
  const index = args.findIndex((arg) => arg === '--port' || arg.startsWith('--port='));
  if (index < 0) return null;
  const raw = args[index] === '--port' ? args[index + 1] : args[index].slice('--port='.length);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port requires an integer from 1 to 65535 (received ${raw ?? '(missing)'})`);
  }
  return port;
}

function applyDashboardPort(args, env) {
  const port = dashboardPortFromArgs(args);
  if (port != null) env.PORT = String(port);
  return port;
}

const removed = new Set([
  'install',
  'cleanup',
  'reinstall',
  'project',
  'dispatch',
  'ack',
]);

function log(line) {
  console.log(line);
}

function err(line) {
  console.error(line);
}

function fatal(code, message) {
  err(message);
  process.exit(code);
}

function hasCommand(name) {
  // Using `command -v` is the most portable way on POSIX shells.
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function cmdStatus(args) {
  const wantJson = args.includes('--json');
  const probe = await probeDashboard();

  if (wantJson) {
    log(JSON.stringify({
      dashboard_url: probe.ok ? dashboardUrl() : null,
      dashboard_healthy: probe.ok,
      dashboard: probe.data ?? null,
      error: probe.ok ? null : probe.error,
    }, null, 2));
    return;
  }

  log('');
  log('Dashboard');
  if (probe.ok) {
    const pc = probe.data?.project_count ?? '?';
    log(`  OK running on ${dashboardUrl()} (${pc} projects)`);
  } else {
    log(`  not reachable (${probe.error})`);
    log(`  start it with: golem dashboard`);
  }
}

function publicSupervisorRecord(record) {
  if (!record) return null;
  const { owner_token: _ownerToken, ...health } = record.health ?? {};
  return { ...record, health };
}


async function cmdDashboard(args) {
  const serverEntry = resolve(DASHBOARD_DIR, 'server', 'index.js');
  if (!existsSync(serverEntry)) {
    fatal(1, `dashboard server entry missing: ${serverEntry}`);
  }
  if (!existsSync(resolve(GOLEM_ROOT, 'node_modules'))) {
    fatal(1, 'root deps missing — npm install (from the repo root)');
  }

  const publicFlag = args.includes('--public');
  const env = { ...process.env };
  try {
    applyDashboardPort(args, env);
  } catch (error) {
    fatal(2, `golem dashboard: ${error.message}`);
  }
  if (publicFlag) {
    env.HOST = '0.0.0.0';
    err('WARNING --public: dashboard binding 0.0.0.0 — reachable on your LAN with NO auth.');
    err('WARNING anyone on this network can drive sessions via /api/brief.');
  }

  const passthru = args.filter((a) => a !== '--public');
  const proc = spawn(process.execPath, [serverEntry, ...passthru], {
    cwd: GOLEM_ROOT,
    stdio: 'inherit',
    env,
  });
  proc.on('error', (e) => fatal(1, `failed to start dashboard: ${e.message}`));
}

async function cmdDashboardRestart(args) {
  if (!existsSync(resolve(DASHBOARD_DIR, 'server', 'index.js'))) {
    fatal(1, `dashboard server entry missing: ${resolve(DASHBOARD_DIR, 'server', 'index.js')}`);
  }
  if (!existsSync(resolve(GOLEM_ROOT, 'node_modules'))) {
    fatal(1, 'root deps missing — npm install (from the repo root)');
  }

  try {
    applyDashboardPort(args, process.env);
  } catch (error) {
    fatal(2, `golem dashboard:restart: ${error.message}`);
  }
  log('Restarting dashboard...');
  const stopped = await stopDashboard();
  log(stopped.length ? `  OK dashboard stopped (${stopped.map(({ pid }) => `pid=${pid}`).join(', ')})` : '  dashboard was not running');
  log('  starting dashboard detached...');
  const started = await startDashboardDetached(args);
  log(`  log: ${started.logFile}`);
  if (!started.ok) {
    const exit = started.exit
      ? started.exit.error
        ? `; child error: ${started.exit.error}`
        : `; child exit code=${started.exit.code ?? 'null'} signal=${started.exit.signal ?? 'null'}`
      : '';
    const tail = started.tail ? `\n\nLast log lines:\n${started.tail}` : '';
    fatal(1, `  FAIL dashboard did not come back up within startup window${exit}. Log: ${started.logFile}${tail}`);
  }
  log(`  OK dashboard responding on ${dashboardUrl()} (pid=${started.pid})`);
}

async function cmdMigrateHome(args) {
  const src = legacyConfigDir();
  const dest = migratedHomeDir();

  let srcStat = null;
  try { srcStat = lstatSync(src); } catch { /* doesn't exist */ }

  if (srcStat && srcStat.isSymbolicLink()) {
    fatal(1, `already migrated: ${src} is a symlink -> ${readlinkSync(src)}`);
  }
  if (!srcStat) {
    fatal(1, `nothing to migrate: ${src} does not exist`);
  }
  if (existsSync(dest)) {
    fatal(1, `${dest} already exists — refusing to overwrite. Resolve manually before retrying.`);
  }

  log('');
  log('golem migrate-home');
  log(`  source: ${src}`);
  log(`  dest:   ${dest}`);

  // 1. Backup tarball (parent-relative tar so the archive contains a
  //    relocatable `golem/` entry, not an absolute-path member).
  const home = homedir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(home, `golem-config-backup-${stamp}.tar.gz`);
  const rel = src.startsWith(home + '/') ? src.slice(home.length + 1) : src;
  log(`  backing up to ${backupPath} ...`);
  const tarResult = spawnSync('tar', ['-czf', backupPath, '-C', home, rel], { stdio: 'inherit' });
  if (tarResult.status !== 0) {
    fatal(1, `backup failed (tar exit ${tarResult.status}) — aborting before touching ${src}`);
  }
  if (!existsSync(backupPath)) {
    fatal(1, `backup tarball missing after tar reported success — aborting: ${backupPath}`);
  }
  log(`  OK backup written: ${backupPath}`);

  // 2. Stop the dashboard (open SQLite handle on tracker.db inside src).
  const stopped = await stopDashboard();
  log(stopped.length ? `  OK dashboard stopped (${stopped.map(({ pid }) => `pid=${pid}`).join(', ')})` : '  dashboard was not running');

  // 3 + 4. Move, then symlink the old path to the new one.
  try {
    renameSync(src, dest);
    symlinkSync(dest, src);
  } catch (e) {
    fatal(1, `move/symlink failed: ${e.message}. Backup is intact at ${backupPath} — restore with: tar -xzf ${backupPath} -C ${home}`);
  }
  log(`  OK moved ${src} -> ${dest}`);
  log(`  OK symlinked ${src} -> ${dest}`);

  // 5. Restart the dashboard.
  log('  restarting dashboard...');
  const up = await startDashboardDetached();
  log(`  log: ${up.logFile}`);
  if (up.ok) {
    log('  OK dashboard responding');
  } else {
    const exit = up.exit
      ? up.exit.error
        ? `; child error: ${up.exit.error}`
        : `; child exit code=${up.exit.code ?? 'null'} signal=${up.exit.signal ?? 'null'}`
      : '';
    err(`  FAIL dashboard did not come back up within startup window${exit}. Log: ${up.logFile}`);
    if (up.tail) err(`\nLast log lines:\n${up.tail}`);
  }

  log('');
  log('Rollback (one operation): ');
  log(`  rm "${src}" && mv "${dest}" "${src}" && golem dashboard`);
  log(`  (or restore from backup: tar -xzf ${backupPath} -C ${home})`);
}

const ADAPTERS = { cc: ccAdapter, pi: piAdapter };
const KNOWN_TARGETS = ['cc', 'cc-marketplace', 'pi'];


function readPackageVersion() {
  return JSON.parse(readFileSync(resolve(GOLEM_ROOT, 'package.json'), 'utf8')).version;
}

function substrateRoot() {
  return process.env.GOLEM_SUBSTRATE_ROOT ? resolve(process.env.GOLEM_SUBSTRATE_ROOT) : resolve(GOLEM_ROOT, 'substrate');
}

function optionValue(args, name) {
  const idx = args.indexOf(name);
  return idx === -1 ? null : args[idx + 1];
}

function normalizeTarget(target) {
  if (target === 'claudecode') return 'cc';
  if (KNOWN_TARGETS.includes(target)) return target;
  fatal(2, `Unknown sync target/harness: ${target} (known: ${KNOWN_TARGETS.join(', ')}, claudecode)`);
}

function planForTarget(target) {
  const root = substrateRoot();
  if (target === 'cc-marketplace') {
    return ccAdapter.buildMarketplacePlan({ substrateRoot: root });
  }
  const adapter = ADAPTERS[target];
  if (!adapter) fatal(2, `Unknown sync target: ${target} (known: ${KNOWN_TARGETS.join(', ')})`);
  return adapter.buildPlan({ substrateRoot: root, repoRoot: GOLEM_ROOT, packageVersion: readPackageVersion() });
}

// Targets whose adapter renders a golem-owned block into a global instructions
// file the human also owns (~/.claude/CLAUDE.md). This
const INSTRUCTION_ADAPTERS = { cc: ccAdapter };

/** Instruction render plan for a target, or an empty plan when it has none.
 * The lock target is namespaced per harness because instructions land outside
 * the bundle's out dir and must not share its lockfile section. */
function instructionPlanFor(target) {
  const adapter = INSTRUCTION_ADAPTERS[target];
  if (!adapter) return { items: [], outDir: null, lockTarget: null };
  return {
    items: adapter.buildInstructionPlan({ substrateRoot: substrateRoot() }),
    outDir: adapter.instructionOutDir(),
    lockTarget: `${target}-instructions`,
  };
}

function knownProjects() {
  try {
    const doc = JSON.parse(readFileSync(projectsJsonPath(), 'utf8'));
    return (doc.projects ?? []).filter((p) => p?.path && existsSync(p.path));
  } catch {
    return [];
  }
}

function printDrift({ clean, drifted, orphaned }) {
  if (clean) {
    log('  OK clean — no drift');
    return;
  }
  if (drifted.length) {
    log('');
    log('  drifted:');
    for (const d of drifted) log(`    ${d.reason.padEnd(9)} ${d.key}`);
  }
  if (orphaned.length) {
    log('');
    log('  orphaned (source removed, output would be pruned):');
    for (const o of orphaned) log(`    orphan    ${o.key}`);
  }
}

function printTamper({ tampered, forceHint = '--force' }) {
  if (!tampered.length) return;
  log('');
  err(`  TAMPER — refused to overwrite; re-run with ${forceHint} to replace the managed region:`);
  for (const t of tampered) {
    const region = t.block ? ' (golem:instructions block)' : '';
    const why = t.reason ? ` — ${t.reason}` : '';
    err(`    ${t.outputRelPath}${region}${why}`);
  }
}

function warnVisibleGeneratedFiles({ projectRoot, outDir, items, result }) {
  const byKey = new Map(items.map((item) => [item.key, item.outputRelPath]));
  const relPaths = [];
  for (const key of new Set([...(result.written ?? []), ...(result.unchanged ?? [])])) {
    const relOut = byKey.get(key);
    if (!relOut) continue;
    relPaths.push(pathRelative(projectRoot, join(outDir, relOut)));
  }
  if (!relPaths.length) return;
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...relPaths], { cwd: projectRoot, encoding: 'utf8' });
  if (status.status !== 0) return;
  const visible = status.stdout.split('\0')
    .filter(Boolean)
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3));
  if (!visible.length) return;
  err('');
  err('  WARNING project render has generated files that are untracked and not gitignored:');
  for (const rel of visible) err(`    ${rel}`);
  err('  Add an ignore rule or intentionally track them before using project-scoped artifacts in this repo.');
}

function pathRelative(from, to) {
  const rel = relative(from, to);
  return rel || '.';
}

async function cmdSync(args) {
  const checkOnly = args.includes('--check');
  const all = args.includes('--all');
  const force = args.includes('--force');
  const explicitTarget = optionValue(args, '--target') || optionValue(args, '--harness');
  const target = normalizeTarget(explicitTarget || 'cc');
  const projectArg = optionValue(args, '--project');

  if (checkOnly && (all || (!explicitTarget && !projectArg && !optionValue(args, '--out') && args.filter((a) => a !== '--check').length === 0))) {
    return cmdSyncCheckAll();
  }

  if (projectArg) {
    if (target === 'cc-marketplace') fatal(2, '--project is not valid with cc-marketplace');
    return cmdSyncProject({ target, projectRoot: resolve(projectArg), checkOnly, force });
  }

  const customOut = optionValue(args, '--out');
  const outDir = customOut ? resolve(customOut) : renderDirFor(target);

  const items = planForTarget(target);
  // A custom --out means "render the bundle over there" (e.g. ./plugin for the
  // committed round-trip). Instructions always belong to the real harness home,
  // so they are deliberately skipped in that mode rather than misfiled.
  const { items: instructionItems, outDir: instructionOutDir, lockTarget: instructionLockTarget } =
    customOut ? { items: [], outDir: null, lockTarget: null } : instructionPlanFor(target);

  if (checkOnly) {
    const main = compiler.checkDrift({ target, outDir, items });
    const instr = instructionItems.length
      ? compiler.checkDrift({ target: instructionLockTarget, outDir: instructionOutDir, items: instructionItems })
      : { clean: true, drifted: [], orphaned: [] };
    const clean = main.clean && instr.clean;
    log('');
    log(`golem sync --check --target ${target}`);
    log(`  out: ${outDir}`);
    if (instructionItems.length) log(`  instructions out: ${instructionOutDir}`);
    printDrift({ clean, drifted: [...main.drifted, ...instr.drifted], orphaned: [...main.orphaned, ...instr.orphaned] });
    if (!clean) process.exit(1);
    return;
  }

  const main = compiler.render({
    target,
    outDir,
    items,
    packageVersion: readPackageVersion(),
    force,
  });
  const instr = instructionItems.length
    ? compiler.render({ target: instructionLockTarget, outDir: instructionOutDir, items: instructionItems, packageVersion: readPackageVersion(), force })
    : { written: [], unchanged: [], tampered: [], pruned: [] };
  if (target === 'cc') {
    ccAdapter.syncMcpChannelDeps({ repoRoot: GOLEM_ROOT, outDir });
  }
  if (target === 'cc-marketplace') {
    ccAdapter.ensureMarketplacePluginLink({ ccPluginDir: renderDirFor('cc'), marketplaceOutDir: outDir });
  }

  log('');
  log(`golem sync --target ${target}`);
  log(`  out: ${outDir}`);
  if (instructionItems.length) log(`  instructions out: ${instructionOutDir}`);
  const written = [...main.written, ...instr.written];
  const unchanged = [...main.unchanged, ...instr.unchanged];
  const tampered = [...main.tampered, ...instr.tampered];
  const pruned = [...main.pruned, ...instr.pruned];
  log(`  written: ${written.length}, unchanged: ${unchanged.length}, pruned: ${pruned.length}, tampered: ${tampered.length}`);
  if (tampered.length) {
    printTamper({ tampered });
    process.exit(1);
  }
  if (pruned.length) {
    log('');
    log('  pruned (source removed):');
    for (const p of pruned) log(`    ${p.outputRelPath}`);
  }
}

async function cmdSyncProject({ target, projectRoot, checkOnly, force }) {
  const root = substrateRoot();
  const packageVersion = readPackageVersion();
  const projectId = projectIdFor(projectRoot);
  log('');
  log(`golem sync --target ${target}${checkOnly ? ' --check' : ''} --project ${projectRoot}`);
  log(`  project_id: ${projectId}`);

  const outDir = projectRoot;
  const items = ccAdapter.buildProjectPlan({ substrateRoot: root, repoRoot: GOLEM_ROOT, packageVersion });
  if (checkOnly) {
    const res = compiler.checkDrift({ target: 'cc', outDir, items, projectId });
    log(`  out: ${outDir}`);
    printDrift(res);
    if (!res.clean) process.exit(1);
    return;
  }
  const res = compiler.render({ target: 'cc', outDir, items, packageVersion, force, projectId });
  log(`  out: ${outDir}`);
  log(`  written: ${res.written.length}, unchanged: ${res.unchanged.length}, pruned: ${res.pruned.length}, tampered: ${res.tampered.length}`);
  warnVisibleGeneratedFiles({ projectRoot, outDir, items, result: res });
  if (res.tampered.length) {
    log('');
    err('  TAMPER — refused to overwrite (hand-edited outside sync); re-run with --force:');
    for (const t of res.tampered) err(`    ${t.outputRelPath}`);
    process.exit(1);
  }
}

async function cmdSyncCheckAll({ quiet = false } = {}) {
  let drift = false;
  const say = quiet ? () => {} : log;
  if (!quiet) log('');
  say('golem sync --check --all');

  // Source size report runs once, before any render-drift check. GOL-377
  // addendum: it can never fail — an over-cap total is only a warning.
  const lint = lintSubstrate({ substrateRoot: substrateRoot() });
  if (!quiet) log('');
  say(`substrate lint: ${lint.files} files, ${lint.total} words`);
  for (const w of lint.warnings ?? []) log(`  warning: ${w.check}: ${w.file} — ${w.detail}`);

  const ccOut = renderDirFor('cc');
  const cc = compiler.checkDrift({ target: 'cc', outDir: ccOut, items: planForTarget('cc') });
  const ccInstrOut = ccAdapter.instructionOutDir();
  const ccInstr = compiler.checkDrift({ target: 'cc-instructions', outDir: ccInstrOut, items: ccAdapter.buildInstructionPlan({ substrateRoot: substrateRoot() }) });
  if (!quiet) log('');
  say(`global cc: ${ccOut}`);
  say(`  instructions out: ${ccInstrOut}`);
  if (!quiet) printDrift({ clean: cc.clean && ccInstr.clean, drifted: [...cc.drifted, ...ccInstr.drifted], orphaned: [...cc.orphaned, ...ccInstr.orphaned] });
  drift = drift || !cc.clean || !ccInstr.clean;

  const marketplaceOut = renderDirFor('cc-marketplace');
  const marketplace = compiler.checkDrift({ target: 'cc-marketplace', outDir: marketplaceOut, items: planForTarget('cc-marketplace') });
  if (!quiet) log('');
  say(`global cc-marketplace: ${marketplaceOut}`);
  if (!quiet) printDrift(marketplace);
  drift = drift || !marketplace.clean;

  const piOut = renderDirFor('pi');
  const pi = compiler.checkDrift({ target: 'pi', outDir: piOut, items: planForTarget('pi') });
  if (!quiet) log('');
  say(`global pi: ${piOut}`);
  if (!quiet) printDrift(pi);
  drift = drift || !pi.clean;

  for (const p of knownProjects()) {
    const projectId = p.id || projectIdFor(p.path);
    const ccProj = compiler.checkDrift({ target: 'cc', outDir: p.path, items: ccAdapter.buildProjectPlan({ substrateRoot: substrateRoot() }), projectId });
    if (!quiet) log('');
    say(`project cc ${projectId}: ${p.path}`);
    if (!quiet) printDrift(ccProj);
    drift = drift || !ccProj.clean;
  }

  if (drift && !quiet) process.exit(1);
  return !drift;
}



function indent(text, pad) {
  return String(text || '').split('\n').map((l) => pad + l).join('\n');
}

async function cmdDoctor() {
  let failures = 0;
  function ok(label) { log(`  OK ${label}`); }
  function fail(label) { err(`  FAIL ${label}`); failures += 1; }
  function skip(label) { log(`  · ${label}`); }

  log('');
  log('golem doctor');

  log('');
  log('Tooling');
  (await hasCommand('node')) ? ok('node on PATH') : fail('node on PATH');
  (await hasCommand('npm')) ? ok('npm on PATH') : fail('npm on PATH');

  // The Claude plugin is installed from the workspace render; a stale install
  // means every Claude session runs old skills and hooks (GOL-303 C9).
  try {
    const installed = JSON.parse(readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const entry = installed?.plugins?.['golem@golem-workspace']?.[0];
    const want = readPackageVersion();
    if (!entry) skip('claude plugin golem@golem-workspace not installed');
    else if (entry.version === want) ok(`claude plugin golem@golem-workspace ${entry.version} matches package.json`);
    else fail(`claude plugin golem@golem-workspace is ${entry.version}, package.json is ${want} — golem sync --target cc && claude plugin update golem@golem-workspace`);
  } catch (e) {
    skip(`claude plugin parity not checked — ${e.message}`);
  }

  log('');
  log('Managed workers (herdr)');
  try {
    const version = herdrVersion();
    if (version == null) skip('herdr not found on PATH — managed workers need herdr');
    else if (version === HERDR_SUPPORTED_VERSION) ok(`herdr ${version} on PATH`);
    else log(`  ⚠ herdr ${version} on PATH — supported version is ${HERDR_SUPPORTED_VERSION}`);
  } catch (e) {
    skip(`herdr version not checked — ${e.message}`);
  }
  try {
    for (const p of knownProjects()) {
      const pid = p.project_id ?? p.id;
      if (!pid) continue;
      log(`  · ${p.name || pid}: herdr session ${herdrSessionForProject(pid)}`);
    }
  } catch (e) {
    skip(`herdr sessions not listed — ${e.message}`);
  }

  log('');
  log('Dashboard');
  existsSync(DASHBOARD_DIR) ? ok(`dashboard dir exists (${DASHBOARD_DIR})`) : fail('dashboard dir exists');
  existsSync(resolve(GOLEM_ROOT, 'node_modules')) ? ok('root node_modules') : fail('root node_modules — npm install (from the repo root)');
  try {
    await import('better-sqlite3');
    ok('better-sqlite3 loads from root node_modules');
  } catch (e) {
    fail(`better-sqlite3 failed to load — ${e.message}`);
  }

  log('');
  log('Workspace (~/.golem)');
  const legacy = legacyConfigDir();
  const migrated = migratedHomeDir();
  const legacyStat = existsSync(legacy) ? lstatSync(legacy) : null;
  if (existsSync(migrated)) {
    ok(`~/.golem exists (${migrated})`);
    if (legacyStat && legacyStat.isSymbolicLink()) {
      ok(`${legacy} is a compat symlink -> ${readlinkSync(legacy)}`);
    } else if (legacyStat && legacyStat.isDirectory()) {
      fail(`split-brain: ~/.golem exists AND ${legacy} is still a real directory (not a symlink) — a migration was interrupted or something recreated the old dir`);
    } else {
      skip(`${legacy} does not exist — nothing points at it`);
    }
  } else {
    skip(`not yet migrated — run \`golem migrate-home\` to move off ${legacy}`);
  }
  const dbPath = trackerDbPath();
  existsSync(dbPath) ? ok(`tracker DB readable (${dbPath})`) : fail(`tracker DB missing at ${dbPath}`);

  log('');
  log('Substrate sync');
  try {
    const clean = await cmdSyncCheckAll({ quiet: true });
    clean ? ok('sync --check --all clean') : fail('sync --check --all drifted — run `golem sync --check --all`');
  } catch (e) {
    fail(`could not run sync --check --all — ${e.message}`);
  }


  log('');
  log('LSP capability');
  try {
    const projects = knownProjects();
    if (!projects.length) {
      skip('no registered projects to check');
    }
    for (const p of projects) {
      try {
        const { projectId, lsp } = await updateProjectLsp(p.path);
        const label = p.name || projectId;
        if (lsp.available) ok(`${label}: ${lsp.servers.join(', ')}`);
        else skip(`${label}: none detected`);
      } catch (e) {
        skip(`${p.name || p.id || p.path}: could not check LSP — ${e.message}`);
      }
    }
  } catch (e) {
    skip(`could not record LSP capability — ${e.message}`);
  }

  log('');
  log('Worktrees');
  try {
    const projects = knownProjects();
    let worktreeProjects = 0;
    let staleCount = 0;
    for (const p of projects) {
      const wtDir = resolve(p.path, '.worktrees');
      if (!existsSync(wtDir)) continue;
      worktreeProjects++;
      let entries;
      try { entries = readdirSync(wtDir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const wtPath = resolve(wtDir, e.name);
        const gitFile = resolve(wtPath, '.git');
        if (!existsSync(gitFile)) continue;
        // Check staleness: >7 days old
        let stale = false;
        let reason = '';
        try {
          const st = statSync(wtPath);
          const ageDays = (Date.now() - st.mtimeMs) / (1000 * 60 * 60 * 24);
          if (ageDays > 7) { stale = true; reason = `idle ${Math.round(ageDays)}d`; }
        } catch { /* can't stat */ }
        // Check if branch is fully merged into main
        if (!stale) {
          try {
            const gitdirContent = readFileSync(gitFile, 'utf8');
            const m = gitdirContent.match(/^gitdir:\s*(.+)$/m);
            if (m) {
              const branchPath = m[1].trim();
              const branchName = basename(branchPath);
              const r = spawnSync('git', ['branch', '--list', '--merged', 'main', branchName], { cwd: p.path, encoding: 'utf8', timeout: 3000 });
              if (r.status === 0 && r.stdout.trim()) { stale = true; reason = 'merged into main'; }
            }
          } catch { /* can't check merge status */ }
        }
        if (stale) {
          staleCount++;
          log(`  ⚠ ${p.name || p.id}: .worktrees/${e.name} — ${reason}`);
        }
      }
    }
    if (staleCount === 0) {
      worktreeProjects > 0 ? ok(`no stale worktrees (${worktreeProjects} project(s) with .worktrees/)`) : skip('no .worktrees/ dirs found');
    } else {
      skip(`${staleCount} stale worktree(s) found — review and \`git worktree remove\` when done`);
    }
  } catch (e) {
    skip(`could not check worktrees — ${e.message}`);
  }

  log('');
  log('Dashboard server reachability');
  const probe = await probeDashboard();
  if (probe.ok) {
    const pc = probe.data?.project_count ?? '?';
    ok(`dashboard responding on ${dashboardUrl()} (${pc} projects)`);
  } else {
    skip(`dashboard not reachable (${probe.error}) — run \`golem dashboard\` to start`);
  }

  log('');
  if (failures === 0) {
    ok('all critical checks passed');
  } else {
    fail(`${failures} critical check(s) failed`);
    process.exit(1);
  }
}

function cmdHelp() {
  log(`golem — minimal Node CLI for the v4 harness.

Usage:
  npx golem <command> [args]
  node cli/golem.js <command> [args]

Run:
  dashboard [--public] [--port P] [npm-start-args…]
                       Start the admin dashboard on ${dashboardUrl()}.
                       --port is an explicit alternate port; --public binds
                       0.0.0.0 (LAN-reachable, no auth).
  dashboard:restart [--public] [--port P] [npm-start-args…]
                       Stop every matching dashboard process and restart detached.
  claude|cc [--backend native|ollama] [--model <id>] [-- <claude args...>]
                       Open Claude Code with Golem's development channel loaded;
                       optionally launch through Ollama with an explicit model.
  pi [--role <role>] [--profile <name>] [--provider <id> --model <id>] [--resume <session-id>] [-- <pi args...>]
                       Open native Pi with the canonical Golem bridge extension;
                       --role applies a validated role preset and --profile
                       selects a reusable model config; Pi keeps its own
                       profile, providers, and sessions.
  agent list|create|read|attach|stop|notify|role|dedup [--help]
                       One toolkit for every agent: list the roster, create a
                       managed agent in your team, read or attach to its
                       terminal, stop it, notify a session, set a role, or
                       clean up duplicate session rows.
                       See golem agent --help.
  team create|list|join|close [--help]
                       Teams: create a team and its herdr workspace, list
                       teams, join a team (or own it with --owner), or close
                       a team and stop only its agents.
  ticket <operation> [args] [flags]
                       Flat agent authoring family over the tracker REST API:
                       list, get, create, update, replace-body, get-outline,
                       get-block, patch-blocks, add-comment, reply-comment,
                       update-comment. Mutations bind the trusted Pi/Claude CLI
                       session context (--human for unbound human shells);
                       --json is the stable contract: stdout carries
                       only result JSON, diagnostics go to stderr. See
                       golem ticket --help.
  schedule list|inspect|cancel [--help]
                         Manage durable delayed and recurring notifications.
  message inspect <id> [--content] [--json]
                         Inspect delivery without claiming task completion.
  migrate-home         One-time move of ~/.config/golem -> ~/.golem (ADR-4).
                       Backs up first, stops the dashboard, moves, symlinks
                       the old path to the new one, restarts. Explicit only —
                       never runs automatically. Rollback is one command
                       (printed on completion).
  sync [--check] [--all] [--target cc|cc-marketplace|pi] [--out <dir>]
       [--force] [--project <root>]
                        Render substrate/ sources into a harness bundle
                        (default target: cc, default out: ~/.golem/renders/
                        cc-plugin/). --check reports drift without writing
                        (exit 0 clean, 1 drifted). --force overwrites a
                        hand-edited (tampered) output; without it, sync warns
                        and refuses that one file.
                        --project switches to project-scoped artifacts only,
                        rendering into the project root's harness-local dirs and
                        recording the lockfile under projects.<project_id>.
                         With --check --all, or only --check and no target/project args, reports
                        global renders plus all known project render sections.
                       Root instructions render as a marked block into
                       ~/.claude/CLAUDE.md. Text outside the markers is yours
                       and is never rewritten. Skipped when --out is given,
                       since the bundle is going elsewhere.

Inspect:
  doctor               Sanity-check the environment.
  status [--json]    Dashboard health + canonical URL.
  help                 Show this message.

Removed in v4 (no longer supported):
  install, cleanup, reinstall, session, project, dispatch, ack

Environment:
  GOLEM_ROOT           Workspace anchor (default: repo containing cli/golem.js).

Install:
  npm link             Symlinks ./cli/golem.js as a global \`golem\` command.
  npx golem <cmd>      Run without installing, from the repo root.
`);
}

function cmdRemoved(name) {
  fatal(2, `Error: \`${name}\` is a v3 subcommand that has been removed in golem v4.\n\nRun \`golem help\` for the surviving commands.`);
}

const CLAUDE_CHANNEL_FLAG = '--dangerously-load-development-channels';
const GOLEM_CLAUDE_CHANNEL = 'plugin:golem@golem-workspace';

function claudeLauncherHelp() {
  log(`Usage: golem claude [--backend native|ollama] [--model <id>] [-- <claude args...>]
       golem cc [--backend native|ollama] [--model <id>] [-- <claude args...>]

Open Claude Code in the current directory as a push-capable Golem
channel consumer. The default backend is native. With --backend ollama, Golem
runs \`ollama launch claude\`, preserving the old golemx launch contract.

Golem injects:

  ${CLAUDE_CHANNEL_FLAG} ${GOLEM_CLAUDE_CHANNEL}

--model selects the native Claude Code model or the Ollama launch model,
depending on the backend. All arguments after -- are passed to Claude Code
unchanged. Other unrecognised arguments remain native Claude Code passthrough
for backwards compatibility. Use
\`golem claude -- --help\` for native Claude Code help. The development-channel
flag is reserved because this wrapper owns the Golem channel identity.`);
}

function isReservedClaudeArgument(arg) {
  return arg === CLAUDE_CHANNEL_FLAG || arg.startsWith(`${CLAUDE_CHANNEL_FLAG}=`);
}

async function cmdClaude(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    claudeLauncherHelp();
    return;
  }

  const passthrough = [];
  let backend = 'native';
  let model = null;
  let separatorSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!separatorSeen && arg === '--') {
      separatorSeen = true;
      continue;
    }
    if (!separatorSeen && (arg === '--backend' || arg === '--model')) {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) fatal(2, `golem claude requires a value for ${arg}`);
      if (arg === '--backend') backend = value;
      else model = value;
      index += 1;
      continue;
    }
    if (!separatorSeen && arg.startsWith('--backend=')) {
      backend = arg.slice('--backend='.length);
      continue;
    }
    if (!separatorSeen && arg.startsWith('--model=')) {
      model = arg.slice('--model='.length);
      continue;
    }
    if (isReservedClaudeArgument(arg)) {
      fatal(2, `golem claude owns ${CLAUDE_CHANNEL_FLAG}; remove it and let Golem select ${GOLEM_CLAUDE_CHANNEL}`);
    }
    passthrough.push(arg);
  }

  if (!['native', 'ollama'].includes(backend)) {
    fatal(2, `golem claude: unknown backend '${backend}' (known: native, ollama)`);
  }
  if (model === '') fatal(2, 'golem claude requires a non-empty --model value');

  const executable = backend === 'ollama' ? 'ollama' : 'claude';
  const launchArgs = backend === 'ollama'
    ? ['launch', 'claude', ...(model ? ['--model', model] : []), '--', CLAUDE_CHANNEL_FLAG, GOLEM_CLAUDE_CHANNEL, ...passthrough]
    : [CLAUDE_CHANNEL_FLAG, GOLEM_CLAUDE_CHANNEL, ...(model ? ['--model', model] : []), ...passthrough];

  const child = spawn(executable, launchArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  const onSigint = () => {
    // Claude Code receives terminal SIGINT directly and owns its turn-level
    // interrupt behavior. Keep the wrapper alive until the native child exits.
  };
  const forwardTermination = (signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const onSigterm = () => forwardTermination('SIGTERM');
  const onSighup = () => forwardTermination('SIGHUP');
  process.on('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  process.once('SIGHUP', onSighup);

  let exitSignal = null;
  try {
    const outcome = await new Promise((resolveOutcome) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolveOutcome(result);
      };
      child.once('error', (error) => finish({ error }));
      child.once('exit', (code, signal) => finish({ code, signal }));
    });

    if (outcome.error) {
      const detail = outcome.error.code === 'ENOENT'
        ? `the '${executable}' executable was not found on PATH`
        : outcome.error.message;
      err(`golem claude could not start Claude Code: ${detail}`);
      process.exitCode = 1;
      return;
    }

    if (Number.isInteger(outcome.code)) {
      if (outcome.code) process.exitCode = outcome.code;
      return;
    }

    exitSignal = outcome.signal;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.off('SIGHUP', onSighup);
  }

  if (exitSignal) {
    process.kill(process.pid, exitSignal);
    return;
  }

  err('golem claude: Claude Code exited without a status or signal');
  process.exitCode = 1;
}


function piLauncherHelp() {
  log(`Usage: golem pi [--role <role>] [--profile <name>] [--provider <id> --model <id>] [--resume <session-id>] [-- <pi args...>]

Open native Pi with Golem's canonical rendered bridge extension. Pi retains its
own profile, authentication, models, providers, extensions, and sessions. Tested
on Pi ${SUPPORTED_PI_VERSION} with Node.js >=${MIN_PI_NODE.major}.${MIN_PI_NODE.minor}.

Wrapper options:
  --role <role>         Apply the role's validated Pi execution preset.
  --profile <name>      Model profile override: its provider/model/thinking are
                        applied (role defaults come from profiles.json). Raw
                        --provider/--model still win over the profile.
  --provider <id>       Explicit native Pi provider. With --role, overrides its preset.
  --model <id>          Explicit provider-local model id. With --role, overrides its preset.
  --thinking <level>    With --role, overrides its preset thinking level.
  --name <name>         With --role, overrides its preset session name.
  --resume <session-id> Resume a native Pi session id through --session.

Arguments after -- are passed to Pi unchanged. Pi's own extension discovery and
configuration remain active; the shipped Golem extension is appended explicitly.

  golem pi --role explorer
  golem pi --role explorer --thinking max
  golem pi --role reviewer --profile grok-4.6-high
  golem pi --resume <pi-session-id> -- --thinking high`);
}

function hasPiRoleOption(args) {
  let separatorSeen = false;
  for (const arg of args) {
    if (arg === '--') {
      separatorSeen = true;
      continue;
    }
    if (!separatorSeen && (arg === '--role' || arg.startsWith('--role='))) return true;
  }
  return false;
}

async function cmdPi(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    piLauncherHelp();
    return;
  }
  if (!piNodeSupported()) {
    fatal(1, `golem pi requires Node.js >=${MIN_PI_NODE.major}.${MIN_PI_NODE.minor}; running ${process.versions.node}`);
  }

  let role = null;
  let provider = null;
  let model = null;
  let thinking;
  let name;
  let profile = null;
  let resume = null;
  let separatorSeen = false;
  const roleMode = hasPiRoleOption(args);
  const passthrough = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!separatorSeen && arg === '--') { separatorSeen = true; continue; }
    if (!separatorSeen && ['--role', '--provider', '--model', '--profile', '--resume'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('-')) fatal(2, `golem pi requires a value for ${arg}`);
      if (arg === '--role') role = value;
      else if (arg === '--provider') provider = value;
      else if (arg === '--model') model = value;
      else if (arg === '--profile') profile = value;
      else resume = value;
      continue;
    }
    if (roleMode && !separatorSeen && ['--thinking', '--name', '-n'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('-')) fatal(2, `golem pi requires a value for ${arg}`);
      if (arg === '--thinking') thinking = value;
      else name = value;
      continue;
    }
    if (!separatorSeen && arg.startsWith('--role=')) role = arg.slice('--role='.length);
    else if (!separatorSeen && arg.startsWith('--provider=')) provider = arg.slice('--provider='.length);
    else if (!separatorSeen && arg.startsWith('--model=')) model = arg.slice('--model='.length);
    else if (!separatorSeen && arg.startsWith('--profile=')) profile = arg.slice('--profile='.length);
    else if (!separatorSeen && arg.startsWith('--resume=')) resume = arg.slice('--resume='.length);
    else if (roleMode && !separatorSeen && arg.startsWith('--thinking=')) thinking = arg.slice('--thinking='.length);
    else if (roleMode && !separatorSeen && arg.startsWith('--name=')) name = arg.slice('--name='.length);
    else passthrough.push(arg);
  }
  if (roleMode && !role) fatal(2, 'golem pi requires a non-empty --role');
  if (profile != null && !profile.trim()) fatal(2, 'golem pi requires a non-empty --profile');
  let profileExec = null;
  if (profile != null) {
    profileExec = getProfile(profile);
    if (!profileExec) {
      fatal(2, `golem pi: unknown model profile "${profile}"; expected one of: ${listProfileNames().join(', ') || '(none)'}`);
    }
  }
  const effectiveProvider = provider ?? profileExec?.provider ?? null;
  const effectiveModel = model ?? profileExec?.model ?? null;
  if (!roleMode && (effectiveProvider == null) !== (effectiveModel == null)) fatal(2, 'golem pi requires --provider and --model together');
  if (provider != null && !provider.trim()) fatal(2, 'golem pi requires a non-empty --provider');
  if (model != null && !model.trim()) fatal(2, 'golem pi requires a non-empty --model');
  if (thinking != null && !thinking.trim()) fatal(2, 'golem pi requires a non-empty --thinking');
  if (name != null && !name.trim()) fatal(2, 'golem pi requires a non-empty --name');
  if (resume != null && !resume.trim()) fatal(2, 'golem pi requires a non-empty --resume');

  let presetArgs = [];
  if (roleMode) {
    const overrides = {};
    if (profile != null) overrides.profile = profile;
    if (provider != null) overrides.provider = provider;
    if (model != null) overrides.model = model;
    if (thinking != null) overrides.thinking = thinking;
    if (name != null) overrides.name = name;
    try {
      presetArgs = resolveRolePreset(role, overrides);
    } catch (error) {
      fatal(2, `golem pi: ${error.message}`);
    }
  } else if (effectiveProvider != null) {
    // Bare mode with a resolved profile: decompose the profile into the
    // provider/model/thinking flags Pi consumes. Raw --provider/--model already
    // won per-field above (D3); the profile's thinking remains in force unless
    // the caller passes a native override after `--`.
    presetArgs = [
      '--provider', effectiveProvider.trim(), '--model', effectiveModel.trim(),
      ...(profileExec?.thinking ? ['--thinking', profileExec.thinking] : []),
    ];
  }

  const childEnv = { ...process.env };
  const versionProbe = spawnSync('pi', ['--version'], { env: childEnv, encoding: 'utf8' });
  if (versionProbe.error?.code === 'ENOENT') fatal(1, "golem pi could not find the 'pi' executable on PATH; install @earendil-works/pi-coding-agent");
  if (versionProbe.status !== 0) fatal(1, `golem pi could not inspect Pi: ${(versionProbe.stderr || versionProbe.error?.message || 'unknown error').trim()}`);
  const piVersion = versionProbe.stdout.trim();
  if (piVersion !== SUPPORTED_PI_VERSION) {
    err(`WARN: Golem tested on Pi ${SUPPORTED_PI_VERSION}; you have ${piVersion || '(no version)'} — continuing`);
  }

  const extension = join(renderDirFor('pi'), 'golem.ts');
  if (!existsSync(extension)) fatal(1, `golem pi render is missing ${extension}; run golem sync --target pi`);

  const dashboard = await probeDashboard();
  if (!dashboard.ok) err(`golem pi: dashboard unavailable (${dashboard.error}); starting in degraded mode and tracker tools will fail until it returns`);

  Object.assign(childEnv, {
    // A managed spawn passes its worker id as the nonce and waits for it (GOL-382 R5).
    GOLEM_PI_LAUNCH_NONCE: process.env.GOLEM_PI_LAUNCH_NONCE || randomUUID(),
    GOLEM_PI_VERSION: piVersion,
    GOLEM_PI_EXTENSION_VERSION: readPackageVersion(),
    // Skip Pi's boot-time pi.dev catalog refresh: it hangs ~15s when pi.dev is
    // unreachable (the refresh aborts only at its 15s timeout). Catalogs come
    // from the stored models-store.json; refresh on demand by running
    // `pi --list-models` outside golem when pi.dev is reachable.
    PI_OFFLINE: '1',
  });
  const launchArgs = [
    '--extension', extension,
    ...presetArgs,
    ...(resume ? ['--session', resume.trim()] : []),
    ...passthrough,
  ];
  const child = spawn('pi', launchArgs, { cwd: process.cwd(), env: childEnv, stdio: 'inherit' });
  const onSigint = () => { /* native Pi owns terminal Ctrl-C turn semantics */ };
  const forward = (signal) => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  const onSigterm = () => forward('SIGTERM');
  const onSighup = () => forward('SIGHUP');
  process.on('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  process.once('SIGHUP', onSighup);
  let exitSignal = null;
  try {
    const outcome = await new Promise((resolveOutcome) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolveOutcome(value); } };
      child.once('error', (error) => finish({ error }));
      child.once('exit', (code, signal) => finish({ code, signal }));
    });
    if (outcome.error) {
      err(`golem pi could not start Pi: ${outcome.error.message}`);
      process.exitCode = 1;
      return;
    }
    if (Number.isInteger(outcome.code)) {
      if (outcome.code) process.exitCode = outcome.code;
      return;
    }
    exitSignal = outcome.signal;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.off('SIGHUP', onSighup);
  }
  if (exitSignal) process.kill(process.pid, exitSignal);
  else {
    err('golem pi: Pi exited without a status or signal');
    process.exitCode = 1;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'help';
  const rest = args.slice(1);

  if (removed.has(cmd)) {
    cmdRemoved(cmd);
    return;
  }

  switch (cmd) {
    case 'help':
    case '-h':
    case '--help':
      cmdHelp();
      break;
    case 'status':
      await cmdStatus(rest);
      break;
    case 'dashboard':
      await cmdDashboard(rest);
      break;
    case 'dashboard:restart':
      await cmdDashboardRestart(rest);
      break;
    case 'claude':
    case 'cc':
      await cmdClaude(rest);
      break;
    case 'pi':
      await cmdPi(rest);
      break;
    case 'agent': {
      const { runAgent } = await import('./agent.js');
      process.exitCode = await runAgent(cmd, rest);
      break;
    }
    case 'schedule':
    case 'message': {
      const { runCollaboration } = await import('./collaboration.js');
      process.exitCode = await runCollaboration(cmd, rest);
      break;
    }
    case 'team': {
      const { runTeam } = await import('./team.js');
      process.exitCode = await runTeam(cmd, rest);
      break;
    }
    case 'ticket': {
      const { runTicket } = await import('./ticket.js');
      process.exitCode = await runTicket(rest);
      break;
    }
    case 'migrate-home':
      await cmdMigrateHome(rest);
      break;
    case 'sync':
      await cmdSync(rest);
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    default:
      fatal(2, `Unknown command: ${cmd}\n\nRun \`golem help\` for available commands.`);
  }
}

main().catch((e) => fatal(1, e.stack || e.message));
