#!/usr/bin/env node
import assert from 'node:assert/strict';
import { stableWatchedPaths } from '../dashboard/server/state.js';

const firstDiscovery = stableWatchedPaths([
  '/projects/b/PLAN.md',
  '/journals/b/hook.jsonl',
  '/projects/a/PLAN.md',
  '/journals/a/hook.jsonl',
]);
const recencyReorderedDiscovery = stableWatchedPaths([
  '/journals/a/hook.jsonl',
  '/projects/a/PLAN.md',
  '/journals/b/hook.jsonl',
  '/projects/b/PLAN.md',
]);

assert.deepEqual(
  recencyReorderedDiscovery,
  firstDiscovery,
  'project recency reordering must not change the watcher fingerprint',
);
assert.deepEqual(
  stableWatchedPaths([...firstDiscovery, '/projects/a/PLAN.md']),
  firstDiscovery,
  'duplicate discovered paths must not change the watcher fingerprint',
);
assert.notDeepEqual(
  stableWatchedPaths([...firstDiscovery, '/projects/c/PLAN.md']),
  firstDiscovery,
  'adding a watched path must change the watcher fingerprint',
);
assert.notDeepEqual(
  stableWatchedPaths(firstDiscovery.slice(1)),
  firstDiscovery,
  'removing a watched path must change the watcher fingerprint',
);

console.log('state watcher fingerprint tests passed');
