function workloadScore(row = {}) {
  const inProgress = Array.isArray(row.in_progress_tickets)
    ? row.in_progress_tickets.length
    : Array.isArray(row.workload?.in_progress_tickets) ? row.workload.in_progress_tickets.length : 0;
  const pending = Number(row.pending_count ?? row.workload?.pending_count ?? 0) || 0;
  return { inProgress, pending };
}

export function leastLoadedRoleSession(rows = [], role) {
  const candidates = rows
    .filter((row) => row?.alive !== false && row?.role === role)
    .sort((a, b) => {
      const aw = workloadScore(a);
      const bw = workloadScore(b);
      if (aw.inProgress !== bw.inProgress) return aw.inProgress - bw.inProgress;
      if (aw.pending !== bw.pending) return aw.pending - bw.pending;
      return String(b.updated_at || b.started_at || '').localeCompare(String(a.updated_at || a.started_at || ''));
    });
  return candidates[0] || null;
}

function slimSession(row) {
  if (!row) return null;
  return {
    session_id: row.session_id,
    label: row.label || row.name || `session ${String(row.session_id || '').slice(0, 8)}`,
    role: row.role || null,
    status: row.status || null,
    reachable: row.reachable === true,
    workload: row.workload || workloadScore(row),
  };
}

/** GOL-382 R10: the intake suggestion is the least-loaded live session of the
 *  configured default role (roles.default), not a fixed role name. No default
 *  role means no suggestion. */
export function teamAssists(rows = [], { intakeRole = null } = {}) {
  return {
    suggested_intake: intakeRole ? slimSession(leastLoadedRoleSession(rows, intakeRole)) : null,
  };
}
