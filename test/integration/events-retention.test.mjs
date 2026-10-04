import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { openTrackerDb } from '../../dashboard/server/tracker-db.js';

test('tracker retention is explicit and preserves recent events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-retention-'));
  const tracker = openTrackerDb(path.join(dir, 'tracker.db'));
  const nowTs = '2026-10-04T00:00:00.000Z';
  try {
    for (const cls of ['tracker', 'activity', 'lifecycle']) {
      for (const created_at of [
        '2026-09-01T00:00:00.000Z',
        '2026-10-03T00:00:00.000Z',
      ]) {
        tracker.recordEvent({
          type: 'retention_probe',
          class: cls,
          created_at,
          data: {},
        });
      }
    }
    const ordinary = tracker.pruneBus({
      nowTs,
      lifecycleDays: 7,
      activityDays: 7,
    });
    assert.equal(ordinary.deleted, 2);
    assert.equal(
      tracker.busStats().rows_per_class.find((r) => r.class === 'tracker')
        .count,
      2,
    );
    assert.throws(
      () => tracker.pruneBus({ trackerDays: -1 }),
      /positive number/,
    );
    const explicit = tracker.pruneBus({
      nowTs,
      trackerDays: 7,
      lifecycleDays: 7,
      activityDays: 7,
    });
    assert.equal(explicit.tracker, 1);
    assert.equal(explicit.deleted, 1);
    assert.equal(
      tracker.busStats().rows_per_class.find((r) => r.class === 'tracker')
        .count,
      1,
    );
    assert.equal(
      tracker.pruneBus({
        nowTs,
        trackerDays: 7,
        lifecycleDays: 7,
        activityDays: 7,
      }).deleted,
      0,
    );
  } finally {
    tracker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
