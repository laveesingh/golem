// TKT-0519: scratch-ticket helper for smokes. ALL smoke fixtures MUST go
// through this — they land in the quarantined `smoketests-000000` project
// (deliberately unregistered — never appears in the projects sidebar) so they
// never pollute a real project's board or its per-project ticket numbering.
// Archive them in a finally block; never create scratch tickets in a real project.
import fs from 'node:fs';
import path from 'node:path';

export const SMOKE_PROJECT = 'smoketests-000000';

// Explicit private SQLite fixture boundary. No HTTP or shared-state fallback.
export function createPrivateScratchFixture(tracker, dbPath, fields = {}) {
  const root = process.env.GOLEM_W2_SANDBOX;
  const ownedPath = fs.realpathSync(dbPath);
  if (!root || !ownedPath.startsWith(fs.realpathSync(root) + path.sep))
    throw new Error('private scratch fixture requires an owned sandbox DB');
  const row = tracker
    .raw()
    .prepare('PRAGMA database_list')
    .all()
    .find((db) => db.name === 'main');
  if (!row?.file || fs.realpathSync(row.file) !== ownedPath)
    throw new Error('private scratch fixture DB handle/path mismatch');
  return tracker.createTicket({
    kind: 'task',
    ...fields,
    project_id: SMOKE_PROJECT,
    created_by: 'smoke',
    title: `SMOKE-${fields.title ?? 'scratch'}`,
  });
}

export function archivePrivateScratchFixture(tracker, id) {
  return tracker.updateTicket(id, { state: 'archived', actor: 'smoke' });
}
const DEFAULT_API = 'http://dashboard.golem.localhost:7420';
// Isolated browser journeys set this to their temporary dashboard. Existing
// smokes keep using the shared local dashboard without any call-site changes.
const apiBase = () => process.env.GOLEM_SMOKE_API || DEFAULT_API;

// Create a scratch ticket in the smoke project. `fields` overrides defaults
// (kind, body, assignee, parent_id, etc.); the title is SMOKE-prefixed.
export async function createScratchTicket(fields = {}) {
  const res = await fetch(`${apiBase()}/api/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'task',
      ...fields,
      project_id: SMOKE_PROJECT,
      created_by: 'smoke',
      title: `SMOKE-${fields.title ?? 'scratch'}`,
    }),
  });
  if (!res.ok)
    throw new Error(`createScratchTicket: ${res.status} ${await res.text()}`);
  return res.json();
}

// Exercise idea promotion without creating a real-board ticket. The caller owns idea cleanup.
export async function promoteScratchIdea(id, title = 'promoted idea') {
  const res = await fetch(
    `${apiBase()}/api/ideas/${encodeURIComponent(id)}/promote`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: SMOKE_PROJECT,
        created_by: 'smoke',
        title: `SMOKE-${title}`,
      }),
    },
  );
  if (!res.ok)
    throw new Error(`promoteScratchIdea: ${res.status} ${await res.text()}`);
  return res.json();
}

// Archive a scratch ticket (best-effort — a no-op on an already-archived ticket).
export async function archiveTicket(id) {
  await fetch(`${apiBase()}/api/tickets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'archived', actor: 'smoke' }),
  }).catch(() => {});
}
