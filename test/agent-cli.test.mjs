#!/usr/bin/env node
// GOL-372: the golem agent toolkit. Temp GOLEM_HOME only; the worker manager
// is stubbed, so no herdr, tmux, or dashboard is touched. Covers help, the
// verb map, scope defaults (team for a lead, project otherwise and unbound),
// cross-team --scope project, name ambiguity with candidates, exact-id
// resolution, create team refusal, role/dedup mechanics, and the removed
// verbs answering unknown command through the real CLI entry.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-agent-cli-'));
process.env.GOLEM_HOME = path.join(temp, 'home');
delete process.env.XDG_CONFIG_HOME;
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
const { createTeam, setTeamLead } = await import('../lib/team-registry.js');
const { claimWorker, updateWorker } = await import('../lib/worker-registry.js');
const { projectIdFor } = await import('../lib/project-id.js');
const projectId = projectIdFor(projectDir);
const preset = { harness: 'pi', model: 'agent-cli-model' };

const alpha = createTeam({ label: 'Alpha Team', projectId, herdrSession: 'agent-cli-test' });
const beta = createTeam({ label: 'Beta Team', projectId, herdrSession: 'agent-cli-test' });
setTeamLead(alpha.team_id, 'lead-A');

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

// Manager stub shaped like the worker-manager exports.
const calls = [];
const stubManager = {
  async listWorkerViews({ includeDead = false } = {}) {
    const { listWorkers } = await import('../lib/worker-registry.js');
    return listWorkers({ projectId })
      .filter((row) => includeDead || ['spawning', 'live', 'failed'].includes(String(row.state || '').toLowerCase()))
      .map((row) => viewFor(row));
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

async function run(args, { resolveContext = leadContext, manager = stubManager } = {}) {
  const out = [];
  const exit = await runAgent('agent', args, {
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
    cwd: projectDir,
    resolveContext,
    manager,
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
  const rows = JSON.parse(scoped.text);
  assert.equal(rows.length, 1, 'lead-A default list holds only the alpha team');
  assert.equal(rows[0].session_id, 'sess-alpha-1');
  assert.equal(rows[0].team, 'alpha-team');

  const team = await run(['list', '--scope', 'team', '--json']);
  assert.deepEqual(JSON.parse(team.text).map((row) => row.session_id), ['sess-alpha-1']);

  const project = await run(['list', '--scope', 'project', '--json']);
  assert.equal(project.exit, 0, project.text);
  const ids = JSON.parse(project.text).map((row) => row.session_id).sort();
  assert.deepEqual(ids, ['sess-alpha-1', 'sess-beta-1'], '--scope project shows other teams agents');

  const unbound = await run(['list', '--json'], { resolveContext: unboundContext });
  assert.deepEqual(JSON.parse(unbound.text).map((row) => row.session_id).sort(), ['sess-alpha-1', 'sess-beta-1'],
    'an unbound shell lists the project scope without caller binding');

  const ended = await run(['list', '--scope', 'project', '--ended', '--json']);
  assert.ok(JSON.parse(ended.text).some((row) => row.session_id === 'sess-beta-9'), '--ended adds retired rows');
  assert.ok(!JSON.parse(project.text).some((row) => row.session_id === 'sess-beta-9'), 'retired rows hidden by default');

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
  assert.deepEqual(calls.at(-1), ['peek', 'builder1', { projectId, teamId: alpha.team_id, lines: null }]);

  // Exact session id reaches across teams (no enforcement).
  const stop = await run(['stop', 'sess-beta-1', '--json']);
  assert.equal(stop.exit, 0, stop.text);
  assert.deepEqual(calls.at(-1), ['stop', 'builder1', { projectId, teamId: beta.team_id }]);

  // A caller with no team and a repeated name gets candidates, not a pick.
  const ambiguous = await run(['read', 'builder1'], { resolveContext: unboundContext });
  assert.equal(ambiguous.exit, 2);
  assert.match(ambiguous.text, /agent name is ambiguous: builder1 \(2 agents\)/);
  assert.ok(ambiguous.text.includes('sess-alpha-1') && ambiguous.text.includes('sess-beta-1'), 'candidates listed');

  const missing = await run(['read', 'nobody']);
  assert.equal(missing.exit, 2);
  assert.match(missing.text, /agent not found: nobody/);

  const attach = await run(['attach', 'sess-alpha-1']);
  assert.equal(attach.exit, 0, attach.text);
  assert.deepEqual(calls.at(-1), ['attach', 'builder1', { projectId, teamId: alpha.team_id }]);
}

// --- create ----------------------------------------------------------------------
{
  const refused = await run(['create', 'builder'], { resolveContext: unboundContext });
  assert.equal(refused.exit, 2);
  assert.match(refused.text, /no team: pass --team or run golem team lead <team>/);

  const created = await run(['create', 'explorer', '--team', 'beta-team', '--json']);
  assert.equal(created.exit, 0, created.text);
  const record = JSON.parse(created.text);
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
  assert.equal(JSON.parse(cleared.text).role, null);

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
  const session = spawnSync(process.execPath, [cli, 'session', 'list'], { encoding: 'utf8' });
  assert.equal(session.status, 2);
  assert.match(session.stderr, /Unknown command: session/);
  console.log('--- unknown-command pastes ---');
  console.log(`$ node cli/golem.js spawn builder\n${spawn.stderr.trim()}`);
  console.log(`$ node cli/golem.js session list\n${session.stderr.trim()}`);
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

console.log('agent CLI passed: help, verb map, scope defaults, ambiguity, create, role, dedup, removed verbs');
