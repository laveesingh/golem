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
export function operationPlan(query, inputs = {}) {
  return { ok: query.resolution.ok, dry_run: true, operation: query.resolution.operation,
    plan: { project_id: query.resolution.project_id, team_id: query.resolution.team_id, session: query.resolution.session,
      target: query.resolution.target, placement: query.resolution.placement, required_capabilities: query.resolution.required_capabilities, ...inputs },
    resolution: query.resolution };
}
export function writeDryRun(query, options, stdout, inputs) {
  if (!options['--dry-run']) return null;
  const plan = operationPlan(query, inputs);
  stdout(options['--json'] ? JSON.stringify(plan) : `${query.resolution.ok ? 'resolved' : 'unresolved'} dry-run: ${JSON.stringify(plan.plan)}${query.resolution.ok ? '' : `; ${[...query.resolution.conflicts, ...query.resolution.missing].map(c => c.message).join('; ')}; try: ${query.resolution.corrected_command}`}`);
  return query.resolution.ok ? 0 : 2;
}
export { requireManagementResolution };
