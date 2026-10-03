import { formatJson, wantsJson } from '../lib/cli-envelope.ts';
// Physical herdr containers; logical membership is retained by stop.
import { NotificationError } from '../lib/notification-contract.js';
import { formatTable } from '../lib/cli-table.js';
import { activeWorkerStates, listWorkers } from '../lib/worker-registry.js';
import { killWorker } from '../lib/worker-manager.js';
import { resolveCliSessionContext } from '../lib/cli-session-context.js';
import { MANAGEMENT_SELECTOR_FLAGS, managementQuery, listReceipt, writeDryRun, requireManagementResolution } from '../lib/management-cli.js';
import { inspectManagedSession, startManagedSession, adoptManagedSession, stopManagedSession } from '../lib/management-session.js';
import { sessionAttach, sessionDelete, sessionList, sessionStop, ensureSession, paneList } from '../lib/herdr-driver.js';

const commands = {
  list: { args: [0, 0], flags: { '--scope': 'value' }, usage: 'session list [--scope all|project|team]', description: 'Read native registrations with mapped project and open-team count. JSON is {schema_version:2,items:[...],resolution:{...}}; scripts read .items.' },
  inspect: { args: [0, 1], flags: {}, usage: 'session inspect [name]', description: 'Read exact mapping, native running state, teams, capabilities and unresolved operations; never starts resources.' },
  start: { args: [0, 1], flags: {}, usage: 'session start [name] [--project P]', description: 'Start the owned project container; allocate an opaque association only with no conflicting evidence. An unowned native resource requires explicit adoption. No conversation resume promise.' },
  adopt: { args: [0, 1], flags: {}, usage: 'session adopt <name> --project P', description: 'Associate an exact existing native container with a project without stealing foreign ownership or changing native resources.' },
  stop: { args: [0, 1], flags: {}, usage: 'session stop <name>', description: 'Stop the physical container, retaining its registration, project association and team definitions/memberships. Actual failures remain partial.' },
  close: { args: [0, 1], flags: { '--force': 'bool' }, usage: 'session close <name> [--force]', description: 'Stop/delete the physical container and close definitions only after confirmed outcomes. Includes contained external activity; self-close requires --force.' },
  attach: { args: [0, 1], flags: {}, usage: 'session attach [name]', description: 'Attach UI to an exact existing native registration, without creating an unknown resource.' },
};
for (const [verb, command] of Object.entries(commands)) {
  Object.assign(command.flags, MANAGEMENT_SELECTOR_FLAGS, { '--json': 'bool' });
  if (!['list', 'inspect'].includes(verb)) command.flags['--dry-run'] = 'bool';
  command.help = `golem ${command.usage} [--json]\n\n${command.description}\nSelectors: --project P --team T --session S --caller ID. Mutations/attach accept --dry-run. Exit0 completed/no-op, exit2 invalid scope, exit1 runtime/partial failure.`;
}
function parse(args) {
  if (!args.length || ['--help', '-h', 'help'].includes(args[0])) return { help: Object.values(commands).map(c => c.help).join('\n\n') };
  const verb = args[0], command = commands[verb];
  if (!command) throw new NotificationError(`unknown command: session ${verb}`);
  const options = {}, positional = [];
  for (let i = 1; i < args.length; i++) {
    const token = args[i];
    if (['--help', '-h'].includes(token)) { options.help = true; continue; }
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const type = command.flags[token];
    if (!type) throw new NotificationError(`unknown option: ${token}`);
    if (Object.hasOwn(options, token)) throw new NotificationError(`duplicate option: ${token}`);
    if (type === 'bool') options[token] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new NotificationError(`${token} requires a value`); options[token] = args[++i]; }
  }
  if (options.help) return { help: command.help };
  if (positional.length < command.args[0] || positional.length > command.args[1]) throw new NotificationError(command.help.split('\n')[0]);
  return { verb, options, positional };
}
const columns = [ { key: 'name', label: 'SESSION', max: 32 }, { key: 'status', label: 'STATUS', max: 7 },
  { key: 'project', label: 'PROJECT', max: 32 }, { key: 'open_teams', label: 'OPEN TEAMS', max: 10 } ];
function sessionViews(rows, evidence) {
  const parents = Object.values(evidence.snapshot?.mappings.projects ?? {});
  const imports = Object.values(evidence.snapshot?.plan.projects ?? {});
  return rows.map(row => {
    const parent = parents.find(p => p.session === row.name) ?? imports.find(p => p.session === row.name);
    const project = (evidence.sources.projects.value ?? []).find(p => p.project_id === parent?.project_id);
    return { name: row.name, status: row.running ? 'running' : 'stopped', project: project?.name ?? parent?.project_id ?? null,
      open_teams: evidence.teams.filter(t => t.closed_at == null && t.herdr_session === row.name).length };
  });
}
export async function runSession(family, args, { stdout = text => process.stdout.write(`${text}\n`), stderr = text => process.stderr.write(`${text}\n`),
  cwd = process.cwd(), env = process.env, resolveContext = resolveCliSessionContext,
  herdr = { sessionList, sessionAttach, sessionStop, sessionDelete, ensureSession, paneList },
  workers = { listWorkers, killWorker }, sleep = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = 30000, ...collector } = {}) {
  let resolution = null; const json = wantsJson(args);
  try {
    const parsed = parse(args);
    if (parsed.help) { stdout(json ? formatJson({ help: parsed.help }) : parsed.help); return 0; }
    const { verb, options: o, positional } = parsed;
    if (o['--scope'] && !['team', 'project', 'all'].includes(o['--scope'])) throw new NotificationError(`invalid scope: ${o['--scope']}`);
    const query = await managementQuery({ operation: `session ${verb}`, kind: 'session', target: positional[0], options: o, cwd, env, resolveContext,
      nativeSessions: () => herdr.sessionList(), ...collector });
    resolution = query.resolution;
    if (verb === 'adopt' && !o['--project']) { resolution.ok = false; resolution.missing.push({ field: 'project', message: 'session adopt requires --project <exact-project-id>' }); }
    if (verb === 'start' && !resolution.project_id) { resolution.ok = false; resolution.missing.push({ field: 'project', message: 'session start requires --project or an owned association' }); }
    if (verb === 'stop' && !positional[0] && !o['--session']) { resolution.ok = false; resolution.missing.push({ field: 'session', message: 'session stop requires an exact physical target: pass --session <handle>' }); }
    const dry = writeDryRun(query, o, stdout);
    if (dry != null) return dry;
    requireManagementResolution(resolution);
    const inventory = query.evidence.sources.nativeSessions;
    const name = resolution.target?.herdr_session ?? resolution.session;
    const output = result => stdout(json ? formatJson({ ...result, resolution }) : result.error ?? `session ${result.session} ${result.lifecycle ?? (result.adopted ? 'adopted' : 'inspected')}${result.noop ? ' (no-op)' : ''}`);
    if (verb === 'inspect') {
      output(inspectManagedSession(name, { inventory: inventory.status === 'resolved' ? inventory.value : null, snapshot: query.evidence.snapshot })); return 0;
    }
    if (inventory.status !== 'resolved') throw new Error(`native session inventory unavailable: ${inventory.reason}`);
    if (verb === 'list') {
      const selected = inventory.value.filter(row => resolution.scope === 'global' || (resolution.session && row.name === resolution.session));
      const items = sessionViews(selected, query.evidence);
      stdout(json ? formatJson(listReceipt(items, resolution)) : items.length ? formatTable(columns, items) : 'No herdr sessions.'); return 0;
    }
    if (verb === 'start') {
      const result = await startManagedSession(resolution.project_id, { session: positional[0] ?? o['--session'] ?? null, inventory: inventory.value, native: herdr }); output(result); return result.ok ? 0 : 1;
    }
    if (verb === 'adopt') { output(adoptManagedSession(resolution.project_id, name, { inventory: inventory.value })); return 0; }
    if (verb === 'attach') {
      if (!inventory.value.some(row => row.name === name)) throw new NotificationError(`unknown native session: ${name}; start explicitly`);
      const status = herdr.sessionAttach(name, { outputToStderr: json }); if (json) output({ ok: status === 0, attached: status === 0, status, session: name }); return status;
    }
    if (verb === 'close' && env.HERDR_SESSION === name && !o['--force']) throw new NotificationError(`refusing to close ${name}: this terminal runs inside it (pass --force to close it anyway)`);
    if (['close', 'stop'].includes(verb)) {
      const result = await stopManagedSession(name, { close: verb === 'close', inventory: inventory.value, native: herdr, workers, sleep, timeoutMs });
      if (json) output(result);
      else if (result.ok) stdout(`session ${name} ${verb === 'close' ? 'closed' : 'stopped'} (${result.stopped.length} agents stopped, ${result.teams_closed.length} teams closed)`);
      else output(result);
      return result.ok ? 0 : 1;
    }
    throw new NotificationError(`unknown command: session ${verb}`);
  } catch (error) {
    if (json) stdout(formatJson({ ok: false, error: error.message, resolution: error.resolution ?? resolution })); else stderr(`golem session: ${error.message}`);
    return error.exitCode === 2 || error instanceof NotificationError ? 2 : 1;
  }
}
