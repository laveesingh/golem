import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  archiveTicket,
  createScratchTicket,
} from '../../dashboard/scripts/_scratch.mjs';
import { startPrivateDashboard } from '../support/private-dashboard.mjs';

const exportPath = path.join(
  process.env.GOLEM_W2_SANDBOX,
  'scrub-openapi.json',
);
const dashboard = await startPrivateDashboard({
  env: { ...process.env, GOLEM_OPENAPI_EXPORT: exportPath },
});
process.env.GOLEM_SMOKE_API = dashboard.base;
const tickets = [];
async function request(route, method = 'GET', body) {
  return fetch(`${dashboard.base}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
}
try {
  for (const title of ['scrub source', 'scrub target']) {
    tickets.push(await createScratchTicket({ title }));
  }
  const id = tickets[0].id;
  const openapi = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  for (const [method, route, schemaPath] of [
    ['POST', `/api/tickets/${id}/move`, '/api/tickets/{id}/move'],
    ['GET', '/api/channels', '/api/channels'],
    ['GET', '/api/channel/health', '/api/channel/health'],
    ['GET', '/api/projects/scrub-project', '/api/projects/{id}'],
    ['GET', '/api/projects/scrub-project/plan', '/api/projects/{id}/plan'],
  ]) {
    assert.ok(!(schemaPath in openapi.paths), schemaPath);
    const response = await request(
      route,
      method,
      method === 'POST' ? { state: 'review' } : undefined,
    );
    assert.equal(response.status, 404, `${method} ${route}`);
    assert.equal((await response.json()).error, 'not found');
  }
  const patch = await request(`/api/tickets/${id}`, 'PATCH', {
    state: 'review',
    actor: 'smoke',
  });
  assert.equal(patch.status, 200);
  assert.equal((await patch.json()).state, 'review');
  for (const route of [
    '/api/snapshot',
    '/api/projects',
    '/api/workspaces',
    '/api/chat',
  ]) {
    const response = await request(route);
    assert.equal(response.status, 200, route);
    if (route === '/api/snapshot') {
      const snapshot = await response.json();
      assert.ok(Array.isArray(snapshot.channels));
      assert.ok(Array.isArray(snapshot.projects));
    }
  }
  const linkBody = {
    to_ticket: tickets[1].id,
    type: 'relates',
    actor: 'smoke',
  };
  for (const method of ['POST', 'DELETE']) {
    const response = await request(
      `/api/tickets/${id}/links`,
      method,
      linkBody,
    );
    assert.equal(
      response.status,
      method === 'POST' ? 201 : 200,
      `${method} links`,
    );
  }
  console.log(
    'S6: five removed routes return 404 and are absent from actual OpenAPI; PATCH, snapshot, consumed reads and link writes remain',
  );
} finally {
  try {
    for (const ticket of tickets) await archiveTicket(ticket.id);
  } finally {
    await dashboard.stop();
  }
}
