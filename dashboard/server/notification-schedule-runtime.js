import { readSessionFacts, isSessionFactTerminal } from '../../lib/session-facts.js';

function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
// Clock selection/emission only. The existing outbox drainer owns all network
// publication, so schedules cannot bypass delivery ownership or replay fences.
export function createNotificationScheduleRuntime({ tracker, readFacts = readSessionFacts, pidAlive = processAlive }) {
  let pendingCursor = '';
  return {
    prepare({ sessions = [], channels = [], nowMs = Date.now() } = {}) {
      tracker.schedules.reconcile(nowMs);
      const facts = new Map(readFacts().map((fact) => [fact.canonical_id, fact]));
      const targets = new Map(sessions.map((row) => [row.session_id, row]));
      const transports = new Map(channels.map((row) => [row.session_id, row]));
      const problem = (row) => {
        const fact = facts.get(row.target_session_id), target = targets.get(row.target_session_id), channel = transports.get(row.target_session_id);
        if (String(channel?.consumer_reason || '').startsWith('unsupported_')
          || fact?.compatibility?.status === 'unsupported' || target?.compatibility?.status === 'unsupported') return 'target transport is unsupported; inspect configuration';
        if (target?.delivery_mode === 'pull-only') return 'target cannot receive pushed notifications';
        const reloading = fact?.observations?.reason === 'reload' && (!fact.pid || pidAlive(fact.pid));
        if (!reloading && (isSessionFactTerminal(fact) || target?.alive === false)) return 'target session has ended; no automatic retargeting';
        return null; // absence/unreachable alone is not proof of permanent death
      };
      let changed = false;
      const pending = tracker.schedules.pendingBatch(pendingCursor);
      pendingCursor = pending.length ? pending[pending.length - 1].id : '';
      for (const row of pending) {
        const reason = problem(row);
        if (reason) { tracker.schedules.block(row.id, reason, nowMs); changed = true; }
      }
      for (const row of tracker.schedules.due(nowMs)) {
        try {
          const reason = problem(row);
          if (reason) tracker.schedules.block(row.id, reason, nowMs);
          else if (!tracker.schedules.emit(row, { nowMs })) continue;
          changed = true;
        } catch (error) {
          // Storage faults remain retryable on the next tick. Do not turn an
          // I/O exception into an invented permanent schedule outcome.
          if (error.code === 'NOTIFICATION_TOO_LARGE') {
            tracker.schedules.block(row.id, error.message, nowMs); changed = true;
          } else console.error('[notification-scheduler] emission failed:', error.message);
        }
      }
      return changed;
    },
    reconcile(nowMs = Date.now()) { tracker.schedules.reconcile(nowMs); },
  };
}
