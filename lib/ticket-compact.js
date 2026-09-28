// Compact ticket write responses for agents (GOL-349 response shaping, shared by
// the CLI, the Claude channel MCP and the Pi tool runtime).
//
// A write's caller already has the body it sent; the REST payload also carries
// comments, events and, for dispatch, the ticket twice plus the raw channel
// result. Agents get what they act on: the summary fields, the html outline
// with its assigned block ids, and mermaid_errors. `ticket_get` stays the
// deliberate full read. REST responses are unchanged: the web drawer reads them.

export const TICKET_SUMMARY_FIELDS = Object.freeze(['id', 'display_id', 'seq', 'project_id', 'kind', 'title', 'state',
  'priority', 'assignee', 'assignee_label', 'parent_id', 'labels', 'body_format', 'body_revision',
  'created_by', 'created_at', 'updated_at']);

export function compactTicket(ticket) {
  if (!ticket || typeof ticket !== 'object') return ticket;
  const summary = {};
  for (const field of TICKET_SUMMARY_FIELDS) {
    if (ticket[field] !== undefined) summary[field] = ticket[field];
  }
  // D3: html create/update responses carry the normalized outline with the
  // assigned block ids — that is the useful payload, not the body.
  if (Array.isArray(ticket.outline)) summary.outline = ticket.outline;
  // GOL-369 D7: the server checks changed Mermaid diagrams on every write.
  // The write commits; broken diagrams report here so the next edit fixes
  // only that diagram.
  if (Array.isArray(ticket.mermaid_errors)) summary.mermaid_errors = ticket.mermaid_errors;
  return summary;
}

// POST /api/tickets/:id/dispatch returns the ticket twice (assignment.ticket and
// ticket) and the raw channel result, whose body repeats the receiver's brief.
// The dispatcher keeps the delivery outcome and one ticket summary.
export function compactDispatch(result) {
  if (!result || typeof result !== 'object') return result;
  const out = {};
  for (const field of ['ok', 'queued', 'delivered', 'queue_id', 'envelope_id', 'delivery']) {
    if (result[field] !== undefined) out[field] = result[field];
  }
  if (result.ticket) out.ticket = compactTicket(result.ticket);
  return out;
}

// ticket_get for agents: the ticket itself stays whole (body, state, links,
// dispatch fields). What shrinks is what repeats or belongs to other tickets:
// - children: each child's own summary, not its full body (read the child
//   with its own ticket_get);
// - events: type, actor, data and time; the row ids and routing fields repeat
//   on every event and carry no meaning for the reader;
// - comments: the text and its anchor (quote, section, block) without the
//   text-matching offsets and the parent ticket id.
// `full: true` on the tool returns the unshaped REST payload.
const CHILD_FIELDS = ['id', 'display_id', 'title', 'kind', 'state', 'assignee', 'assignee_label'];
const EVENT_FIELDS = ['type', 'actor_label', 'data', 'created_at'];
const COMMENT_DROP = new Set(['ticket_id', 'prefix', 'suffix', 'section_id', 'updated_at']);

function pick(row, fields) {
  const out = {};
  for (const field of fields) if (row?.[field] !== undefined) out[field] = row[field];
  return out;
}

export function compactTicketRead(ticket) {
  if (!ticket || typeof ticket !== 'object') return ticket;
  const out = { ...ticket };
  if (Array.isArray(ticket.children)) out.children = ticket.children.map((child) => pick(child, CHILD_FIELDS));
  if (Array.isArray(ticket.events)) out.events = ticket.events.map((event) => pick(event, EVENT_FIELDS));
  if (Array.isArray(ticket.comments)) {
    out.comments = ticket.comments.map((comment) => Object.fromEntries(
      Object.entries(comment).filter(([key]) => !COMMENT_DROP.has(key)),
    ));
  }
  return out;
}

// ticket_list rows: the same summary the CLI prints; bodies come from ticket_get.
export function compactTicketList(rows) {
  const list = Array.isArray(rows) ? rows : rows?.tickets;
  if (!Array.isArray(list)) return rows;
  const compact = list.map(compactTicket);
  return Array.isArray(rows) ? compact : { ...rows, tickets: compact };
}
