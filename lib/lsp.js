import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { projectsJsonPath } from './golem-home.js';
import { projectIdFor, resolveProjectRoot } from './project-id.js';

function runGit(args, cwd, { allowFail = false } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (!allowFail && res.status !== 0) throw new Error((res.stderr || res.stdout || `git ${args.join(' ')} failed`).trim());
  return res;
}

function gitTrackedRegularFiles(root) {
  return runGit(['ls-files'], root).stdout.split('\n').filter(Boolean).filter((rel) => {
    try {
      return fs.statSync(path.join(root, rel)).isFile();
    } catch {
      return false;
    }
  }).sort();
}

export function claudeLspServers() {
  const res = spawnSync('claude', ['plugin', 'list'], { encoding: 'utf8' });
  if (res.status !== 0) return [];
  return [...res.stdout.matchAll(/❯ ([a-z0-9-]+)-lsp@[^\n]+\n\s+Version:[^\n]+\n\s+Scope:[^\n]+\n\s+Status: ✔ enabled/g)]
    .map((m) => m[1]);
}

export async function detectLspCapability(startPath) {
  const root = await resolveProjectRoot(startPath || process.cwd());
  const servers = [...new Set(claudeLspServers())].sort();
  return {
    available: servers.length > 0,
    servers,
    checked_at: new Date().toISOString(),
  };
}

export async function updateProjectLsp(startPath) {
  const root = await resolveProjectRoot(startPath || process.cwd());
  const id = projectIdFor(root);
  const lsp = await detectLspCapability(root);
  let doc = { version: 1, projects: [] };
  try {
    doc = JSON.parse(readFileSync(projectsJsonPath(), 'utf8'));
  } catch {
    // Create a minimal registry if this is the first golem command in a sandbox.
  }
  const projects = Array.isArray(doc.projects) ? doc.projects : [];
  const idx = projects.findIndex((p) => p?.id === id || path.resolve(p?.path || '') === root);
  const entry = { id, name: path.basename(root), path: root, kind: 'auto', ...projects[idx], lsp };
  if (idx >= 0) projects[idx] = entry;
  else projects.push(entry);
  mkdirSync(path.dirname(projectsJsonPath()), { recursive: true });
  writeFileSync(projectsJsonPath(), JSON.stringify({ ...doc, version: doc.version ?? 1, projects }, null, 2) + '\n');
  return { projectId: id, root, lsp };
}
