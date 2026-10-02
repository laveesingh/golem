import assert from 'node:assert/strict';
import {
  archiveTicket,
  createScratchTicket,
  SMOKE_PROJECT,
} from '../../dashboard/scripts/_scratch.mjs';
import { pilotClient } from '../../dashboard/web/src/api/pilot-client.ts';
import { startPrivateDashboard } from '../support/private-dashboard.mjs';

const dashboard = await startPrivateDashboard();
const client = pilotClient(dashboard.base);
const ids = [];
const previous = process.env.GOLEM_SMOKE_API;
process.env.GOLEM_SMOKE_API = dashboard.base;
try {
  assert.equal((await client.health()).ok, true);
  const created = await createScratchTicket(
    { title: 'typed client', priority: null },
    (body) => client.createTicket(body),
  );
  ids.push(created.id);
  assert.equal(created.priority, null);
  assert.equal(created.kind, 'task');
  await assert.rejects(
    client.createTicket({
      project_id: SMOKE_PROJECT,
      created_by: 'smoke',
      title: '',
    }),
    (error) =>
      error.payload?.code === 'invalid_input' &&
      error.payload?.error === 'createTicket: title is required',
  );
  console.log(
    'typed pilot client: health/create/nullable/error consumers pass',
  );
} finally {
  for (const id of ids) await archiveTicket(id);
  if (previous === undefined) delete process.env.GOLEM_SMOKE_API;
  else process.env.GOLEM_SMOKE_API = previous;
  await dashboard.stop();
}
