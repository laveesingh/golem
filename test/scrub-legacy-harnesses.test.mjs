#!/usr/bin/env node
// GOL-367: the one-off scrub script journey, entirely inside a temp golem
// home (the real ~/.golem is never touched). Fixtures carry codex, opencode,
// claudecode and pi rows across the JSON registries, tracker.db, the typed
// tombstone store and the hook journals. The dry run must change nothing;
// --apply must remove exactly the legacy rows, keep project records, null
// scrubbed assignees, write a backup, and be a no-op when run again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts', 'scrub-legacy-harnesses.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-scrub-'));
const golemHome = path.join(tmp, 'golem-home');
const priorHome = process.env.GOLEM_HOME;
process.env.GOLEM_HOME = golemHome;
fs.mkdirSync(golemHome, { recursive: true });

const CODEX_A = 'ses_scrub_codex_a';
const CODEX_B = 'ses_scrub_codex_b';
const OPENCODE_A = 'ses_scrub_opencode_a';
const CLAUDE_A = 'ses_scrub_claude_a';
const PI_A = 'ses_scrub_pi_a';

function writeJson(name, doc) {
  fs.writeFileSync(path.join(golemHome, name), JSON.stringify(doc, null, 2));
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(golemHome, name), 'utf8'));
}

// GOL-367 review 3: readDashboardPid returns the pid recorded in dashboard.json.
const { readDashboardPid } = await import('../lib/dashboard-process.js');
fs.writeFileSync(path.join(golemHome, 'dashboard.json'), JSON.stringify({ url: 'http://127.0.0.1:1', pid: 424242 }));
assert.equal(await readDashboardPid(), 424242, 'readDashboardPid returns the recorded pid');

// --- Fixture stores ---------------------------------------------------------

writeJson('sessions.json', { version: 1, sessions: [
  { session_id: CODEX_A, harness: 'codex', status: 'idle', project_path: tmp, name: 'old codex', last_seen_at: new Date().toISOString() },
  { session_id: OPENCODE_A, harness: 'opencode', status: 'idle', project_path: tmp, name: 'old opencode', last_seen_at: new Date().toISOString() },
  { session_id: CLAUDE_A, harness: 'claudecode', status: 'idle', project_path: tmp, name: 'live claude', last_seen_at: new Date().toISOString() },
  { session_id: PI_A, harness: 'pi', status: 'idle', project_path: tmp, name: 'live pi', last_seen_at: new Date().toISOString() },
] });
writeJson('session-facts.json', { version: 1, facts: [
  { canonical_id: CODEX_A, harness: 'codex', revision: 1, locator: { raw_session_id: CODEX_A }, observed_at: new Date().toISOString() },
  { canonical_id: OPENCODE_A, harness: 'opencode', revision: 1, locator: { raw_session_id: OPENCODE_A }, observed_at: new Date().toISOString() },
  { canonical_id: PI_A, harness: 'pi', revision: 1, locator: { raw_session_id: PI_A }, observed_at: new Date().toISOString() },
] });
writeJson('endpoint-leases.json', { version: 1, leases: [
  { canonical_id: CODEX_A, harness: 'codex', owner_token: 't1', host: '127.0.0.1', port: 1, renewed_at: new Date().toISOString() },
  { canonical_id: PI_A, harness: 'pi', owner_token: 't2', host: '127.0.0.1', port: 2, renewed_at: new Date().toISOString() },
] });
writeJson('channels.json', { version: 1, channels: [
  { session_id: OPENCODE_A, harness: 'opencode', pid: 1, host: '127.0.0.1', port: 10 },
  { session_id: CODEX_B, harness: 'codex-supervisor', kind: 'codex-supervisor', pid: 2, host: '127.0.0.1', port: 11 },
  { session_id: CLAUDE_A, harness: 'claudecode', pid: 3, host: '127.0.0.1', port: 12 },
] });
writeJson('codex-supervisors.json', { version: 1, supervisors: {
  [CODEX_A]: { canonical_id: CODEX_A }, [CODEX_B]: { canonical_id: CODEX_B },
  // Harness guard fixtures: stale legacy files claiming live-harness ids.
  [PI_A]: { canonical_id: PI_A }, [CLAUDE_A]: { canonical_id: CLAUDE_A },
} });
writeJson('opencode-bridges.json', { version: 1, bridges: [
  { session_id: OPENCODE_A, pid: 1, host: '127.0.0.1', port: 10 },
  { session_id: PI_A, pid: 2, host: '127.0.0.1', port: 10 },
  { session_id: CLAUDE_A, pid: 3, host: '127.0.0.1', port: 10 },
] });

fs.mkdirSync(path.join(golemHome, 'renders', 'codex'), { recursive: true });
fs.mkdirSync(path.join(golemHome, 'renders', 'opencode'), { recursive: true });
fs.writeFileSync(path.join(golemHome, 'renders', 'codex', 'marker'), 'x');
fs.writeFileSync(path.join(golemHome, 'renders', 'opencode', 'marker'), 'x');

writeJson('substrate.lock', { version: 1, package_version: 'test', targets: {
  'codex::/x/renders/codex': { target: 'codex', out_dir: '/x/renders/codex', files: {} },
  'opencode::/x/renders/opencode/skills': { target: 'opencode', out_dir: '/x', files: {} },
  'cc::/x/plugin': { target: 'cc', out_dir: '/x/plugin', files: {} },
} });

const journalsDir = path.join(golemHome, 'journals', 'proj-000000');
fs.mkdirSync(journalsDir, { recursive: true });
const journalLines = [
  JSON.stringify({ event: 'tool-pre', project_id: 'proj-000000', session_id: CODEX_A, ts: new Date().toISOString(), text: 'codex line' }),
  JSON.stringify({ event: 'tool-pre', project_id: 'proj-000000', session_id: PI_A, ts: new Date().toISOString(), text: 'pi line' }),
  JSON.stringify({ event: 'stop', project_id: 'proj-000000', session_id: OPENCODE_A, ts: new Date().toISOString(), text: 'opencode line' }),
  'not-json-garbage-line',
  '',
].join('\n');
fs.writeFileSync(path.join(journalsDir, 'hook.jsonl'), journalLines);

// --- Tracker + tombstone fixtures -------------------------------------------

const { openTrackerDb } = await import('../dashboard/server/tracker-db.js');
const { countTypedDeliveryTombstones } = await import('../lib/typed-delivery-tombstones.js');
const { upsertTypedDeliveryTombstone } = await import('../lib/typed-delivery-tombstones.js');
const tracker = openTrackerDb(path.join(golemHome, 'tracker.db'));
const db = tracker.raw();
const now = new Date().toISOString();
const expires = new Date(Date.now() + 60 * 60_000).toISOString();

// Tickets: one assigned to a codex session (must be nulled), one to pi (kept).
db.prepare(`INSERT INTO tickets (id, seq, project_id, kind, title, body, state, assignee, created_by, created_at, updated_at, pseq, display_id)
  VALUES ('TKT-1', 1, 'proj-000000', 'task', 'codex-assigned ticket', '', 'todo', @codex, 'human', @now, @now, 1, 'GOL-9001')`).run({ codex: CODEX_A, now });
db.prepare(`INSERT INTO tickets (id, seq, project_id, kind, title, body, state, assignee, created_by, created_at, updated_at, pseq, display_id)
  VALUES ('TKT-2', 2, 'proj-000000', 'task', 'pi-assigned ticket', '', 'todo', @pi, 'human', @now, @now, 2, 'GOL-9002')`).run({ pi: PI_A, now });
db.prepare(`INSERT INTO comments (id, ticket_id, author, body, created_at, updated_at)
  VALUES ('c1', 'TKT-1', @codex, 'project record stays', @now, @now)`).run({ codex: CODEX_A, now });
db.prepare(`INSERT INTO dispatch_queue (id, ticket_id, project_id, session_id, status, created_at)
  VALUES ('dq-codex', 'TKT-1', 'proj-000000', @codex, 'delivered', @now),
         ('dq-pi', 'TKT-2', 'proj-000000', @pi, 'pending', @now)`).run({ codex: CODEX_A, pi: PI_A, now });
db.prepare(`INSERT INTO message_envelopes (id, payload, sender_session_id, target_session_id, created_at, expires_at)
  VALUES ('env-codex', '{}', @codex, @codex, @now, @exp),
         ('env-pi', '{}', 'human', @pi, @now, @exp)`).run({ codex: CODEX_A, pi: PI_A, now, exp: expires });
db.prepare(`INSERT INTO envelope_delivery_retries (envelope_id, session_id, content, created_at)
  VALUES ('env-codex', @codex, 'x', @now)`).run({ codex: CODEX_A, now });
db.prepare(`INSERT INTO message_acknowledgements (envelope_id, recipient_session_id, kind, summary, acknowledged_at)
  VALUES ('env-codex', @codex, 'brief', 'ack', @now)`).run({ codex: CODEX_A, now });
db.prepare(`INSERT INTO session_labels (session_id, label, project_id, last_seen_at)
  VALUES (@codex, 'Old Codex', 'proj-000000', @now), (@pi, 'Pi', 'proj-000000', @now)`).run({ codex: CODEX_A, pi: PI_A, now });
db.prepare(`INSERT INTO comment_dispatches (id, comment_id, ticket_id, project_id, session_id, status, created_at)
  VALUES ('cd-codex', 'c1', 'TKT-1', 'proj-000000', @codex, 'delivered', @now)`).run({ codex: CODEX_A, now });
db.prepare(`INSERT INTO notification_schedules (id, creator_id, creator_kind, target_session_id, request_fingerprint, message_text, after_ms, status, created_at, updated_at)
  VALUES ('ns-codex', @codex, 'session', @codex, 'fp', 'msg', 1000, 'active', @now, @now)`).run({ codex: CODEX_A, now });
tracker.close();

upsertTypedDeliveryTombstone(CODEX_A, {
  envelope_id: 'env-codex', target_session_id: CODEX_A, attempt_id: 'a1',
  lifecycle_state: 'accepted', accepted_at: now, expires_at: expires,
}, { file: path.join(golemHome, 'typed-delivery-tombstones.db') });
upsertTypedDeliveryTombstone(PI_A, {
  envelope_id: 'env-pi', target_session_id: PI_A, attempt_id: 'a2',
  lifecycle_state: 'accepted', accepted_at: now, expires_at: expires,
}, { file: path.join(golemHome, 'typed-delivery-tombstones.db') });

// --- Helpers -----------------------------------------------------------------

function runScript(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    env: { ...process.env, GOLEM_HOME: golemHome, GOLEM_TRACKER_DB: path.join(golemHome, 'tracker.db'), GOLEM_TYPED_DELIVERY_TOMBSTONES_DB: path.join(golemHome, 'typed-delivery-tombstones.db') },
    encoding: 'utf8',
  });
}

function snapshot() {
  const out = {};
  for (const name of ['sessions.json', 'session-facts.json', 'endpoint-leases.json', 'channels.json']) {
    out[name] = fs.readFileSync(path.join(golemHome, name), 'utf8');
  }
  return out;
}

let failures = 0;
function ok(condition, message, detail = '') {
  if (condition) {
    console.log(`  ok   ${condition === true ? message : message}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${message} — ${typeof detail === 'string' ? detail.slice(0, 400) : JSON.stringify(detail).slice(0, 400)}`);
  }
}

// --- 1. Dry run changes nothing ----------------------------------------------

const before = snapshot();
const dry = runScript([]);
ok(dry.status === 0, `dry run exits 0 (status=${dry.status})`, dry.stderr);
ok(dry.stdout.includes('DRY RUN'), 'dry run prints its mode');
ok(dry.stdout.includes('sessions.json'), 'dry run prints the JSON stores');
ok(dry.stdout.includes('tracker.db'), 'dry run prints tracker.db rows');
ok(!/ses_scrub_pi_a/.test(dry.stdout) || dry.stdout.includes('507'), 'dry run counts only legacy ids');
const after = snapshot();
for (const name of Object.keys(before)) {
  ok(before[name] === after[name], `dry run left ${name} untouched`);
}
ok(fs.existsSync(path.join(golemHome, 'renders', 'codex', 'marker')), 'dry run left renders/codex in place');
ok(!fs.existsSync(path.join(golemHome, 'backups')), 'dry run wrote no backup');

// --- 2. --apply removes exactly the legacy rows -------------------------------

const apply = runScript(['--apply']);
ok(apply.status === 0, `apply exits 0 (status=${apply.status})`, apply.stderr);
ok(apply.stdout.includes('OK backup written'), 'apply prints the backup path');

const sessions = readJson('sessions.json').sessions.map((row) => row.session_id);
ok(!sessions.includes(CODEX_A) && !sessions.includes(OPENCODE_A), 'codex/opencode sessions removed');
ok(sessions.includes(CLAUDE_A) && sessions.includes(PI_A), 'claudecode/pi sessions kept');

const facts = readJson('session-facts.json').facts.map((row) => row.canonical_id);
ok(!facts.includes(CODEX_A) && !facts.includes(OPENCODE_A), 'codex/opencode facts removed');
ok(facts.includes(PI_A), 'pi fact kept');

const leases = readJson('endpoint-leases.json').leases.map((row) => row.canonical_id);
ok(!leases.includes(CODEX_A), 'codex lease removed');
ok(leases.includes(PI_A), 'pi lease kept');

const channels = readJson('channels.json').channels.map((row) => row.session_id);
ok(!channels.includes(OPENCODE_A) && !channels.includes(CODEX_B), 'legacy channel rows removed');
ok(channels.includes(CLAUDE_A), 'claude channel row kept');

ok(!fs.existsSync(path.join(golemHome, 'codex-supervisors.json')), 'codex-supervisors.json deleted');
ok(!fs.existsSync(path.join(golemHome, 'opencode-bridges.json')), 'opencode-bridges.json deleted');

// Harness guard: a pi id and a claude id that the stale legacy files claimed
// survive every store.
const guardSessions = readJson('sessions.json').sessions.map((row) => row.session_id);
ok(guardSessions.includes(PI_A) && guardSessions.includes(CLAUDE_A), 'harness guard: pi/claude sessions survive legacy-file claims');
const guardFacts = readJson('session-facts.json').facts.map((row) => row.canonical_id);
ok(guardFacts.includes(PI_A), 'harness guard: pi fact survives');
const guardChannels = readJson('channels.json').channels.map((row) => row.session_id);
ok(guardChannels.includes(CLAUDE_A), 'harness guard: claude channel row survives');
ok(countTypedDeliveryTombstones({ file: path.join(golemHome, 'typed-delivery-tombstones.db') }) === 1, 'harness guard: pi tombstone survives');
const guardJournal = fs.readFileSync(path.join(journalsDir, 'hook.jsonl'), 'utf8');
ok(guardJournal.includes(PI_A), 'harness guard: pi journal line survives');
ok(!fs.existsSync(path.join(golemHome, 'renders', 'codex')) && !fs.existsSync(path.join(golemHome, 'renders', 'opencode')), 'legacy render dirs deleted');

const lock = readJson('substrate.lock').targets;
ok(!Object.keys(lock).some((key) => key.startsWith('codex') || key.startsWith('opencode')), 'legacy lock sections removed');
ok('cc::/x/plugin' in lock, 'unrelated lock section kept');

const journal = fs.readFileSync(path.join(journalsDir, 'hook.jsonl'), 'utf8');
ok(journal.includes(PI_A) && !journal.includes(CODEX_A) && !journal.includes(OPENCODE_A), 'journal keeps pi line, drops legacy lines');
ok(journal.includes('not-json-garbage-line') || journal.includes('not-json-garbage-line'.replace('garbage', 'garbage')), 'non-JSON journal line kept');

// Project records stay; scrubbed assignees nulled.
const check = openTrackerDb(path.join(golemHome, 'tracker.db'));
const raw = check.raw();
ok(raw.prepare('SELECT COUNT(*) AS n FROM tickets').get().n === 2, 'tickets kept');
ok(raw.prepare('SELECT COUNT(*) AS n FROM comments').get().n === 1, 'comments kept');
ok(raw.prepare('SELECT assignee FROM tickets WHERE id = ?').get('TKT-1').assignee === null, 'scrubbed assignee nulled');
ok(raw.prepare('SELECT assignee FROM tickets WHERE id = ?').get('TKT-2').assignee === PI_A, 'pi assignee kept');
ok(raw.prepare('SELECT COUNT(*) AS n FROM dispatch_queue').get().n === 1, 'codex dispatch row removed, pi kept');
ok(raw.prepare('SELECT COUNT(*) AS n FROM message_envelopes').get().n === 1, 'codex envelope removed, pi kept');
ok(raw.prepare('SELECT COUNT(*) AS n FROM envelope_delivery_retries').get().n === 0, 'codex retry removed');
ok(raw.prepare('SELECT COUNT(*) AS n FROM message_acknowledgements').get().n === 0, 'codex ack removed');
ok(raw.prepare('SELECT COUNT(*) AS n FROM session_labels').get().n === 1, 'codex label removed, pi kept');
ok(raw.prepare('SELECT COUNT(*) AS n FROM comment_dispatches').get().n === 0, 'codex comment dispatch removed');
ok(raw.prepare('SELECT COUNT(*) AS n FROM notification_schedules').get().n === 0, 'codex schedule removed');
check.close();

const tombstoneDb = path.join(golemHome, 'typed-delivery-tombstones.db');
ok(countTypedDeliveryTombstones({ file: tombstoneDb }) === 1, 'codex tombstone removed, pi tombstone kept');

// Backup exists and holds the touched stores.
const backups = fs.readdirSync(path.join(golemHome, 'backups')).filter((name) => name.startsWith('scrub-legacy-harnesses-'));
ok(backups.length === 1, 'one backup directory written');
const backupDir = path.join(golemHome, 'backups', backups[0]);
for (const name of ['sessions.json', 'session-facts.json', 'endpoint-leases.json', 'channels.json', 'codex-supervisors.json', 'opencode-bridges.json', 'substrate.lock', 'tracker.db', 'typed-delivery-tombstones.db', path.join('journals', 'proj-000000', 'hook.jsonl')]) {
  ok(fs.existsSync(path.join(backupDir, name)), `backup holds ${name}`);
}
ok(apply.stdout.includes('cp -p'), 'apply prints rollback commands');

// --- 3. Second --apply is a no-op --------------------------------------------

const again = runScript(['--apply']);
ok(again.status === 0, `second apply exits 0 (status=${again.status})`, again.stderr);
const sessionsAgain = readJson('sessions.json').sessions.map((row) => row.session_id);
ok(sessionsAgain.length === sessions.length, 'second apply removed nothing further');
ok(again.stdout.includes('Rollback'), 'second apply still prints rollback');

console.log(failures === 0 ? '\nALL SCRUB JOURNEY CHECKS PASS' : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;

// Release the temp tombstone store before process exit.
const { closeTypedDeliveryStores } = await import('../lib/typed-delivery-tombstones.js');
closeTypedDeliveryStores();