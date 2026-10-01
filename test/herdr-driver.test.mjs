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
for (const key of ['GOLEM_HOME', 'GOLEM_HERDR_BIN', 'GOLEM_HERDR_SESSION', 'GOLEM_HERDR_LOG_DIR']) {
  originalEnv[key] = process.env[key];
}

const session = 'gol370-driver-unit';
const capture = path.join(temp, 'argv.txt');
const envCapture = path.join(temp, 'inherited-env.json');
const responses = {};
const responsesFile = path.join(temp, 'responses.json');

function writeFakeHerdr() {
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(capture)}, args.join('\\u0000'));
fs.writeFileSync(${JSON.stringify(envCapture)}, JSON.stringify(Object.fromEntries(['HERDR_ENV','HERDR_SESSION','HERDR_PANE_ID','HERDR_WORKSPACE_ID','HERDR_SOCKET_PATH','GOLEM_HERDR_SESSION'].map(k => [k, process.env[k] ?? null]))));
let responses = {};
try { responses = JSON.parse(fs.readFileSync(${JSON.stringify(responsesFile)}, 'utf8')); } catch {}
const sessionIndex = args.indexOf('--session');
const key = args.filter((a, index) => sessionIndex < 0 || (index !== sessionIndex && index !== sessionIndex + 1)).join(' ');
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
if (key.startsWith('pane read ')) {
  process.stdout.write(entry?.text ?? '');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ id: 'fake', result: entry }));
process.exit(0);
`, { mode: 0o700 });
}
writeFakeHerdr();

process.env.GOLEM_HOME = path.join(temp, 'state');
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
setResponse(['workspace', 'list'], { type: 'workspace_list', workspaces: [] });
driver.workspaceList(session);
let argv = fs.readFileSync(capture, 'utf8').split('\u0000');
check('workspace list carries --session first', argv.slice(0, 2).join(' ') === `--session ${session}`, argv.join(' '));

driver.workspaceFocus({ session, workspaceId: 'w-exact' });
check('workspace focus targets exact ID/session', JSON.stringify(argvOf()) === JSON.stringify(['--session', session, 'workspace', 'focus', 'w-exact']));
driver.workspaceRename({ session, workspaceId: 'w-exact', label: 'Label With Spaces' });
check('workspace rename keeps exact ID and one label argument', JSON.stringify(argvOf()) === JSON.stringify(['--session', session, 'workspace', 'rename', 'w-exact', 'Label With Spaces']));
setResponse(['workspace', 'focus', 'w-denied'], { __error: { message: 'focus denied' } });
assert.throws(() => driver.workspaceFocus({ session, workspaceId: 'w-denied' }), /focus denied/);
setResponse(['workspace', 'rename', 'w-denied', 'New'], { __error: { message: 'rename denied' } });
assert.throws(() => driver.workspaceRename({ session, workspaceId: 'w-denied', label: 'New' }), /rename denied/);
check('focus/rename errors never become successful UI outcomes', true);

driver.paneLabel({ session, paneId: 'p-stable', label: 'Logical Display' });
check('pane display label never changes native agent handle', JSON.stringify(argvOf()) === JSON.stringify(['--session', session, 'pane', 'rename', 'p-stable', 'Logical Display']));
setResponse(['pane', 'move', 'p-stable', '--workspace', 'w-target', '--new-tab', '--no-focus'], { type: 'pane_move', move_result: { pane: { pane_id: 'p-new', tab_id: 't-new', workspace_id: 'w-target' } } });
const moved = driver.paneMove({ session, paneId: 'p-stable', workspaceId: 'w-target' });
check('move consumes actual returned pane/tab/workspace IDs', moved.pane_id === 'p-new' && moved.tab_id === 't-new' && moved.workspace_id === 'w-target');
setResponse(['pane', 'move', 'p-missing', '--workspace', 'w-target', '--new-tab', '--no-focus'], { type: 'pane_move' });
assert.throws(() => driver.paneMove({ session, paneId: 'p-missing', workspaceId: 'w-target' }), /no exact placement IDs/);
check('missing move result stays uncertain rather than guessed', true);

setResponse(['workspace', 'list'], { type: 'workspace_list', workspaces: [] });
check('already absent workspace close is a confirmed no-op', driver.workspaceClose({ session, workspaceId: 'gone' }) === true);
setResponse(['workspace', 'list'], { type: 'workspace_list', workspaces: [{ workspace_id: 'still-present' }] });
check('successful close command without inventory disappearance remains partial', driver.workspaceClose({ session, workspaceId: 'still-present' }) === false);
setResponse(['workspace', 'list'], { __error: { message: 'inventory failed' } });
assert.throws(() => driver.workspaceClose({ session, workspaceId: 'unknown' }), /inventory failed/);
check('unknown workspace inventory is never confirmed deletion', true);

// 2. JSON envelope parsing: results and errors
setResponse(['workspace', 'list'], { type: 'workspace_list', workspaces: [{ workspace_id: 'w1', label: 'agents' }] });
const list = driver.workspaceList(session);
check('workspace list parses the result payload', list.length === 1 && list[0].workspace_id === 'w1');

setResponse(['workspace', 'list'], { type: 'workspace_list', workspaces: [] });
setResponse(['workspace', 'create', '--label', 'agents'], { type: 'workspace_created', workspace: { workspace_id: 'w9', label: 'agents' } });
const workspaceCreated = driver.workspaceCreate({ session, label: 'agents' });
check('workspaceCreate returns a new exact owned resource', workspaceCreated?.workspace_id === 'w9');

setResponse(['workspace', 'list'], { type: 'workspace_list', workspaces: [{ workspace_id: 'w1', label: 'agents' }] });
const owned = driver.workspaceCreate({ session, label: 'agents' });
check('workspaceCreate never adopts a same-label workspace', owned?.workspace_id === 'w9');

// 3. error envelopes throw with the herdr message
setResponse(['pane', 'list'], { __error: { code: 'server_not_running', message: 'no herdr server is running at the fixture socket' } });
assert.throws(() => driver.paneList(session), /no herdr server is running/);
check('error envelopes throw with the herdr message', true);
setResponse(['pane', 'list'], { type: 'ok' });
assert.throws(() => driver.paneList(session), /inventory unavailable/);
check('invalid inventory never becomes an empty native target', true);
setResponse(['pane', 'list'], { panes: [
  { pane_id: 'foreign-shell', workspace_id: 'w1' },
  { pane_id: 'owned-pane', workspace_id: 'w1', agent: {} },
] });
const { unmanagedAgentPanes } = await import('../lib/team-herdr.js');
assert.deepEqual(unmanagedAgentPanes(session, 'w1').map(p => p.pane_id), ['foreign-shell','owned-pane'], 'post-stop inventory must not exclude initially managed retained panes');
check('unmanaged shells retain workspace even without detected agents', true);

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
check('pane read returns plain terminal text, not an envelope', driver.paneRead({ session, paneId: 'w1:p2' }) === 'scrollback line');

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

// 9. Stable mappings, not project-label derivation. Reads cannot allocate.
delete process.env.GOLEM_HERDR_SESSION;
const { projectHerdrSession, createTeamWorkspace } = await import('../lib/team-herdr.js');
const { ensureProjectAssociation } = await import('../lib/management-registry.js');
assert.throws(() => driver.herdrSessionForProject('proj-unmapped'), /no runtime association/);
const mapped = ensureProjectAssociation('proj-myapp-111111');
check('new project receives opaque handle', /^g-[0-9a-f]{28}$/.test(mapped.session));
check('team and driver read the same stable mapping', projectHerdrSession('proj-myapp-111111') === mapped.session);
check('rename/long-prefix labels do not retarget a mapping', driver.herdrSessionForProject('proj-myapp-111111', { knownProjects: [{ project_id: 'proj-myapp-111111', name: 'a'.repeat(64) }] }) === mapped.session);
check('different projects get distinct handles', ensureProjectAssociation('proj-clash-222222').session !== mapped.session);
process.env.GOLEM_HERDR_SESSION = session;
setResponse(['workspace', 'create', '--label', 'agents'], { workspace: { workspace_id: 'new-owned', label: 'agents' } });
check('team creation does not reuse a same-label workspace', createTeamWorkspace(session, 'agents') === 'new-owned');
check('team creation invokes exact create', argvOf().slice(2).join(' ') === 'workspace create --label agents');

// Inherited caller query: no target override, no focus, moved alias is current.
const inherited = { ...process.env, HERDR_ENV: '1', HERDR_SESSION: 'caller-session', HERDR_PANE_ID: 'old:p1',
  HERDR_WORKSPACE_ID: 'old', HERDR_SOCKET_PATH: '/tmp/fixture/caller-session/herdr.sock', GOLEM_HERDR_SESSION: 'different-target' };
setResponse(['pane', 'current', '--current'], { type: 'pane_current', pane: { pane_id: 'moved:p9', workspace_id: 'moved', tab_id: 'moved:t9', focused: false } });
const callerPane = driver.paneCurrentInherited({ env: inherited });
assert.deepEqual(argvOf(), ['pane', 'current', '--current']);
assert.equal(callerPane.session, 'caller-session');
assert.equal(callerPane.pane_id, 'moved:p9'); assert.equal(callerPane.workspace_id, 'moved'); assert.equal(callerPane.focused, false);
const nativeEnv = JSON.parse(fs.readFileSync(envCapture, 'utf8'));
assert.equal(nativeEnv.HERDR_SESSION, 'caller-session'); assert.equal(nativeEnv.HERDR_SOCKET_PATH, inherited.HERDR_SOCKET_PATH);
assert.equal(nativeEnv.GOLEM_HERDR_SESSION, null);
check('inherited current query preserves caller socket/session and moved nonfocused IDs, ignoring target override', true);
setResponse(['pane', 'current', '--current'], { __error: { message: 'caller alias unavailable' } });
assert.throws(() => driver.paneCurrentInherited({ env: inherited }), /caller alias unavailable/);
assert.throws(() => driver.paneCurrentInherited({ env: { HERDR_ENV: '1' } }), /context is missing/);
const hang = path.join(bin, 'herdr-hang');
fs.writeFileSync(hang, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
assert.throws(() => driver.paneCurrentInherited({ env: { ...inherited, GOLEM_HERDR_BIN: hang }, timeoutMs: 25 }), /query failed/);
check('inherited unavailable/timeout errors are bounded and never fall back to UI focus', true);

console.log(failures === 0 ? '\nHERDR DRIVER UNIT TESTS PASS' : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;

// Cleanup
for (const key of Object.keys(originalEnv)) {
  if (originalEnv[key] === undefined) delete process.env[key];
  else process.env[key] = originalEnv[key];
}
fs.rmSync(temp, { recursive: true, force: true });
