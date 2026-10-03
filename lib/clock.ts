export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Deterministic, monotonic clock. Callbacks at equal deadlines use FIFO order. */
export function createTestClock(
  startMs: number,
): Clock & { advance(ms: number): void } {
  if (!Number.isSafeInteger(startMs) || startMs < 0)
    throw Error('invalid clock epoch');
  let time = startMs;
  let sequence = 0;
  let advancing = false;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => time,
    setTimeout(fn, ms) {
      if (!Number.isFinite(ms) || ms < 0 || !Number.isSafeInteger(time + ms))
        throw Error('invalid clock delay');
      const id = ++sequence;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      if (advancing) throw Error('recursive clock advance');
      if (
        !Number.isSafeInteger(ms) ||
        ms < 0 ||
        !Number.isSafeInteger(time + ms)
      )
        throw Error('invalid clock advance');
      const target = time + ms;
      advancing = true;
      try {
        let fired = 0;
        for (;;) {
          const next = [...timers]
            .filter(([, timer]) => timer.at <= target)
            .sort(([a, left], [b, right]) => left.at - right.at || a - b)[0];
          if (!next) break;
          if (++fired > 10000) throw Error('clock callback budget exceeded');
          const [id, timer] = next;
          timers.delete(id);
          time = timer.at;
          timer.fn();
        }
        time = target;
      } finally {
        advancing = false;
      }
    },
  };
}
