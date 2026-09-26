#!/usr/bin/env node
// Compact ticket write responses: the shared shaper and the Pi tool runtime
// that returns it. A fake client stands in for the dashboard REST payloads.

import assert from 'node:assert/strict';
import { compactDispatch, compactTicket, TICKET_SUMMARY_FIELDS } from '../lib/ticket-compact.js';
import { createGolemToolRuntime } from '../lib/golem-tool-runtime.js';

const body = 'x'.repeat(20_000);
const fullTicket = {
  id: 'TKT-1', display_id: 'GOL-1', seq: 1, project_id: 'golem-38ab8a', kind: 'spec', title: 'T', state: 'in_progress',
  priority: 'p2', assignee: 's-2', assignee_label: 'builder1', parent_id: null, labels: [], body_format: 'html', body_revision: 7,
  created_by: 's-1', created_at: 1, updated_at: 2,
  body, comments: [{ id: 'c1', body }], events: [{ kind: 'dispatched' }], children: [], links: [],
  active_unacked_dispatches: [{ id: 'd1' }],
  outline: [{ block_id: 'b1', heading: 'Summary' }], mermaid_errors: [{ block_id: 'b2', error: 'parse' }],
};
const summary = compactTicket(fullTicket);

// compactTicket keeps what a writer acts on and drops the echo.
for (const field of TICKET_SUMMARY_FIELDS) assert.deepEqual(summary[field], fullTicket[field], `keeps ${field}`);
assert.deepEqual(summary.outline, fullTicket.outline, 'keeps the html outline with block ids');
assert.deepEqual(summary.mermaid_errors, fullTicket.mermaid_errors, 'keeps mermaid_errors');
for (const field of ['body', 'comments', 'events', 'children', 'links', 'active_unacked_dispatches']) {
  assert.equal(field in summary, false, `drops ${field}`);
}
assert.equal(compactTicket(null), null);

// compactDispatch keeps the delivery outcome and one ticket summary.
const delivered = {
  ok: true, assignment: { ok: true, ticket: fullTicket }, queued: false, delivered: true, envelope_id: 'env-1', ticket: fullTicket,
  delivery: { ok: true, queued: false, mode: 'push', status: 200, error: null }, channel: { ok: true, status: 200, body: JSON.stringify({ brief: body }) },
};
assert.deepEqual(compactDispatch(delivered), {
  ok: true, queued: false, delivered: true, envelope_id: 'env-1', delivery: delivered.delivery, ticket: summary,
});
const queued = { ok: true, queued: true, delivered: false, queue_id: 'q-1', envelope_id: 'env-2', ticket: fullTicket };
assert.deepEqual(compactDispatch(queued), { ok: true, queued: true, delivered: false, queue_id: 'q-1', envelope_id: 'env-2', ticket: summary });
const deliveredSize = JSON.stringify(delivered).length;
const compactSize = JSON.stringify(compactDispatch(delivered)).length;
assert.ok(compactSize < 1_000 && deliveredSize > 80_000, `dispatch shrinks ${deliveredSize} -> ${compactSize}`);

// The Pi runtime returns the compact shapes; comment tools pass through.
const calls = [];
const client = {
  createTicket: async (payload) => { calls.push(['create', payload.title]); return fullTicket; },
  updateTicket: async (id, patch) => { calls.push(['update', id, patch.title]); return fullTicket; },
  dispatchTicket: async (id, input) => { calls.push(['dispatch', id, input.session_id]); return delivered; },
  addComment: async () => ({ id: 'c9', body: 'hi' }),
};
const runtime = createGolemToolRuntime({ client, callerSessionId: 's-1', projectId: 'golem-38ab8a' });
assert.deepEqual(await runtime.invoke('ticket_create', { title: 'T' }), summary);
assert.deepEqual(await runtime.invoke('ticket_update', { id: 'GOL-1', title: 'T2' }), summary);
assert.deepEqual(await runtime.invoke('ticket_dispatch', { id: 'GOL-1', session_id: 's-2' }), compactDispatch(delivered));
assert.deepEqual(await runtime.invoke('ticket_comment', { id: 'GOL-1', body: 'hi' }), { id: 'c9', body: 'hi' });
assert.deepEqual(calls, [['create', 'T'], ['update', 'GOL-1', 'T2'], ['dispatch', 'GOL-1', 's-2']]);

console.log(`ticket compact passed: summary + outline + mermaid_errors kept, echo dropped; dispatch ${deliveredSize} -> ${compactSize} chars; Pi runtime returns compact create/update/dispatch`);
