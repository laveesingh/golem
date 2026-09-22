// Claude Code adapter (TKT-0574, ADR-2/ADR-3). Builds the RenderItem plan
// that lib/compiler/engine.js writes into a CC plugin bundle layout:
//   skills/<name>/SKILL.md (+ assets), agents/*.md, hooks/{hooks.json,*.sh},
//   .mcp.json, .claude-plugin/plugin.json, README.md, mcp/channel/*.
//
// P2 sources carry no template markers — every text file is a verbatim copy
// of its substrate/ source plus (where it's safe — see below) a GENERATED
// header. Content is never rewritten beyond that; the parity gate depends on
// it.
//
// GENERATED-header placement was chosen by checking, not guessing, what each
// format tolerates:
//   - .md WITH YAML frontmatter (skills/SKILL.md, agents/*.md): an HTML
//     comment as the first line of the body, right after the closing `---`.
//     Frontmatter itself is untouched (keeps `name`/`description` parsing
//     unaffected); the comment is inert prose in the body either way.
//   - README.md (no frontmatter): the comment as the file's first line.
//   - shell scripts: a `#` comment line right after the shebang.
//   - tracker template assets (skills/tracker/templates/*.md): NO header —
//     the dashboard's GET /api/templates serves these verbatim as ticket
//     body prefills; a header would leak into real ticket content.
//   - JSON (hooks.json, .mcp.json, plugin.json, marketplace.json): NO header.
//     `$comment` is a valid key per the *published JSON Schema*
//     (json.schemastore.org), but `claude plugin validate --strict` (the
//     actual tool, checked in TKT-0575) flags it as an "unknown field" —
//     harmless (Claude Code ignores it at load time) but it fails strict
//     validation, which golem doctor/CI wants to be able to run clean. The
//     schema and the real validator disagree here; the real tool wins.
//     Tamper detection for all JSON outputs relies solely on the lockfile's
//     output hash.
//   - mcp/channel/*.js: verbatim copy, no header — these are real npm
//     package sources copied as-is, not templated artifacts.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import matter from 'gray-matter';
import { sha256, sha256File, applyTemplate } from '../engine.js';

// Dialect flags for the engine's {{#if <flag>}} templating. Skill bodies may
// GOL-365: the {{#if claudecode}} branches remain for harness-specific text.

const GENERATED_NOTE = 'rendered by `golem sync` from substrate/ — edit the source, not this file.';

function htmlComment(relSourcePath) {
  return `<!-- GENERATED: ${relSourcePath} — ${GENERATED_NOTE} -->\n`;
}
function shComment(relSourcePath) {
  return `# GENERATED: ${relSourcePath} — ${GENERATED_NOTE}\n`;
}

/** Insert `headerLine` as the first line of the body, right after YAML frontmatter (if present) or at the top of the file. */
function insertHeader(text, headerLine) {
  const fmEnd = frontmatterEnd(text);
  if (fmEnd === -1) return headerLine + text;
  return text.slice(0, fmEnd) + headerLine + text.slice(fmEnd);
}

/** Index right after the frontmatter's closing `---` line (+ its newline), or -1 if there's no frontmatter. */
function frontmatterEnd(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return -1;
  const m = text.slice(4).match(/\r?\n---\r?\n/);
  if (!m) return -1;
  return 4 + m.index + m[0].length;
}

function stripScopeFrontmatter(text) {
  const end = frontmatterEnd(text);
  if (end === -1) return text;
  const head = text.slice(0, end).replace(/^scope:\s*(global|project)\s*\r?\n/gm, '');
  return head + text.slice(end);
}

function scopeOfMarkdown(abs) {
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    const scope = matter(raw).data?.scope;
    return scope === 'project' ? 'project' : 'global';
  } catch {
    return 'global';
  }
}

function scopeOfJson(abs) {
  try {
    const scope = JSON.parse(fs.readFileSync(abs, 'utf8'))?.scope;
    return scope === 'project' ? 'project' : 'global';
  } catch {
    return 'global';
  }
}

function skillDirScope(skillDir) {
  return scopeOfMarkdown(path.join(skillDir, 'SKILL.md'));
}

function listFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(abs));
    else out.push(abs);
  }
  return out;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * @param {object} ctx
 * @param {string} ctx.substrateRoot - absolute path to substrate/
 * @param {string} ctx.repoRoot - absolute path to the repo root
 * @param {string} ctx.packageVersion - root package.json version, stamped into plugin.json
 * @returns {Array} RenderItems (see engine.js render())
 */
export function buildPlan({ substrateRoot, repoRoot, packageVersion }) {
  const items = [];

  // --- skills/ (SKILL.md gets a header; every other asset is verbatim) ----
  const skillsDir = path.join(substrateRoot, 'skills');
  for (const abs of listFilesRecursive(skillsDir)) {
    const rel = path.relative(substrateRoot, abs); // e.g. skills/gates/SKILL.md
    const skillRoot = path.join(skillsDir, path.relative(skillsDir, abs).split(path.sep)[0]);
    if (skillDirScope(skillRoot) === 'project') continue;
    const srcSha = sha256File(abs);
    const isSkillDoc = path.basename(abs) === 'SKILL.md';
    items.push({
      key: rel,
      outputRelPath: rel,
      sourceSha256: srcSha,
      build: () => {
        const text = stripScopeFrontmatter(fs.readFileSync(abs, 'utf8'));
        // Only SKILL.md bodies are templated; other assets (tracker templates)
        // are verbatim ticket-prefill content and must not be touched.
        return isSkillDoc
          ? insertHeader(applyTemplate(text, HARNESS_CONTEXT), htmlComment(rel))
          : text;
      },
    });
  }

  // --- agents/*.md (header after frontmatter) ------------------------------
  const agentsDir = path.join(substrateRoot, 'agents');
  for (const abs of listFilesRecursive(agentsDir)) {
    if (scopeOfMarkdown(abs) === 'project') continue;
    const rel = path.relative(substrateRoot, abs);
    items.push({
      key: rel,
      outputRelPath: rel,
      sourceSha256: sha256File(abs),
      build: () => insertHeader(stripScopeFrontmatter(fs.readFileSync(abs, 'utf8')), htmlComment(rel)),
    });
  }

  // --- hooks/ (hooks.json verbatim; *.sh gets a header after the shebang) --
  const hooksDir = path.join(substrateRoot, 'hooks');
  for (const abs of listFilesRecursive(hooksDir)) {
    const rel = path.relative(substrateRoot, abs); // e.g. hooks/journal-route.sh
    const isShellScript = abs.endsWith('.sh');
    items.push({
      key: rel,
      outputRelPath: rel,
      sourceSha256: sha256File(abs),
      mode: isShellScript ? 0o755 : undefined,
      build: () => {
        const text = fs.readFileSync(abs, 'utf8');
        if (!isShellScript) return text; // hooks.json — verbatim, no header
        const lines = text.split('\n');
        const shebangEnd = lines[0].startsWith('#!') ? 1 : 0;
        lines.splice(shebangEnd, 0, shComment(rel).trimEnd());
        return lines.join('\n');
      },
    });
  }

  // --- roles/ (compact boot cards, verbatim; 15-line budget matters) --------
  const rolesDir = path.join(substrateRoot, 'roles');
  if (fs.existsSync(rolesDir)) {
    for (const abs of listFilesRecursive(rolesDir)) {
      if (!abs.endsWith('.md')) continue;
      const rel = path.relative(substrateRoot, abs);
      items.push({
        key: rel,
        outputRelPath: rel,
        sourceSha256: sha256File(abs),
        build: () => fs.readFileSync(abs, 'utf8'),
      });
    }
  }

  // --- instructions/ runtime assets used by hooks ---------------------------
  const trackerContextAbs = path.join(substrateRoot, 'instructions', 'tracker-context.md');
  if (fs.existsSync(trackerContextAbs)) {
    items.push({
      key: 'instructions/tracker-context.md',
      outputRelPath: path.join('instructions', 'tracker-context.md'),
      sourceSha256: sha256File(trackerContextAbs),
      build: () => applyTemplate(fs.readFileSync(trackerContextAbs, 'utf8'), HARNESS_CONTEXT),
    });
  }

  // --- .mcp.json (verbatim) -------------------------------------------------
  const mcpJsonAbs = path.join(substrateRoot, 'mcp.json');
  if (scopeOfJson(mcpJsonAbs) !== 'project') {
    items.push({
      key: 'mcp.json',
      outputRelPath: '.mcp.json',
      sourceSha256: sha256File(mcpJsonAbs),
      build: () => fs.readFileSync(mcpJsonAbs, 'utf8'),
    });
  }

  // --- .claude-plugin/plugin.json (plugin-meta.json + package version) -----
  const metaAbs = path.join(substrateRoot, 'plugin-meta.json');
  const metaRaw = fs.readFileSync(metaAbs, 'utf8');
  items.push({
    key: 'plugin-meta.json+version',
    outputRelPath: path.join('.claude-plugin', 'plugin.json'),
    sourceSha256: sha256(metaRaw + '\n' + packageVersion),
    build: () => {
      const meta = JSON.parse(metaRaw);
      const { $schema, name, displayName, description, author, license, keywords } = meta;
      const doc = {
        $schema,
        name,
        displayName,
        version: packageVersion,
        description,
        author,
        license,
        keywords,
      };
      // JSON.stringify multi-lines every array; the hand-authored original
      // kept `keywords` compact. Collapse it back so the only diff vs the
      // original really is the version line (parity discipline).
      const pretty = JSON.stringify(doc, null, 2);
      const compact = pretty.replace(
        /"keywords": \[\n(\s*"[^"]*",?\n)+\s*\]/,
        `"keywords": [${keywords.map((k) => JSON.stringify(k)).join(', ')}]`,
      );
      return compact + '\n';
    },
  });

  // --- README.md (header as the first line — no frontmatter) ---------------
  const readmeAbs = path.join(substrateRoot, 'README.md');
  items.push({
    key: 'README.md',
    outputRelPath: 'README.md',
    sourceSha256: sha256File(readmeAbs),
    build: () => htmlComment('README.md') + '\n' + fs.readFileSync(readmeAbs, 'utf8'),
  });

  // --- mcp/channel/ (real npm package, copied as-is; node_modules handled
  // separately by syncMcpChannelDeps — not per-file lockfile-tracked) -------
  const mcpChannelDir = path.join(repoRoot, 'mcp', 'channel');
  for (const name of ['index.js', 'identity.js', 'tracker-client.js', 'tracker-client.test.mjs', 'package.json', 'package-lock.json']) {
    const abs = path.join(mcpChannelDir, name);
    if (!fs.existsSync(abs)) continue;
    const rel = path.join('mcp', 'channel', name);
    items.push({
      key: rel,
      outputRelPath: rel,
      sourceSha256: sha256File(abs),
      build: () => {
        const text = fs.readFileSync(abs, 'utf8');
        // This test is copied one directory shallower into plugin/mcp/channel;
        // keep its dashboard fixture path valid without editing the source test.
        return name === 'tracker-client.test.mjs'
          ? text.replaceAll("../../dashboard/server/", "../../../dashboard/server/")
          : text;
      },
    });
  }

  // --- lib/ runtime helpers imported by mcp/channel ------------------------
  for (const name of [
    'session-role.js', 'golem-home.js', 'project-id.js', 'session-facts.js', 'session-facts-write.js',
    'golem-client.js', 'golem-tool-contracts.js', 'golem-tool-runtime.js', 'claude-session-context.js',
  ]) {
    const abs = path.join(repoRoot, 'lib', name);
    if (!fs.existsSync(abs)) continue;
    const rel = path.join('lib', name);
    items.push({
      key: rel,
      outputRelPath: rel,
      sourceSha256: sha256File(abs),
      build: () => fs.readFileSync(abs, 'utf8'),
    });
  }

  return items;
}

export function instructionOutDir() {
  return os.homedir();
}

export function buildInstructionPlan({ substrateRoot }) {
  const items = [];
  const abs = path.join(substrateRoot, 'instructions', 'AGENTS.md');
  if (fs.existsSync(abs)) items.push({
    key: 'instructions:AGENTS.md',
    outputRelPath: path.join('.claude', 'CLAUDE.md'),
    sourceSha256: sha256File(abs),
    type: 'block',
    beginMarker: INSTRUCTIONS_BEGIN,
    endMarker: INSTRUCTIONS_END,
    build: () => applyTemplate(fs.readFileSync(abs, 'utf8'), HARNESS_CONTEXT),
  });
  const trackerContextAbs = path.join(substrateRoot, 'instructions', 'tracker-context.md');
  if (fs.existsSync(trackerContextAbs)) items.push({
    key: 'instructions:tracker-context.md',
    outputRelPath: path.join('.claude', 'tracker-context.md'),
    sourceSha256: sha256File(trackerContextAbs),
    build: () => applyTemplate(fs.readFileSync(trackerContextAbs, 'utf8'), HARNESS_CONTEXT),
  });
  return items;
}

/** Project-scoped CC items render into a project root: .claude/skills and .claude/agents. */
export function buildProjectPlan({ substrateRoot }) {
  const items = [];

  const skillsDir = path.join(substrateRoot, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const abs of listFilesRecursive(skillsDir)) {
      const relWithinSkills = path.relative(skillsDir, abs);
      const skillRoot = path.join(skillsDir, relWithinSkills.split(path.sep)[0]);
      if (skillDirScope(skillRoot) !== 'project') continue;
      const rel = path.join('skills', relWithinSkills);
      const isSkillDoc = path.basename(abs) === 'SKILL.md';
      items.push({
        key: rel,
        outputRelPath: path.join('.claude', 'skills', relWithinSkills),
        sourceSha256: sha256File(abs),
        build: () => {
          const text = stripScopeFrontmatter(fs.readFileSync(abs, 'utf8'));
          return isSkillDoc
            ? insertHeader(applyTemplate(text, HARNESS_CONTEXT), htmlComment(rel))
            : text;
        },
      });
    }
  }

  const agentsDir = path.join(substrateRoot, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const abs of listFilesRecursive(agentsDir)) {
      if (!abs.endsWith('.md') || scopeOfMarkdown(abs) !== 'project') continue;
      const rel = path.relative(substrateRoot, abs);
      items.push({
        key: rel,
        outputRelPath: path.join('.claude', 'agents', path.basename(abs)),
        sourceSha256: sha256File(abs),
        build: () => insertHeader(stripScopeFrontmatter(fs.readFileSync(abs, 'utf8')), htmlComment(rel)),
      });
    }
  }

  return items;
}

/**
 * Bulk-copy mcp/channel/node_modules into the render. Not per-file
 * lockfile-tracked (thousands of files nobody hand-edits) — see the module
 * doc. Idempotent: always mirrors the source tree.
 */
export function syncMcpChannelDeps({ repoRoot, outDir }) {
  const src = path.join(repoRoot, 'mcp', 'channel', 'node_modules');
  const dest = path.join(outDir, 'mcp', 'channel', 'node_modules');
  if (!fs.existsSync(src)) return { copied: false };
  fs.rmSync(dest, { recursive: true, force: true });
  copyDirRecursive(src, dest);
  return { copied: true, dest };
}

// Fixed name of the symlink `ensureMarketplacePluginLink` creates at the
// marketplace root, pointing at the real cc-plugin render.
const MARKETPLACE_PLUGIN_LINK = 'cc-plugin';

/**
 * Plan for the `cc-marketplace` target (TKT-0575, ADR-3 cutover #2): a
 * one-file local marketplace root at ~/.golem/renders/cc-marketplace/
 * pointing its single plugin entry at the cc-plugin render. `source` MUST be
 * a plain relative string with no `..` — verified with `claude plugin
 * validate --strict`, not guessed: the published JSON Schema allows a bare
 * relative-path string (matching this repo's own `.claude-plugin/
 * marketplace.json`), but the real tool additionally requires it resolve
 * *within* the marketplace root (the dir containing `.claude-plugin/`), so a
 * sibling dir can't be referenced with `../`. Since cc-plugin renders as a
 * sibling of cc-marketplace under ~/.golem/renders/, `ensureMarketplacePluginLink`
 * (called after this renders) maintains a symlink named `cc-plugin` *inside*
 * the marketplace root pointing at the real render — the OS resolves it
 * transparently, so `"./cc-plugin"` here is valid without duplicating
 * ~24MB of mcp/channel/node_modules into a second physical copy.
 *
 * @param {object} ctx
 * @param {string} ctx.substrateRoot
 */
export function buildMarketplacePlan({ substrateRoot }) {
  const metaAbs = path.join(substrateRoot, 'plugin-meta.json');
  const metaRaw = fs.readFileSync(metaAbs, 'utf8');
  const meta = JSON.parse(metaRaw);

  return [{
    key: 'marketplace.json',
    outputRelPath: path.join('.claude-plugin', 'marketplace.json'),
    sourceSha256: sha256(metaRaw),
    build: () => {
      const doc = {
        $schema: 'https://json.schemastore.org/claude-code-marketplace.json',
        name: 'golem-workspace',
        owner: meta.author,
        description: 'Workspace-render marketplace for golem (see golem sync --target cc-marketplace). Points at the rendered plugin, not the repo checkout.',
        plugins: [
          {
            name: meta.name,
            source: `./${MARKETPLACE_PLUGIN_LINK}`,
            description: meta.description,
          },
        ],
      };
      return JSON.stringify(doc, null, 2) + '\n';
    },
  }];
}

/**
 * Create/refresh the `cc-plugin` symlink inside the cc-marketplace render
 * root, pointing at the real cc-plugin render dir. Idempotent.
 */
export function ensureMarketplacePluginLink({ ccPluginDir, marketplaceOutDir }) {
  const linkPath = path.join(marketplaceOutDir, MARKETPLACE_PLUGIN_LINK);
  fs.mkdirSync(marketplaceOutDir, { recursive: true });
  try {
    const existing = fs.readlinkSync(linkPath);
    if (existing === ccPluginDir) return { created: false, linkPath };
    fs.unlinkSync(linkPath);
  } catch {
    // doesn't exist, or isn't a symlink (fs.rmSync below handles either)
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
  fs.symlinkSync(ccPluginDir, linkPath);
  return { created: true, linkPath };
}
