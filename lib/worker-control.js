// Adapter-owned control evidence. Conversation identity and process lifetime
// are independent of logical names, roles and provider/version labels.
import path from 'node:path';
import { readSessionFacts } from './session-facts.js';
import { captureProcessGroup, processGroupMatches } from './process-group.js';
import { agentGet, paneProcessInfo } from './herdr-driver.js';
export function nativeConversationMatches(fact, agent) {
  const ref = agent?.agent_session;
  if (!fact?.locator || typeof ref?.value !== 'string') return false;
  if (ref.kind === 'path') return !!fact.locator.session_file && path.resolve(ref.value) === path.resolve(fact.locator.session_file);
  // Exact native UUID, not a name/provider/role/cwd correlation.
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(ref.value) && ref.value === fact.locator.raw_session_id;
}
function nativeProgramProcess(agent, row) {
  const executable = agent?.agent;
  return ['pi', 'claude'].includes(executable) && (row.argv0 === executable
    || path.basename(row.argv0 ?? '') === executable
    || path.basename(row.argv?.[1] ?? '') === executable);
}
export function nativeForegroundAgentPresent(agent, info) {
  return (info?.foreground_processes ?? []).some(row => nativeProgramProcess(agent, row));
}
function currentConversationProcess(fact, agent, info) {
  if (!nativeConversationMatches(fact, agent) || !nativeForegroundAgentPresent(agent, info)) return null;
  const ref = agent.agent_session;
  const flag = ref.kind === 'path' ? '--session' : '--session-id';
  return (info.foreground_processes ?? []).find(row => {
    if (!nativeProgramProcess(agent, row) || !Number.isInteger(row.pid) || !Array.isArray(row.argv)) return false;
    const values = [];
    for (let i = 0; i < row.argv.length; i++) {
      if (row.argv[i] === flag) values.push(row.argv[++i]);
      else if (row.argv[i].startsWith(`${flag}=`)) values.push(row.argv[i].slice(flag.length + 1));
    }
    // Unknown/ambiguous current arguments cannot borrow cached agent identity.
    return values.length === 1 && typeof values[0] === 'string' && (ref.kind === 'path'
      ? path.isAbsolute(values[0]) && path.resolve(values[0]) === path.resolve(fact.locator.session_file)
      : values[0] === fact.locator.raw_session_id);
  }) ?? null;
}
export function workerProcessEvidence(worker, { native = { agentGet, paneProcessInfo }, facts = readSessionFacts(),
  capture = captureProcessGroup, matches = processGroupMatches } = {}) {
  const unavailable = reason => ({ state: 'unavailable', reason, recovery: 'inspect exact conversation/pane/process evidence; adopt a demonstrably matching resource' });
  const recorded = worker.process_ownership;
  let agent = null, info = null, paneId = worker.herdr_pane_id;
  const fact = facts.find(row => row.canonical_id === worker.session_id);
  if (paneId) {
    try { agent = native.agentGet({ session: worker.herdr_session, target: paneId }); }
    catch (error) { if (!/agent_not_found|pane_not_found/.test(error.message)) return unavailable(`native identity probe failed: ${error.message}`); }
    // Native alias resolution supplies actual moved-pane placement.
    if (agent?.pane_id) paneId = agent.pane_id;
    try { info = native.paneProcessInfo({ session: worker.herdr_session, paneId }); }
    catch (error) { if (!/pane_not_found/.test(error.message)) return unavailable(`native process probe failed: ${error.message}`); }
  }
  try {
    if (agent?.agent_session && !nativeConversationMatches(fact, agent)) return unavailable('native conversation identity does not match registered locator/UUID');
    const group = info?.foreground_process_group_id;
    if (info && (!Number.isInteger(group) || group <= 1)) return unavailable('native foreground process group unavailable');
    const explicitCurrentSession = (info?.foreground_processes ?? []).some(row => Array.isArray(row.argv)
      && row.argv.some(arg => typeof arg === 'string' && /^(--session|--session-id)(=|$)/.test(arg)));
    if (agent?.agent_session && explicitCurrentSession && !currentConversationProcess(fact, agent, info)) return unavailable('current process conversation arguments disagree with cached native identity');
    if (recorded && (!info || recorded.pgid === group)) {
      // Only a recorded launch/adoption has authority to use captured evidence.
      if (worker.operation_id || worker.control_origin === 'explicit-adoption') {
        if (matches(recorded.pgid, recorded)) return { state: 'available', reason: 'exact captured process incarnation', identity: recorded, pane_id: info ? paneId : null, agent };
        if (!info) return { state: 'available', reason: 'pane absent; exact recorded group requires survivor verification', identity: recorded, pane_id: null, agent };
      }
    }
    const bound = info && currentConversationProcess(fact, agent, info);
    if (bound) {
      const identity = capture(group);
      if (!identity.members.some(row => row.pid === bound.pid)) return unavailable('native conversation process is not in the captured current group');
      // Bracket the incarnation capture with current process-info, not merely
      // a cached session descriptor plus an unrelated Pi executable.
      const current = native.paneProcessInfo({ session: worker.herdr_session, paneId });
      const confirmed = currentConversationProcess(fact, agent, current);
      if (current?.foreground_process_group_id !== group || confirmed?.pid !== bound.pid || !matches(group, identity)) return unavailable('conversation/process incarnation changed during binding');
      return { state: 'available', reason: 'current exact conversation arguments bound to captured incarnation', identity, pane_id: paneId, agent };
    }
    return unavailable('missing or changed captured incarnation; no matching native conversation identity');
  } catch (error) { return unavailable(`process ownership probe failed: ${error.message}`); }
}
