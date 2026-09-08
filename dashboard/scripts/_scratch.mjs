// TKT-0519: scratch-ticket helper for smokes. ALL smoke fixtures MUST go
// through this — they land in the quarantined `smoketests-000000` project
// (deliberately unregistered — never appears in the projects sidebar) so they
// never pollute a real project's board or its per-project ticket numbering.
// Archive them in a finally block; never create scratch tickets in a real project.
export const SMOKE_PROJECT = 'smoketests-000000';
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
      project_id: SMOKE_PROJECT,
      created_by: 'smoke',
      kind: 'task',
      ...fields,
      title: `SMOKE-${fields.title ?? 'scratch'}`,
    }),
  });
  if (!res.ok) throw new Error(`createScratchTicket: ${res.status} ${await res.text()}`);
  return res.json();
}

// Exercise idea promotion without creating a real-board ticket. The caller owns idea cleanup.
export async function promoteScratchIdea(id, title = 'promoted idea') {
  const res = await fetch(`${apiBase()}/api/ideas/${encodeURIComponent(id)}/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: SMOKE_PROJECT, created_by: 'smoke', title: `SMOKE-${title}` }),
  });
  if (!res.ok) throw new Error(`promoteScratchIdea: ${res.status} ${await res.text()}`);
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
