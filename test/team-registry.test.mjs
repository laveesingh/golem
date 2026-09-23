#!/usr/bin/env node
// GOL-371: team registry, team-scoped worker naming, and caller-team
// resolution. Temp GOLEM_HOME only; no herdr, no tmux, no dashboard.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-team-registry-'));
process.env.GOLEM_HOME = path.join(temp, 'state');
delete process.env.XDG_CONFIG_HOME;

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
assert.equal(herdrAgentNameFor('blue-team', 'builder1'), 'blue-team-builder1');
const long = herdrAgentNameFor('a-very-long-team-slug-here', 'builder12345');
assert.ok(long.length <= 32, `cut to 32 chars: ${long}`);
assert.match(long, /^[a-z][a-z0-9_-]{0,31}$/);
assert.equal(herdrAgentNameFor('blue-team', 'Builder One'), 'blue-team-builder-one');
assert.throws(() => herdrAgentNameFor('Bad Slug', 'builder1'), /team slug is required/);

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
  assert.equal(written.lead_session_id, 'legacy-lead', 'lead_session_id is mirrored on write');
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
assert.throws(() => resolveCallerTeam({ teamRef: 'nope', projectId: projectA, teams }), /unknown team: nope/);
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

console.log('team registry journey passed: slugs, rows, owner/member join, legacy lead read + mirror, close, team-scoped naming, session lookup, G8 resolution');
