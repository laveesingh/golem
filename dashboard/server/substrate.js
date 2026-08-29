import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as compiler from '../../lib/compiler/engine.js';
import * as ccAdapter from '../../lib/compiler/adapters/cc.js';
import * as ocAdapter from '../../lib/compiler/adapters/opencode.js';
import { loadConfig, saveConfig } from '../../lib/golem-config.js';
import { golemHome, projectsJsonPath, renderDirFor } from '../../lib/golem-home.js';
import { projectIdFor } from '../../lib/project-id.js';
import { listRoleCards, writeRoleCard } from '../../lib/session-role.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SUBSTRATE_ROOT = path.join(REPO_ROOT, 'substrate');
const SKILLS_ROOT = path.join(SUBSTRATE_ROOT, 'skills');
const INSTRUCTIONS_ROOT = path.join(SUBSTRATE_ROOT, 'instructions');
const ROLES_ROOT = path.join(SUBSTRATE_ROOT, 'roles');
const USER_SKILLS_ROOT = path.join(os.homedir(), '.agents', 'skills');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const SYNC_TIMEOUT_MS = 30_000;

function getRegisteredProjects() {
  try {
    const raw = fs.readFileSync(projectsJsonPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.projects) ? parsed.projects : [];
  } catch {
    return [];
  }
}

function sanitizeSlug(slug) {
  if (typeof slug !== 'string' || !slug.trim()) throw Object.assign(new Error('slug is required'), { statusCode: 400 });
  const cleaned = slug.trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(cleaned)) {
    throw Object.assign(new Error('slug must only contain lowercase alphanumeric characters, dashes, or underscores'), { statusCode: 400 });
  }
  return cleaned;
}

function parseFrontmatter(rawContent) {
  const match = String(rawContent || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: rawContent || '', raw: rawContent || '' };
  const yamlBlock = match[1];
  const body = match[2];
  const frontmatter = {};
  for (const line of yamlBlock.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      let val = line.slice(colon + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      frontmatter[key] = val;
    }
  }
  return { frontmatter, body, raw: rawContent };
}

function serializeFrontmatter(frontmatter, body) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(frontmatter || {})) {
    if (v != null && v !== '') {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---', '', String(body || '').trimStart());
  return lines.join('\n');
}

function scanSkillDir(dir, scope, projectMeta = null) {
  if (!fs.existsSync(dir)) return [];
  const list = [];
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const slug = ent.name;
      const skillMd = path.join(dir, slug, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      try {
        const stat = fs.statSync(skillMd);
        const raw = fs.readFileSync(skillMd, 'utf8');
        const { frontmatter, body } = parseFrontmatter(raw);
        list.push({
          slug,
          name: frontmatter.name || slug,
          description: frontmatter.description || '',
          frontmatter,
          scope, // 'builtin' | 'user' | 'project'
          project_id: projectMeta?.id || null,
          project_name: projectMeta?.name || null,
          project_path: projectMeta?.path || null,
          dir_path: path.join(dir, slug),
          rel_path: path.relative(REPO_ROOT, skillMd),
          size: stat.size,
          word_count: body.trim().split(/\s+/).filter(Boolean).length,
          updated_at: stat.mtime.toISOString(),
          has_templates: fs.existsSync(path.join(dir, slug, 'templates')),
        });
      } catch {}
    }
  } catch {}
  return list;
}

export function listSubstrateSkills({ pool = 'all', project = null } = {}) {
  const projects = getRegisteredProjects();
  const all = [
    ...scanSkillDir(SKILLS_ROOT, 'builtin'),
    ...scanSkillDir(USER_SKILLS_ROOT, 'user'),
    ...projects.flatMap((p) => (p.path ? scanSkillDir(path.join(p.path, '.agents', 'skills'), 'project', p) : [])),
  ];

  let result = all;
  if (pool === 'builtin') result = all.filter((s) => s.scope === 'builtin');
  else if (pool === 'user') result = all.filter((s) => s.scope === 'user');
  else if (pool === 'project') result = all.filter((s) => s.scope === 'project');

  if (project) {
    result = result.filter((s) => !s.project_id || s.project_id === project || s.project_name === project);
  }

  result.sort((a, b) => a.slug.localeCompare(b.slug));
  return result;
}

function resolveSkillLocation(slug, scope = null, projectId = null) {
  const cleaned = sanitizeSlug(slug);
  if (scope === 'user') {
    return { dir: path.join(USER_SKILLS_ROOT, cleaned), scope: 'user', project: null };
  }
  if (scope === 'project') {
    const projects = getRegisteredProjects();
    const p = projects.find((item) => item.id === projectId || item.name === projectId) || projects[0];
    if (!p?.path) throw Object.assign(new Error(`Project "${projectId}" not found for project skill`), { statusCode: 404 });
    return { dir: path.join(p.path, '.agents', 'skills', cleaned), scope: 'project', project: p };
  }
  if (scope === 'builtin') {
    return { dir: path.join(SKILLS_ROOT, cleaned), scope: 'builtin', project: null };
  }

  // Automatic search across pools
  const candidateBuiltin = path.join(SKILLS_ROOT, cleaned);
  if (fs.existsSync(path.join(candidateBuiltin, 'SKILL.md'))) {
    return { dir: candidateBuiltin, scope: 'builtin', project: null };
  }
  const candidateUser = path.join(USER_SKILLS_ROOT, cleaned);
  if (fs.existsSync(path.join(candidateUser, 'SKILL.md'))) {
    return { dir: candidateUser, scope: 'user', project: null };
  }
  for (const p of getRegisteredProjects()) {
    if (p.path) {
      const candidateProj = path.join(p.path, '.agents', 'skills', cleaned);
      if (fs.existsSync(path.join(candidateProj, 'SKILL.md'))) {
        return { dir: candidateProj, scope: 'project', project: p };
      }
    }
  }

  // Default to builtin if creating new without explicit scope
  return { dir: candidateBuiltin, scope: 'builtin', project: null };
}

export function getSubstrateSkill(slug, { scope = null, project = null } = {}) {
  const cleaned = sanitizeSlug(slug);
  const location = resolveSkillLocation(cleaned, scope, project);
  const skillMd = path.join(location.dir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    throw Object.assign(new Error(`Skill "${cleaned}" not found in scope "${location.scope}"`), { statusCode: 404 });
  }
  const stat = fs.statSync(skillMd);
  const raw = fs.readFileSync(skillMd, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);

  const files = [];
  function collectFiles(dir, rel = '') {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${f.name}` : f.name;
      if (f.isDirectory()) {
        collectFiles(path.join(dir, f.name), relPath);
      } else {
        files.push(relPath);
      }
    }
  }
  try { collectFiles(location.dir); } catch {}

  return {
    slug: cleaned,
    name: frontmatter.name || cleaned,
    description: frontmatter.description || '',
    frontmatter,
    body,
    raw,
    scope: location.scope,
    project_id: location.project?.id || null,
    project_name: location.project?.name || null,
    dir_path: location.dir,
    size: stat.size,
    word_count: body.trim().split(/\s+/).filter(Boolean).length,
    updated_at: stat.mtime.toISOString(),
    files,
  };
}

export function saveSubstrateSkill(slug, data = {}) {
  const cleaned = sanitizeSlug(slug);
  const location = resolveSkillLocation(cleaned, data.scope || null, data.project || data.project_id || null);
  fs.mkdirSync(location.dir, { recursive: true });
  const skillMd = path.join(location.dir, 'SKILL.md');

  let rawContent = '';
  if (typeof data.raw === 'string' && data.raw.trim()) {
    rawContent = data.raw;
  } else {
    const frontmatter = data.frontmatter || {
      name: data.name || cleaned,
      description: data.description || '',
    };
    rawContent = serializeFrontmatter(frontmatter, data.body || '');
  }

  fs.writeFileSync(skillMd, rawContent, 'utf8');
  return getSubstrateSkill(cleaned, { scope: location.scope, project: location.project?.id || null });
}

export function deleteSubstrateSkill(slug, { scope = null, project = null } = {}) {
  const cleaned = sanitizeSlug(slug);
  const location = resolveSkillLocation(cleaned, scope, project);
  if (!fs.existsSync(location.dir)) {
    throw Object.assign(new Error(`Skill "${cleaned}" not found in scope "${location.scope}"`), { statusCode: 404 });
  }
  fs.rmSync(location.dir, { recursive: true, force: true });
  return { ok: true, deleted: cleaned, scope: location.scope };
}

export function getSubstrateInstructions() {
  const filePath = path.join(INSTRUCTIONS_ROOT, 'AGENTS.md');
  if (!fs.existsSync(filePath)) {
    return { path: 'instructions/AGENTS.md', raw: '', size: 0, updated_at: null };
  }
  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath, 'utf8');
  return {
    path: 'instructions/AGENTS.md',
    raw,
    size: stat.size,
    word_count: raw.trim().split(/\s+/).filter(Boolean).length,
    updated_at: stat.mtime.toISOString(),
  };
}

export function saveSubstrateInstructions(data) {
  const filePath = path.join(INSTRUCTIONS_ROOT, 'AGENTS.md');
  fs.mkdirSync(INSTRUCTIONS_ROOT, { recursive: true });
  const content = typeof data === 'string' ? data : (data?.raw ?? data?.body ?? '');
  fs.writeFileSync(filePath, content, 'utf8');
  return getSubstrateInstructions();
}

export function listSubstrateRoles() {
  return listRoleCards().map((r) => ({
    role: r.name,
    name: r.name,
    color: r.color,
    glyph: r.glyph,
    builtin: !!r.builtin,
    overridden: !!r.overridden,
    body: r.body || '',
    default_path: r.default_path,
    overlay_path: r.overlay_path,
    updated_at: r.updated_at || null,
  }));
}

export function saveSubstrateRole(role, data) {
  const cleaned = sanitizeSlug(role);
  const content = typeof data === 'string' ? data : (data?.raw ?? data?.body ?? '');
  const result = writeRoleCard(cleaned, content);
  return {
    role: cleaned,
    name: cleaned,
    body: result.body,
    overridden: true,
    updated_at: result.updated_at,
  };
}

const TARGETS = [
  { id: 'claudecode', target: 'cc', label: 'Claude Code' },
  { id: 'opencode', target: 'opencode', label: 'opencode' },
];

const CAPABILITY_WARNINGS = {
  opencode: [
    'opencode has no Claude Code Stop-hook channel; lifecycle parity is provided by the runtime shim where opencode exposes events.',
    'opencode renders agents and skills into separate harness-native locations, plus a managed opencode.jsonc config fragment.',
  ],
};

const GLOBAL_ARTIFACTS = ['skills', 'agents', 'roles', 'commands', 'hooks', 'mcp', 'config-fragment', 'instructions'];

const MANAGED_ELSEWHERE = {
  opencode: {
    hooks: 'runtime shim',
    mcp: 'config merge',
  },
};

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version || null;
  } catch {
    return null;
  }
}

function readLockfile() {
  try { return compiler.readLockfile(); }
  catch { return { version: 1, targets: {}, projects: {} }; }
}

function lockKey(target, outDir) {
  return `${target}::${outDir}`;
}

function lockEntry(lock, target, outDir, projectId = null) {
  const bucket = projectId ? lock.projects?.[projectId]?.targets : lock.targets;
  return bucket?.[lockKey(target, outDir)] ?? null;
}

function statusFromDrift(res) {
  // Matrix cells check one artifact subset from a larger render target. Other
  // artifact lock entries appear as orphans in that subset, so cell drift is
  // determined by the subset's own changed/new/tampered files.
  if ((res.drifted ?? []).length === 0) return 'in_sync';
  if ((res.drifted ?? []).some((d) => d.reason === 'tampered')) return 'error';
  return 'drifted';
}

function summarizeDrift(res) {
  return {
    clean: !!res.clean,
    drifted: res.drifted ?? [],
    orphaned: res.orphaned ?? [],
    drifted_count: (res.drifted ?? []).length,
    orphaned_count: (res.orphaned ?? []).length,
  };
}

function cell({ harness, scope, artifact, target, outDir, items, enabled, projectId = null, config = null }) {
  const base = { harness, scope, artifact, target, out_dir: outDir, status: 'disabled', details: null, lock: null, warnings: CAPABILITY_WARNINGS[harness] ?? [] };
  if (!enabled) return base;
  try {
    const drift = compiler.checkDrift({ target, outDir, items, projectId });
    const entry = lockEntry(readLockfile(), target, outDir, projectId);
    return {
      ...base,
      status: statusFromDrift(drift),
      details: summarizeDrift(drift),
      lock: entry ? {
        synced_at: entry.synced_at ?? null,
        package_version: readLockfile().package_version ?? null,
        file_count: Object.keys(entry.files ?? {}).length,
      } : null,
      config,
    };
  } catch (err) {
    return { ...base, status: 'error', error: String(err?.message ?? err), config };
  }
}

function neutralCell({ harness, scope = 'global', artifact, target, enabled, status, label, details = null }) {
  return {
    harness,
    scope,
    artifact,
    target,
    out_dir: null,
    status: enabled ? status : 'disabled',
    label: enabled ? label : null,
    details,
    lock: null,
    warnings: CAPABILITY_WARNINGS[harness] ?? [],
  };
}

function artifactTypeForCc(relPath) {
  if (relPath.startsWith('skills/')) return 'skills';
  if (relPath.startsWith('agents/')) return 'agents';
  // Without this, cc role cards fall through to the config-fragment bucket and
  // are counted under the wrong label rather than not at all.
  if (relPath.startsWith('roles/')) return 'roles';
  if (relPath.startsWith('hooks/')) return 'hooks';
  if (relPath === '.mcp.json' || relPath.startsWith('mcp/')) return 'mcp';
  if (relPath.startsWith('.claude-plugin/') || relPath === 'README.md') return 'config-fragment';
  return 'config-fragment';
}

function splitItems(items, classifier) {
  const grouped = new Map();
  for (const item of items) {
    const kind = classifier(item.outputRelPath, item);
    const arr = grouped.get(kind) ?? [];
    arr.push(item);
    grouped.set(kind, arr);
  }
  return grouped;
}

function readProjects() {
  try {
    const json = JSON.parse(fs.readFileSync(projectsJsonPath(), 'utf8'));
    return Array.isArray(json.projects) ? json.projects.filter((p) => p.path) : [];
  } catch {
    return [];
  }
}

function resolveProject(projectValue) {
  if (!projectValue) return null;
  for (const p of readProjects()) {
    const pid = p.project_id || p.id || projectIdFor(p.path);
    if (projectValue === pid || projectValue === p.id || projectValue === p.path) return { ...p, project_id: pid };
  }
  return { id: projectValue, project_id: projectValue, path: projectValue };
}

function resolveOpencodeBin() {
  const probe = spawnSync('sh', ['-c', 'command -v opencode'], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  const fallback = path.join(process.env.HOME || '', '.opencode', 'bin', 'opencode');
  return fs.existsSync(fallback) ? fallback : null;
}

function opencodeVersion(bin = resolveOpencodeBin()) {
  if (!bin) return null;
  const res = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

function validateOpencodeConfig(bin) {
  if (!bin) return { ok: true, skipped: true };
  const res = spawnSync(bin, ['debug', 'config'], { encoding: 'utf8' });
  if (res.status === 0) return { ok: true };
  return { ok: false, error: (res.stderr || res.stdout || `exit ${res.status}`).trim() };
}

function buildStatus({ project = null } = {}) {
  const cfg = loadConfig();
  const lock = readLockfile();
  const version = packageVersion();
  const status = {
    generated_at: new Date().toISOString(),
    golem_home: golemHome(),
    package_version: version,
    lockfile: { version: lock.version ?? null, package_version: lock.package_version ?? null },
    config: substrateConfigShape(cfg),
    warnings: CAPABILITY_WARNINGS,
    global: [],
    projects: [],
    rollup: { in_sync: 0, drifted: 0, disabled: 0, error: 0 },
  };

  for (const row of globalCells(cfg)) status.global.push(row);
  for (const p of project ? [resolveProject(project)].filter(Boolean) : readProjects().map((p) => ({ ...p, project_id: p.project_id || p.id || projectIdFor(p.path) }))) {
    const cells = projectCells(cfg, p);
    if (cells.length) status.projects.push({ project_id: p.project_id, id: p.id ?? p.project_id, name: p.name ?? path.basename(p.path), path: p.path, cells });
  }

  for (const row of [...status.global, ...status.projects.flatMap((p) => p.cells)]) {
    status.rollup[row.status] = (status.rollup[row.status] ?? 0) + 1;
  }
  return status;
}

function globalCells(cfg) {
  const root = SUBSTRATE_ROOT;
  const rows = [];
  const ccEnabled = cfg.harnesses?.claudecode?.enabled !== false;
  const ccItems = ccAdapter.buildPlan({ substrateRoot: root, repoRoot: REPO_ROOT, packageVersion: packageVersion() });
  const ccGroups = splitItems(ccItems, artifactTypeForCc);
  const ccInstructionItems = ccAdapter.buildInstructionPlan({ substrateRoot: root });
  for (const artifact of GLOBAL_ARTIFACTS) {
    if (artifact === 'instructions') {
      rows.push(ccInstructionItems.length
        ? cell({ harness: 'claudecode', scope: 'global', artifact, target: 'cc-instructions', outDir: ccAdapter.instructionOutDir(), items: ccInstructionItems, enabled: ccEnabled })
        : neutralCell({ harness: 'claudecode', artifact, target: 'cc-instructions', enabled: ccEnabled, status: 'empty', label: 'empty', details: { clean: true, drifted_count: 0, orphaned_count: 0 } }));
      continue;
    }
    const items = ccGroups.get(artifact) ?? [];
    rows.push(items.length
      ? cell({ harness: 'claudecode', scope: 'global', artifact, target: 'cc', outDir: renderDirFor('cc'), items, enabled: ccEnabled })
      : neutralCell({ harness: 'claudecode', artifact, target: 'cc', enabled: ccEnabled, status: 'empty', label: 'empty', details: { clean: true, drifted_count: 0, orphaned_count: 0 } }));
  }

  const ocEnabled = !!cfg.harnesses?.opencode?.enabled;
  const ocAgentItems = ocAdapter.buildAgentPlan({ substrateRoot: root });
  const ocSkillItems = ocAdapter.buildSkillPlan({ substrateRoot: root });
  const ocRoleItems = ocAdapter.buildRolePlan({ substrateRoot: root });
  const ocInstructionItems = ocAdapter.buildInstructionPlan({ substrateRoot: root });
  const ocRows = new Map([
    ['agents', cell({ harness: 'opencode', scope: 'global', artifact: 'agents', target: 'opencode', outDir: ocAdapter.agentOutDir(), items: ocAgentItems, enabled: ocEnabled, config: { testedVersion: cfg.harnesses?.opencode?.testedVersion ?? null, currentVersion: opencodeVersion() } })],
    ['skills', cell({ harness: 'opencode', scope: 'global', artifact: 'skills', target: 'opencode', outDir: ocAdapter.skillsOutDir(), items: ocSkillItems, enabled: ocEnabled })],
    ['roles', cell({ harness: 'opencode', scope: 'global', artifact: 'roles', target: 'opencode', outDir: ocAdapter.rolesOutDir(), items: ocRoleItems, enabled: ocEnabled })],
    ['instructions', cell({ harness: 'opencode', scope: 'global', artifact: 'instructions', target: 'opencode-instructions', outDir: ocAdapter.instructionOutDir(), items: ocInstructionItems, enabled: ocEnabled })],
    ['config-fragment', opencodeConfigCell(cfg, ocEnabled)],
  ]);
  for (const artifact of GLOBAL_ARTIFACTS) {
    rows.push(ocRows.get(artifact) ?? neutralCell({
      harness: 'opencode',
      artifact,
      target: 'opencode',
      enabled: ocEnabled,
      status: MANAGED_ELSEWHERE.opencode[artifact] ? 'managed' : 'empty',
      label: MANAGED_ELSEWHERE.opencode[artifact] ?? 'empty',
      details: { clean: true, drifted_count: 0, orphaned_count: 0 },
    }));
  }
  return rows;
}

function opencodeConfigCell(cfg, enabled) {
  const outDir = path.dirname(ocAdapter.opencodeConfigPath());
  const base = { harness: 'opencode', scope: 'global', artifact: 'config-fragment', target: 'opencode', out_dir: ocAdapter.opencodeConfigPath(), status: enabled ? 'in_sync' : 'disabled', details: null, lock: null, warnings: CAPABILITY_WARNINGS.opencode, config: { testedVersion: cfg.harnesses?.opencode?.testedVersion ?? null, currentVersion: opencodeVersion() } };
  if (!enabled) return base;
  try {
    const current = fs.existsSync(ocAdapter.opencodeConfigPath()) ? fs.readFileSync(ocAdapter.opencodeConfigPath(), 'utf8') : '';
    const next = ocAdapter.computeConfigText(current || '{\n  "$schema": "https://opencode.ai/config.json"\n}\n', ocAdapter.buildConfigMerge({ repoRoot: REPO_ROOT }));
    return { ...base, status: current === next ? 'in_sync' : 'drifted', out_dir: outDir, details: { clean: current === next, drifted_count: current === next ? 0 : 1, orphaned_count: 0 } };
  } catch (err) {
    return { ...base, status: 'error', error: String(err?.message ?? err) };
  }
}

function projectCells(cfg, project) {
  if (!project?.path) return [];
  const root = SUBSTRATE_ROOT;
  const rows = [];
  const projectId = project.project_id || project.id || projectIdFor(project.path);
  const ccEnabled = cfg.harnesses?.claudecode?.enabled !== false;
  const ccItems = ccAdapter.buildProjectPlan({ substrateRoot: root });
  if (ccItems.length) rows.push(cell({ harness: 'claudecode', scope: 'project', artifact: 'config-fragment', target: 'cc', outDir: project.path, items: ccItems, enabled: ccEnabled, projectId }));

  const ocEnabled = !!cfg.harnesses?.opencode?.enabled;
  const ocAgentItems = ocAdapter.buildProjectAgentPlan({ substrateRoot: root });
  const ocSkillItems = ocAdapter.buildProjectSkillPlan({ substrateRoot: root });
  if (ocAgentItems.length) rows.push(cell({ harness: 'opencode', scope: 'project', artifact: 'agents', target: 'opencode', outDir: ocAdapter.projectAgentOutDir(project.path), items: ocAgentItems, enabled: ocEnabled, projectId }));
  if (ocSkillItems.length) rows.push(cell({ harness: 'opencode', scope: 'project', artifact: 'skills', target: 'opencode', outDir: ocAdapter.projectSkillsOutDir(project.path), items: ocSkillItems, enabled: ocEnabled, projectId }));
  return rows;
}

function substrateConfigShape(cfg = loadConfig()) {
  return {
    harnesses: Object.fromEntries(Object.entries(cfg.harnesses ?? {}).map(([id, h]) => [id, {
      enabled: !!h?.enabled,
      modelMap: h?.modelMap ?? {},
      testedVersion: h?.testedVersion ?? null,
    }])),
  };
}

function validateConfigPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('body must be an object'), { statusCode: 400 });
  if (body.harnesses != null && (typeof body.harnesses !== 'object' || Array.isArray(body.harnesses))) throw Object.assign(new Error('harnesses must be an object'), { statusCode: 400 });
  for (const [id, h] of Object.entries(body.harnesses ?? {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw Object.assign(new Error(`invalid harness id: ${id}`), { statusCode: 400 });
    if (h == null || typeof h !== 'object' || Array.isArray(h)) throw Object.assign(new Error(`harness ${id} must be an object`), { statusCode: 400 });
    if ('enabled' in h && typeof h.enabled !== 'boolean') throw Object.assign(new Error(`harness ${id}.enabled must be boolean`), { statusCode: 400 });
    if ('modelMap' in h && (typeof h.modelMap !== 'object' || Array.isArray(h.modelMap) || h.modelMap == null)) throw Object.assign(new Error(`harness ${id}.modelMap must be an object`), { statusCode: 400 });
  }
}

function mergeConfigPatch(current, patch) {
  const next = { ...current, harnesses: { ...(current.harnesses ?? {}) } };
  for (const [id, h] of Object.entries(patch.harnesses ?? {})) {
    next.harnesses[id] = { ...(next.harnesses[id] ?? {}), ...h };
  }
  return next;
}

function renderSummary(res) {
  return { written: res.written.length, unchanged: res.unchanged.length, pruned: res.pruned.length, tampered: res.tampered.length, tampered_files: res.tampered };
}

function syncTarget({ harness, project = null, force = false }) {
  const cfg = loadConfig();
  const started = Date.now();
  const targetDef = TARGETS.find((t) => t.id === harness || t.target === harness);
  if (!targetDef) throw Object.assign(new Error(`unknown target: ${harness}`), { statusCode: 400 });
  if (targetDef.id === 'opencode' && !cfg.harnesses?.opencode?.enabled) return { harness: targetDef.id, skipped: true, status: 'disabled' };
  if (targetDef.id === 'claudecode' && cfg.harnesses?.claudecode?.enabled === false) return { harness: targetDef.id, skipped: true, status: 'disabled' };

  const root = SUBSTRATE_ROOT;
  const pkg = packageVersion();
  const results = [];
  const p = project ? resolveProject(project) : null;
  if (Date.now() - started > SYNC_TIMEOUT_MS) throw new Error('sync timed out before start');

  if (targetDef.id === 'claudecode') {
    if (p) {
      const items = ccAdapter.buildProjectPlan({ substrateRoot: root });
      const res = compiler.render({ target: 'cc', outDir: p.path, items, packageVersion: pkg, force, projectId: p.project_id || p.id || projectIdFor(p.path) });
      results.push({ artifact: 'project', out_dir: p.path, ...renderSummary(res) });
    } else {
      const outDir = renderDirFor('cc');
      const items = ccAdapter.buildPlan({ substrateRoot: root, repoRoot: REPO_ROOT, packageVersion: pkg });
      const res = compiler.render({ target: 'cc', outDir, items, packageVersion: pkg, force });
      ccAdapter.syncMcpChannelDeps({ repoRoot: REPO_ROOT, outDir });
      results.push({ artifact: 'global', out_dir: outDir, ...renderSummary(res) });
      const instructionItems = ccAdapter.buildInstructionPlan({ substrateRoot: root });
      const instructionOutDir = ccAdapter.instructionOutDir();
      results.push({ artifact: 'instructions', out_dir: instructionOutDir, ...renderSummary(compiler.render({ target: 'cc-instructions', outDir: instructionOutDir, items: instructionItems, packageVersion: pkg, force })) });
    }
  }

  if (targetDef.id === 'opencode') {
    if (p) {
      const projectId = p.project_id || p.id || projectIdFor(p.path);
      const agentItems = ocAdapter.buildProjectAgentPlan({ substrateRoot: root });
      const skillItems = ocAdapter.buildProjectSkillPlan({ substrateRoot: root });
      results.push({ artifact: 'agents', out_dir: ocAdapter.projectAgentOutDir(p.path), ...renderSummary(compiler.render({ target: 'opencode', outDir: ocAdapter.projectAgentOutDir(p.path), items: agentItems, packageVersion: pkg, force, projectId })) });
      results.push({ artifact: 'skills', out_dir: ocAdapter.projectSkillsOutDir(p.path), ...renderSummary(compiler.render({ target: 'opencode', outDir: ocAdapter.projectSkillsOutDir(p.path), items: skillItems, packageVersion: pkg, force, projectId })) });
    } else {
      const agentItems = ocAdapter.buildAgentPlan({ substrateRoot: root });
      const skillItems = ocAdapter.buildSkillPlan({ substrateRoot: root });
      // Roles are a separate (target, outDir) bucket for opencode. `golem sync
      // --check` and `golem doctor` both check it, so a dashboard sync that
      // skipped it would leave permanent drift and a red doctor with no way to
      // clear it from the dashboard. cc and codex carry roles inside their
      // single buildPlan, which is why only opencode needs this.
      const roleItems = ocAdapter.buildRolePlan({ substrateRoot: root });
      const instructionItems = ocAdapter.buildInstructionPlan({ substrateRoot: root });
      results.push({ artifact: 'agents', out_dir: ocAdapter.agentOutDir(), ...renderSummary(compiler.render({ target: 'opencode', outDir: ocAdapter.agentOutDir(), items: agentItems, packageVersion: pkg, force })) });
      results.push({ artifact: 'skills', out_dir: ocAdapter.skillsOutDir(), ...renderSummary(compiler.render({ target: 'opencode', outDir: ocAdapter.skillsOutDir(), items: skillItems, packageVersion: pkg, force })) });
      results.push({ artifact: 'roles', out_dir: ocAdapter.rolesOutDir(), ...renderSummary(compiler.render({ target: 'opencode', outDir: ocAdapter.rolesOutDir(), items: roleItems, packageVersion: pkg, force })) });
      results.push({ artifact: 'instructions', out_dir: ocAdapter.instructionOutDir(), ...renderSummary(compiler.render({ target: 'opencode-instructions', outDir: ocAdapter.instructionOutDir(), items: instructionItems, packageVersion: pkg, force })) });
      const bin = resolveOpencodeBin();
      const merge = ocAdapter.buildConfigMerge({ repoRoot: REPO_ROOT });
      const configRes = ocAdapter.applyConfigMerge({ configPath: ocAdapter.opencodeConfigPath(), merge, validate: () => validateOpencodeConfig(bin) });
      if (configRes.restored) throw new Error(`opencode config validation failed: ${configRes.error}`);
      if (bin) {
        const ver = opencodeVersion(bin);
        if (ver) {
          const next = loadConfig();
          next.harnesses = next.harnesses ?? {};
          next.harnesses.opencode = { ...next.harnesses.opencode, testedVersion: ver };
          saveConfig(next);
        }
      }
      results.push({ artifact: 'config-fragment', out_dir: ocAdapter.opencodeConfigPath(), changed: !!configRes.changed, validation_skipped: !bin });
    }
  }

  return { harness: targetDef.id, status: 'ok', elapsed_ms: Date.now() - started, results };
}

export async function registerSubstrateRoutes(fastify) {
  fastify.get('/api/substrate/config', async () => substrateConfigShape(loadConfig()));

  fastify.put('/api/substrate/config', async (req, reply) => {
    try {
      validateConfigPatch(req.body ?? {});
      const next = mergeConfigPatch(loadConfig(), req.body ?? {});
      saveConfig(next);
      return substrateConfigShape(next);
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.get('/api/substrate/status', async (req) => buildStatus({ project: req.query?.project || null }));

  fastify.post('/api/substrate/sync', async (req, reply) => {
    const body = req.body ?? {};
    const targets = body.target ? [body.target] : TARGETS.map((t) => t.id);
    const out = { generated_at: new Date().toISOString(), timeout_ms: SYNC_TIMEOUT_MS, project: body.project || null, results: [] };
    try {
      for (const target of targets) out.results.push(syncTarget({ harness: target, project: body.project || null, force: body.force === true }));
      out.status = out.results.some((r) => r.status === 'ok') ? 'ok' : 'skipped';
      return out;
    } catch (err) {
      out.status = 'error';
      out.error = String(err?.message ?? err);
      return reply.code(err.statusCode || 500).send(out);
    }
  });

  // GOL-2: Substrate Skills CRUD
  fastify.get('/api/substrate/skills', async () => listSubstrateSkills());

  fastify.get('/api/substrate/skills/:slug', async (req, reply) => {
    try {
      return getSubstrateSkill(req.params.slug);
    } catch (err) {
      return reply.code(err.statusCode || 500).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.post('/api/substrate/skills', async (req, reply) => {
    try {
      const b = req.body ?? {};
      const slug = b.slug || b.name;
      const skill = saveSubstrateSkill(slug, b);
      return reply.code(201).send(skill);
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.put('/api/substrate/skills/:slug', async (req, reply) => {
    try {
      return saveSubstrateSkill(req.params.slug, req.body ?? {});
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: String(err?.message ?? err) });
    }
  });

  fastify.delete('/api/substrate/skills/:slug', async (req, reply) => {
    try {
      return deleteSubstrateSkill(req.params.slug);
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: String(err?.message ?? err) });
    }
  });

  // GOL-2: Substrate Instructions
  fastify.get('/api/substrate/instructions', async () => getSubstrateInstructions());

  fastify.put('/api/substrate/instructions', async (req, reply) => {
    try {
      return saveSubstrateInstructions(req.body ?? {});
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: String(err?.message ?? err) });
    }
  });

  // GOL-2: Substrate Roles
  fastify.get('/api/substrate/roles', async () => listSubstrateRoles());

  fastify.put('/api/substrate/roles/:role', async (req, reply) => {
    try {
      return saveSubstrateRole(req.params.role, req.body ?? {});
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: String(err?.message ?? err) });
    }
  });
}
