import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'vitest';
import {
  archivePrivateScratchFixture,
  createPrivateScratchFixture,
  SMOKE_PROJECT,
} from '../../dashboard/scripts/_scratch.mjs';
import { openTrackerDb } from '../../dashboard/server/tracker-db.js';
import { createSandbox } from '../support/sandbox.mjs';

test('private scratch cannot override quarantine and rejects a mismatched DB', () => {
  const sandbox = createSandbox();
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
  }
});
