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
