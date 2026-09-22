// Caller provenance on the trusted local host. Never bind by cwd, label, or
// newest session. Native process ancestry and the corresponding live records
// must agree; inherited environment ids alone are not an identity.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readEndpointLeases, readSessionFacts, isSessionFactTerminal } from './session-facts.js';
import { NotificationError } from './notification-contract.js';
import { projectIdFor } from './project-id.js';
import { readClaudeSessionRecord } from './claude-session-context.js';

function processRow(pid) {
  try {
    const ppid = Number(execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8', timeout: 2000 }).trim());
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 }).trim();
    const startedAt = Date.parse(execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 }).trim());
    return command ? { pid, ppid, command, startedAt } : null;
  } catch { return null; }
}
function claudeRecord(pid, env) {
  try { return readClaudeSessionRecord(pid, { env }); }
  catch { throw new NotificationError('Claude native session record is unreadable', 'INVALID_CALLER_CONTEXT'); }
}
function invalid(message) { throw new NotificationError(message, 'INVALID_CALLER_CONTEXT'); }

export function resolveCliSessionContext({
  pid = process.ppid, env = process.env, readProcess = processRow,
  leases = readEndpointLeases(), facts = readSessionFacts(), readClaude = (p) => claudeRecord(p, env),
  maxDepth = 32,
} = {}) {
  const visited = new Set();
  const matches = [];
  let depth = 0;
  while (pid > 1 && depth++ < maxDepth) {
    if (visited.has(pid)) invalid('process ancestry contains a cycle');
    visited.add(pid);
    const process = readProcess(pid);
    if (!process || !Number.isSafeInteger(Number(process.ppid)) || Number(process.ppid) < 0) invalid('process ancestry is unavailable; cannot establish caller identity');
    const [executable, script = ''] = process.command.split(/\s+/);
    const name = path.basename(executable);
    if (name === 'codex' || name === 'opencode') invalid('this native harness does not yet support CLI caller binding; use its advertised compatibility tools');
    const pi = name === 'pi' || (name === 'node' && /\/pi-coding-agent\/(?:dist|bin)\//.test(script));
    const claude = name === 'claude' || (name === 'node' && /\/@anthropic-ai\/claude-code\//.test(script));
    const owned = leases.filter((lease) => Number(lease.pid) === pid && lease.harness === 'pi');
    if (owned.length && !pi) invalid('native lease conflicts with the current process at its PID');
    if (pi) {
      const ids = [...new Set(owned.map((lease) => lease.canonical_id))];
      if (ids.length !== 1) invalid('Pi ancestor has missing or ambiguous live session leases');
      const fact = facts.find((entry) => entry.canonical_id === ids[0]);
      if (!fact || isSessionFactTerminal(fact) || fact.harness !== 'pi') invalid('Pi session fact is missing, stale, or conflicting');
      if (owned.some((lease) => Number.isFinite(process.startedAt) && Date.parse(lease.renewed_at) < process.startedAt)) invalid('Pi lease predates the process currently using its PID');
      matches.push({ sessionId: ids[0], projectId: fact.project_id ?? (fact.project_path ? projectIdFor(fact.project_path) : null), harness: 'pi', pid });
    } else if (claude) {
      const native = readClaude(pid);
      if (!native?.sessionId) invalid('Claude ancestor has no canonical native session record');
      if (Number.isFinite(process.startedAt) && !(native.recordMtimeMs >= process.startedAt)) invalid('Claude native session record predates this process');
      // Claude's procStart string has no timezone and is written in UTC on
      // macOS while `ps lstart` is local time. Use the native numeric creation
      // epoch instead, allowing bounded startup/registry latency.
      if (Number.isFinite(process.startedAt) && (!Number.isFinite(native.startedAt)
        || native.startedAt < process.startedAt - 1000 || native.startedAt - process.startedAt > 120_000)) {
        invalid('Claude native process birth identity does not match this PID');
      }
      const fact = facts.find((entry) => entry.canonical_id === native.sessionId);
      if (fact && (isSessionFactTerminal(fact) || fact.harness !== 'claudecode')) invalid('Claude native identity conflicts with its session fact');
      if (native.pid != null && Number(native.pid) !== pid) invalid('Claude session record PID conflicts with ancestry');
      matches.push({ sessionId: native.sessionId, projectId: fact?.project_id ?? (fact?.project_path ? projectIdFor(fact.project_path) : null), harness: 'claudecode', projectPath: native.cwd ?? null, pid });
    }
    // The nearest native ancestor owns this invocation. An outer agent may
    // have launched it; that is not a competing identity for this shell.
    if (matches.length) { pid = 0; break; }
    pid = Number(process.ppid);
  }
  if (pid > 1) invalid('process ancestry exceeds the bounded lookup; refusing ambiguous context');
  const ids = [...new Set(matches.map((entry) => entry.sessionId))];
  if (ids.length > 1) invalid('multiple native sessions appear in the caller ancestry');
  const context = matches[0] ?? null;
  // Pi shell metadata can be inherited by a nested Claude process; it is not
  // evidence about that Claude session's identity.
  const hints = [env.GOLEM_SESSION_ID, env.GOLEM_CEO_SESSION_ID, context?.harness === 'pi' ? env.PI_SESSION_ID : null].filter(Boolean);
  // Ordinary id hints cannot turn proven non-native ancestry into a binding.
  // Explicit human mode is still required for mutations from that shell.
  if (context && hints.some((id) => id !== context.sessionId)) invalid('inherited session identity conflicts with live native evidence');
  if (!context && env.CLAUDE_CODE_SESSION_ID) invalid('agent context cannot be resolved by this CLI');
  // CLAUDE_CODE_SESSION_ID is per-run, not the logical/resumed session id.
  return context;
}
