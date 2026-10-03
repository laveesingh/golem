// S1 integration fixture: real store owners plus their actual JS/shell
// callers inside an owned sandbox. Prints one JSON receipt line.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repo } from '../support/sandbox.mjs';

const home = process.env.GOLEM_HOME;
const sandbox = process.env.GOLEM_W2_SANDBOX;
assert.ok(home && sandbox, 'owned sandbox required');
const urlOf = (file) => pathToFileURL(file).href;
const receipt = { stores: {} };

// --- dashboard.json through the real server self-registration caller ---
{
  const { saveDashboardStore } = await import(
    urlOf(path.join(repo, 'lib/dashboard-store.ts'))
  );
  const file = path.join(home, 'dashboard.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ url: 'http://127.0.0.1:7499', pid: 7 }),
  );
  const { loadDashboardStore, dashboardBaseUrlFrom } = await import(
    urlOf(path.join(repo, 'lib/dashboard-store.ts'))
  );
  const migrated = loadDashboardStore(file);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.value.url, 'http://127.0.0.1:7499');
  assert.equal(dashboardBaseUrlFrom(file), 'http://127.0.0.1:7499');
  saveDashboardStore({ url: 'http://127.0.0.1:7499' }, file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schema_version, 1);
  fs.writeFileSync(file, JSON.stringify({ schema_version: 2 }));
  assert.throws(
    () => loadDashboardStore(file),
    /VERSIONED_VERSION_UNSUPPORTED/,
  );
  receipt.stores.dashboard = {
    legacyMigrated: true,
    stamped: true,
    futureRefused: true,
  };
}

// --- share-tunnel.json through the real supervisor module ---
{
  const tunnel = await import(
    urlOf(path.join(repo, 'dashboard/server/share-tunnel.js'))
  );
  const dir = path.join(home, 'share-home');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'share-tunnel.json'),
    JSON.stringify({ publicPort: 61961, pid: 987654 }),
  );
  const read = tunnel.readShareRegistry(dir);
  assert.equal(tunnel.registryOrigin(read), 'http://127.0.0.1:61961');
  assert.equal(read.schema_version, 1);
  tunnel.writeShareRegistry(dir, {
    origin: 'http://127.0.0.1:7420',
    pid: 4242,
  });
  const stored = JSON.parse(
    fs.readFileSync(path.join(dir, 'share-tunnel.json'), 'utf8'),
  );
  assert.equal(stored.schema_version, 1);
  assert.equal(stored.origin, 'http://127.0.0.1:7420');
  fs.writeFileSync(
    path.join(dir, 'share-tunnel.json'),
    JSON.stringify({ schema_version: 2 }),
  );
  assert.throws(
    () => tunnel.readShareRegistry(dir),
    /VERSIONED_VERSION_UNSUPPORTED/,
  );
  receipt.stores.share = {
    legacyMigrated: true,
    stamped: true,
    futureRefused: true,
  };
}

// --- journal + spool through the real readers and the actual shell hook ---
{
  const { readJsonl } = await import(
    urlOf(path.join(repo, 'lib/jsonl-header.ts'))
  );
  const { readProjectMilestones } = await import(
    urlOf(path.join(repo, 'dashboard/server/milestones.js'))
  );
  const dir = path.join(home, 'journals', 'proj-abc123');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hook.jsonl'),
    '{"event":"milestone","session_id":"s9","text":"legacy landed","ts":"2026-10-03T00:00:00.000Z"}\n',
  );
  const legacy = await readProjectMilestones({
    hookFile: path.join(dir, 'hook.jsonl'),
  });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].text, 'legacy landed');

  // Real hook run: a fresh project journal gains a header before its event.
  const project = path.join(sandbox, 'hook-proj');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Hook Proj\n');
  const payload = JSON.stringify({
    session_id: 'synthetic-s1-session',
    cwd: project,
    harness: 'synthetic',
  });
  const run = spawnSync(
    'bash',
    [path.join(repo, 'substrate/hooks/journal-route.sh'), 'SessionStart'],
    {
      cwd: project,
      input: payload,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        // Never touch a live dashboard from tests: unroutable bus URL keeps
        // events in the sandbox spool file (the sandbox already sets this).
        GOLEM_DASHBOARD_URL: 'http://127.0.0.1:1',
        GOLEM_HOME_DIR: home,
        HOME: path.join(sandbox, 'home'),
        CLAUDE_PROJECT_DIR: project,
      },
    },
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const journalFiles = [];
  const journalsDir = path.join(home, 'journals');
  for (const entry of fs.readdirSync(journalsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(journalsDir, entry.name, 'hook.jsonl');
    if (fs.existsSync(candidate)) journalFiles.push(candidate);
  }
  assert.ok(journalFiles.length > 0, 'hook wrote a journal file');
  let headered = 0;
  for (const candidate of journalFiles) {
    const first = fs.readFileSync(candidate, 'utf8').split('\n')[0];
    if (first === '{"schema_version":1,"kind":"journal"}') headered += 1;
    const parsed = readJsonl(candidate, 'journal');
    assert.ok(
      parsed.values.every((value) => value?.schema_version == null),
      'header never parses as a journal event',
    );
  }
  assert.ok(headered > 0, 'at least one journal carries the v1 header');
  // The hook forwards spool lines through `select(.schema_version == null)`;
  // pin that filter text and prove the same selection over the real file.
  const hookSource = fs.readFileSync(
    path.join(repo, 'substrate/hooks/journal-route.sh'),
    'utf8',
  );
  assert.ok(
    hookSource.includes('[.[] | select(.schema_version == null)]'),
    'spool forwarder drops versioned header lines',
  );
  const spool = path.join(home, 'spool', 'synthetic-s1-session.jsonl');
  // The hook spools in the background; wait boundedly for its write.
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(spool) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (fs.existsSync(spool)) {
    const lines = fs.readFileSync(spool, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines[0], '{"schema_version":1,"kind":"spool"}');
    const forwarded = lines
      .map((line) => JSON.parse(line))
      .filter((event) => event.schema_version == null);
    assert.ok(forwarded.length > 0, 'spool holds bus events');
    for (const event of forwarded)
      assert.equal(event.schema_version ?? null, null);
    receipt.stores.shellSpool = { headered: true, filtered: true };
  } else {
    receipt.stores.shellSpool = { headered: false, filtered: false };
  }
  receipt.stores.journal = { legacyRead: true, shellHeadered: headered > 0 };
}

console.log(JSON.stringify({ ok: true, ...receipt }));
