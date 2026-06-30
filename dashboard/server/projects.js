// Discover workspaces under the substrate's two roots:
//   - $GOLEM_PROJECTS_ROOT (default golem-projects/) — bootstrapped projects.
//   - $GOLEM_IDEAS_ROOT    (default golem-ideas/)    — ideation scratchpads.
// Each entry carries a `kind` field ('project' | 'idea'). A project is a child
// directory containing either a journal/ dir or a CLAUDE.md; an idea is any
// non-dotfile directory under the ideas root.
// We exclude `archive/` and dotfile-prefixed dirs from both roots.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { CONFIG } from './config.js';
import { colorFor, glyphFor } from './util.js';
import {
  projectIdFor,
  centralJournalDir,
  centralGatesDir,
} from './project-id.js';
import { planPath } from './plan.js';

const REGISTRY_FILE = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
  'golem',
  'projects.json',
);

const EXCLUDED = new Set(['archive', 'node_modules']);

const STALE_DAYS = CONFIG.projectStaleDays;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

async function dirExists(p) {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p) {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

// True for git worktrees: a .git file (not directory) points back to the main
// repo, and the checkout sits under .claude/worktrees/.
async function isWorktree(workspaceDir) {
  // A git worktree is signalled by `.git` being a *file* containing a
  // `gitdir:` pointer (created by `git worktree add`). A plain repo has
  // `.git` as a directory — that's NOT a worktree, just the repo itself.
  // The previous implementation treated both as worktrees, which incorrectly
  // filtered out the golem repo root (and any other regular repo) from the
  // sidebar when it was registered via the registry.
  const gitPath = path.join(workspaceDir, '.git');
  try {
    const st = await fs.stat(gitPath);
    if (st.isFile()) return true;
  } catch {
    /* no .git entry — not a worktree, not a repo */
  }
  if (workspaceDir.includes(path.sep + '.claude' + path.sep + 'worktrees' + path.sep)) return true;
  return false;
}

async function getLastSeenAt(workspaceDir) {
  try {
    const st = await fs.stat(workspaceDir);
    return st.mtime.getTime();
  } catch {
    return 0;
  }
}

// TKT-0107: composite activity signal — the maximum of four real-work signals
// so the sidebar can surface projects by recent activity rather than mtime.
// Order of priority (highest first; first non-zero wins as the floor, then
// everything else is taken as the max):
//   1. Live native-session heartbeat (overrides everything — a session
//      running means someone is actively working on the project right now).
//   2. Latest ticket updated_at for this project (from tracker.db).
//   3. Journal directory latest mtime (any file under the journal).
//   4. Latest git commit timestamp (if the project is a git repo).
//   5. Fallback: workspace directory mtime (existing behaviour).
async function getLastActivityAt({ workspaceDir, projectId, tracker, nativeSessions }) {
  let best = 0;
  // 1. live session heartbeat
  if (Array.isArray(nativeSessions)) {
    for (const s of nativeSessions) {
      const t = s?.last_seen_at ?? 0;
      if (t > best) best = t;
    }
  }
  // 2. latest ticket updated_at for this project
  try {
    if (tracker && typeof tracker.maxTicketUpdatedAt === 'function') {
      const t = tracker.maxTicketUpdatedAt(projectId);
      if (typeof t === 'number' && t > best) best = t;
    }
  } catch { /* ignore */ }
  // 3. journal directory latest mtime
  try {
    const central = centralJournalDir(projectId);
    const candidates = [];
    if (await dirExists(central)) candidates.push(central);
    if (await dirExists(path.join(workspaceDir, 'journal'))) {
      candidates.push(path.join(workspaceDir, 'journal'));
    }
    for (const dir of candidates) {
      const files = await fs.readdir(dir).catch(() => []);
      for (const f of files) {
        try {
          const st = await fs.stat(path.join(dir, f));
          if (st.mtimeMs && st.mtimeMs > best) best = st.mtimeMs;
        } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }
  // 4. latest git commit timestamp
  try {
    const commitTs = await lastGitCommitMs(workspaceDir);
    if (commitTs > best) best = commitTs;
  } catch { /* ignore */ }
  // 5. fallback: workspace mtime (only if everything else missed)
  if (best === 0) {
    best = await getLastSeenAt(workspaceDir);
  }
  return best;
}

// Run `git log -1 --format=%ct` to get the latest commit unix-seconds. Returns
// 0 when the project isn't a git repo or git isn't available.
async function lastGitCommitMs(workspaceDir) {
  if (!workspaceDir) return 0;
  try {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('git', ['log', '-1', '--format=%ct'], {
      cwd: workspaceDir, encoding: 'utf8', timeout: 1500,
    });
    if (r.status !== 0 || !r.stdout) return 0;
    const sec = Number.parseInt(r.stdout.trim(), 10);
    if (!Number.isFinite(sec) || sec <= 0) return 0;
    return sec * 1000;
  } catch { return 0; }
}

function isStale(lastSeenAt) {
  return lastSeenAt > 0 && Date.now() - lastSeenAt > STALE_MS;
}

// v4: resolve journal/summary/hook paths. Prefer the central location
// (~/.config/golem/journals/<project_id>/) when that dir exists on disk;
// otherwise fall back to the legacy in-repo <path>/journal/. The central dir is
// keyed by the contract project_id derived from the absolute project root —
// NOT the dashboard's own registry id, which may differ for legacy entries.
async function resolveJournalPaths(projectPath, contractId) {
  const central = centralJournalDir(contractId);
  if (await dirExists(central)) {
    return {
      journalDir: central,
      hookFile: path.join(central, 'hook.jsonl'),
      summaryFile: path.join(central, 'summary.jsonl'),
      journalCentral: true,
    };
  }
  const legacy = path.join(projectPath, 'journal');
  return {
    journalDir: legacy,
    hookFile: path.join(legacy, 'hook.jsonl'),
    summaryFile: path.join(legacy, 'summary.jsonl'),
    journalCentral: false,
  };
}

// v4: gates dir — central (~/.config/golem/gates/<project_id>/) when present,
// else legacy in-repo docs/agent-notes/gates/.
async function resolveGatesDir(projectPath, contractId) {
  const central = centralGatesDir(contractId);
  if (await dirExists(central)) return { gatesDir: central, gatesCentral: true };
  return {
    gatesDir: path.join(projectPath, 'docs', 'agent-notes', 'gates'),
    gatesCentral: false,
  };
}

// TKT-0194: parse a gate file's YAML frontmatter and body. Gates follow the
// format described in plugin/skills/gates/SKILL.md: frontmatter with
// gate_id, kind (approval|input), status (awaiting|approved|denied|cancelled),
// created_at, phase_just_completed, next_phase, target_file, required_keys —
// followed by a markdown body describing what was completed and what approval
// unlocks. Returns null if the file is missing or unreadable; returns a partial
// object on parse errors so a malformed gate still surfaces in the UI (better
// to show it than to silently drop it).
async function readGateFile(absPath) {
  let raw;
  try { raw = await fs.readFile(absPath, 'utf8'); } catch { return null; }
  if (!raw.startsWith('---')) return { gateId: path.basename(absPath, '.md'), path: absPath, body: raw, frontmatter: {}, status: 'unknown' };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { gateId: path.basename(absPath, '.md'), path: absPath, body: raw, frontmatter: {}, status: 'unknown' };
  const yaml = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();
  const fm = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const k = m[1];
    let v = m[2].trim();
    if (v === '') fm[k] = '';
    else if (/^\d{4}-\d{2}-\d{2}T/.test(v)) fm[k] = v;
    else if (v.startsWith('[') && v.endsWith(']')) fm[k] = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    else fm[k] = v;
  }
  return {
    gateId: fm.gate_id || path.basename(absPath, '.md'),
    path: absPath,
    body,
    frontmatter: fm,
    kind: fm.kind || 'approval',
    status: fm.status || 'awaiting',
    createdAt: fm.created_at || null,
    phaseJustCompleted: fm.phase_just_completed || null,
    nextPhase: fm.next_phase || null,
  };
}

// TKT-0194: read all gate files in a project's gatesDir. Returns a flat
// list of gate objects (empty if the dir doesn't exist or has no gates).
async function readGatesForProject(gatesDir) {
  if (!gatesDir) return [];
  let entries;
  try { entries = await fs.readdir(gatesDir, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const abs = path.join(gatesDir, e.name);
    const gate = await readGateFile(abs);
    if (gate) out.push(gate);
  }
  // Awaiting gates first (the action surface), then by createdAt desc.
  out.sort((a, b) => {
    if (a.status === 'awaiting' && b.status !== 'awaiting') return -1;
    if (b.status === 'awaiting' && a.status !== 'awaiting') return 1;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  return out;
}

async function readClaudeMdTitle(projectDir) {
  try {
    const md = await fs.readFile(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    const m = md.match(/^#\s+(.+?)\s*$/m);
    if (m) {
      const t = m[1].replace(/[`*_]/g, '').trim();
      if (t && !t.includes('{{')) return t;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function readDescription(projectDir) {
  // Prefer the first non-comment paragraph after "## What this project is".
  try {
    const md = await fs.readFile(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    const startIdx = md.search(/##\s+What this project is/m);
    if (startIdx !== -1) {
      const after = md.slice(startIdx).split(/\n##\s+/)[0]; // up to next heading
      // Strip HTML comments, then collect non-blank lines.
      const cleaned = after.replace(/<!--[\s\S]*?-->/g, '');
      const lines = cleaned.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
      const para = lines.join(' ');
      if (para && !para.includes('{{') && para.length > 8) return para.slice(0, 280);
    }
    // Fallback: README.md first sentence.
    try {
      const readme = await fs.readFile(path.join(projectDir, 'README.md'), 'utf8');
      const lines = readme.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
      if (lines[0]) return lines[0].slice(0, 280);
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function discoverFromRoot(root, kind, { requireSubstrate, tracker = null, nativeSessions = [] }) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || EXCLUDED.has(e.name)) continue;
    const workspaceDir = path.join(root, e.name);
    if (await isWorktree(workspaceDir)) continue;
    const journalDir = path.join(workspaceDir, 'journal');
    const claudeMd = path.join(workspaceDir, 'CLAUDE.md');
    let hasJournal = false;
    let hasClaudeMd = false;
    try { await fs.access(journalDir); hasJournal = true; } catch { /* ignore */ }
    try { await fs.access(claudeMd); hasClaudeMd = true; } catch { /* ignore */ }
    if (requireSubstrate && !hasJournal && !hasClaudeMd) continue;

    const id = `${kind === 'idea' ? 'idea:' : ''}${e.name}`;
    const title = (await readClaudeMdTitle(workspaceDir)) || e.name;
    const description = (await readDescription(workspaceDir)) || '';

    const contractId = projectIdFor(workspaceDir);
    const jp = await resolveJournalPaths(workspaceDir, contractId);
    const gd = await resolveGatesDir(workspaceDir, contractId);
    const lastActivityAt = await getLastActivityAt({ workspaceDir, projectId: contractId, tracker, nativeSessions });

    out.push({
      id,
      project_id: contractId,
      kind,
      name: title,
      glyph: glyphFor(title),
      color: colorFor(id),
      description,
      path: workspaceDir,
      // TKT-0107: composite activity signal (live session > ticket > journal
      // > git > workspace-mtime). Keep the legacy key name so the snapshot
      // and consumer code stay unchanged; downstream readers can rename.
      last_seen_at: lastActivityAt,
      last_activity_at: lastActivityAt,
      stale: isStale(lastActivityAt),
      journalDir: jp.journalDir,
      hookFile: jp.hookFile,
      summaryFile: jp.summaryFile,
      journalCentral: jp.journalCentral,
      trackerDir: path.join(workspaceDir, 'tracker'),
      gatesDir: gd.gatesDir,
      gatesCentral: gd.gatesCentral,
      // TKT-0194: surface the actual gate files (frontmatter + body) so
      // the project view can show awaiting gates and offer verdict actions.
      gates: await readGatesForProject(gd.gatesDir),
      agentNotesDir: path.join(workspaceDir, 'docs', 'agent-notes'),
      hasJournal: hasJournal || jp.journalCentral,
    });
  }
  return out;
}

// v4: the golem repo root is no longer treated as a special CEO workspace.
// Each live session self-registers, so there is no single "root" project to
// surface alongside the per-project workspaces. Keep this function as a no-op
// tombstone so callers don't need to change and the kind='root' concept can
// still be referenced in backwards-compatible filters.
async function discoverRoot() {
  return null;
}

// Read ~/.config/golem/projects.json and surface any registered project whose
// `path` isn't already discovered by the auto-scan. This is the v3 mechanism
// for external projects (e.g. trialroomai outside golem/golem-projects/).
async function discoverFromRegistry({ alreadyDiscoveredPaths, tracker = null, nativeSessions = [] }) {
  let raw;
  try {
    raw = await fs.readFile(REGISTRY_FILE, 'utf8');
  } catch {
    return [];
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.error(`[projects.js] failed to parse ${REGISTRY_FILE}:`, err.message);
    return [];
  }
  const out = [];
  for (const entry of json.projects ?? []) {
    if (!entry?.path || !entry?.id) continue;
    // NOTE: previously `kind === 'root'` was filtered here on the assumption
    // the root was surfaced separately by `discoverRoot()`. That synthetic
    // path was removed in TKT-0008 — the registry entry is the only place
    // the golem repo root is described, and skipping it makes the tracker
    // invisible to anyone working at the root (the dashboard / substrate
    // developer's primary workspace). Surface it like any other entry.
    if (alreadyDiscoveredPaths.has(entry.path)) continue;

    // Only surface if the path actually exists.
    try {
      await fs.access(entry.path);
    } catch {
      continue;
    }

    const workspaceDir = entry.path;
    if (await isWorktree(workspaceDir)) continue;
    // v4: kind:"auto" entries are hook-registered (registered_by:"hook") and
    // carry the contract project_id as their `id`. They render like external
    // projects. Manual entries keep their registered kind. Either way the
    // central journal/gates dirs are keyed by the contract project_id derived
    // from the absolute path — derive it here so it matches the hook's writes
    // even if the registry `id` was hand-edited.
    const contractId = projectIdFor(workspaceDir);
    const jp = await resolveJournalPaths(workspaceDir, contractId);
    const gd = await resolveGatesDir(workspaceDir, contractId);
    const lastActivityAt = await getLastActivityAt({ workspaceDir, projectId: contractId, tracker, nativeSessions });

    // The registry `name` is user-supplied via `golem project register` and is
    // authoritative. Prefer it. An external project's own CLAUDE.md is NOT a
    // golem harness file — its H1 is often literally "CLAUDE.md" or unrelated
    // to the project — so it must not override the registered name. Fall back
    // to the CLAUDE.md H1 only when the registry has no name at all.
    const title = entry.name || (await readClaudeMdTitle(workspaceDir)) || entry.id;
    const description = (await readDescription(workspaceDir)) || '';
    // kind:"auto" (hook-registered) renders like external projects.
    const kind = entry.kind === 'auto' ? 'external' : (entry.kind ?? 'external');

    out.push({
      id: entry.id,
      project_id: contractId,
      registered_by: entry.registered_by ?? null,
      auto: entry.kind === 'auto',
      kind,
      name: title,
      glyph: glyphFor(title),
      color: colorFor(entry.id),
      description,
      path: workspaceDir,
      // TKT-0107: composite activity signal (see getLastActivityAt above).
      // Keep the legacy key name so the snapshot stays shape-compatible; new
      // consumers should prefer last_activity_at.
      last_seen_at: lastActivityAt,
      last_activity_at: lastActivityAt,
      stale: isStale(lastActivityAt),
      journalDir: jp.journalDir,
      hookFile: jp.hookFile,
      summaryFile: jp.summaryFile,
      journalCentral: jp.journalCentral,
      trackerDir: path.join(workspaceDir, 'tracker'),
      gatesDir: gd.gatesDir,
      gatesCentral: gd.gatesCentral,
      // TKT-0194: see note in the auto-discover path above.
      gates: await readGatesForProject(gd.gatesDir),
      agentNotesDir: path.join(workspaceDir, 'docs', 'agent-notes'),
      hasJournal: jp.journalCentral || (await dirExists(jp.journalDir)),
    });
  }
  return out;
}

// Returns projects (from auto-scan AND the v3 registry) and ideas with a
// `kind` field on each entry. The synthetic kind='root' CEO workspace is no
// longer surfaced in v4.
// TKT-0194: apply a verdict to a gate file. Reads the file, updates the
// `status:` line in the frontmatter, appends `acted_at: <ISO>` if not
// present, and writes back. Atomic write (write to .tmp + rename) so a
// concurrent read sees either the old or new content, never a torn
// partial. The dashboard projects-list reads `gates` from the
// discoverProjects output and would re-discover on the next request.
async function applyGateVerdict(gatesDir, gateId, decision) {
  if (!['approved', 'denied', 'cancelled'].includes(decision)) {
    throw Object.assign(new Error(`invalid decision: ${decision}`), { status: 400 });
  }
  if (!gatesDir) throw Object.assign(new Error('gatesDir not set'), { status: 500 });
  // Gate files are .md; gateId may or may not include .md. Try both.
  const candidates = [
    path.join(gatesDir, gateId),
    path.join(gatesDir, `${gateId}.md`),
  ];
  let abs = null;
  for (const c of candidates) {
    try { const st = await fs.stat(c); if (st.isFile()) { abs = c; break; } } catch { /* keep looking */ }
  }
  if (!abs) throw Object.assign(new Error(`gate not found: ${gateId}`), { status: 404 });
  const raw = await fs.readFile(abs, 'utf8');
  if (!raw.startsWith('---')) {
    // Best-effort: prepend a frontmatter with the verdict.
    const newRaw = `---\nstatus: ${decision}\nacted_at: ${new Date().toISOString()}\n---\n\n${raw}`;
    await atomicWrite(abs, newRaw);
    return { gateId, path: abs, status: decision, frontmatter: { status: decision } };
  }
  const end = raw.indexOf('\n---', 3);
  if (end === -1) throw Object.assign(new Error('gate frontmatter malformed'), { status: 500 });
  const yaml = raw.slice(3, end);
  const body = raw.slice(end + 4);
  // Update or insert `status:` line; append `acted_at:` if not present.
  const lines = yaml.split('\n');
  let statusFound = false;
  let actedFound = false;
  const out = lines.map((l) => {
    if (/^status:\s*/.test(l)) { statusFound = true; return `status: ${decision}`; }
    if (/^acted_at:\s*/.test(l)) { actedFound = true; return l; }
    return l;
  });
  if (!statusFound) out.push(`status: ${decision}`);
  if (!actedFound) out.push(`acted_at: ${new Date().toISOString()}`);
  const newYaml = out.join('\n');
  const newRaw = `---\n${newYaml}\n---${body}`;
  await atomicWrite(abs, newRaw);
  return { gateId, path: abs, status: decision };
}

async function atomicWrite(absPath, content) {
  const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, absPath);
}

export async function discoverProjects({ tracker = null, nativeSessions = [] } = {}) {
  const [projects, ideas] = await Promise.all([
    discoverFromRoot(CONFIG.projectsRoot, 'project', { requireSubstrate: true, tracker, nativeSessions }),
    discoverFromRoot(CONFIG.ideasRoot, 'idea', { requireSubstrate: false, tracker, nativeSessions }),
  ]);
  const alreadyDiscoveredPaths = new Set([
    ...projects.map((p) => p.path),
    ...ideas.map((p) => p.path),
  ]);
  const external = await discoverFromRegistry({ alreadyDiscoveredPaths, tracker, nativeSessions });

  const all = [...projects, ...ideas, ...external];
  // Order: the golem repo root (its registry kind is the literal string "root")
  // sorts first — that's where dashboard / substrate work lives — then
  // projects (active recency, then stale alpha), then external, then ideas.
  const kindOrder = { root: -1, project: 0, external: 1, idea: 2 };
  all.sort((a, b) => {
    const oa = kindOrder[a.kind] ?? 9;
    const ob = kindOrder[b.kind] ?? 9;
    if (oa !== ob) return oa - ob;
    // Stale sinks to the bottom within each kind bucket.
    if (a.stale !== b.stale) return a.stale ? 1 : -1;
    // Active projects by recency descending; stale/others tie-break by name.
    if (!a.stale && a.last_seen_at && b.last_seen_at) {
      return (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0);
    }
    return a.id.localeCompare(b.id);
  });
  // v4: stamp the PLAN.md path on every workspace so the watcher can observe
  // it and state.js can read progress. (The file may not exist — readPlan
  // handles that; we only need the path to watch + read.)
  for (const p of all) {
    p.planFile = planPath(p.path);
  }
  return all;
}

// TKT-0194: re-export gate helpers so index.js can mount the verdict endpoint.
export { readGatesForProject, applyGateVerdict };
