#!/usr/bin/env node
// GOL-372: the golem agent toolkit. Temp GOLEM_HOME only; the worker manager
// is stubbed, so no herdr, tmux, or dashboard is touched. Covers help, the
// verb map, scope defaults (team for a lead, project otherwise and unbound),
// cross-team --scope project, name ambiguity with candidates, exact-id
// resolution, create team refusal, role/dedup mechanics, and the removed
// verbs answering unknown command through the real CLI entry.

import { parseCliEnvelope } from './_cli-envelope.mjs';
import assert from 'node:assert/strict';
import { parseManagementList } from './_management-list.mjs';
import { spawnSync } from 'node:child_process';
import fs, { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-agent-cli-'));
process.env.GOLEM_HOME = path.join(temp, 'home');
delete process.env.XDG_CONFIG_HOME;
delete process.env.HERDR_ENV;
const projectDir = path.join(temp, 'project');
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# agent cli fixture\n');
// Silence the best-effort herdr state fetch: the binary stub fails fast and
// listHerdrAgentStates falls back to unknown states.
const binDir = path.join(temp, 'bin');
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, 'herdr-stub'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
process.env.GOLEM_HERDR_BIN = path.join(binDir, 'herdr-stub');

const { runAgent, buildAgentRows } = await import('../cli/agent.js');
const { createTeam, joinTeam } = await import('../lib/team-registry.js');
const { claimWorker, updateWorker } = await import('../lib/worker-registry.js');
const { projectIdFor } = await import('../lib/project-id.js');
const projectId = projectIdFor(projectDir);
const preset = { harness: 'pi', model: 'agent-cli-model' };

const alpha = createTeam({ label: 'Alpha Team', projectId, herdrSession: 'agent-cli-test' });
const beta = createTeam({ label: 'Beta Team', projectId, herdrSession: 'agent-cli-test' });
joinTeam(alpha.team_id, 'lead-A', { owner: true });

const alphaBuilder = claimWorker({ role: 'builder', projectId, preset, teamId: alpha.team_id });
updateWorker(alphaBuilder.worker_id, { session_id: 'sess-alpha-1', state: 'live' });
const betaBuilder = claimWorker({ role: 'builder', projectId, preset, teamId: beta.team_id });
updateWorker(betaBuilder.worker_id, { session_id: 'sess-beta-1', state: 'live' });
const retired = claimWorker({ role: 'explorer', projectId, preset, teamId: beta.team_id, name: 'explorer9' });
updateWorker(retired.worker_id, { session_id: 'sess-beta-9', state: 'dead', ended_at: new Date().toISOString() });

function viewFor(row, extra = {}) {
  return {
    ...row,
    model: preset.model,
    provider: 'test-provider',
    harness: 'pi',
    status: row.state === 'live' ? 'idle' : row.state,
    dispatchable: row.state === 'live',
    idle_seconds: 3,
    attach_hint: `golem agent attach ${row.name}`,
    ...extra,
  };
}

// Manager stub shaped like the worker-manager exports. The roster carries
// the managed live rows plus one external session with no worker record.
const calls = [];
function enrichedView(row, { host = 'herdr' } = {}) {
  return {
    session_id: row.session_id ?? null,
    name: row.name,
    label: row.name,
    status: row.state === 'live' ? 'idle' : row.state,
    role: row.role,
    harness: 'pi',
    project_id: projectId,
    model: preset.model,
    provider: 'test-provider',
    delivery_ready: row.state === 'live',
    delivery_reason: null,
    idle_seconds: null,
    worker: {
      session_id: row.session_id,
      name: row.name,
      role: row.role,
      model: preset.model,
      tmux_session: null,
      state: row.state,
      attach_hint: `golem agent attach ${row.name}`,
      team_id: row.team_id ?? null,
      team_label: null,
      host,
      herdr_state: null,
    },
    worker_name: row.name,
    worker_role: row.role,
    worker_model: preset.model,
    worker_tmux_session: null,
    worker_state: row.state,
    worker_attach_hint: `golem agent attach ${row.name}`,
    team_id: row.team_id ?? null,
    team_label: null,
    host,
    herdr_state: null,
  };
}
const EXTERNAL = {
  session_id: 'sess-external-1',
  name: 'field-lead',
  label: 'field-lead',
  status: 'idle',
  role: 'lead',
  harness: 'claudecode',
  project_id: projectId,
  model: 'ext-model',
  provider: 'ext-provider',
  delivery_ready: true,
  delivery_reason: null,
  idle_seconds: null,
  worker: null,
  worker_name: null,
  worker_role: null,
  worker_model: null,
  worker_tmux_session: null,
  worker_state: null,
  worker_attach_hint: null,
  team_id: null,
  team_label: null,
  host: 'external',
  herdr_state: null,
};
const stubManager = {
  async listAgentRoster({ includeDead = false } = {}) {
    const { listWorkers } = await import('../lib/worker-registry.js');
    const rows = listWorkers({ projectId });
    const live = rows
      .filter((row) => ['spawning', 'live', 'failed'].includes(String(row.state || '').toLowerCase()))
      .map((row) => enrichedView(row));
    const ended = includeDead
      ? rows.filter((row) => ['dead', 'failed'].includes(String(row.state || '').toLowerCase()) && row.state === 'dead')
        .map((row) => enrichedView(row, { host: 'legacy' }))
      : [];
    return { roster: [...live, { ...EXTERNAL }], ended, projectId };
  },
  async spawnWorker(input) {
    calls.push(['spawn', input]);
    const claimed = claimWorker({ role: input.role, projectId, preset, name: input.name ?? null, teamId: input.teamId });
    return viewFor({ ...claimed, session_id: `sess-new-${claimed.name}`, state: 'live', status: 'idle', dispatchable: true });
  },
  async peekWorker(name, opts) {
    calls.push(['peek', name, opts]);
    return `scrollback for ${name}\n`;
  },
  attachWorker(name, opts) {
    calls.push(['attach', name, opts]);
    return 0;
  },
  async killWorker(name, opts) {
    calls.push(['stop', name, opts]);
    const { findWorker } = await import('../lib/worker-registry.js').catch(() => ({}));
    void findWorker;
    const { listWorkers } = await import('../lib/worker-registry.js');
    const row = listWorkers({ projectId }).find((entry) => entry.name === name
      && (opts?.teamId == null || entry.team_id === opts.teamId));
    return viewFor({ ...row, state: 'dead' });
  },
};

const leadContext = () => ({ sessionId: 'lead-A', projectId });
const unboundContext = () => null;

async function run(args, { resolveContext = leadContext, manager = stubManager, client = null } = {}) {
  const out = [];
  const exit = await runAgent('agent', args, {
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
    cwd: projectDir,
    resolveContext,
    manager,
    ...(client ? { client } : {}),
  });
  return { exit, text: out.join('\n') };
}

// --- help --------------------------------------------------------------------
{
  const { exit, text } = await run([]);
  assert.equal(exit, 0);
  for (const verb of ['agent list', 'agent create', 'agent read', 'agent attach', 'agent stop', 'agent notify', 'agent role', 'agent dedup']) {
    assert.ok(text.includes(verb), `help lists ${verb}`);
  }
  const bogus = await run(['frobnicate']);
  assert.equal(bogus.exit, 2);
  assert.match(bogus.text, /unknown command: agent frobnicate/);
  const notifyHelp = await run(['notify', '--help']);
  assert.equal(notifyHelp.exit, 0);
  for (const section of ['Usage:', 'Input:', 'Timing:', 'Receipts:', 'Examples:']) {
    assert.ok(notifyHelp.text.includes(section), `notify help section: ${section}`);
  }
  assert.ok(notifyHelp.text.includes('golem agent list --json'), 'notify help points at agent list');
}

// --- scope: team default for a lead, project on demand and unbound ------------
{
  const scoped = await run(['list', '--json']);
  assert.equal(scoped.exit, 0, scoped.text);
  const rows = parseManagementList(scoped.text);
  assert.equal(rows.length, 1, 'lead-A default list holds only the alpha team');
  assert.equal(rows[0].session_id, 'sess-alpha-1');
  assert.equal(rows[0].team, 'alpha-team');
  assert.equal(rows[0].host, 'herdr');

  const team = await run(['list', '--scope', 'team', '--json']);
  assert.deepEqual(parseManagementList(team.text).map((row) => row.session_id), ['sess-alpha-1']);

  const project = await run(['list', '--scope', 'project', '--json']);
  assert.equal(project.exit, 0, project.text);
  const ids = parseManagementList(project.text).map((row) => row.session_id).sort();
  assert.deepEqual(ids, ['sess-alpha-1', 'sess-beta-1', 'sess-external-1'], '--scope project shows other teams agents and external sessions');
  const external = parseManagementList(project.text).find((row) => row.session_id === 'sess-external-1');
  assert.equal(external.host, 'external');
  assert.equal(external.team, null);
  assert.equal(external.name, 'field-lead');
  assert.equal(external.delivery, 'ready');

  const unbound = await run(['list', '--json'], { resolveContext: unboundContext });
  assert.deepEqual(parseManagementList(unbound.text).map((row) => row.session_id).sort(), ['sess-alpha-1', 'sess-beta-1', 'sess-external-1'],
    'an unbound shell lists the project scope without caller binding');

  const ended = await run(['list', '--scope', 'project', '--ended', '--json']);
  const endedRows = parseManagementList(ended.text);
  assert.ok(endedRows.some((row) => row.session_id === 'sess-beta-9'), '--ended adds retired rows');
  assert.equal(endedRows.find((row) => row.session_id === 'sess-beta-9').host, 'legacy');
  assert.ok(!parseManagementList(project.text).some((row) => row.session_id === 'sess-beta-9'), 'retired rows hidden by default');

  // An external session shows under team scope when it owns or joined the team.
  const { createTeam: createTeamInScope, joinTeam: joinInScope } = await import('../lib/team-registry.js');
  const gamma = createTeamInScope({ label: 'Gamma Team', projectId, herdrSession: 'agent-cli-test' });
  joinInScope(gamma.team_id, 'sess-external-1');
  const externalLead = await run(['list', '--json'], { resolveContext: () => ({ sessionId: 'sess-external-1', projectId }) });
  assert.deepEqual(parseManagementList(externalLead.text).map((row) => row.session_id), ['sess-external-1'],
    'a lead with no managed agents still sees its own external session');

  // The discovered external id is usable with agent notify.
  const sent = [];
  const notifyClient = {
    async request() {
      return { notification_protocol: 1, idempotency: true, scheduling: true };
    },
    async notifySession(body) {
      sent.push(body);
      return { operation_id: body.operation_id, receipt: { kind: 'message', id: body.operation_id, state: 'accepted' } };
    },
  };
  const notified = await run(['notify', '--to', 'sess-external-1', '--message', 'hello field', '--human', '--json'], {
    resolveContext: unboundContext,
    client: notifyClient,
  });
  assert.equal(notified.exit, 0, notified.text);
  assert.equal(sent[0].session_id, 'sess-external-1');

  const badScope = await run(['list', '--scope', 'bogus']);
  assert.equal(badScope.exit, 2);
  assert.match(badScope.text, /invalid scope/);

  const table = await run(['list', '--scope', 'project']);
  for (const column of ['ID', 'NAME', 'ROLE', 'TEAM', 'HOST', 'STATUS', 'HERDR STATE', 'MODEL', 'DELIVERY']) {
    assert.ok(table.text.includes(column), `table column: ${column}`);
  }
}

// --- T2 identifiers ------------------------------------------------------------
{
  // Team-unique name resolves inside the callers team.
  const read = await run(['read', 'builder1']);
  assert.equal(read.exit, 0, read.text);
  assert.equal(read.text.trim(), 'scrollback for builder1');
  assert.deepEqual(calls.at(-1), ['peek', 'builder1', { projectId, teamId: alpha.team_id, workerId: alphaBuilder.worker_id, lines: null }]);

  // Exact session id reaches across teams (no enforcement).
  const stop = await run(['stop', 'sess-beta-1', '--json']);
  assert.equal(stop.exit, 0, stop.text);
  assert.deepEqual(calls.at(-1), ['stop', 'builder1', { projectId, teamId: beta.team_id, workerId: betaBuilder.worker_id }]);

  // A caller with no team and a repeated name gets candidates, not a pick.
  const ambiguous = await run(['read', 'builder1'], { resolveContext: unboundContext });
  assert.equal(ambiguous.exit, 2);
  assert.match(ambiguous.text, /More than one agent matches/);
  assert.ok(ambiguous.text.includes('sess-alpha-1') && ambiguous.text.includes('sess-beta-1'), 'candidates listed');

  const missing = await run(['read', 'nobody']);
  assert.equal(missing.exit, 2);
  assert.match(missing.text, /agent not found: nobody/);

  const attach = await run(['attach', 'sess-alpha-1']);
  assert.equal(attach.exit, 0, attach.text);
  assert.deepEqual(calls.at(-1), ['attach', 'builder1', { projectId, teamId: alpha.team_id, workerId: alphaBuilder.worker_id }]);

  // GOL-382 R6: an exact session id on two rows (a stale shared binding)
  // resolves to the live row instead of failing as ambiguous.
  const { resolveAgentRef } = await import('../lib/agent-resolve.js');
  const liveRow = { worker_id: 'w-live', session_id: 'sess-shared', name: 'builder1', state: 'live', project_id: projectId, team_id: alpha.team_id };
  const deadRow = { worker_id: 'w-dead', session_id: 'sess-shared', name: 'builder1', state: 'dead', project_id: projectId, team_id: beta.team_id };
  assert.equal(resolveAgentRef('sess-shared', { workers: [deadRow, liveRow], projectId }).worker_id, 'w-live', 'exact id picks the live row');
  assert.equal(resolveAgentRef('sess-shared', { workers: [liveRow, deadRow], projectId }).worker_id, 'w-live', 'row order does not matter');
  assert.throws(() => resolveAgentRef('sess-shared', { workers: [liveRow, { ...deadRow, state: 'live' }], projectId }), /More than one agent matches/, 'two live rows return identities for selection');
}

// --- create ----------------------------------------------------------------------
{
  const refused = await run(['create', 'builder'], { resolveContext: unboundContext });
  assert.equal(refused.exit, 2);
  assert.match(refused.text, /no team: pass --team/);

  const created = await run(['create', 'explorer', '--team', 'beta-team', '--json']);
  assert.equal(created.exit, 0, created.text);
  const record = parseCliEnvelope(created.text);
  assert.equal(record.team, 'beta-team');
  assert.equal(calls.at(-1)[0], 'spawn');
  assert.equal(calls.at(-1)[1].teamId, beta.team_id);
}

// --- role + dedup ------------------------------------------------------------------
{
  const sessionsFile = path.join(process.env.GOLEM_HOME, 'sessions.json');
  writeFileSync(sessionsFile, JSON.stringify({ version: 1, sessions: [
    { session_id: 'sess-alpha-1', name: 'builder1', project_path: projectDir, updated_at: new Date().toISOString() },
  ] }));
  const invalid = await run(['role', 'typo']);
  assert.equal(invalid.exit, 2);
  assert.match(invalid.text, /invalid role/);

  const cleared = await run(['role', 'clear', 'sess-alpha-1', '--json']);
  assert.equal(cleared.exit, 0, cleared.text);
  assert.equal(parseCliEnvelope(cleared.text).role, null);

  const listed = await run(['role', 'list']);
  assert.equal(listed.exit, 0);
  assert.ok(listed.text.includes('builder'));

  const dedupFile = path.join(process.env.GOLEM_HOME, 'sessions.json');
  writeFileSync(dedupFile, JSON.stringify({ version: 1, sessions: [
    { session_id: 'dup-new', name: 'dupe', project_path: '/x', updated_at: new Date().toISOString() },
    { session_id: 'dup-old', name: 'dupe', project_path: '/x', updated_at: '2020-01-01T00:00:00.000Z' },
  ] }));
  const dry = await run(['dedup']);
  assert.equal(dry.exit, 0);
  assert.match(dry.text, /golem agent dedup \(dry-run/);
  const applied = await run(['dedup', '--apply']);
  assert.equal(applied.exit, 0);
  assert.match(applied.text, /applied: marked duplicate/);
}

// --- removed verbs through the real entry --------------------------------------------
{
  const cli = path.join(repo, 'cli', 'golem.js');
  const spawn = spawnSync(process.execPath, [cli, 'spawn', 'builder'], { encoding: 'utf8' });
  assert.equal(spawn.status, 2);
  assert.match(spawn.stderr, /Unknown command: spawn/);
  console.log('--- unknown-command pastes ---');
  console.log(`$ node cli/golem.js spawn builder\n${spawn.stderr.trim()}`);
}

// --- row builder -----------------------------------------------------------------------
{
  const rows = buildAgentRows(
    [{ session_id: 's1', name: 'builder1', role: 'builder', team_id: alpha.team_id, state: 'live', status: 'idle', model: 'm', dispatchable: true, herdr_session: 'h', herdr_agent_name: 'alpha-team-builder1' }],
    { teams: [alpha, beta], herdrStates: new Map([['alpha-team-builder1', 'working']]) },
  );
  assert.equal(rows[0].team, 'alpha-team');
  assert.equal(rows[0].host, 'herdr');
  assert.equal(rows[0].herdr_state, 'working');
  assert.equal(rows[0].delivery, 'ready');
}

// --- row builder reads pane-keyed states (GOL-379) -------------------------------------
{
  // The name key is absent (rename never stuck), yet the pane id resolves.
  const rows = buildAgentRows(
    [{ session_id: 's2', name: 'explorer1', role: 'explorer', team_id: beta.team_id, state: 'live', status: 'idle', model: 'm', dispatchable: true, herdr_session: 'h', herdr_pane_id: 'w1:p7', herdr_agent_name: 'beta-team-explorer1' }],
    { teams: [alpha, beta], herdrStates: new Map([['w1:p7', 'blocked']]) },
  );
  assert.equal(rows[0].team, 'beta-team');
  assert.equal(rows[0].herdr_state, 'blocked');
}

// --- enrichDispatchableRows keeps the roster's delivery_ready ---
{
  const { enrichDispatchableRows } = await import('../lib/worker-manager.js');
  const enriched = enrichDispatchableRows([
    { session_id: 'sess-alpha-1', delivery_ready: false, status: 'idle', project_id: projectId },
    { session_id: 'sess-external-1', name: 'field-lead', delivery_ready: true, status: 'idle', project_id: projectId },
  ], { projectId });
  const managedRow = enriched.find((row) => row.session_id === 'sess-alpha-1');
  assert.equal(managedRow.delivery_ready, false, 'a managed row with delivery_ready:false stays not ready');
  assert.equal(managedRow.host, 'herdr', 'a new reservation carries an exact native session');
  const externalRow = enriched.find((row) => row.session_id === 'sess-external-1');
  assert.equal(externalRow.delivery_ready, true, 'an external row with delivery_ready:true stays ready');
  assert.equal(externalRow.host, 'external');
}

// Actual pre-herdr legacy rows stay legacy and refuse native teardown/read.
{
  const { withManagementTransaction } = await import('../lib/management-registry.js');
  const { enrichDispatchableRows, peekWorker, killWorker } = await import('../lib/worker-manager.js');
  withManagementTransaction(state => state.workers.workers.push({ worker_id: 'actual-legacy', session_id: 'sess-real-legacy',
    name: 'legacy-worker', project_id: projectId, state: 'live', tmux_session: 'legacy-exact', tmux_socket: 'legacy-socket',
    herdr_session: null, herdr_pane_id: null, herdr_agent_name: 'legacy-control-exact' }));
  const row = enrichDispatchableRows([{ session_id: 'sess-real-legacy', project_id: projectId, delivery_ready: false }])[0];
  assert.equal(row.host, 'legacy', 'actual migrated legacy placement stays legacy');
  assert.equal(row.delivery_ready, false);
  await assert.rejects(peekWorker('legacy-worker', { projectId }), /legacy tmux row.*legacy-exact/);
  await assert.rejects(killWorker('legacy-worker', { projectId }), /legacy tmux row.*legacy-exact/);
}
// New agent controls: real owned process-incarnation fixture + injected native DTOs.
{
  const { spawn } = await import('node:child_process'); const { once } = await import('node:events');
  const { captureProcessGroup } = await import('../lib/process-group.js'); const { readWorkers } = await import('../lib/worker-registry.js');
  const { upsertSessionFact } = await import('../lib/session-facts.js');
  const children = [0, 1, 2].map(() => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }));
  const exits = children.map(child => once(child, 'exit'));
  try {
    const row = claimWorker({ role: 'builder', projectId, preset, teamId: alpha.team_id, name: 'controlled-agent' });
    const own = updateWorker(row.worker_id, { state: 'live', session_id: 'controlled-conversation', herdr_pane_id: 'source-pane', herdr_tab_id: 'source-tab', herdr_workspace_id: 'source-w', process_ownership: captureProcessGroup(children[0].pid) });
    const externalId = '12345678-1234-1234-1234-123456789abc', file = path.join(temp, 'external-native.jsonl');
    upsertSessionFact({ canonical_id: externalId, harness: 'pi', name: 'external-adopted', project_path: projectDir, locator: { raw_session_id: externalId, session_file: file }, status: 'idle' });
    const external = { agent: 'pi', name: 'existing-external-handle', pane_id: 'external-pane', tab_id: 'external-tab', workspace_id: 'external-w', agent_session: { kind: 'path', value: file } };
    const unnamedId = 'abcdef12-1234-1234-1234-123456789abc', unnamedFile = path.join(temp, 'unnamed-native.jsonl');
    upsertSessionFact({ canonical_id: unnamedId, harness: 'pi', name: 'unnamed-adopted', project_path: projectDir, locator: { raw_session_id: unnamedId, session_file: unnamedFile }, status: 'idle' });
    const unnamed = { ...external, name: null, pane_id: 'unnamed-pane', tab_id: 'unnamed-tab', agent_session: { kind: 'path', value: unnamedFile } };
    const effects = []; let displayFails = false, moveFails = false, handleFails = false;
    let position = { pane_id: 'source-pane', tab_id: 'source-tab', workspace_id: 'source-w' };
    const native = {
      agentGet: ({ target }) => target === 'unnamed-pane' ? unnamed : target === 'external-pane' ? external : { ...position, name: own.herdr_agent_name, agent: 'pi' },
      agentList: () => [external, unnamed],
      agentRename: value => { effects.push(['handle', value]); if (handleFails) throw new Error('native handle update unavailable'); unnamed.name = value.name; return true; },
      paneProcessInfo: ({ paneId }) => paneId === 'unnamed-pane' ? { foreground_process_group_id: children[2].pid, foreground_processes: [{ pid: children[2].pid, argv0: 'pi', argv: ['pi', '--session', unnamedFile] }] } : paneId === 'external-pane' ? { foreground_process_group_id: children[1].pid, foreground_processes: [{ pid: children[1].pid, argv0: 'pi', argv: ['pi', '--session', file] }] } : { foreground_process_group_id: children[0].pid, foreground_processes: [{ pid: children[0].pid, argv0: 'pi', argv: ['pi'] }] },
      workspaceList: () => [{ workspace_id: 'source-w' }, { workspace_id: 'destination-w' }, { workspace_id: 'retry-w' }],
      paneLabel: value => { effects.push(['label', value]); if (displayFails) throw new Error('display unavailable'); return true; },
      paneMove: value => { effects.push(['move', value]); position = { pane_id: value.workspaceId === 'retry-w' ? 'retry-pane' : 'moved-pane', tab_id: 'moved-tab', workspace_id: value.workspaceId }; if (moveFails) throw new Error('move response unavailable'); return position; },
    };
    const run = async args => { const out = []; const exit = await runAgent('agent', [...args, '--json'], { cwd: projectDir, env: {}, native, resolveContext: () => null, stdout: t => out.push(t), stderr: () => {} }); return { exit, value: parseCliEnvelope(out.join('')) }; };
    const inspect = await run(['inspect', own.session_id]); assert.equal(inspect.exit, 0); assert.equal(inspect.value.native_handle, own.herdr_agent_name); assert.equal(inspect.value.capabilities.stop.state, 'available', JSON.stringify(inspect.value));
    const bytes = () => JSON.stringify(['workers.json', 'teams.json', 'herdr-mappings.json'].map(name => fs.readFileSync(path.join(process.env.GOLEM_HOME, name), 'utf8')));
    const before = bytes();
    for (const args of [['rename', own.session_id, 'renamed-control'], ['move', own.session_id, '--workspace', 'destination-w'], ['adopt', externalId, '--team', beta.team_id, '--pane', 'external-pane']]) assert.equal((await run([...args, '--dry-run'])).exit, 0);
    assert.equal(bytes(), before); assert.equal(effects.length, 0);
    displayFails = true;
    const partial = await run(['rename', own.session_id, 'renamed-control']); assert.equal(partial.exit, 1); assert.equal(partial.value.logical_changed, true); assert.equal(partial.value.herdr_agent_name, own.herdr_agent_name);
    displayFails = false;
    const renamed = await run(['rename', own.session_id, 'renamed-control']); assert.equal(renamed.exit, 0); assert.equal(renamed.value.logical_changed, false); assert.equal(renamed.value.team_id, alpha.team_id); assert.equal(renamed.value.role, own.role);
    assert.equal((await run(['rename', own.session_id, 'renamed-control'])).value.noop, true);
    assert.equal((await run(['rename', own.session_id, 'builder1'])).exit, 2);
    const moved = await run(['move', own.session_id, '--workspace', 'destination-w']); assert.equal(moved.exit, 0); assert.equal(moved.value.herdr_pane_id, 'moved-pane'); assert.equal(moved.value.herdr_tab_id, 'moved-tab'); assert.equal(moved.value.team_id, alpha.team_id); assert.equal(moved.value.herdr_agent_name, own.herdr_agent_name);
    assert.equal((await run(['move', own.session_id, '--workspace', 'destination-w'])).value.noop, true);
    moveFails = true;
    const partialMove = await run(['move', own.session_id, '--workspace', 'retry-w']); assert.equal(partialMove.exit, 1); assert.equal(partialMove.value.pending_native_move.workspace_id, 'retry-w');
    const moveCalls = effects.filter(e => e[0] === 'move').length;
    moveFails = false;
    const recoveredMove = await run(['move', own.session_id, '--workspace', 'retry-w']); assert.equal(recoveredMove.exit, 0); assert.equal(recoveredMove.value.recovered_move, true); assert.equal(recoveredMove.value.herdr_pane_id, 'retry-pane'); assert.equal(effects.filter(e => e[0] === 'move').length, moveCalls, 'exact alias recovery never duplicates an uncertain move');
    const cross = await run(['move', own.session_id, '--workspace', 'destination-w', '--session', 'different-server']); assert.equal(cross.exit, 2); assert.equal(cross.value.resolution.target, null, 'conflicting session scope selects no agent');
    const adopted = await run(['adopt', externalId, '--team', beta.team_id, '--pane', 'external-pane']); assert.equal(adopted.exit, 0, JSON.stringify(adopted.value)); assert.equal(adopted.value.session_id, externalId); assert.equal(adopted.value.role, null); assert.equal(adopted.value.herdr_agent_name, external.name); assert.equal(adopted.value.team_id, beta.team_id);
    assert.equal((await run(['adopt', externalId, '--team', beta.team_id, '--pane', 'external-pane'])).value.noop, true);
    handleFails = true;
    const pendingAdopt = await run(['adopt', unnamedId, '--team', beta.team_id, '--pane', 'unnamed-pane']); assert.equal(pendingAdopt.exit, 1); assert.match(pendingAdopt.value.pending_native_handle, /^g-[0-9a-f]{28}$/);
    const reservedHandle = pendingAdopt.value.herdr_agent_name;
    handleFails = false;
    const resumedAdopt = await run(['adopt', unnamedId, '--team', beta.team_id, '--pane', 'unnamed-pane']); assert.equal(resumedAdopt.exit, 0, JSON.stringify(resumedAdopt.value)); assert.equal(resumedAdopt.value.herdr_agent_name, reservedHandle); assert.equal(resumedAdopt.value.pending_native_handle, null); assert.equal(unnamed.name, reservedHandle);
    const rows = readWorkers(); assert.equal(rows.find(w => w.session_id === own.session_id).team_id, alpha.team_id); assert.equal(rows.filter(w => w.session_id === unnamedId).length, 1, 'retry never allocates another adopted runtime');
    const wrong = await runAgent('agent', ['adopt', externalId, '--team', beta.team_id, '--pane', 'wrong-pane', '--json'], { cwd: projectDir, env: {}, native: { ...native, agentGet: () => ({ ...external, agent_session: { kind: 'path', value: '/different-native' } }) }, resolveContext: () => null, stdout: () => {}, stderr: () => {} }); assert.equal(wrong, 0, 'an explicit native pane selects the target without a cached conversation-identity veto');
  } finally {
    for (const child of children) if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL');
    await Promise.all(exits);
  }
}
console.log('agent CLI passed: existing toolkit plus inspect/adopt/rename/move, exact identity, stable handle/membership, partial retry/conflicts and zero-write plans');
