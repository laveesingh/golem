import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { readProjectMilestones } from '../../dashboard/server/milestones.js';
import {
  readShareRegistry,
  registryOrigin,
  writeShareRegistry,
} from '../../dashboard/server/share-tunnel.js';
import {
  DASHBOARD_FALLBACK_URL,
  dashboardBaseUrlFrom,
  loadDashboardStore,
  saveDashboardStore,
} from '../../lib/dashboard-store.ts';
import {
  appendJsonl,
  assertJsonlReadable,
  ensureJsonlHeader,
  isJsonlHeaderLine,
  readJsonl,
} from '../../lib/jsonl-header.ts';
import { createPilotClient } from '../../lib/pilot-client.ts';
import {
  VersionedFileError,
  validateVersioned,
} from '../../lib/read-versioned.ts';
import {
  loadShareTunnelStore,
  saveShareTunnelStore,
  shareRegistryPath,
} from '../../lib/share-tunnel-store.ts';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-stores-unit-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
function refusal(fn, status = 409) {
  assert.throws(
    fn,
    (error) =>
      error instanceof VersionedFileError && error.statusCode === status,
  );
}

test('dashboard.json: missing reads the versioned default without writing', () => {
  const file = path.join(root, 'dashboard.json');
  assert.deepEqual(loadDashboardStore(file), {
    value: { schema_version: 1 },
    version: 1,
    migrated: false,
  });
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(dashboardBaseUrlFrom(file), DASHBOARD_FALLBACK_URL);
});

test('dashboard.json: unversioned legacy migrates in memory; writes stamp v1', () => {
  const file = path.join(root, 'dashboard.json');
  const legacy = {
    url: 'http://127.0.0.1:7421',
    host: '127.0.0.1',
    port: 7421,
    pid: 123,
    started_at: '2026-10-03T00:00:00.000Z',
    extension: 'kept',
  };
  const before = JSON.stringify(legacy);
  fs.writeFileSync(file, before);
  const read = loadDashboardStore(file);
  assert.equal(read.migrated, true);
  assert.deepEqual(read.value, { ...legacy, schema_version: 1 });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(dashboardBaseUrlFrom(file), 'http://127.0.0.1:7421');
  saveDashboardStore({ url: 'http://127.0.0.1:7422' }, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    url: 'http://127.0.0.1:7422',
    schema_version: 1,
  });
});

test('dashboard.json: future and invalid stored state refuses; invalid saves are 400', () => {
  const file = path.join(root, 'dashboard.json');
  fs.writeFileSync(file, JSON.stringify({ schema_version: 2, url: 'x' }));
  refusal(() => loadDashboardStore(file));
  // Discovery keeps its existing fallback contract for unusable files.
  assert.equal(dashboardBaseUrlFrom(file), DASHBOARD_FALLBACK_URL);
  fs.writeFileSync(file, 'not json');
  refusal(() => loadDashboardStore(file));
  refusal(() => saveDashboardStore({ url: 42 }, file), 400);
});

test('share-tunnel.json: legacy publicPort migrates; versioned roundtrip keeps origin', () => {
  const home = path.join(root, 'home');
  const file = shareRegistryPath(home);
  const legacy = {
    publicPort: 61961,
    metricsPort: 20991,
    hostname: 'old-host.trycloudflare.com',
    pid: 987654,
    updated_at: '2020-01-01T00:00:00.000Z',
  };
  const before = JSON.stringify(legacy);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, before);
  const read = loadShareTunnelStore(file);
  assert.equal(read.migrated, true);
  assert.deepEqual(read.value, { ...legacy, schema_version: 1 });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(
    registryOrigin(readShareRegistry(home)),
    'http://127.0.0.1:61961',
  );
  writeShareRegistry(home, { ...legacy, origin: 'http://127.0.0.1:7420' });
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.schema_version, 1);
  assert.equal(stored.origin, 'http://127.0.0.1:7420');
});

test('share-tunnel.json: future and invalid registries refuse, never read as absent', () => {
  const home = path.join(root, 'home2');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    shareRegistryPath(home),
    JSON.stringify({ schema_version: 2, origin: 'http://127.0.0.1:7420' }),
  );
  refusal(() => loadShareTunnelStore(shareRegistryPath(home)));
  refusal(() => readShareRegistry(home));
  refusal(
    () => saveShareTunnelStore(shareRegistryPath(home), { pid: 'x' }),
    400,
  );
});

test('shared validateVersioned migrates legacy input and refuses versions', () => {
  const policy = {
    currentVersion: 1,
    validateCurrent: (value) =>
      value !== null && typeof value === 'object' && value.schema_version === 1,
    validateLegacy: (value) =>
      value !== null &&
      typeof value === 'object' &&
      typeof value.url === 'string',
    migrateLegacy: (value) => ({ ...value, schema_version: 1 }),
    missing: () => ({ schema_version: 1 }),
  };
  const file = path.join(root, 'probe.json');
  assert.deepEqual(
    validateVersioned({ url: 'http://127.0.0.1:7421' }, policy, file),
    { url: 'http://127.0.0.1:7421', schema_version: 1 },
  );
  assert.throws(
    () => validateVersioned({ schema_version: 2 }, policy, file),
    (error) => error instanceof VersionedFileError,
  );
});

test('typed pilot client performs health and ticket-create calls without a server', async () => {
  const calls = [];
  const stubFetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = String(request?.url ?? input);
    const method = request?.method ?? init?.method;
    const body = request ? await request.text() : init?.body;
    calls.push({ url, method, body });
    const payload =
      method === 'POST'
        ? { id: 'TKT-1', title: 't', kind: 'task' }
        : { ok: true };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createPilotClient('http://127.0.0.1:1', stubFetch);
  assert.deepEqual(await client.health(), { ok: true });
  assert.equal(
    (await client.createTicket({ project_id: 'p', title: 't' })).id,
    'TKT-1',
  );
  assert.equal(calls[0].url, 'http://127.0.0.1:1/api/health');
  assert.equal(calls[1].url, 'http://127.0.0.1:1/api/tickets');
  assert.deepEqual(JSON.parse(calls[1].body), { project_id: 'p', title: 't' });
  const failing = createPilotClient(
    'http://127.0.0.1:1',
    async () => new Response('{"error":"bad"}', { status: 400 }),
  );
  await assert.rejects(failing.health(), /400/);
});

test('journal: new files gain a header; legacy files read fully and stay on disk', () => {
  const file = path.join(root, 'journals', 'hook.jsonl');
  ensureJsonlHeader(file, 'journal');
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    '{"schema_version":1,"kind":"journal"}\n',
  );
  appendJsonl(file, 'journal', { event: 'milestone', text: 'landed' });
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines[0], '{"schema_version":1,"kind":"journal"}');
  assert.deepEqual(JSON.parse(lines[1]), {
    event: 'milestone',
    text: 'landed',
  });
  const read = readJsonl(file, 'journal');
  assert.deepEqual(read, {
    version: 1,
    kind: 'journal',
    migrated: false,
    values: [{ event: 'milestone', text: 'landed' }],
  });
  const legacyFile = path.join(root, 'legacy-hook.jsonl');
  fs.writeFileSync(
    legacyFile,
    '{"event":"milestone","text":"old"}\nnot json\n',
  );
  const legacy = readJsonl(legacyFile, 'journal');
  assert.equal(legacy.version, 0);
  assert.equal(legacy.migrated, true);
  assert.deepEqual(legacy.values, [{ event: 'milestone', text: 'old' }]);
  assert.equal(
    fs.readFileSync(legacyFile, 'utf8'),
    '{"event":"milestone","text":"old"}\nnot json\n',
  );
});

test('journal and spool: higher headers refuse; wrong kinds refuse; missing reads empty', () => {
  const future = path.join(root, 'future.jsonl');
  fs.writeFileSync(
    future,
    '{"schema_version":2,"kind":"journal"}\n{"event":"x"}\n',
  );
  refusal(() => readJsonl(future, 'journal'));
  refusal(() => assertJsonlReadable(future, 'journal'));
  const crossed = path.join(root, 'crossed.jsonl');
  fs.writeFileSync(crossed, '{"schema_version":1,"kind":"spool"}\n');
  refusal(() => readJsonl(crossed, 'journal'));
  assert.equal(
    isJsonlHeaderLine('{"schema_version":1,"kind":"journal"}'),
    true,
  );
  assert.equal(isJsonlHeaderLine('{"event":"milestone"}'), false);
  assert.equal(isJsonlHeaderLine('not json'), false);
  const missing = readJsonl(path.join(root, 'absent.jsonl'), 'spool');
  assert.deepEqual(missing, {
    version: 0,
    kind: null,
    migrated: false,
    values: [],
  });
  assertJsonlReadable(path.join(root, 'absent.jsonl'), 'spool');
  const spool = path.join(root, 'spool.jsonl');
  ensureJsonlHeader(spool, 'spool');
  appendJsonl(spool, 'spool', { uuid: 'a' });
  assert.deepEqual(readJsonl(spool, 'spool').values, [{ uuid: 'a' }]);
});

test('milestone reader skips the v1 header and still refuses a higher one', async () => {
  const dir = path.join(root, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const hookFile = path.join(dir, 'hook.jsonl');
  ensureJsonlHeader(hookFile, 'journal');
  appendJsonl(hookFile, 'journal', {
    ts: '2026-10-03T00:00:00.000Z',
    event: 'milestone',
    session_id: 's1',
    text: 'shipped',
  });
  const milestones = await readProjectMilestones({ hookFile });
  assert.equal(milestones.length, 1);
  assert.equal(milestones[0].text, 'shipped');
  fs.writeFileSync(
    hookFile,
    '{"schema_version":2,"kind":"journal"}\n{"event":"milestone","text":"x"}\n',
  );
  await assert.rejects(
    readProjectMilestones({ hookFile }),
    (error) => error instanceof VersionedFileError,
  );
});
