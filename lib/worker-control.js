// Locate a native terminal by its reported conversation. This is discovery,
// never an authority/process-incarnation gate on an explicitly selected pane.
import path from 'node:path';
export function nativeConversationMatches(fact, agent) {
  const ref = agent?.agent_session;
  if (!fact?.locator || typeof ref?.value !== 'string') return false;
  if (ref.kind === 'path') return !!fact.locator.session_file && path.resolve(ref.value) === path.resolve(fact.locator.session_file);
  return ref.kind === 'id' && !!ref.value && ref.value === fact.locator.raw_session_id;
}
