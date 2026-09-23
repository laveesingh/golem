#!/usr/bin/env node
// GOL-370 herdr driver — unit tests against a fake GOLEM_HERDR_BIN script
// (same style as the old host fakes). The driver must put `--session` first on
// every call, parse the JSON envelopes, and throw on `error` payloads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gol370-herdr-driver-'));
const bin = path.join(temp, 'bin');
fs.mkdirSync(bin, { recursive: true });

const originalEnv = {};
for (const key of ['GOLEM_HERDR_BIN', 'GOLEM_HERDR_SESSION', 'GOLEM_HERDR_LOG_DIR']) {
  originalEnv[key] = process.env[key];
}

const session = 'gol370-driver-unit';
const capture = path.join(temp, 'argv.txt');
const responses = {};
const responsesFile = path.join(temp, 'responses.json');

function writeFakeHerdr() {
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(capture)}, args.join('\\u0000'));
let responses = {};
try { responses = JSON.parse(fs.readFileSync(${JSON.stringify(responsesFile)}, 'utf8')); } catch {}
const sessionIndex = args.indexOf('--session');
const key = args.filter((a, index) => index !== sessionIndex && index !== sessionIndex + 1).join(' ');
const entry = responses[key];
if (entry == null) {
  process.stdout.write(JSON.stringify({ id: 'fake', result: { type: 'ok', key } }));
  process.exit(0);
}
const errPayload = typeof entry === 'object' && (entry.__error || entry.error)
  ? (entry.__error ? entry.__error : entry.error)
  : null;
if (errPayload) {
  process.stdout.write(JSON.stringify({ id: 'fake', error: errPayload }));
  process.exit(0);
}
// pane read prints plain scrollback text (no JSON envelope).
if (args[0] === 'pane' && args[1] === 'read') {
  process.stdout.write(entry?.text ?? '');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ id: 'fake', result: entry }));
process.exit(0);
`, { mode: 0o700 });
}
writeFakeHerdr();

process.env.GOLEM_HERDR_BIN = path.join(bin, 'herdr');
process.env.GOLEM_HERDR_SESSION = session;

const driver = await import('../lib/herdr-driver.js');

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.log(`  FAIL ${name} — ${String(detail).slice(0, 300)}`); }
}

function argvOf() {
  return fs.readFileSync(capture, 'utf8').split('\u0000');
}

// Mirror the fake's key derivation exactly: every arg except --session and
// its value, joined by spaces.
function fakeKey(args) {
  const drop = new Set();
  const sessionIndex = args.indexOf('--session');
  if (sessionIndex >= 0) { drop.add(sessionIndex); drop.add(sessionIndex + 1); }
  return args.filter((a, index) => !drop.has(index)).join(' ');
}

function setResponse(args, value) {
  responses[fakeKey(args)] = value;
  fs.writeFileSync(responsesFile, JSON.stringify(responses));
}

// 1. --session override lands first on every call
driver.workspaceList(session);
let argv = fs.readFileSync(capture, 'utf8').split('\u0000');
check('workspace list carries --session first', argv.slice(0, 2).join(' ') === `--session ${session}`, argv.join(' '));

// 2. JSON envelope parsing: results and errors
setResponse(['workspace', 'list'], { type: 'workspace_list', workspaces: [{ workspace_id: 'w1', label: 'agents' }] });
const list = driver.workspaceList(session);
check('workspace list parses the result payload', list.length === 1 && list[0].workspace_id === 'w1');

setResponse(['workspace', 'list'], { type: 'workspace_list', workspaces: [] });
setResponse(['workspace', 'create', '--label', 'agents'], { type: 'workspace_created', workspace: { workspace_id: 'w9', label: 'agents' } });
const workspaceCreated = driver.workspaceEnsure({ session, label: 'agents' });
check('workspaceEnsure creates when the label is absent', workspaceCreated?.workspace_id === 'w9');

setResponse(['workspace', 'list'], { type: 'workspace_list', workspaces: [{ workspace_id: 'w1', label: 'agents' }] });
const ensured = driver.workspaceEnsure({ session, label: 'agents' });
check('workspaceEnsure returns the existing row', ensured?.workspace_id === 'w1');

// 3. error envelopes throw with the herdr message
setResponse(['pane', 'list'], { __error: { code: 'server_not_running', message: 'no herdr server is running at the fixture socket' } });
assert.throws(() => driver.paneList(session), /no herdr server is running/);
check('error envelopes throw with the herdr message', true);

// 4. tab create + pane run + agent rename shapes
setResponse(['tab', 'create', '--workspace', 'w1', '--cwd', '/tmp', '--label', 'builder1'], {
  type: 'tab_created',
  tab: { tab_id: 'w1:t2', label: 'builder1' },
  root_pane: { pane_id: 'w1:p2', tab_id: 'w1:t2' },
});
const tabCreated = driver.tabCreate({ session, workspaceId: 'w1', label: 'builder1', cwd: '/tmp' });
check('tab create returns the tab and root pane', tabCreated?.tab?.tab_id === 'w1:t2' && tabCreated?.pane?.pane_id === 'w1:p2');
argv = fs.readFileSync(capture, 'utf8').split('\u0000');
check('tab create carries workspace/cwd/label', argv.slice(2).join(' ').includes('--workspace w1') && argv.join(' ').includes('--label builder1'), argv.join(' '));

setResponse(['pane', 'run', 'w1:p2', "'/bin/echo'", "'hi there'"], { type: 'pane_ran' });
driver.paneRun({ session, paneId: 'w1:p2', command: ['/bin/echo', 'hi there'] });
argv = fs.readFileSync(capture, 'utf8').split('\u0000');
check('pane run joins the command after the pane id', argv.slice(-3).join(' ') === `w1:p2 '/bin/echo' 'hi there'`, argv.join(' '));

setResponse(['agent', 'rename', 'w1:p2', 'builder1'], { type: 'agent_renamed' });
driver.agentRename({ session, paneId: 'w1:p2', name: 'builder1' });
argv = fs.readFileSync(capture, 'utf8').split('\u0000');
check('agent rename targets the pane with the agent name', argv.slice(-3).join(' ') === `rename w1:p2 builder1`, argv.join(' '));

// 5. pane read returns text
setResponse(['pane', 'read', 'w1:p2'], { type: 'pane_read', text: 'scrollback line' });
check('pane read returns the text payload', String(driver.paneRead({ session, paneId: 'w1:p2' })).includes('scrollback line'));

// 6. session stop is --session-scoped
setResponse(['session', 'stop', 'gol370-driver-unit'], { type: 'session_stopped' });
check('sessionStop returns true on success', driver.sessionStop('gol370-driver-unit') === true);

// 6b. GOL-379: agent get by pane id or live name
setResponse(['agent', 'get', 'w1:p2'], { type: 'agent_info', agent: { name: 'builder1', pane_id: 'w1:p2', agent_status: 'idle' } });
const gotten = driver.agentGet({ session, target: 'w1:p2' });
check('agent get returns the agent payload', gotten?.name === 'builder1' && gotten?.pane_id === 'w1:p2');
argv = fs.readFileSync(capture, 'utf8').split('\u0000');
check('agent get targets the pane id', argv.slice(-2).join(' ') === `get w1:p2`, argv.join(' '));
setResponse(['agent', 'get', 'missing-name'], { __error: { code: 'agent_not_found', message: 'agent target missing-name not found' } });
assert.throws(() => driver.agentGet({ session, target: 'missing-name' }), /agent target missing-name not found/);
check('agent get throws the herdr not-found message', true);

// 6c. GOL-379: herdr states key by pane id and live name
setResponse(['agent', 'list'], { type: 'agent_list', agents: [
  { name: 'a-team-builder1', pane_id: 'w1:p2', agent_status: 'working' },
  { pane_id: 'w1:p3', agent_status: 'idle' },
]});
const { listHerdrAgentStates: listStates } = await import('../lib/team-herdr.js');
const states = listStates(session);
check('states carry the pane id key', states.get('w1:p2') === 'working');
check('states carry the live name key', states.get('a-team-builder1') === 'working');
check('unnamed agents still resolve by pane', states.get('w1:p3') === 'idle');

// 7. herdrVersion strips the binary name
fs.writeFileSync(path.join(bin, 'herdr-version'), `#!/usr/bin/env node
process.stdout.write('herdr 0.9.1\\n');
`, { mode: 0o700 });
process.env.GOLEM_HERDR_BIN = path.join(bin, 'herdr-version');
check('herdrVersion returns the bare version', driver.herdrVersion() === '0.9.1');
process.env.GOLEM_HERDR_BIN = path.join(bin, 'herdr');

// 8. resolveSession: the override wins, a missing session throws
process.env.GOLEM_HERDR_SESSION = session;
check('resolveSession honors GOLEM_HERDR_SESSION', driver.resolveSession('anything-else') === session);
delete process.env.GOLEM_HERDR_SESSION;
check('resolveSession falls back to the stored session', driver.resolveSession('stored-session') === 'stored-session');
assert.throws(() => driver.resolveSession(null), /herdr session is required/);
check('resolveSession throws without any session', true);
process.env.GOLEM_HERDR_SESSION = session;

// 9. G2 session names: one function serves spawn, team create and doctor.
// Without the override, derivation lowercases, collapses illegal runs to
// one '-', and falls back to the project id on empty/collision.
delete process.env.GOLEM_HERDR_SESSION;
const { projectHerdrSession } = await import('../lib/team-herdr.js');
const known = [
  { project_id: 'proj-myapp-111111', name: 'My App!' },
  { project_id: 'proj-clash1-222222', name: 'Clash!' },
  { project_id: 'proj-clash2-333333', name: 'clash?' },
  { project_id: 'proj-empty-444444', name: '!!!' },
];
check('My App! derives my-app', driver.herdrSessionForProject('proj-myapp-111111', { knownProjects: known }) === 'my-app');
check('team seam derives the same session as spawn', projectHerdrSession('proj-myapp-111111', { knownProjects: known }) === 'my-app');
check('colliding names fall back to the project id',
  driver.herdrSessionForProject('proj-clash1-222222', { knownProjects: known }) === 'proj-clash1-222222'
  && projectHerdrSession('proj-clash2-333333', { knownProjects: known }) === 'proj-clash2-333333');
check('empty derivations fall back to the project id', driver.herdrSessionForProject('proj-empty-444444', { knownProjects: known }) === 'proj-empty-444444');
check('long names cap at the 32-char herdr limit',
  driver.herdrSessionForProject('proj-long-555555', { knownProjects: [...known, { project_id: 'proj-long-555555', name: `${'a'.repeat(40)}!` }] }) === 'a'.repeat(32));
process.env.GOLEM_HERDR_SESSION = session;
check('GOLEM_HERDR_SESSION overrides derivation on both paths',
  driver.herdrSessionForProject('proj-myapp-111111', { knownProjects: known }) === session
  && projectHerdrSession('proj-myapp-111111', { knownProjects: known }) === session);

console.log(failures === 0 ? '\nHERDR DRIVER UNIT TESTS PASS' : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;

// Cleanup
for (const key of Object.keys(originalEnv)) {
  if (originalEnv[key] === undefined) delete process.env[key];
  else process.env[key] = originalEnv[key];
}
fs.rmSync(temp, { recursive: true, force: true });
