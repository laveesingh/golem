import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createTestClock, systemClock } from '../../lib/clock.ts';

test('clock advances deadlines in FIFO order, including nested callbacks', () => {
  const clock = createTestClock(100);
  const events = [];
  clock.setTimeout(() => {
    events.push(clock.now());
    clock.setTimeout(() => events.push('nested'), 0);
  }, 10);
  clock.setTimeout(() => events.push('same'), 10);
  const cancelled = clock.setTimeout(() => events.push('cancelled'), 5);
  clock.clearTimeout(cancelled);
  clock.advance(10);
  assert.deepEqual(events, [110, 'same', 'nested']);
  assert.equal(clock.now(), 110);
  clock.advance(100);
  assert.equal(clock.now(), 210);
});

test('clock refuses invalid or recursive advances and bounds zero-delay loops', () => {
  for (const value of [-1, Infinity, NaN, 1.5])
    assert.throws(() => createTestClock(value));
  const clock = createTestClock(0);
  for (const value of [-1, Infinity, NaN]) {
    assert.throws(() => clock.advance(value));
    assert.throws(() => clock.setTimeout(() => {}, value));
  }
  clock.setTimeout(() => clock.advance(0), 0);
  assert.throws(() => clock.advance(0), /recursive/);
  const recur = () => clock.setTimeout(recur, 0);
  recur();
  assert.throws(() => clock.advance(0), /budget/);
  assert.equal(typeof systemClock.now(), 'number');
});
