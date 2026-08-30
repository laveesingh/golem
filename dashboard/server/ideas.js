// TKT-0206: a global ideas stack — a FIFO queue of raw thoughts the user
// drops via a bottom-left anchor in the dashboard. The ideas live in
// `~/.config/golem/ideas/` (mirrors the gates layout) as one .md per
// idea: frontmatter (id, created_at, status) + body.
//
// "Pop" semantics — when the user takes an idea forward, it's deleted
// from the queue (status:popped + the file is removed). The body is
// meant to be brief; for a real PRD/Spec the user creates a tracker
// ticket. The ideas stack is a parking lot, not a planning surface.

import path from 'node:path';
import fs from 'node:fs/promises';
import { ideasDir } from '../../lib/golem-home.js';

export const IDEAS_DIR = ideasDir();

async function ensureDir() {
  await fs.mkdir(IDEAS_DIR, { recursive: true });
}

// Parse a single idea file. Returns null on unreadable / parse-failure;
// returns a partial object on missing frontmatter so the UI can still
// surface the body.
export async function readIdeaFile(absPath) {
  let raw;
  try { raw = await fs.readFile(absPath, 'utf8'); } catch { return null; }
  if (!raw.startsWith('---')) {
    return { id: path.basename(absPath, '.md'), path: absPath, body: raw, status: 'pending' };
  }
  const end = raw.indexOf('\n---', 3);
  if (end === -1) {
    return { id: path.basename(absPath, '.md'), path: absPath, body: raw, status: 'pending' };
  }
  const yaml = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();
  const fm = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const v = m[2].trim();
    if (v === '') fm[m[1]] = '';
    else if (/^\d{4}-\d{2}-\d{2}T/.test(v)) fm[m[1]] = v;
    else fm[m[1]] = v;
  }
  return {
    id: fm.id || path.basename(absPath, '.md'),
    path: absPath,
    body,
    frontmatter: fm,
    status: fm.status || 'pending',
    createdAt: fm.created_at || null,
    projectId: fm.project_id || fm.project || null,
    project_id: fm.project_id || fm.project || null,
  };
}

// Read all ideas in the central dir. Sort oldest-first (FIFO queue — the
// user wants the oldest idea to be at the top of the list, so they see
// what they've been sitting on longest).
// When projectId is supplied, only ideas for that project are returned.
// A null/undefined projectId returns all ideas (backward-compatible global view).
export async function listIdeas(projectId = null) {
  await ensureDir();
  let entries;
  try { entries = await fs.readdir(IDEAS_DIR, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const abs = path.join(IDEAS_DIR, e.name);
    const idea = await readIdeaFile(abs);
    if (!idea) continue;
    if (projectId && idea.projectId !== projectId && idea.project_id !== projectId) continue;
    out.push(idea);
  }
  out.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return out;
}

function ideaIdSlug(text) {
  // First 24 chars of a slug of the body — short, human-readable, stable
  // enough for the user to identify the file. Not a security boundary.
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'idea';
}

export async function createIdea({ body, project_id, projectId }) {
  if (!body || !body.trim()) throw Object.assign(new Error('body is required'), { status: 400 });
  await ensureDir();
  const now = new Date().toISOString();
  // Generate a filename that sorts by created_at; include a 4-char
  // random suffix so two ideas created in the same millisecond don't
  // collide.
  const ts = now.replace(/[:.]/g, '-');
  const suf = Math.random().toString(36).slice(2, 6);
  const id = `idea-${ts}-${suf}`;
  const filename = `${id}.md`;
  const abs = path.join(IDEAS_DIR, filename);
  const effectiveProject = project_id || projectId || null;
  const frontmatter = [
    '---',
    `id: ${id}`,
    `created_at: ${now}`,
    'status: pending',
    ...(effectiveProject ? [`project_id: ${effectiveProject}`] : []),
    '---',
    '',
  ].join('\n');
  // The body follows the frontmatter, with a leading blank line.
  await fs.writeFile(abs, frontmatter + body.trim() + '\n', 'utf8');
  const idea = await readIdeaFile(abs);
  return idea;
}

// Pop = remove from the queue. The user is taking the idea forward
// (likely creating a tracker ticket); the idea file is no longer the
// parking lot's concern. Atomic write-not-required for delete.
export async function popIdea(id) {
  if (!id) throw Object.assign(new Error('id is required'), { status: 400 });
  const candidates = [path.join(IDEAS_DIR, `${id}.md`)];
  for (const c of candidates) {
    try {
      await fs.unlink(c);
      return { id, popped: true };
    } catch {}
  }
  throw Object.assign(new Error(`idea not found: ${id}`), { status: 404 });
}

export async function readIdea(id) {
  if (!id) throw Object.assign(new Error('id is required'), { status: 400 });
  const idea = await readIdeaFile(path.join(IDEAS_DIR, `${id}.md`));
  if (!idea) throw Object.assign(new Error(`idea not found: ${id}`), { status: 404 });
  return idea;
}
