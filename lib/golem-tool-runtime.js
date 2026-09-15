import { GolemClientError } from './golem-client.js';
import { GOLEM_TOOL_CONTRACTS, registerGolemTools } from './golem-tool-contracts.js';

const WRITE_TOOLS = new Set([
  'ticket_create', 'ticket_update', 'ticket_comment',
  'ticket_comment_update', 'ticket_comment_reply', 'ticket_dispatch',
  'session_notify',
]);

function invalid(message) {
  return new GolemClientError(message, { code: 'GOLEM_INVALID_ARGUMENT', retryable: false });
}

function required(value, message) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(message);
  return value.trim();
}

/**
 * Build the harness-neutral execution layer used by native adapters.
 * callerSessionId and projectId are trusted adapter context, never tool args.
 * Adapter-local operations are explicit callbacks rather than hidden process
 * inspection, keeping the same contracts usable in Pi, MCP, and tests.
 */
export function createGolemToolRuntime({
  client,
  callerSessionId,
  projectId,
  acknowledge,
  setRole,
  projectContext,
} = {}) {
  if (!client || typeof client !== 'object') throw new TypeError('createGolemToolRuntime: client is required');
  const trustedSessionId = typeof callerSessionId === 'string' && callerSessionId.trim()
    ? callerSessionId.trim()
    : null;
  const trustedProjectId = typeof projectId === 'string' && projectId.trim()
    ? projectId.trim()
    : null;

  const invoke = async (name, rawArgs = {}) => {
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    if (WRITE_TOOLS.has(name) && !trustedSessionId) {
      throw invalid(`${name}: no trusted caller session id`);
    }

    if (name === 'ack') {
      if (typeof acknowledge !== 'function') throw invalid('ack: adapter does not provide acknowledgement');
      return acknowledge({
        kind: args.kind || 'unknown',
        gate_id: args.gate_id,
        envelope_id: args.envelope_id,
        summary: required(args.summary, 'ack: summary is required'),
        target_session_id: trustedSessionId,
      });
    }
    if (name === 'session_role') {
      if (typeof setRole !== 'function') throw invalid('session_role: adapter does not provide role persistence');
      return setRole({ session_id: trustedSessionId, role: args.role === 'clear' ? null : args.role });
    }
    if (name === 'project_context') {
      if (typeof projectContext !== 'function') throw invalid('project_context: adapter does not provide context rendering');
      return projectContext({ session_id: trustedSessionId, project_id: trustedProjectId });
    }
    if (name === 'ticket_list') {
      const params = {};
      const scopedProject = args.all === true || args.project === '*' ? null : (args.project || trustedProjectId);
      if (scopedProject) params.project = scopedProject;
      if (args.mine === true) params.assignee = required(trustedSessionId, 'ticket_list mine:true: no trusted caller session id');
      else if (args.assignee != null) params.assignee = args.assignee;
      if (args.state != null) params.state = args.state;
      if (args.kind != null) params.kind = args.kind;
      return client.listTickets(params);
    }
    if (name === 'ticket_get') return client.getTicket(required(args.id, 'ticket_get: id is required'));
    if (name === 'ticket_create') {
      const scopedProject = required(args.project || trustedProjectId, 'ticket_create: could not resolve a project — pass project:"<contract-id>"');
      return client.createTicket({
        project_id: scopedProject, title: args.title, body: args.body, kind: args.kind,
        priority: args.priority, state: args.state, labels: args.labels,
        parent_id: args.parent_id, assignee: args.assignee,
        source_ref: args.source_ref, created_by: trustedSessionId,
      });
    }
    if (name === 'ticket_update') {
      const patch = { actor: trustedSessionId };
      for (const key of ['state', 'title', 'body', 'body_format', 'expected_revision', 'kind', 'priority', 'labels', 'parent_id', 'assignee']) {
        if (args[key] !== undefined) patch[key] = args[key];
      }
      return client.updateTicket(required(args.id, 'ticket_update: id is required'), patch);
    }
    if (name === 'ticket_comment') {
      return client.addComment(required(args.id, 'ticket_comment: id is required'), {
        author: trustedSessionId, body: args.body, quote: args.quote, prefix: args.prefix,
        suffix: args.suffix, section: args.section, section_id: args.section_id,
        status: args.status, parent_id: args.parent_id,
      });
    }
    if (name === 'ticket_comment_update') {
      const patch = {};
      for (const key of ['body', 'status']) if (args[key] !== undefined) patch[key] = args[key];
      return client.updateComment(required(args.id, 'ticket_comment_update: id is required'), required(args.comment_id, 'ticket_comment_update: comment_id is required'), patch);
    }
    if (name === 'ticket_comment_reply') {
      return client.replyComment(required(args.id, 'ticket_comment_reply: id is required'), required(args.comment_id, 'ticket_comment_reply: comment_id is required'), { author: trustedSessionId, body: args.body });
    }
    if (name === 'ticket_dispatch') {
      return client.dispatchTicket(required(args.id, 'ticket_dispatch: id is required'), {
        session_id: required(args.session_id, 'ticket_dispatch: session_id is required'),
        note: args.note, mode: args.when_idle === true ? 'when_idle' : 'now',
        workspace: args.workspace || undefined, sender_id: trustedSessionId,
      });
    }
    if (name === 'sessions_dispatchable') return client.listDispatchable(args.project || trustedProjectId || undefined);
    if (name === 'session_notify') {
      const to = required(args.to, 'session_notify: exact `to` session_id is required.');
      const text = required(args.text, 'session_notify: `text` is required.');
      const sessions = await client.listDispatchable();
      const target = Array.isArray(sessions) ? sessions.find((entry) => entry?.session_id === to) : null;
      if (!target) throw invalid(`session_notify: no live dispatchable session has exact session_id "${to}". Labels/names are not accepted; call sessions_dispatchable before choosing a new recipient.`);
      if (target.reachable === false) throw invalid(`session_notify: target session_id "${to}" has no live channel (unreachable) — it cannot receive a push right now.`);
      return client.notifySession({ session_id: to, text: args.ticket ? `${args.ticket}: ${text}` : text, sender_id: trustedSessionId, project_id: target.project_id || null });
    }
    throw invalid(`unknown Golem tool: ${name}`);
  };

  return Object.freeze({
    contracts: GOLEM_TOOL_CONTRACTS,
    invoke,
    register(registerTool, options) {
      return registerGolemTools(registerTool, invoke, options);
    },
  });
}
