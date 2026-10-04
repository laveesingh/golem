// #54: the dashboard can answer slower than the old 1.5 s request default, and a
// role POST can land server-side while its response is lost to an abort. These
// tests pin both halves of the fix: the raised default and the non-destructive
// abort path (commit when the role landed, tear down when it did not).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  spawnWorker,
  waitForWorkerRegistration,
} from '../../lib/worker-manager.js';
import { readWorkers } from '../../lib/worker-registry.js';

function abortError() {
  return Object.assign(new Error('This operation was aborted'), {
    name: 'AbortError',
  });
}

// Each spawn runs against an isolated GOLEM_HOME so worker and management rows
// never leak between tests. Saved env is restored after every test.
let savedEnv;
let home;
function isolate() {
  savedEnv = { ...process.env };
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-worker-timeout-test-'));
  const project = path.join(home, 'proj');
  fs.mkdirSync(project, { recursive: true });
  process.env.GOLEM_HOME = path.join(home, 'golem-home');
  fs.mkdirSync(process.env.GOLEM_HOME, { recursive: true });
  process.env.HOME = path.join(home, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  delete process.env.GOLEM_WORKER_REQUEST_TIMEOUT_MS;
  delete process.env.GOLEM_DASHBOARD_URL;
  delete process.env.GOLEM_TEST_REGISTRATION_DIR;
  return project;
}
function restore() {
  for (const key of Object.keys(process.env))
    if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(home, { recursive: true, force: true });
}

function fakeNative(calls) {
  return {
    ensureSession: () => ({ started: true }),
    workspaceList: () => [],
    workspaceCreate: () => ({ workspace_id: 'ws-test' }),
    workspaceClose: () => true,
    tabCreate: () => ({
      tab: { tab_id: 'tab-test' },
      pane: { pane_id: 'pane-test', tab_id: 'tab-test' },
    }),
    tabClose: (args) => {
      calls.tabClose.push(args);
      return true;
    },
    paneRun: () => ({}),
    paneList: () => [],
    paneProcessInfo: () => ({}),
    agentList: () => [],
    agentRename: () => ({}),
    agentGet: () => ({ pane_id: 'pane-test' }),
  };
}

function spawnDeps(project, calls, { assign, readRole }) {
  return {
    native: fakeNative(calls),
    resolveProject: async () => ({
      projectRoot: project,
      projectId: 'timeout-proj',
    }),
    resolveExecution: () => ({
      harness: 'pi',
      provider: 'test',
      model: 'test-model',
    }),
    registration: async () => ({
      session_id: 'sess-test-1',
      channel_url: null,
    }),
    detected: async () => ({}),
    assign,
    readRole,
    barrier: async () => {},
  };
}

test('aborted role post that landed server-side commits instead of tearing down', async () => {
  const project = isolate();
  try {
    const calls = { tabClose: [] };
    const worker = await spawnWorker(
      { role: 'builder', name: 'timeout-commit', project },
      spawnDeps(project, calls, {
        assign: async () => {
          throw abortError();
        },
        readRole: async () => 'builder',
      }),
    );
    assert.equal(worker.session_id, 'sess-test-1');
    assert.equal(worker.state, 'live');
    assert.deepEqual(calls.tabClose, []);
  } finally {
    restore();
  }
});

test('aborted role post with no committed role still tears down', async () => {
  const project = isolate();
  try {
    const calls = { tabClose: [] };
    await assert.rejects(
      spawnWorker(
        { role: 'builder', name: 'timeout-teardown', project },
        spawnDeps(project, calls, {
          assign: async () => {
            throw abortError();
          },
          readRole: async () => null,
        }),
      ),
      /aborted/i,
    );
    assert.equal(calls.tabClose.length, 1);
    assert.equal(calls.tabClose[0].tabId, 'tab-test');
    const row = readWorkers().find((w) => w.name === 'timeout-teardown');
    assert.equal(row?.state, 'failed');
  } finally {
    restore();
  }
});

test('dispatchable poll survives dashboard latency past the old 1.5 s default', async () => {
  isolate();
  let server;
  try {
    const rows = [
      {
        session_id: 'sess-slow',
        project_id: 'slow-proj',
        name: 'slow-builder',
        role: null,
        status: 'idle',
      },
    ];
    server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(rows));
      }, 2500);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.GOLEM_DASHBOARD_URL = `http://127.0.0.1:${server.address().port}`;
    const row = await waitForWorkerRegistration({
      projectId: 'slow-proj',
      sessionId: 'sess-slow',
      timeoutMs: 15000,
      pollMs: 250,
    });
    assert.equal(row.session_id, 'sess-slow');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    restore();
  }
});
