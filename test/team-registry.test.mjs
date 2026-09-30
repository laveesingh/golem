#!/usr/bin/env node
// GOL-371: team registry, team-scoped worker naming, and caller-team
// resolution. Temp GOLEM_HOME only; no herdr, no tmux, no dashboard.

import assert from 'node:assert/strict';
import { parseManagementList } from './_management-list.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-team-registry-'));
process.env.GOLEM_HOME = path.join(temp, 'state');
delete process.env.XDG_CONFIG_HOME;
delete process.env.HERDR_ENV;

const { teamsJsonPath } = await import('../lib/golem-home.js');
const {
  slugifyTeamLabel,
  herdrAgentNameFor,
  createTeam,
  findTeam,
  listTeams,
  joinTeam,
  teamHasSession,
  setTeamWorkspace,
  closeTeam,
} = await import('../lib/team-registry.js');
const {
  claimWorker,
  findWorker,
  findWorkerBySession,
  listWorkers,
} = await import('../lib/worker-registry.js');
const { resolveCallerTeam, resolveListTeam, NO_TEAM_MESSAGE } = await import('../lib/team-context.js');

const preset = { model: 'test-model' };
const projectA = 'team-proj-aaaaaa';
const projectB = 'team-proj-bbbbbb';

// --- golem-home -------------------------------------------------------------
assert.equal(teamsJsonPath(), path.join(process.env.GOLEM_HOME, 'teams.json'));

// --- slugs ------------------------------------------------------------------
assert.equal(slugifyTeamLabel('Blue Team'), 'blue-team');
assert.equal(slugifyTeamLabel('  Research & Dev!! '), 'research-dev');
assert.equal(slugifyTeamLabel('a'), 'a');
assert.throws(() => slugifyTeamLabel(''), /label is required/);
assert.throws(() => slugifyTeamLabel('!!!'), /valid slug/);
assert.throws(() => slugifyTeamLabel('9 lives'), /valid slug/);
assert.throws(() => slugifyTeamLabel('x'.repeat(100)), /valid slug/);

// --- herdr agent names --------------------------------------------------------
assert.match(herdrAgentNameFor('stable-runtime-1'), /^g-[0-9a-f]{28}$/);
assert.equal(herdrAgentNameFor('stable-runtime-1'), herdrAgentNameFor('stable-runtime-1'));
assert.notEqual(herdrAgentNameFor('stable-runtime-1'), herdrAgentNameFor('stable-runtime-2'));
assert.throws(() => herdrAgentNameFor(''), /runtime ID is required/);

// --- team rows ----------------------------------------------------------------
const blue = createTeam({ label: 'Blue Team', projectId: projectA, herdrSession: 'herdr-a' });
assert.equal(blue.slug, 'blue-team');
assert.equal(blue.owner_session_id, null);
assert.deepEqual(blue.member_session_ids, []);
assert.equal(blue.herdr_workspace_id, null);
assert.equal(blue.closed_at, null);
assert.match(blue.team_id, /^[0-9a-f-]{36}$/);

const red = createTeam({
  label: 'Red Team', projectId: projectA, ownerSessionId: 'lead-1', herdrSession: 'herdr-a', herdrWorkspaceId: 'w9',
});
assert.equal(red.owner_session_id, 'lead-1');
assert.equal(red.herdr_workspace_id, 'w9');

// Duplicate slug among open teams in the same project refuses.
assert.throws(
  () => createTeam({ label: 'blue team', projectId: projectA, herdrSession: 'herdr-a' }),
  /team slug already exists: blue-team/,
);
// Same slug in another project is fine.
const blueB = createTeam({ label: 'Blue Team', projectId: projectB, herdrSession: 'herdr-b' });
assert.equal(blueB.slug, 'blue-team');

// --- find / list ---------------------------------------------------------------
assert.equal(findTeam(blue.team_id, { projectId: projectA }).label, 'Blue Team');
assert.equal(findTeam('blue-team', { projectId: projectA }).team_id, blue.team_id);
assert.equal(findTeam('blue-team', { projectId: projectB }).team_id, blueB.team_id);
assert.equal(findTeam('nope', { projectId: projectA }), null);
assert.equal(listTeams({ projectId: projectA }).length, 2);
assert.equal(listTeams({ projectId: projectB }).length, 1);

// --- owner and members (GOL-382 R4) ----------------------------------------------
const moved = joinTeam(red.team_id, 'lead-9', { owner: true });
assert.equal(moved.owner_session_id, 'lead-9');
assert.deepEqual(moved.member_session_ids, ['lead-1'], 'the previous owner stays a member');
const joined = joinTeam(blue.team_id, 'lead-9');
assert.deepEqual(joined.member_session_ids, ['lead-9'], 'join without --owner adds a member');
assert.equal(joined.owner_session_id, null);
assert.equal(findTeam(red.team_id).owner_session_id, null, 'joining another team leaves the previous one');
assert.ok(teamHasSession(findTeam(blue.team_id), 'lead-9'));
assert.ok(!teamHasSession(findTeam(red.team_id), 'lead-9'));
// A new team takes its owner out of any other open team.
const green = createTeam({ label: 'Green Team', projectId: projectA, ownerSessionId: 'lead-9', herdrSession: 'herdr-a' });
assert.ok(!teamHasSession(findTeam(blue.team_id), 'lead-9'), 'create leaves the previous team');
assert.equal(green.owner_session_id, 'lead-9');
closeTeam(green.team_id);
joinTeam(blue.team_id, 'lead-9', { owner: true });
assert.throws(() => joinTeam(red.team_id, ''), /session_id is required/);
assert.throws(() => joinTeam('missing-id', 'lead-9'), /team not found/);
// Rows written before owners (lead_session_id only) read as the owner; writes
// mirror lead_session_id for an old reader.
{
  const file = teamsJsonPath();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const legacy = raw.teams.find((row) => row.team_id === red.team_id);
  delete legacy.owner_session_id;
  delete legacy.member_session_ids;
  legacy.lead_session_id = 'legacy-lead';
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(findTeam(red.team_id).owner_session_id, 'legacy-lead', 'legacy lead reads as owner');
  setTeamWorkspace(red.team_id, 'w9');
  const written = JSON.parse(fs.readFileSync(file, 'utf8')).teams.find((row) => row.team_id === red.team_id);
  assert.equal(written.owner_session_id, 'legacy-lead');
  assert.equal(written.lead_session_id, undefined, 'v2 removes the superseded owner mirror');
}

// --- workspace + close -----------------------------------------------------------
const withWs = setTeamWorkspace(blue.team_id, 'w1');
assert.equal(withWs.herdr_workspace_id, 'w1');
const closed = closeTeam(blue.team_id);
assert.ok(closed.closed_at, 'closed_at is set');
assert.equal(closeTeam(blue.team_id).closed_at, closed.closed_at, 'close is idempotent');
// A closed slug can be reused by a new open team.
const blue2 = createTeam({ label: 'Blue Team', projectId: projectA, herdrSession: 'herdr-a' });
assert.notEqual(blue2.team_id, blue.team_id);
// Slug lookup prefers the open row.
assert.equal(findTeam('blue-team', { projectId: projectA }).team_id, blue2.team_id);
assert.equal(listTeams({ projectId: projectA }).length, 4);
assert.equal(listTeams({ projectId: projectA, includeClosed: false }).length, 2);
assert.throws(() => joinTeam(blue.team_id, 'lead-9'), /team is closed/);

// --- team-scoped worker naming ----------------------------------------------------
const team1 = createTeam({ label: 'Team One', projectId: projectA, herdrSession: 'herdr-a' });
const team2 = createTeam({ label: 'Team Two', projectId: projectA, herdrSession: 'herdr-a' });
const first1 = claimWorker({ role: 'builder', projectId: projectA, preset, teamId: team1.team_id });
const first2 = claimWorker({ role: 'builder', projectId: projectA, preset, teamId: team2.team_id });
assert.equal(first1.name, 'builder1');
assert.equal(first2.name, 'builder1', 'two teams in one project can each have a builder1');
assert.equal(first1.team_id, team1.team_id);
const second1 = claimWorker({ role: 'builder', projectId: projectA, preset, teamId: team1.team_id });
assert.equal(second1.name, 'builder2', 'names sequence within the team');
assert.throws(
  () => claimWorker({ role: 'builder', projectId: projectA, name: 'builder1', preset, teamId: team1.team_id }),
  /worker name already exists: builder1 \(team /,
);
// Rows without a team keep the project-scoped behavior: they must avoid
// names held by any occupied row in the project (including team rows), so
// unscoped lookups never go ambiguous.
const legacy = claimWorker({ role: 'builder', projectId: projectA, preset });
assert.equal(legacy.team_id, null);
assert.equal(legacy.name, 'builder3', 'team-held builder1/builder2 are skipped project-wide');
// findWorker stays project-scoped by default...
assert.throws(
  () => findWorker('builder1', { projectId: projectA }),
  /ambiguous/,
);
// ...and resolves within one team when asked.
assert.equal(findWorker('builder1', { projectId: projectA, teamId: team1.team_id }).worker_id, first1.worker_id);
assert.equal(findWorker('builder1', { projectId: projectA, teamId: team2.team_id }).worker_id, first2.worker_id);
assert.equal(findWorker('builder1', { teamId: team2.team_id }).worker_id, first2.worker_id);
assert.equal(listWorkers({ teamId: team1.team_id }).length, 2);
assert.equal(listWorkers({ projectId: projectA, teamId: team2.team_id }).length, 1);

// --- findWorkerBySession ------------------------------------------------------------
import { updateWorker } from '../lib/worker-registry.js';
updateWorker(first1.worker_id, { session_id: 'sess-builder-1', state: 'live' });
updateWorker(first2.worker_id, { session_id: 'sess-builder-2', state: 'live' });
assert.equal(findWorkerBySession('sess-builder-1').worker_id, first1.worker_id);
assert.equal(findWorkerBySession('sess-builder-1', { projectId: projectA }).worker_id, first1.worker_id);
assert.equal(findWorkerBySession('sess-builder-1', { projectId: projectB }), null);
assert.equal(findWorkerBySession('missing-session'), null);
assert.throws(() => findWorkerBySession(''), /session_id is required/);

// --- caller-team resolution (G8) ------------------------------------------------------
const teams = listTeams({ projectId: projectA });

// --team wins, by id and by slug.
assert.equal(resolveCallerTeam({ teamRef: team1.team_id, projectId: projectA, teams }).team_id, team1.team_id);
assert.equal(resolveCallerTeam({ teamRef: 'team-two', projectId: projectA, teams }).team_id, team2.team_id);
assert.throws(() => resolveCallerTeam({ teamRef: 'nope', projectId: projectA, teams }), /unknown or ambiguous team: nope/);
// A slug shared with a closed row resolves to the open team.
assert.equal(resolveCallerTeam({ teamRef: 'blue-team', projectId: projectA, teams }).team_id, blue2.team_id);

// An owner or a member resolves to its team.
joinTeam(team1.team_id, 'lead-alpha', { owner: true });
joinTeam(team2.team_id, 'member-beta');
const teamsAfterLead = listTeams({ projectId: projectA });
assert.equal(
  resolveCallerTeam({ projectId: projectA, callerSessionId: 'lead-alpha', teams: teamsAfterLead }).team_id,
  team1.team_id,
);
assert.equal(resolveListTeam({ projectId: projectA, teams: teamsAfterLead }), null, 'list falls back to project scope');
assert.equal(
  resolveListTeam({ projectId: projectA, callerSessionId: 'lead-alpha', teams: teamsAfterLead }).team_id,
  team1.team_id,
);
assert.equal(
  resolveCallerTeam({ projectId: projectA, callerSessionId: 'member-beta', teams: listTeams({ projectId: projectA }) }).team_id,
  team2.team_id,
  'a joined member resolves to its team',
);
// Own worker row resolves when the caller owns or joined nothing.
const workerRow = findWorkerBySession('sess-builder-2');
assert.equal(
  resolveCallerTeam({ projectId: projectA, callerSessionId: 'sess-builder-2', teams: teamsAfterLead, workerRow }).team_id,
  team2.team_id,
);
// Lead wins over own worker row.
joinTeam(team1.team_id, 'sess-builder-2');
updateWorker(first2.worker_id, { session_id: 'lead-alpha' });
const leadAlsoWorker = findWorkerBySession('lead-alpha');
assert.equal(
  resolveCallerTeam({ projectId: projectA, callerSessionId: 'lead-alpha', teams: teamsAfterLead, workerRow: leadAlsoWorker }).team_id,
  team1.team_id,
  'lead membership wins over the caller worker row',
);
// Nothing resolves: unbound and bound-without-team both refuse.
assert.throws(() => resolveCallerTeam({ projectId: projectA, teams: teamsAfterLead }), new RegExp(NO_TEAM_MESSAGE));
assert.throws(
  () => resolveCallerTeam({ projectId: projectA, callerSessionId: 'nobody', teams: teamsAfterLead }),
  new RegExp(NO_TEAM_MESSAGE),
);
assert.throws(
  () => resolveCallerTeam({ projectId: projectA, callerSessionId: 'nobody', teams: teamsAfterLead, workerRow: { team_id: null } }),
  new RegExp(NO_TEAM_MESSAGE),
);

// --- golem team list hides closed teams unless --all ------------------------
{
  const { runTeam } = await import('../cli/team.js');
  const projectC = 'team-proj-cccccc';
  const openTeam = createTeam({ projectId: projectC, label: 'List open', herdrSession: 'herdr-c' });
  const shutTeam = createTeam({ projectId: projectC, label: 'List shut', herdrSession: 'herdr-c' });
  closeTeam(shutTeam.team_id);
  const listed = async (args) => {
    const out = [];
    const status = await runTeam('team', ['list', '--project', projectC, '--json', ...args], { stdout: (t) => out.push(t), stderr: () => {} });
    assert.equal(status, 0);
    return parseManagementList(out.join('')).map((row) => row.slug);
  };
  assert.deepEqual(await listed([]), [openTeam.slug], 'default list shows open teams only');
  assert.deepEqual((await listed(['--all'])).sort(), [openTeam.slug, shutTeam.slug].sort(), '--all includes closed teams');
}

// Exact team controls, native failures/retry and canonical explicit members.
{
  const { runTeam } = await import('../cli/team.js');
  fs.writeFileSync(path.join(process.env.GOLEM_HOME, 'sessions.json'), JSON.stringify({ sessions: [{ session_id: 'external-team-member', project_id: projectA }] }));
  const target = createTeam({ label: 'Control Team', projectId: projectA, herdrSession: 'herdr-a', herdrWorkspaceId: 'control-w', ownerSessionId: 'external-team-member' });
  const nativeRows = [{ workspace_id: 'control-w', label: 'Control Team' }, { workspace_id: 'free-w', label: 'Same Native Label' }];
  const effects = []; let failRename = false, failInventory = false, failAttach = false;
  const native = {
    workspaceList: session => { assert.equal(session, 'herdr-a'); if (failInventory) throw new Error('native probe failed'); return nativeRows; },
    workspaceFocus: pair => { effects.push(['focus', pair]); return true; },
    workspaceRename: pair => { effects.push(['rename', pair]); if (failRename) throw new Error('display rejected'); nativeRows.find(w => w.workspace_id === pair.workspaceId).label = pair.label; return true; },
    sessionAttach: (session, options) => { effects.push(['attach', session, options]); return failAttach ? 1 : 0; },
  };
  const run = async args => { const out = []; const exit = await runTeam('team', [...args, '--json'], { cwd: temp, env: {}, herdr: native, resolveContext: () => null, stdout: t => out.push(t), stderr: () => {} }); return { exit, value: JSON.parse(out.join('')) }; };
  const inspected = await run(['inspect', target.team_id]); assert.equal(inspected.exit, 0); assert.equal(inspected.value.owner.session_id, 'external-team-member'); assert.equal(inspected.value.capabilities.focus.state, 'available'); assert.equal(effects.length, 0);
  const bytes = () => JSON.stringify(['teams.json', 'herdr-mappings.json', 'workers.json', 'sessions.json'].map(name => { const file = path.join(process.env.GOLEM_HOME, name); return [name, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null]; })); const before = bytes();
  for (const args of [['focus', target.team_id], ['attach', target.team_id], ['rename', target.team_id, 'Renamed Control'], ['leave', target.team_id, '--agent', 'external-team-member'], ['adopt', 'New Adopted', '--workspace', 'free-w', '--project', projectA]]) {
    const dry = await run([...args, '--dry-run']); assert.equal(dry.exit, 0, JSON.stringify(dry.value));
  }
  assert.equal(bytes(), before); assert.equal(effects.length, 0);
  assert.equal((await run(['focus', target.team_id])).exit, 0);
  assert.equal((await run(['attach', target.team_id])).value.attached, true);
  assert.deepEqual(effects[0], ['focus', { session: 'herdr-a', workspaceId: 'control-w' }]); assert.equal(effects[2][0], 'attach'); assert.equal(effects[2][2].outputToStderr, true);
  failAttach = true;
  const attachFailed = await run(['attach', target.team_id]); assert.equal(attachFailed.exit, 1); assert.equal(attachFailed.value.focused, true); assert.equal(attachFailed.value.attached, false);
  failAttach = false;
  failRename = true;
  const partial = await run(['rename', target.team_id, 'Renamed Control']); assert.equal(partial.exit, 1); assert.equal(partial.value.logical_changed, true); assert.equal(findTeam(target.team_id).pending_native_label, 'Renamed Control');
  failRename = false;
  const renamed = await run(['rename', target.team_id, 'Renamed Control']); assert.equal(renamed.exit, 0); assert.equal(renamed.value.logical_changed, false); assert.equal(renamed.value.display_updated, true); assert.equal(renamed.value.slug, 'renamed-control');
  assert.equal(findTeam(target.team_id).herdr_workspace_id, 'control-w'); assert.equal(findTeam(target.team_id).owner_session_id, 'external-team-member');
  const n = effects.length; assert.equal((await run(['rename', target.team_id, 'Renamed Control'])).value.noop, true); assert.equal(effects.length, n);
  const workerBefore = findWorkerBySession('sess-builder-1');
  assert.equal((await run(['join', target.team_id, '--agent', 'sess-builder-1', '--owner'])).exit, 0);
  assert.ok(findTeam(target.team_id).member_session_ids.includes('external-team-member'));
  const workerAfter = findWorkerBySession('sess-builder-1'); for (const field of ['role', 'herdr_session', 'herdr_agent_name', 'herdr_pane_id', 'herdr_workspace_id']) assert.equal(workerAfter[field], workerBefore[field]);
  const left = await run(['leave', '--agent', 'sess-builder-1']); assert.equal(left.exit, 0, JSON.stringify(left.value)); assert.deepEqual(left.value.left, [target.team_id]); assert.equal(findWorkerBySession('sess-builder-1').team_id, null);
  const again = await run(['leave', '--agent', 'sess-builder-1']); assert.equal(again.exit, 0); assert.equal(again.value.noop, true);
  const adopted = await run(['adopt', 'New Adopted', '--workspace', 'free-w', '--project', projectA]); assert.equal(adopted.exit, 0, JSON.stringify(adopted.value)); assert.equal(adopted.value.herdr_workspace_id, 'free-w');
  assert.equal((await run(['adopt', 'New Adopted', '--workspace', 'free-w', '--project', projectA])).value.noop, true);
  const aligned = await run(['rename', adopted.value.team_id, 'New Adopted']); assert.equal(aligned.exit, 0); assert.equal(aligned.value.display_updated, true); assert.equal(nativeRows.find(w => w.workspace_id === 'free-w').label, 'New Adopted');
  assert.equal((await run(['focus', target.team_id, '--session', 'foreign-session'])).exit, 2);
  assert.equal((await run(['leave', '--agent', 'sess-builder-1', '--project', projectB])).exit, 2);
  assert.equal((await run(['adopt', 'Steal Workspace', '--workspace', 'control-w', '--project', projectA])).exit, 2);
  const absent = await run(['adopt', 'Absent Workspace', '--workspace', 'missing-w', '--project', projectA]); assert.equal(absent.exit, 1); assert.match(absent.value.error, /absent/);
  assert.equal((await run(['rename', target.team_id, 'New Adopted'])).exit, 2);
  failInventory = true;
  const unknown = await run(['inspect', target.team_id]); assert.equal(unknown.exit, 0); assert.equal(unknown.value.capabilities.focus.state, 'unavailable'); assert.match(unknown.value.capabilities.focus.reason, /probe failed/);
  const unavailable = await run(['focus', target.team_id]); assert.equal(unavailable.exit, 1); assert.match(unavailable.value.error, /probe failed/);
}
// One failed target must not prevent independent stops or close metadata.
{
  const { runTeam } = await import('../cli/team.js');
  const team = createTeam({ label: 'Partial close', projectId: projectA, herdrSession: 'herdr-a' });
  const rows = [{ worker_id: 'close-a', name: 'first', project_id: projectA, state: 'live' }, { worker_id: 'close-b', name: 'second', project_id: projectA, state: 'live' }];
  const calls = []; let fail = true;
  const workers = { listWorkers: () => rows, killWorker: async (name, options) => { calls.push(name); assert.equal(options.constraints.teamId, team.team_id); if (name === 'first' && fail) throw new Error('birth evidence mismatch'); rows.find(r => r.name === name).state = 'dead'; return { name }; } };
  const run = async () => { const out = []; const exit = await runTeam('team', ['close', team.team_id, '--json'], { workers, cwd: temp, env: {}, resolveContext: () => null, stdout: t => out.push(t), stderr: () => {} }); return { exit, value: JSON.parse(out.join('')) }; };
  const partial = await run(); assert.equal(partial.exit, 1); assert.deepEqual(calls, ['first', 'second']); assert.deepEqual(partial.value.targets.map(t => t.status), ['failed', 'completed']); assert.equal(findTeam(team.team_id).closed_at, null);
  fail = false; calls.length = 0;
  const retried = await run(); assert.equal(retried.exit, 0); assert.deepEqual(calls, ['first']); assert.equal(retried.value.operation_id, partial.value.operation_id); assert.ok(findTeam(team.team_id).closed_at);
}
console.log('team registry journey passed: canonical registry/naming/scope plus inspect/focus/attach/rename partial-retry/adopt conflicts/explicit join/leave/dry-run controls');
fs.rmSync(temp, { recursive: true, force: true });
