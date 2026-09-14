// Substrate lint — keeps the instruction substrate lean after GOL-303.
//
// Four checks over substrate/ (instructions, roles, skills; README excluded):
//   1. word caps      — per-file caps from CAPS, plus a total cap;
//   2. references     — every `golem:<skill>` names an existing skill dir, and every
//                       `golem:<skill> § <Heading>` / `Global Rules § <Heading>` /
//                       bare `§ <Heading>` resolves to a heading in that file;
//   3. single owner   — each FINGERPRINT sentence appears in at most one file;
//   4. front matter   — a SKILL.md has name + description, name matches its directory,
//                       and no unquoted value contains a YAML control sequence. Pi's
//                       parser is stricter than Claude Code's: a `: ` inside an
//                       unquoted description reads as a nested mapping and the skill
//                       is dropped with a "Skill conflicts" warning.
//
// Runs once over the source tree, not per render target, so it sits beside
// checkDrift rather than inside it.

import fs from 'node:fs';
import path from 'node:path';

export const TOTAL_CAP = 9700;

// Word caps per substrate-relative path. Anything not listed gets DEFAULT_CAP.
// GOL-339: the SDD skill is new; per-file caps were reallocated after extracting
// the method out of lead and moving reminder mechanics into team-ops. TOTAL_CAP
// stays pending the lead's decision on the measured 9,968-word shortfall.
export const CAPS = Object.freeze({
  'instructions/AGENTS.md': 700,
  'roles/lead.md': 150,
  'roles/builder.md': 150,
  'roles/explorer.md': 150,
  'roles/reviewer.md': 150,
  'roles/designer.md': 150,
  'skills/spec-driven-development/SKILL.md': 400,
  'skills/lead/SKILL.md': 300,
  'skills/spec-writing/SKILL.md': 510,
  'skills/building/SKILL.md': 500,
  'skills/exploring/SKILL.md': 300,
  'skills/reviewing/SKILL.md': 400,
  'skills/designing/SKILL.md': 350,
  'skills/team-ops/SKILL.md': 760,
  'skills/tracker/SKILL.md': 620,
  'skills/tracker/templates/spec.md': 650,
  'skills/tracker/templates/task.md': 200,
  'skills/tracker/templates/doc.md': 350,
  'skills/git-conventions/SKILL.md': 250,
  'skills/browsing/SKILL.md': 550,
  'skills/docs-maintenance/SKILL.md': 1000,
  'skills/skill-authoring/SKILL.md': 550,
  'skills/transcript-workflow-review/SKILL.md': 600,
  'skills/compare-design-options/SKILL.md': 370,
  'skills/compare-design-options/references/lab-patterns.md': 470,
  'skills/night-shift/SKILL.md': 250,
  'skills/test-policy/SKILL.md': 160,
  'skills/verify-done/SKILL.md': 170,
  'skills/handoff/SKILL.md': 200,
  'skills/ingest-github-issues/SKILL.md': 250,
});
export const DEFAULT_CAP = 400;

// Sentences that must have exactly one owner. Keep them long enough that a
// pointer ("per golem:team-ops § Common protocol") never matches.
export const FINGERPRINTS = Object.freeze([
  'Load `golem:lead` before your first tool call',
  "Never use the harness's own in-session sub-agent tool",
  'Reply to the authenticated sender session id',
  'One pass. The author decides what to take',
  'Whoever I should interact with through a ticket is its assignee',
  'todo → in_progress → review → done',
  'Reuse an idle teammate with the fitting role. Spawn when none is idle',
  'Never delete, reset, or log out of the shared profile',
  'A claim is not evidence. Only output you produced',
  'The hook journal is not memory',
  'Stage explicitly with `git add <files>`',
]);

const LINT_EXTS = new Set(['.md']);
const SKIP = new Set(['README.md']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (LINT_EXTS.has(path.extname(entry.name)) && !SKIP.has(entry.name)) out.push(abs);
  }
  return out;
}

export function lintFiles(substrateRoot) {
  const roots = ['instructions', 'roles', 'skills'].map((d) => path.join(substrateRoot, d));
  return roots.flatMap((r) => walk(r)).sort();
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function headings(text) {
  const out = new Set();
  for (const line of text.split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) out.add(normalizeHeading(m[1]));
  }
  return out;
}

function normalizeHeading(h) {
  return h.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// A `§ Heading` reference ends at the first period, comma, semicolon, closing
// paren, backtick, angle bracket, or end of line. The skill prefix may be
// wrapped in backticks and may sit on the previous line.
const REF_RE = /(?:(?:`?golem:([a-z0-9-]+)`?)|(Global Rules))?\s*§\s*([A-Za-z][^.,;)`<\n]*)/g;
const SKILL_RE = /golem:([a-z0-9-]+)/g;

export function lintSubstrate({ substrateRoot }) {
  const files = lintFiles(substrateRoot);
  const findings = [];
  const skillsDir = path.join(substrateRoot, 'skills');
  const skillNames = new Set(fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : []);

  const texts = new Map();
  for (const abs of files) texts.set(abs, fs.readFileSync(abs, 'utf8'));

  const headingsByFile = new Map();
  for (const [abs, text] of texts) headingsByFile.set(abs, headings(text));
  const globalRules = path.join(substrateRoot, 'instructions', 'AGENTS.md');
  const skillFile = (name) => path.join(skillsDir, name, 'SKILL.md');

  // 1. word caps
  let total = 0;
  for (const [abs, text] of texts) {
    const rel = path.relative(substrateRoot, abs);
    const words = countWords(text);
    total += words;
    const cap = CAPS[rel] ?? DEFAULT_CAP;
    if (words > cap) findings.push({ check: 'cap', file: rel, detail: `${words} words, cap ${cap}` });
  }
  if (total > TOTAL_CAP) findings.push({ check: 'cap', file: '(total)', detail: `${total} words, cap ${TOTAL_CAP}` });

  // 2. references
  for (const [abs, text] of texts) {
    const rel = path.relative(substrateRoot, abs);
    for (const m of text.matchAll(SKILL_RE)) {
      if (!skillNames.has(m[1])) findings.push({ check: 'ref', file: rel, detail: `golem:${m[1]} is not a skill` });
    }
    for (const m of text.matchAll(REF_RE)) {
      const [, skill, globalPrefix, heading] = m;
      let target = abs;
      if (skill) target = skillFile(skill);
      else if (globalPrefix) target = globalRules;
      const known = headingsByFile.get(target);
      if (!known) {
        if (skill && !skillNames.has(skill)) continue; // already reported above
        findings.push({ check: 'ref', file: rel, detail: `§ ${heading.trim()} points at a file with no headings (${path.relative(substrateRoot, target)})` });
        continue;
      }
      if (!known.has(normalizeHeading(heading))) {
        findings.push({ check: 'ref', file: rel, detail: `§ ${heading.trim()} not found in ${path.relative(substrateRoot, target)}` });
      }
    }
  }

  // 4. front matter — SKILL.md only; roles and templates carry none.
  for (const [abs, text] of texts) {
    const rel = path.relative(substrateRoot, abs);
    if (path.basename(abs) !== 'SKILL.md') continue;
    const block = /^---\n([\s\S]*?)\n---/.exec(text);
    if (!block) { findings.push({ check: 'frontmatter', file: rel, detail: 'no YAML front matter' }); continue; }
    const fields = new Map();
    for (const line of block[1].split('\n')) {
      const m = /^([a-z-]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      fields.set(m[1], m[2]);
      const value = m[2];
      const quoted = /^(['"]).*\1$/.test(value.trim());
      if (quoted) continue;
      if (value.includes(': ')) findings.push({ check: 'frontmatter', file: rel, detail: `${m[1]} contains ": " — YAML reads it as a nested mapping; rephrase or quote` });
      if (/\s#/.test(value)) findings.push({ check: 'frontmatter', file: rel, detail: `${m[1]} contains " #" — YAML reads the rest as a comment` });
      if (/^[\[{&*!|>%@`]/.test(value)) findings.push({ check: 'frontmatter', file: rel, detail: `${m[1]} starts with a YAML control character` });
    }
    const dir = path.basename(path.dirname(abs));
    if (!fields.has('name')) findings.push({ check: 'frontmatter', file: rel, detail: 'no name' });
    else if (fields.get('name') !== dir) findings.push({ check: 'frontmatter', file: rel, detail: `name "${fields.get('name')}" does not match directory "${dir}"` });
    if (!fields.get('description')) findings.push({ check: 'frontmatter', file: rel, detail: 'no description — it is the only routing surface' });
  }

  // 3. single owner
  for (const sentence of FINGERPRINTS) {
    const owners = [];
    for (const [abs, text] of texts) if (text.includes(sentence)) owners.push(path.relative(substrateRoot, abs));
    if (owners.length > 1) findings.push({ check: 'owner', file: owners.join(', '), detail: `"${sentence}" has ${owners.length} owners` });
    if (owners.length === 0) findings.push({ check: 'owner', file: '(none)', detail: `"${sentence}" has no owner` });
  }

  return { clean: findings.length === 0, findings, total, files: files.length };
}
