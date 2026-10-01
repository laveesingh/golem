// Adapter-owned control evidence. Conversation identity and process lifetime
// are independent of logical names, roles and provider/version labels.
import path from 'node:path';
import { readSessionFacts, readEndpointLeases } from './session-facts.js';
import { captureProcessGroup, processGroupMatches, processGroupExactMatches } from './process-group.js';
import { agentGet, paneProcessInfo } from './herdr-driver.js';
export function nativeConversationMatches(fact, agent) {
  const ref = agent?.agent_session;
  if (!fact?.locator || typeof ref?.value !== 'string') return false;
  if (ref.kind === 'path') return !!fact.locator.session_file && path.resolve(ref.value) === path.resolve(fact.locator.session_file);
  // Exact native UUID, not a name/provider/role/cwd correlation.
  return ref.kind === 'id' && !!ref.value && ref.value === fact.locator.raw_session_id;
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
  capture = captureProcessGroup, matches = processGroupMatches, exactMatches = processGroupExactMatches, leases = readEndpointLeases(), refreshLeases = readEndpointLeases } = {}) {
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
        if (matches(recorded.pgid, recorded)) {
          const programs=(info?.foreground_processes ?? []).filter(row=>nativeProgramProcess(agent,row));
          if(programs.length) {
            const current=capture(recorded.pgid);
            const app=programs.length===1 && current.members.find(row=>row.pid===programs[0].pid);
            if(app && recorded.members.some(row=>row.pid===app.pid && row.birth===app.birth)
              && (recorded.application ? recorded.application.pid===app.pid && recorded.application.birth===app.birth : exactMatches(recorded.pgid,recorded))) {
              const checked=native.paneProcessInfo({session:worker.herdr_session,paneId});
              const checkedPrograms=(checked?.foreground_processes ?? []).filter(row=>nativeProgramProcess(agent,row));
              if(checked.foreground_process_group_id===recorded.pgid && checkedPrograms.length===1 && checkedPrograms[0].pid===app.pid
                && !((checked.foreground_processes ?? []).some(row=>row.argv?.some(arg=>/^(--session|--session-id)(=|$)/.test(arg))) && !currentConversationProcess(fact,agent,checked))
                && matches(recorded.pgid,{...recorded,members:[app]})) return {state:'available',reason:'current captured application incarnation',binding_source:'captured-application',identity:{...recorded,application:app},pane_id:paneId,agent};
            }
          } else if (!agent && exactMatches(recorded.pgid,recorded)) {
            // Legacy/undetected owned launches require the ENTIRE unchanged
            // group, never a surviving captured wrapper alone.
            return {state:'available',reason:'exact complete captured group; no replacement application observed',identity:recorded,pane_id:info?paneId:null,agent};
          }
        }
        // An absent pane does not authorize a surviving ancestor/replacement.
      }
    }
    const liveLeases = leases.filter(l => l.canonical_id === fact?.canonical_id && l.harness === 'pi' && l.kind === 'typed-worker' && typeof l.owner_token === 'string' && l.owner_token && Date.parse(l.expires_at) > Date.now());
    const lease = liveLeases.length === 1 && Number.isInteger(liveLeases[0].pid) && liveLeases[0].pid > 1 && liveLeases[0].process_birth ? liveLeases[0] : null;
    const leasedProcess = lease && info?.foreground_processes?.find(row => row.pid === lease.pid && nativeProgramProcess(agent, row));
    const argumentProcess = info && currentConversationProcess(fact, agent, info);
    const bound = argumentProcess || nativeConversationMatches(fact, agent) && leasedProcess;
    if (bound) {
      const identity = capture(group);
      if (!identity.members.some(row => row.pid === bound.pid && (!leasedProcess || row.birth === lease.process_birth))) return unavailable('native conversation process is not in the captured current group');
      // Bracket the incarnation capture with current process-info, not merely
      // a cached session descriptor plus an unrelated Pi executable.
      const current = native.paneProcessInfo({ session: worker.herdr_session, paneId });
      const conflictingCurrentArgs = (current?.foreground_processes ?? []).some(row => Array.isArray(row.argv) && row.argv.some(arg => typeof arg === 'string' && /^(--session|--session-id)(=|$)/.test(arg))) && !currentConversationProcess(fact, agent, current);
      if (conflictingCurrentArgs) return unavailable('current process conversation arguments disagree at binding recheck');
      const currentLeases = leasedProcess ? refreshLeases().filter(l => l.canonical_id === fact.canonical_id && l.harness === 'pi' && l.kind === 'typed-worker' && Date.parse(l.expires_at) > Date.now()) : [];
      const leaseStillCurrent = leasedProcess && currentLeases.length === 1 && currentLeases.some(l => l.canonical_id === fact.canonical_id && l.owner_token === lease.owner_token && l.pid === lease.pid && l.process_birth === lease.process_birth && Date.parse(l.expires_at) > Date.now());
      const confirmed = currentConversationProcess(fact, agent, current) || leaseStillCurrent && current?.foreground_processes?.find(row => row.pid === lease.pid && nativeProgramProcess(agent, row));
      if (current?.foreground_process_group_id !== group || confirmed?.pid !== bound.pid || !matches(group, identity)) return unavailable('conversation/process incarnation changed during binding');
      return { state: 'available', reason: argumentProcess ? 'current exact conversation arguments bound to captured incarnation' : 'current canonical application lease PID/birth bound to captured incarnation', binding_source: argumentProcess ? 'foreground-arguments' : 'application-lease', identity: {...identity,application:identity.members.find(row=>row.pid===bound.pid)}, pane_id: paneId, agent };
    }
    return unavailable('missing or changed captured incarnation; no matching native conversation identity');
  } catch (error) { return unavailable(`process ownership probe failed: ${error.message}`); }
}
