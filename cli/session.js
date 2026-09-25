// golem session — list herdr sessions and attach to one.
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
import { listTeams } from '../lib/team-registry.js';
import { herdrSessionForProject, sessionAttach, sessionList } from '../lib/herdr-driver.js';

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

async function projectSession(explicit, cwd) {
  const value = typeof explicit === 'string' ? explicit.trim() : '';
  const projectId = /^[\w-]+-[a-f0-9]{6}$/.test(value)
    ? value
    : projectIdFor(await resolveProjectRoot(path.resolve(cwd, value || '.')));
  return herdrSessionForProject(projectId);
}

export async function runSession(family, args, {
  stdout = (text) => process.stdout.write(`${text}\n`),
  stderr = (text) => process.stderr.write(`${text}\n`),
  cwd = process.cwd(),
  herdr = { sessionList, sessionAttach },
} = {}) {
  let json = args.includes('--json');
  try {
    const parsed = parse(family, args);
    if (parsed.help) { stdout(json ? JSON.stringify({ help: parsed.help }) : parsed.help); return 0; }
    const { key, options: o, positional } = parsed;

    if (key === 'session list') {
      const views = sessionViews(herdr.sessionList());
      if (json) stdout(JSON.stringify(views));
      else stdout(views.length ? formatTable(SESSION_TABLE_COLUMNS, views) : 'No herdr sessions.');
      return 0;
    }

    if (key === 'session attach') {
      const name = positional[0] ?? await projectSession(o['--project'], cwd);
      requireKnown(name, herdr.sessionList());
      return herdr.sessionAttach(name);
    }

    throw new NotificationError(`unknown command: ${key}`);
  } catch (error) {
    const invalid = error instanceof NotificationError;
    if (json) stdout(JSON.stringify({ ok: false, error: error.message }));
    else stderr(`golem session: ${error.message}`);
    return invalid ? 2 : 1;
  }
}
