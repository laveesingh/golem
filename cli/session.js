// golem session — list herdr sessions, attach to one, or close one.
//
// A herdr session is the server that holds a project's team workspaces
// (lib/herdr-driver.js herdrSessionForProject). Flag parser and help style
// follow cli/team.js.

import fs from 'node:fs';
import path from 'node:path';
import { projectsJsonPath } from '../lib/golem-home.js';
import { projectIdFor, resolveProjectRoot } from '../lib/project-id.js';
import { NotificationError } from '../lib/notification-contract.js';
import { formatTable } from '../lib/cli-table.js';
import { closeTeam, listTeams } from '../lib/team-registry.js';
import { activeWorkerStates, listWorkers } from '../lib/worker-registry.js';
import { killWorker } from '../lib/worker-manager.js';
import { resolveCliSessionContext } from '../lib/cli-session-context.js';
import { MANAGEMENT_SELECTOR_FLAGS, managementQuery, listReceipt, writeDryRun, requireManagementResolution } from '../lib/management-cli.js';
import { beginManagementClose, waitForManagementLaunches, finishManagementClose } from '../lib/management-registry.js';
import {
  herdrSessionForProject,
  sessionAttach,
  sessionDelete,
  sessionList,
  sessionStop,
} from '../lib/herdr-driver.js';

const commands = {
  'session list': { flags: { '--json': 'bool' }, args: [0, 0],
    help: [
      'golem session list [--json]',
      '',
      'Usage: list every herdr session with its status, the golem project it serves, and its open team count.',
      'Exit codes: 0 listed, 1 operational failure, 2 invalid input.',
      'Examples:',
      '  golem session list --json   # machine-readable',
    ].join('\n') },
  'session attach': { flags: { '--project': 'value' }, args: [0, 1],
    help: [
      'golem session attach [<session>] [--project <id-or-path>]',
      '',
      'Usage: attach the current terminal to a herdr session (herdr --session <session>). Without <session>, attach to the session of the current project, or of --project.',
      'Input: <session> must be listed by golem session list; an unknown name fails instead of creating a new session.',
      'Exit codes: herdr exit status once attached, 1 operational failure, 2 invalid input.',
      'Examples:',
      '  golem session attach          # this project\'s session',
      '  golem session attach golem    # a named session',
    ].join('\n') },
  'session close': { flags: { '--force': 'bool', '--json': 'bool' }, args: [1, 1],
    help: [
      'golem session close <session> [--force] [--json]',
      '',
      'Usage: stop every live golem agent in one herdr session, close its open teams, then stop and delete the herdr session. It no longer shows in golem session list.',
      'Input: <session> must be listed by golem session list. Closing the session this terminal runs in is refused without --force, since it ends this terminal. If any agent fails to stop, nothing else is closed.',
      'Exit codes: 0 closed, 1 operational failure, 2 invalid input.',
      'Examples:',
      '  golem session close alpha   # retire the alpha session and its teams',
    ].join('\n') },
};

for (const [key, command] of Object.entries(commands)) {
  Object.assign(command.flags, MANAGEMENT_SELECTOR_FLAGS, { '--json': 'bool' });
  if (key !== 'session list') command.flags['--dry-run'] = 'bool';
  else command.flags['--scope'] = 'value';
  if (key === 'session close') command.args = [0, 1];
  command.help += '\nSelectors: --project P --team T --session S --caller ID. Mutations and attach accept --dry-run.';
}
commands['session list'].help += '\nJSON: {schema_version:2,items:[...],resolution:{...}}. Scripts read .items.';

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
      if (++i >= args.length || args[i].startsWith('--')) throw new NotificationError(`${token} requires a value`);
      options[token] = args[i];
    }
  }
  if (options.help) return { help: command.help, options };
  const [min, max] = command.args;
  if (positional.length < min || positional.length > max) throw new NotificationError(command.help.split('\n')[0]);
  return { key, options, positional };
}

function readProjects() {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectsJsonPath(), 'utf8'));
    return Array.isArray(parsed?.projects) ? parsed.projects : [];
  } catch {
    return [];
  }
}

function projectName(project) {
  return project?.name || project?.project_id || project?.id || null;
}

const SESSION_TABLE_COLUMNS = [
  { key: 'name', label: 'SESSION', max: 32 },
  { key: 'status', label: 'STATUS', max: 7 },
  { key: 'project', label: 'PROJECT', max: 32 },
  { key: 'open_teams', label: 'OPEN TEAMS', max: 10 },
];

function sessionViews(rows) {
  const projects = readProjects();
  const projectBySession = new Map();
  for (const project of projects) {
    const id = project?.project_id ?? project?.id;
    if (!id) continue;
    try { projectBySession.set(herdrSessionForProject(id, { knownProjects: projects }), project); } catch {}
  }
  const openTeams = listTeams({ includeClosed: false });
  return rows.map((row) => ({
    name: row.name,
    status: row.running ? 'running' : 'stopped',
    project: projectName(projectBySession.get(row.name)),
    open_teams: openTeams.filter((team) => team.herdr_session === row.name).length,
  }));
}

function requireKnown(name, rows) {
  const known = rows.map((row) => row.name);
  if (!known.includes(name)) {
    throw new NotificationError(`unknown herdr session: ${name} (known: ${known.join(', ') || 'none'})`);
  }
}

export async function runSession(family, args, {
  stdout = (text) => process.stdout.write(`${text}\n`),
  stderr = (text) => process.stderr.write(`${text}\n`),
  cwd = process.cwd(),
  herdr = { sessionList, sessionAttach, sessionStop, sessionDelete },
  workers = { listWorkers, killWorker },
  env = process.env,
  resolveContext = resolveCliSessionContext,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ...collector
} = {}) {
  let resolution = null;
  let json = args.includes('--json');
  try {
    const parsed = parse(family, args);
    if (parsed.help) { stdout(json ? JSON.stringify({ help: parsed.help }) : parsed.help); return 0; }
    const { key, options: o, positional } = parsed;
    if (o['--scope'] && !['team', 'project', 'all'].includes(o['--scope'])) throw new NotificationError(`invalid scope: ${o['--scope']}`);
    const query = await managementQuery({ operation: key, kind: 'session', target: positional[0], options: o, cwd, env, resolveContext,
      nativeSessions: () => herdr.sessionList(), ...collector });
    resolution = query.resolution;
    const dry = writeDryRun(query, o, stdout);
    if (dry != null) return dry;
    requireManagementResolution(resolution);
    const inventory = query.evidence.sources.nativeSessions;
    if (inventory.status !== 'resolved') throw new Error(`native session inventory unavailable: ${inventory.reason}`);

    if (key === 'session list') {
      const selected = inventory.value.filter(row => resolution.scope === 'global' || (resolution.session && row.name === resolution.session));
      const views = sessionViews(selected);
      if (json) stdout(JSON.stringify(listReceipt(views, resolution)));
      else stdout(views.length ? formatTable(SESSION_TABLE_COLUMNS, views) : 'No herdr sessions.');
      return 0;
    }

    if (key === 'session attach') {
      const name = resolution.target?.herdr_session ?? resolution.session;
      requireKnown(name, inventory.value);
      return herdr.sessionAttach(name);
    }

    if (key === 'session close') {
      const name = resolution.target?.herdr_session ?? resolution.session;
      requireKnown(name, inventory.value);
      if (env.HERDR_SESSION === name && !o['--force']) {
        throw new NotificationError(`refusing to close ${name}: this terminal runs inside it (pass --force to close it anyway)`);
      }
      beginManagementClose({ session: name });
      const flight = await waitForManagementLaunches({ session: name });
      if (!flight.completed) throw new Error(`session ${name} remains closing; unresolved operation IDs: ${flight.pending.map(i => i.operation_id).join(', ')}`);
      const active = activeWorkerStates();
      const live = workers.listWorkers()
        .filter((row) => row.herdr_session === name && active.has(String(row.state || '').toLowerCase()));
      const stopped = [];
      const failed = [];
      for (const row of live) {
        try {
          await workers.killWorker(row.name, { projectId: row.project_id, teamId: row.team_id ?? null, workerId: row.worker_id });
          stopped.push(row.name);
        } catch (error) {
          failed.push(`${row.name}: ${error.message}`);
        }
      }
      if (failed.length) throw new Error(`session ${name} left open; agents failed to stop: ${failed.join('; ')}`);
      const teams = listTeams({ includeClosed: false }).filter((team) => team.herdr_session === name);
      if (!herdr.sessionStop(name)) throw new Error(`session ${name} remains closing; native stop failed`);
      // herdr deletes only a stopped session; the server takes a moment to exit.
      let deleted = false;
      for (let attempt = 0; attempt < 20 && !deleted; attempt += 1) {
        deleted = herdr.sessionDelete(name);
        if (!deleted) await sleep(250);
      }
      if (!deleted) throw new Error(`herdr session ${name} stopped but could not be deleted`);
      for (const team of teams) closeTeam(team.team_id);
      finishManagementClose({ session: name });
      const result = { session: name, stopped, teams_closed: teams.map((team) => team.slug) };
      stdout(json
        ? JSON.stringify({ ...result, resolution })
        : `session ${name} closed (${stopped.length} agents stopped, ${teams.length} teams closed)`);
      return 0;
    }

    throw new NotificationError(`unknown command: ${key}`);
  } catch (error) {
    const invalid = error.exitCode === 2 || error instanceof NotificationError;
    if (json) stdout(JSON.stringify({ ok: false, error: error.message, resolution: error.resolution ?? resolution }));
    else stderr(`golem session: ${error.message}`);
    return invalid ? 2 : 1;
  }
}
