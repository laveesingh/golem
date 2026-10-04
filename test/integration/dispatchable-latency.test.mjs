// #56 regression: dispatchable must not refresh per request (A), must use the
// events(type) index (B), and must enrich once per request (C). A seeded home
// (tens of thousands of events, a hundred sessions) plus a fake `claude`
// binary makes each mechanism observable: spawn counts for A, EXPLAIN for B,
// and a p95 bound over all three.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { test } from 'vitest';

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const server = path.join(repo, 'dashboard', 'server', 'index.js');

const SESSIONS = 120;
const EVENTS = 150000;
// A slow fake `claude` (0.3 s) stands in for the real CLI's startup cost, so a
// per-request refresh is observable in timing; the seeded events make the
// unindexed scan observable too. Calibrated post-fix vs pre-fix on the
// reporter's machine — guards all three mechanisms jointly.
const P95_BOUND_MS = 350;

let savedEnv;
let temp;
let child = null;

function freePort() {
  return new Promise((resolve, reject) => {
    import('node:net').then(({ default: net }) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const port = probe.address().port;
        probe.close(() => resolve(port));
      });
    });
  });
}

async function setup() {
  savedEnv = { ...process.env };
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-dispatchable-perf-'));
  const bin = path.join(temp, 'bin');
  const state = path.join(temp, 'state');
  const claudeHome = path.join(temp, 'claude-home');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
  // Fake `claude`: instant `[]` answer plus an invocation log, so per-request
  // refreshes are countable without waiting on the real CLI.
  const spawnLog = path.join(temp, 'claude-spawns.log');
  fs.writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh\necho spawn >> ${JSON.stringify(spawnLog)}\nsleep 0.3\nprintf '[]'\n`,
    { mode: 0o700 },
  );
  fs.writeFileSync(spawnLog, '');
  // Registry sessions with live pids: harness defaults to claudecode, whose
  // liveness is pid-based, so these rows are alive with no endpoint needed.
  const now = Date.now();
  for (let i = 0; i < SESSIONS; i += 1) {
    fs.writeFileSync(
      path.join(claudeHome, 'sessions', `sess-${i}.json`),
      JSON.stringify({
        sessionId: `perf-session-${i}`,
        pid: process.pid,
        name: `perf-agent-${i}`,
        cwd: path.join(temp, 'proj'),
        status: 'idle',
        updatedAt: now,
        startedAt: now,
      }),
    );
  }
  fs.mkdirSync(path.join(temp, 'proj'), { recursive: true });
  const tracker = path.join(temp, 'tracker.db');
  const port = await freePort();
  child = spawn(process.execPath, [server], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      CLAUDE_CONFIG_DIR: claudeHome,
      GOLEM_HOME: state,
      GOLEM_TRACKER_DB: tracker,
      PORT: String(port),
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) =>
    process.stderr.write(`[perf-server] ${chunk}`),
  );
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('perf dashboard did not start');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // Seed after boot so migrate() owns the schema; the scan cost is what matters.
  const db = new Database(tracker);
  const insert = db.prepare(
    "INSERT INTO events (ticket_id, project_id, type, data, created_at) VALUES (NULL, 'perf-proj', 'fixture_noise', '{}', @at)",
  );
  const base2 = Date.now() - 3600000;
  db.transaction(() => {
    for (let i = 0; i < EVENTS; i += 1) {
      insert.run({ at: new Date(base2 + i * 50).toISOString() });
    }
  })();
  db.close();
  return { base, spawnLog, tracker };
}

async function teardown() {
  if (child) {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    child = null;
  }
  for (const key of Object.keys(process.env))
    if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(temp, { recursive: true, force: true });
}

async function getDispatchable(base) {
  const started = Date.now();
  const res = await fetch(`${base}/api/sessions/dispatchable`);
  const elapsed = Date.now() - started;
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.ok(Array.isArray(rows), 'dispatchable returns an array');
  return { rows, elapsed };
}

function spawnCount(spawnLog) {
  try {
    const text = fs.readFileSync(spawnLog, 'utf8');
    return text.split('\n').filter((line) => line === 'spawn').length;
  } catch {
    return 0;
  }
}

test('dispatchable serves the tick snapshot, uses the type index, and stays fast', async () => {
  try {
    const { base, spawnLog, tracker } = await setup();
    // B, structural: the warning lookup must seek the new index, not scan.
    const db = new Database(tracker, { readonly: true });
    try {
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT w.id FROM events w WHERE w.type = 'dispatch_unacked_warning' ORDER BY w.created_at ASC, w.id ASC",
        )
        .all()
        .map((row) => row.detail)
        .join(' | ');
      assert.ok(
        plan.includes('idx_events_type'),
        `warning lookup uses idx_events_type, got: ${plan}`,
      );
    } finally {
      db.close();
    }
    // Warm up (first call may still take the cold-start refresh), then reset
    // the spawn log so the window below counts request-driven refreshes only.
    await getDispatchable(base);
    await getDispatchable(base);
    fs.writeFileSync(spawnLog, '');
    // A+C: five rapid polls; post-fix none of them refreshes (the 3 s tick may
    // fire at most once inside this window, hence the ≤2 allowance).
    const elapsed = [];
    for (let i = 0; i < 5; i += 1) {
      const { rows, elapsed: ms } = await getDispatchable(base);
      elapsed.push(ms);
      assert.ok(
        rows.length >= SESSIONS,
        `seeded sessions are all listed (got ${rows.length})`,
      );
      assert.ok(
        rows.every((row) => row?.session_id),
        'every row carries a session_id',
      );
    }
    const p95 = elapsed.sort((a, b) => a - b)[Math.min(elapsed.length - 1, 4)];
    console.log(
      `[perf-test] samples=${elapsed.join(',')}ms; refreshes=${spawnCount(spawnLog)}`,
    );
    assert.ok(p95 < P95_BOUND_MS, `p95 ${p95}ms under ${P95_BOUND_MS}ms`);
    const during = spawnCount(spawnLog);
    assert.ok(
      during <= 2,
      `at most a tick refresh during 5 polls (saw ${during} spawns)`,
    );
  } finally {
    await teardown();
  }
}, 120000);
