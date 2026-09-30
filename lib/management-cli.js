// Shared management selectors and receipts. Notification/dispatch transport
// deliberately does not use this resolver or its name/context fallback.
import { collectManagementContext } from './management-context.js';
import { resolveManagement, requireManagementResolution } from './management-resolve.js';
export const MANAGEMENT_SELECTOR_FLAGS = { '--project': 'value', '--team': 'value', '--session': 'value', '--caller': 'value' };
export function managementSelectors(options = {}) {
  return Object.fromEntries(Object.keys(MANAGEMENT_SELECTOR_FLAGS).filter(key => options[key] != null).map(key => [key.slice(2), options[key]]));
}
export async function managementQuery({ operation, kind, target, options = {}, requiresTeam = false, ...collector } = {}) {
  const evidence = await collectManagementContext({ ...collector, selectors: managementSelectors(options) });
  const resolution = resolveManagement({ operation, kind, target, requiresTeam, scope: options['--scope'] ?? null }, evidence);
  return { evidence, resolution };
}
export function listReceipt(items, resolution) { return { schema_version: 2, items, resolution }; }
export function managementProjectInput(query) {
  const id = query.resolution.project_id;
  const explicit = query.evidence.sources.explicitProject;
  if (explicit?.status === 'resolved' && explicit.value.project_id === id && explicit.value.path) return explicit.value.path;
  const registered = (query.evidence.sources.projects.value ?? []).find(p => (p.project_id ?? p.id) === id && p.path);
  if (registered) return registered.path;
  const roots = [...new Set(query.evidence.workers.filter(w => w.project_id === id).map(w => w.project_root).filter(Boolean))];
  if (roots.length === 1) return roots[0];
  const cwd = query.evidence.sources.cwdProject;
  if (cwd?.status === 'resolved' && cwd.value.project_id === id) return cwd.value.path;
  return id;
}
export function managedControlOptions(resolution, options = {}) {
  const row = resolution.target;
  const constraints = {};
  if (options['--project'] != null) constraints.projectId = resolution.project_id;
  if (options['--team'] != null) constraints.teamId = resolution.team_id;
  if (options['--session'] != null) constraints.session = resolution.session;
  return { projectId: row.project_id, teamId: row.team_id ?? null, workerId: row.worker_id,
    ...(Object.keys(constraints).length ? { constraints } : {}) };
}
export function operationPlan(query, inputs = {}) {
  return { ok: query.resolution.ok, dry_run: true, operation: query.resolution.operation,
    plan: { project_id: query.resolution.project_id, team_id: query.resolution.team_id, session: query.resolution.session,
      target: query.resolution.target, placement: query.resolution.placement, required_capabilities: query.resolution.required_capabilities,
      ...(query.resolution.operation.endsWith(' create') || query.resolution.operation === 'session start' ? { association: query.resolution.session ? 'recorded' : 'allocation-required-on-real-mutation' } : {}), ...inputs },
    resolution: query.resolution };
}
export function writeDryRun(query, options, stdout, inputs) {
  if (!options['--dry-run']) return null;
  const plan = operationPlan(query, inputs);
  stdout(options['--json'] ? JSON.stringify(plan) : `${query.resolution.ok ? 'resolved' : 'unresolved'} dry-run: ${JSON.stringify(plan.plan)}${query.resolution.ok ? '' : `; ${[...query.resolution.conflicts, ...query.resolution.missing].map(c => c.message).join('; ')}; try: ${query.resolution.corrected_command}`}`);
  return query.resolution.ok ? 0 : 2;
}
export { requireManagementResolution };
