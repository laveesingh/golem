import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test } from 'vitest';
import {
  archivePrivateScratchFixture,
  archiveTicket,
  createPrivateScratchFixture,
  createScratchTicket,
  SMOKE_PROJECT,
} from '../../dashboard/scripts/_scratch.mjs';
import { openTrackerDb } from '../../dashboard/server/tracker-db.js';
import { createSandbox } from '../support/sandbox.mjs';

test('private scratch cannot override quarantine and rejects a mismatched DB', () => {
  const sandbox = createSandbox();
  const previousOwner = process.env.GOLEM_W2_SANDBOX;
  process.env.GOLEM_W2_SANDBOX = sandbox.root;
  const dbPath = path.join(sandbox.root, 'scratch.db');
  const otherPath = path.join(sandbox.root, 'other.db');
  const tracker = openTrackerDb(dbPath);
  const other = openTrackerDb(otherPath);
  let ticket;
  try {
    ticket = createPrivateScratchFixture(tracker, dbPath, {
      project_id: 'forbidden-real-project',
      created_by: 'human',
      title: 'attempt',
      kind: 'task',
    });
    assert.equal(ticket.project_id, SMOKE_PROJECT);
    assert.equal(ticket.created_by, 'smoke');
    assert.equal(ticket.title, 'SMOKE-attempt');
    assert.throws(
      () => createPrivateScratchFixture(tracker, otherPath),
      /handle\/path mismatch/,
    );
    archivePrivateScratchFixture(tracker, ticket.id);
    assert.equal(tracker.getTicket(ticket.id).state, 'archived');
  } finally {
    if (ticket) archivePrivateScratchFixture(tracker, ticket.id);
    tracker.close();
    other.close();
    sandbox.cleanup();
    process.env.GOLEM_W2_SANDBOX = previousOwner;
  }
});

test('HTTP scratch overrides cannot escape quarantine and cleanup uses the owned API', async () => {
  const previousApi = process.env.GOLEM_SMOKE_API;
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const fields = JSON.parse(body);
    requests.push({ method: request.method, url: request.url, fields });
    response.setHeader('content-type', 'application/json');
    response.statusCode = request.method === 'POST' ? 201 : 200;
    response.end(JSON.stringify({ id: 'fixture-http-ticket', ...fields }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.GOLEM_SMOKE_API = `http://127.0.0.1:${server.address().port}`;
  let ticket;
  try {
    ticket = await createScratchTicket({
      project_id: 'forbidden-real-project',
      created_by: 'human',
      title: 'attempt',
      kind: 'doc',
      body: 'retained body',
    });
    assert.equal(ticket.project_id, SMOKE_PROJECT);
    assert.equal(ticket.created_by, 'smoke');
    assert.equal(ticket.title, 'SMOKE-attempt');
    assert.equal(ticket.kind, 'doc');
    assert.equal(requests[0].fields.project_id, SMOKE_PROJECT);
    assert.equal(requests[0].fields.created_by, 'smoke');
  } finally {
    if (ticket) await archiveTicket(ticket.id);
    if (previousApi === undefined) delete process.env.GOLEM_SMOKE_API;
    else process.env.GOLEM_SMOKE_API = previousApi;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(requests[1].method, 'PATCH');
  assert.equal(requests[1].fields.state, 'archived');
});
