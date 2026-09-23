// golem team — lead-owned teams (GOL-363 R2, R3, R9; GOL-371).
//
// Flag parser and help style follow cli/collaboration.js. Herdr workspace
// calls go through the lib/team-herdr.js seam, which delegates to
// lib/herdr-driver.js (GOL-370).

import path from 'node:path';
import { resolveCliSessionContext } from '../lib/cli-session-context.js';
import { projectIdFor, resolveProjectRoot } from '../lib/project-id.js';
import { NotificationError } from '../lib/notification-contract.js';
import { createTeam, findTeam, listTeams, setTeamLead, setTeamWorkspace, closeTeam } from '../lib/team-registry.js';
import { activeWorkerStates, listWorkers } from '../lib/worker-registry.js';
import { killWorker } from '../lib/worker-manager.js';
import { readSessionFacts } from '../lib/session-facts.js';
import {
  closeTeamWorkspace,
  createTeamWorkspace,
  ensureProjectSession,
  projectHerdrSession,
} from '../lib/team-herdr.js';

const commands = {
  'team create': { flags: { '--project': 'value', '--json': 'bool' }, args: 1,
    help: [
      'golem team create <label> [--project <id-or-path>] [--json]',
      '',
      'Usage: create a team and its herdr workspace. Does not launch a lead.',
      'Input: a label; the slug comes from the label and must be unique among open teams in the project. Run by a bound session, that session becomes the lead; from an unbound shell the team starts with no lead.',
      'Receipts: prints the team id, slug and workspace id. Exit codes: 0 created, 1 operational failure, 2 invalid input/context.',
      'Examples:',
      '  golem team create "Blue team" --json   # machine-readable team record',
    ].join('\n') },
  'team list': { flags: { '--project': 'value', '--json': 'bool' }, args: 0,
    help: [
      'golem team list [--project <id-or-path>] [--json]',
      '',
      'Usage: list the project teams with lead, agent count, state and workspace.',
      'Input: defaults to the caller project. Exit codes: 0 listed, 1 operational failure, 2 invalid input/context.',
      'Examples:',
      '  golem team list --json   # this project, machine-readable',
    ].join('\n') },
  'team lead': { flags: { '--project': 'value', '--json': 'bool' }, args: 1,
    help: [
      'golem team lead <team> [--project <id-or-path>] [--json]',
      '',
      'Usage: make the calling bound session the lead of one team (by id or slug). Covers starting the lead after creating the team, and handoff: the session is cleared from any other open team it led. Workers stay in the team.',
      'Input: the team id or slug. Only a bound session may run it. Exit codes: 0 set, 1 operational failure, 2 invalid input/context.',
      'Examples:',
      '  golem team lead blue-team   # take the lead of the blue team',
    ].join('\n') },
  'team close': { flags: { '--project': 'value', '--json': 'bool' }, args: 1,
    help: [
      'golem team close <team> [--project <id-or-path>] [--json]',
      '',
      'Usage: stop every live agent in one team (by id or slug), close its workspace, and mark it closed. Other teams are not touched.',
      'Input: the team id or slug. Exit codes: 0 closed, 1 operational failure, 2 invalid input/context.',
      'Examples:',
      '  golem team close blue-team   # retire the blue team only',
    ].join('\n') },
};

function parse(family, args) {
  if (!args.length || ['--help', '-h', 'help'].includes(args[0])) {
    return { help: Object.entries(commands).filter(([key]) => key.startsWith(`${family} `)).map(([, value]) => value.help).join('\n\n') };
  }
  const key = `${family} ${args[0]}`;
  const command = commands[key];
  if (!command) throw new NotificationError(`unknown command: ${key}`);
  const options = {};
  const positional = [];
  for (let i = 1; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--help' || token === '-h') { options.help = true; continue; }
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const type = command.flags[token];
    if (!type) throw new NotificationError(`unknown option: ${token}`);
    if (Object.hasOwn(options, token)) throw new NotificationError(`duplicate option: ${token}`);
    if (type === 'bool') options[token] = true;
    else {
      if (++i >= args.length) throw new NotificationError(`${token} requires a value`);
      if (args[i].startsWith('--')) throw new NotificationError(`${token} requires a value`);
      options[token] = args[i];
    }
  }
  if (options.help) return { help: command.help, options };
  if (positional.length !== command.args) throw new NotificationError(command.help.split('\n')[0]);
  return { key, options, positional };
}

function callerSession(resolveContext) {
  try {
    return resolveContext()?.sessionId ?? null;
  } catch {
    return null;
  }
}

async function resolveTeamProject(explicit, { cwd, resolveContext }) {
  if (typeof explicit === 'string' && explicit.trim()) {
    const value = explicit.trim();
    if (/^[\w-]+-[a-f0-9]{6}$/.test(value)) return value;
    return projectIdFor(await resolveProjectRoot(path.resolve(cwd, value)));
  }
  const context = callerSession(resolveContext);
  void context;
  try {
    const full = resolveContext();
    if (full?.projectId) return full.projectId;
  } catch {}
  return projectIdFor(await resolveProjectRoot(cwd));
}

function leadName(sessionId) {
  if (!sessionId) return null;
  try {
    const fact = readSessionFacts().find((entry) => entry.canonical_id === sessionId);
    const name = fact?.name ?? fact?.label ?? null;
    return typeof name === 'string' && name.trim() ? name : null;
  } catch {
    return null;
  }
}

function teamView(team, workerCount) {
  return {
    team_id: team.team_id,
    label: team.label,
    slug: team.slug,
    project_id: team.project_id,
    lead: team.lead_session_id
      ? { session_id: team.lead_session_id, name: leadName(team.lead_session_id) }
      : null,
    agent_count: workerCount,
    state: team.closed_at == null ? 'open' : 'closed',
    herdr_session: team.herdr_session,
    herdr_workspace_id: team.herdr_workspace_id,
    created_at: team.created_at,
    closed_at: team.closed_at,
  };
}

function agentCountFor(teamId, projectId) {
  const active = activeWorkerStates();
  return listWorkers({ projectId }).filter((row) => (
    row.team_id === teamId && active.has(String(row.state || '').toLowerCase())
  )).length;
}

export async function runTeam(family, args, {
  stdout = (text) => process.stdout.write(`${text}\n`),
  stderr = (text) => process.stderr.write(`${text}\n`),
  cwd = process.cwd(),
  resolveContext = resolveCliSessionContext,
  herdr = { ensureProjectSession, createTeamWorkspace, closeTeamWorkspace, projectHerdrSession },
} = {}) {
  let json = args.includes('--json');
  try {
    const parsed = parse(family, args);
    if (parsed.options) json = Boolean(parsed.options['--json']);
    if (parsed.help) { stdout(json ? JSON.stringify({ help: parsed.help }) : parsed.help); return 0; }
    const { key, options: o, positional } = parsed;
    const projectId = await resolveTeamProject(o['--project'], { cwd, resolveContext });

    if (key === 'team list') {
      const teams = listTeams({ projectId });
      const views = teams.map((team) => teamView(team, agentCountFor(team.team_id, projectId)));
      if (json) {
        stdout(JSON.stringify(views));
        return 0;
      }
      stdout(views.length
        ? views.map((view) => [view.slug, view.label, view.lead ? view.lead.session_id : '-', `${view.agent_count} agents`, view.state, view.herdr_workspace_id ?? '-'].join('  ')).join('\n')
        : 'No teams.');
      return 0;
    }

    if (key === 'team create') {
      const label = positional[0];
      const caller = callerSession(resolveContext);
      const session = herdr.projectHerdrSession(projectId);
      const team = createTeam({
        label,
        projectId,
        leadSessionId: caller,
        herdrSession: session,
      });
      try {
        await herdr.ensureProjectSession(session);
        const workspaceId = herdr.createTeamWorkspace(session, team.label);
        const updated = setTeamWorkspace(team.team_id, workspaceId);
        if (json) {
          stdout(JSON.stringify(teamView(updated, 0)));
        } else {
          stdout(`team ${updated.team_id} (slug ${updated.slug}) workspace ${updated.herdr_workspace_id}`);
        }
        return 0;
      } catch (error) {
        try { closeTeam(team.team_id); } catch {}
        throw new Error(`team workspace failed: ${error.message}`);
      }
    }

    if (key === 'team lead') {
      const caller = callerSession(resolveContext);
      if (!caller) throw new NotificationError('team lead requires a bound session', 'INVALID_CALLER_CONTEXT');
      const team = findTeam(positional[0], { projectId });
      if (!team) throw new NotificationError(`unknown team: ${positional[0]}`);
      const updated = setTeamLead(team.team_id, caller);
      const view = teamView(updated, agentCountFor(updated.team_id, projectId));
      stdout(json ? JSON.stringify(view) : `team ${view.slug} lead ${caller}`);
      return 0;
    }

    if (key === 'team close') {
      const team = findTeam(positional[0], { projectId });
      if (!team) throw new NotificationError(`unknown team: ${positional[0]}`);
      const active = activeWorkerStates();
      const members = listWorkers({ projectId, teamId: team.team_id })
        .filter((row) => active.has(String(row.state || '').toLowerCase()));
      const stopped = [];
      for (const member of members) {
        const dead = await killWorker(member.name, { projectId, teamId: team.team_id });
        stopped.push(dead?.name ?? member.name);
      }
      let workspaceClosed = false;
      if (team.herdr_workspace_id) {
        workspaceClosed = herdr.closeTeamWorkspace(team.herdr_session, team.herdr_workspace_id);
      }
      const closed = closeTeam(team.team_id);
      const result = { ...teamView(closed, 0), stopped, workspace_closed: workspaceClosed };
      stdout(json ? JSON.stringify(result) : `team ${closed.slug} closed (${stopped.length} agents stopped)`);
      return 0;
    }

    throw new NotificationError(`unknown command: ${key}`);
  } catch (error) {
    const invalid = error instanceof NotificationError || /unknown team|team slug|team label|team is closed|bound session|requires a value|unknown command|unknown option|duplicate option/.test(error.message);
    if (json) stdout(JSON.stringify({ ok: false, error: error.message }));
    else stderr(`golem team: ${error.message}`);
    return invalid ? 2 : 1;
  }
}
