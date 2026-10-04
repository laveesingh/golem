import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { afterEach, beforeEach, test, vi } from 'vitest';

vi.mock('../../dashboard/server/native-sessions.js', () => ({
  readNativeSessions: vi.fn(),
}));
vi.mock('../../dashboard/server/channels.js', () => ({
  readChannels: vi.fn(),
}));
vi.mock('../../dashboard/server/projects.js', () => ({
  discoverProjects: vi.fn(async () => []),
}));
vi.mock('chokidar', () => ({
  default: {
    watch: () => {
      const watcher = { on: () => watcher, close: async () => {} };
      return watcher;
    },
  },
}));

import { readChannels } from '../../dashboard/server/channels.js';
import { readNativeSessions } from '../../dashboard/server/native-sessions.js';
import {
  createState,
  requireFreshSessionSnapshot,
} from '../../dashboard/server/state.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let state;
let app;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(100_000);
  vi.mocked(readChannels).mockReset().mockResolvedValue([]);
  vi.mocked(readNativeSessions).mockReset().mockResolvedValue([]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state = createState();
  app = Fastify();
  // The production handler uses this same admission owner before roster work.
  app.get('/snapshot', async () => {
    await requireFreshSessionSnapshot(state);
    return state.nativeSessions();
  });
  await app.ready();
});
afterEach(async () => {
  await state.close();
  await app.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('concurrent cold requests share one refresh and publish a fresh empty snapshot', async () => {
  const gate = deferred();
  vi.mocked(readNativeSessions).mockReturnValueOnce(gate.promise);
  const requests = Array.from({ length: 4 }, () => app.inject('/snapshot'));
  await vi.waitFor(() => assert.equal(readNativeSessions.mock.calls.length, 1));
  assert.equal(state.snapshotAgeMs(), null);
  gate.resolve([]);
  const responses = await Promise.all(requests);
  assert.ok(responses.every((r) => r.statusCode === 200));
  assert.equal(state.snapshotAgeMs(), 0);
  assert.equal(readChannels.mock.calls.length, 1);
  await app.inject('/snapshot');
  assert.equal(
    readNativeSessions.mock.calls.length,
    1,
    'warm requests do not refresh',
  );
});

test('background tick and concurrent stale requests share a flight; next tick refreshes again', async () => {
  await state.init();
  const gate = deferred();
  vi.mocked(readNativeSessions).mockReturnValueOnce(gate.promise);
  await vi.advanceTimersByTimeAsync(3_000);
  assert.equal(readNativeSessions.mock.calls.length, 2);
  vi.setSystemTime(140_001);
  const requests = Array.from({ length: 3 }, () =>
    requireFreshSessionSnapshot(state),
  );
  const tickFlight = state.refreshNativeSessions();
  assert.equal(
    tickFlight,
    state.refreshNativeSessions(),
    'callers receive the same promise',
  );
  assert.equal(readNativeSessions.mock.calls.length, 2);
  gate.resolve([{ session_id: 'new-peer', alive: true }]);
  await Promise.all([...requests, tickFlight]);
  assert.equal(state.snapshotAgeMs(), 0);
  assert.equal(state.nativeSessions()[0].session_id, 'new-peer');
  await vi.advanceTimersByTimeAsync(3_000);
  assert.equal(
    readNativeSessions.mock.calls.length,
    3,
    'successful flight is released',
  );
});

test.each(['cold', 'stale'])(
  '%s rejection preserves age, returns 503 to shared requests, then recovers',
  async (mode) => {
    if (mode === 'stale') {
      vi.mocked(readNativeSessions).mockResolvedValueOnce([
        { session_id: 'old-peer' },
      ]);
      await state.refreshNativeSessions();
      vi.setSystemTime(130_001);
    }
    const oldAge = state.snapshotAgeMs();
    const oldStamp = oldAge == null ? null : Date.now() - oldAge;
    const baseline = readNativeSessions.mock.calls.length;
    const gate = deferred();
    vi.mocked(readNativeSessions).mockReturnValueOnce(gate.promise);
    const requests = Array.from({ length: 3 }, () => app.inject('/snapshot'));
    await vi.waitFor(() =>
      assert.equal(readNativeSessions.mock.calls.length, baseline + 1),
    );
    gate.reject(new Error('discovery rejected'));
    const responses = await Promise.all(requests);
    assert.ok(responses.every((r) => r.statusCode === 503));
    assert.ok(
      responses.every(
        (r) =>
          r.json().message ===
          'dispatchable session snapshot is unavailable or stale',
      ),
    );
    assert.equal(
      state.snapshotAgeMs() == null ? null : Date.now() - state.snapshotAgeMs(),
      oldStamp,
    );
    assert.equal(
      console.error.mock.calls.length,
      1,
      'refresh owner logs one failure',
    );
    const recovered = await app.inject('/snapshot');
    assert.equal(recovered.statusCode, 200);
    assert.equal(state.snapshotAgeMs(), 0);
    assert.equal(
      readNativeSessions.mock.calls.length,
      baseline + 2,
      'failed flight is released',
    );
  },
);

test('freshness boundary is inclusive and channel read failure still permits registry fallback', async () => {
  vi.mocked(readChannels).mockRejectedValueOnce(
    new Error('channels unavailable'),
  );
  await state.refreshNativeSessions();
  assert.deepEqual(readNativeSessions.mock.calls[0][1], []);
  vi.setSystemTime(130_000);
  assert.equal((await app.inject('/snapshot')).statusCode, 200);
  assert.equal(readNativeSessions.mock.calls.length, 1);
  vi.setSystemTime(130_001);
  assert.equal((await app.inject('/snapshot')).statusCode, 200);
  assert.equal(readNativeSessions.mock.calls.length, 2);
});
