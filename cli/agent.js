// golem agent — the one agent toolkit (GOL-363 G9, G10, T1–T8, R5, R8, R13).
//
// This family replaces the previous per-verb top-level commands and the old
// session family with no aliases. Flag parser and help style
// follow cli/collaboration.js. The notify implementation moved over
// unchanged apart from its help wording; schedule and message stay where
// they were. Name/id resolution (T2) and scope flags (T3) build on
// lib/agent-resolve.js and lib/team-context.js.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { createGolemClient, resolveGolemDashboardBaseUrl } from '../lib/golem-client.js';
import { dashboardJsonPath, sessionsJsonPath } from '../lib/golem-home.js';
import { resolveCliSessionContext } from '../lib/cli-session-context.js';
import { formatTable } from '../lib/cli-table.js';
import {
  NotificationError,
  notificationBodyLimit,
  validateNotificationSize,
  validateNotificationText,
  validateOperationId,
  notificationExit,
  parseNotificationDuration,
  normalizeNotificationTiming,
} from '../lib/notification-contract.js';
import { roleNamesSnapshot, pushRoleBriefDirect, setSessionRole } from '../lib/session-role.js';
import { listTeams } from '../lib/team-registry.js';
import { normalizeName } from '../lib/worker-registry.js';
import * as nativeDriver from '../lib/herdr-driver.js';
import { managementRosterSnapshot } from '../lib/management-capabilities.js';
import { inspectManagedAgent, renameManagedAgent, moveManagedAgent, adoptManagedAgent } from '../lib/management-agent.js';
import { MANAGEMENT_SELECTOR_FLAGS, managementQuery, listReceipt, writeDryRun, requireManagementResolution, managedControlOptions, managementProjectInput } from '../lib/management-cli.js';
import { herdrStateFor, listHerdrAgentStates, projectHerdrSession } from '../lib/team-herdr.js';
import {
  attachWorker,
  killWorker,
  listAgentRoster,
  listWorkerViews,
  peekWorker,
  spawnWorker,
} from '../lib/worker-manager.js';

const AGENT_SCOPE_HELP = '--scope team|project|all (default team for a caller with a team, else project)';

const commands = {
  'agent list': { flags: { '--scope': 'value', '--project': 'value', '--ended': 'bool', '--json': 'bool' }, args: 0,
    help: [
      'golem agent list [--scope team|project|all] [--project <id-or-path>] [--ended] [--json]',
      '',
      'Usage: list agents: id, name, role, team, host, status, herdr state, model, delivery. One roster for managed and external agents.',
      `Scope: ${AGENT_SCOPE_HELP}. --project picks a project. --ended adds stopped and failed agents. An unbound shell lists the project scope without caller binding.`,
      'The roster comes from the dashboard; external sessions appear with host external so a lead can find peer ids for notify. Without a reachable dashboard it lists managed agents from the local registry.',
      'Receipts: --json is the stable contract. Exit codes: 0 listed, 1 operational failure, 2 invalid input/context.',
      'Examples:',
      '  golem agent list --json                    # your team, machine-readable',
      '  golem agent list --scope all --json        # every project',
    ].join('\n') },
  'agent create': { flags: { '--name': 'value', '--profile': 'value', '--team': 'value', '--project': 'value', '--json': 'bool' }, args: 1,
    help: [
      'golem agent create <role> [--name <name>] [--profile <name>] [--team <team>] [--project <id-or-path>] [--json]',
      '',
      'Usage: start a managed agent in the caller team workspace. The agent joins --team, or the callers team (the team the caller leads, else the team on the callers own agent row); an unbound shell must pass --team.',
      'Input: a role; --name pins the agent name, --profile overrides the roles model profile. With --profile, the named model profile overrides the roles default (resolution: --profile > role default > role exec).',
      'Receipts: the agent record. Exit codes: 0 created, 1 operational failure, 2 invalid input/context.',
      'Examples:',
      '  golem agent create builder --json   # create in your team, machine-readable',
    ].join('\n') },
  'agent read': { flags: { '--lines': 'value', '--project': 'value' }, args: 1,
    help: [
      'golem agent read <agent> [--lines <N>] [--project <id-or-path>]',
      '',
      'Usage: print one managed agents terminal output without attaching or sending input. <agent> is an exact session id, or a name unique in the callers team, then in the project. An ambiguous name fails and lists the candidates.',
      'Exit codes: 0 read, 1 operational failure, 2 invalid input/context.',
      'Examples:',
      '  golem agent read builder1 --lines 50   # recent output of your teams builder1',
    ].join('\n') },
  'agent attach': { flags: { '--project': 'value' }, args: 1,
    help: [
      'golem agent attach <agent> [--project <id-or-path>]',
      '',
      'Usage: attach the current terminal to a managed agents terminal. <agent> is an exact session id, or a name unique in the callers team, then in the project. An ambiguous name fails and lists the candidates.',
      'Exit codes: 0 attached, 1 operational failure, 2 invalid input/context.',
      'Examples:',
      '  golem agent attach builder1   # attach to your teams builder1',
    ].join('\n') },
  'agent stop': { flags: { '--project': 'value', '--json': 'bool' }, args: 1,
    help: [
      'golem agent stop <agent> [--project <id-or-path>] [--json]',
      '',
      'Usage: end one managed agent and verify no processes survive. The record stays, marked ended. <agent> is an exact session id, or a name unique in the callers team, then in the project. An ambiguous name fails and lists the candidates.',
      'Exit codes: 0 stopped, 1 operational failure, 2 invalid input/context.',
      'Examples:',
      '  golem agent stop builder1 --json   # machine-readable ended record',
    ].join('\n') },
  'agent notify': { flags: { '--to': 'value', '--message': 'value', '--message-file': 'value', '--ticket': 'value', '--request-id': 'value', '--after': 'value', '--every': 'value', '--json': 'bool', '--human': 'bool' }, args: 0,
    help: [
      'golem agent notify --to <id|self> (--message <text>|--message-file <path|->) [--ticket <ref>] [--request-id <uuid>] [--after <duration>] [--every <duration>] [--json] [--human]',
      '',
      'Usage: push a durable notification to one exact live agent session id, or schedule a reminder to yourself.',
      'Input: inline --message, a path via --message-file, or stdin with --message-file - (UTF-8, size-capped). --to takes an exact session id from `golem agent list`; self requires a bound session. --ticket prefixes context. Unbound mutations require --human; bound agents must not use it.',
      'Timing: without --after/--every it sends immediately. Durations use integer ms/s/m/h/d. --after schedules once; --every repeats, first due after one interval unless --after sets the first delay. Zero delay is allowed. Delivery follows runtime ticks/readiness, not an exact-time alarm. The message is captured once.',
      'Receipts: an immediate send returns a message receipt (kind "message"); a scheduled send returns a schedule receipt (kind "schedule") — save the schedule id for inspect/cancel. Exit 0: durably admitted, not work completed. Exit 1: operational failure. Exit 2: invalid input/context. Exit 3: uncertain; retry or inspect the original operation using the same request id — a fresh id is a new message.',
      'Examples:',
      '  golem agent list --json                                           # find the exact recipient id first',
      '  golem agent notify --to <session-id> --message "build done" --json # immediate peer return',
      '  golem agent notify --to self --message "check verifier return" --after 15m --json # one-shot self-reminder',
      '  golem agent notify --to self --message-file ./notes.txt --every 1h --json # recurring self-reminder',
      '  golem agent notify --to <session-id> --message-file - --json      # read the text from stdin',
      '  <lost response? retry unchanged with the same --request-id>; then `golem message inspect <message-id> --json`',
    ].join('\n') },
  'agent role': { flags: { '--json': 'bool' }, args: 1,
    help: [
      'golem agent role <role|clear> [<agent>] [--json]',
      '',
      'Usage: set or clear an agents role. <agent> is an exact session id; without it, the bound callers own session. An unbound shell must pass <agent>.',
      'Exit codes: 0 set, 1 operational failure, 2 invalid input/context.',
      'Examples:',
      '  golem agent role builder            # take the builder role yourself',
      '  golem agent role clear <session-id> # clear another agents role',
    ].join('\n') },
  'agent dedup': { flags: { '--apply': 'bool' }, args: 0,
    help: [
      'golem agent dedup [--apply]',
      '',
      'Usage: dry-run named-session duplicate cleanup; --apply marks stale duplicate rows ended.',
      'Input: none. Groups rows in sessions.json by non-empty name within the same project path, keeps the freshest live row, and with --apply marks other un-ended rows ended. Exit codes: 0 done, 1 operational failure, 2 invalid input/context.',
      'Examples:',
      '  golem agent dedup --apply   # write the cleanup',
    ].join('\n') },
};

for (const [verb, count, flags, description] of [
  ['inspect', 1, {}, 'Read known identity, canonical membership, actual placement/model evidence and control capabilities; no writes.'],
  ['rename', 2, {}, 'Change managed logical name and pane display label; stable native handle/identity/membership remain. Display failure is partial and retryable.'],
  ['move', 1, { '--workspace': 'value' }, 'Move within the same native session to an exact workspace; consume returned placement IDs and preserve logical membership. Cross-server unsupported.'],
  ['adopt', 1, { '--pane': 'value' }, 'Adopt a registered conversation into --team using demonstrably matching native session/process identity. No restart, role assignment or physical move.'],
]) commands[`agent ${verb}`] = { args: count, flags, help: `golem agent ${verb} <agent>${verb === 'rename' ? ' <name>' : verb === 'move' ? ' --workspace ID' : verb === 'adopt' ? ' --team T [--pane ID]' : ''} [--json]\n\n${description}\nExit0 completed/no-op, exit2 invalid scope, exit1 runtime/partial failure.` };
const managementVerbs = new Set(['agent list', 'agent create', 'agent read', 'agent attach', 'agent stop', 'agent role', 'agent inspect', 'agent rename', 'agent move', 'agent adopt']);
for (const key of managementVerbs) {
  Object.assign(commands[key].flags, MANAGEMENT_SELECTOR_FLAGS, { '--json': 'bool' });
  if (['agent create', 'agent attach', 'agent stop', 'agent role', 'agent rename', 'agent move', 'agent adopt'].includes(key)) commands[key].flags['--dry-run'] = 'bool';
  commands[key].help += '\nSelectors: --project P --team T --session S --caller ID. Management mutations accept --dry-run.';
}
commands['agent list'].help += '\nJSON: {schema_version:2,items:[...],resolution:{...}}. Scripts read .items.';

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
      if (token !== '--message' && args[i].startsWith('--')) throw new NotificationError(`${token} requires a value`);
      options[token] = args[i];
    }
  }
  if (options.help) return { help: command.help, options };
  if (key === 'agent role') {
    if (positional.length < 1 || positional.length > 2) throw new NotificationError(command.help.split('\n')[0]);
    return { key, options, positional };
  }
  if (positional.length !== command.args) throw new NotificationError(command.help.split('\n')[0]);
  return { key, options, positional };
}

// --- caller + project plumbing (tolerant: an unbound shell yields null) ------

function callerSession(resolveContext) {
  try {
    return resolveContext() ?? null;
  } catch {
    return null;
  }
}

// --- agent list table (G9/R5/R8 columns) --------------------------------------

const AGENT_TABLE_COLUMNS = [
  { key: 'session_id', label: 'ID', max: 40 },
  { key: 'name', label: 'NAME', max: 20 },
  { key: 'role', label: 'ROLE', max: 16 },
  { key: 'team', label: 'TEAM', max: 20 },
  { key: 'host', label: 'HOST', max: 8 },
  { key: 'status', label: 'STATUS', max: 12 },
  { key: 'herdr_state', label: 'HERDR STATE', max: 12 },
  { key: 'model', label: 'MODEL', max: 28 },
  { key: 'delivery', label: 'DELIVERY', max: 12 },
];

function formatAgentTable(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return 'No agents.';
  return formatTable(AGENT_TABLE_COLUMNS, list);
}

/**
 * Build the agent list rows from enriched roster entries (G9): managed rows
 * carry worker identity, external rows carry the roster session. Both shapes
 * converge on the same --json contract.
 */
export function buildRosterRows(entries, { teams = [] } = {}) {
  const slugFor = (teamId) => (Array.isArray(teams) ? teams : []).find((team) => team?.team_id === teamId)?.slug ?? null;
  const labelFor = (teamId) => (Array.isArray(teams) ? teams : []).find((team) => team?.team_id === teamId)?.label ?? null;
  return (Array.isArray(entries) ? entries : []).map((row) => {
    const managed = row?.worker != null;
    const teamId = row?.team_id ?? null;
    const deliveryReady = row?.delivery_ready ?? row?.dispatchable ?? false;
    return {
      session_id: row?.session_id ?? null,
      name: row?.worker_name ?? row?.name ?? row?.label ?? null,
      role: row?.worker_role ?? row?.role ?? null,
      team_id: teamId,
      team: slugFor(teamId),
      team_label: labelFor(teamId) ?? row?.team_label ?? null,
      host: row?.host ?? (managed ? 'legacy' : 'external'),
      state: row?.worker_state ?? null,
      status: row?.status ?? row?.worker_state ?? null,
      herdr_state: row?.herdr_state ?? null,
      model: row?.worker_model ?? row?.model ?? null,
      provider: row?.provider ?? null,
      dispatchable: deliveryReady,
      delivery: deliveryReady ? 'ready' : (row?.delivery_reason || 'not ready'),
      idle_seconds: row?.idle_seconds ?? null,
      capabilities: row?.capabilities ?? null,
      placement: row?.placement ?? null,
      control_provenance: row?.control_provenance ?? null,
      attach_hint: row?.attach_hint ?? null,
    };
  });
}

/**
 * Build the agent list rows (G9): registry views joined with team labels,
 * host placement and one best-effort herdr-state fetch per project session.
 */
export function buildAgentRows(views, { teams = [], herdrStates = new Map() } = {}) {
  const slugFor = (teamId) => (Array.isArray(teams) ? teams : []).find((team) => team?.team_id === teamId)?.slug ?? null;
  const labelFor = (teamId) => (Array.isArray(teams) ? teams : []).find((team) => team?.team_id === teamId)?.label ?? null;
  return (Array.isArray(views) ? views : []).map((view) => {
    const states = herdrStates instanceof Map ? herdrStates : new Map();
    return {
      session_id: view.session_id ?? null,
      name: view.name,
      role: view.role,
      team_id: view.team_id ?? null,
      team: slugFor(view.team_id),
      team_label: labelFor(view.team_id),
      // Transitional host value: herdr placement ids mean herdr, older rows
      // still carry the pre-cutover host GOL-370 is removing. Converges to
      // herdr|external once the cutover lands.
      host: view.herdr_session || view.herdr_workspace_id ? 'herdr' : 'legacy',
      state: view.state,
      status: view.status,
      herdr_state: herdrStateFor(states, view),
      model: view.model ?? null,
      provider: view.provider ?? null,
      dispatchable: view.dispatchable,
      delivery: view.dispatchable ? 'ready' : 'not ready',
      idle_seconds: view.idle_seconds ?? null,
      capabilities: view.capabilities ?? null,
      placement: view.placement ?? null,
    };
  });
}

// --- sessions-registry mechanics (moved from the old agent-less verbs) --------

function readSessionsRegistry() {
  try {
    const parsed = JSON.parse(readFileSync(sessionsJsonPath(), 'utf8'));
    return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

function readSessionsRegistryObject(file = sessionsJsonPath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.sessions) ? parsed : { version: 1, sessions: [] };
  } catch {
    return { version: 1, sessions: [] };
  }
}

function writeSessionsRegistryObject(file, reg) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  renameSync(tmp, file);
}

function withFileLock(lockPath, fn) {
  try { mkdirSync(dirname(lockPath), { recursive: true }); } catch { /* ignore */ }
  for (let i = 0; i < 50; i++) {
    try {
      mkdirSync(lockPath);
      try { return fn(); }
      finally { try { rmdirSync(lockPath); } catch { /* ignore */ } }
    } catch (e) {
      if (e?.code === 'EEXIST') {
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs > 5000) rmdirSync(lockPath);
        } catch { /* ignore */ }
        const wait = Date.now() + 20;
        while (Date.now() < wait) { /* brief spin */ }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`failed to acquire ${lockPath}`);
}

function rowTime(row, keys) {
  for (const key of keys) {
    const t = Date.parse(row?.[key] || '');
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function isLiveSessionRow(row) {
  return !row?.ended_at;
}

function rowFreshness(row, alive) {
  return alive
    ? rowTime(row, ['updated_at', 'last_seen_at', 'boot_time', 'started_at'])
    : rowTime(row, ['ended_at', 'updated_at', 'last_seen_at', 'boot_time', 'started_at']);
}

function sessionLabel(row) {
  return `${row.session_id || '(no session_id)'}${row.model ? ` (model=${row.model})` : ''}`;
}

function keptSessionLabel(row, reason) {
  return `${row.session_id || '(no session_id)'} (${reason}${row.model ? `, model=${row.model}` : ''})`;
}

function sessionProjectScope(row) {
  return row?.project_path || row?.project_id || row?.cwd || '';
}

function sessionsDedupPlan(sessions) {
  const groups = new Map();
  sessions.forEach((row, index) => {
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    if (!name) return;
    const key = `${sessionProjectScope(row)}\0${name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, index });
  });
  const plans = [];
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    const name = key.split('\0').slice(1).join('\0') || key;
    const live = rows.filter(({ row }) => isLiveSessionRow(row));
    const candidates = live.length ? live : rows;
    const keep = candidates
      .slice()
      .sort((a, b) => rowFreshness(b.row, live.length > 0) - rowFreshness(a.row, live.length > 0))[0];
    const mark = rows.filter((entry) => entry.index !== keep.index && !entry.row.ended_at);
    plans.push({ kind: 'named', name, keep, mark, liveKept: live.length > 0 });
  }
  return plans;
}

function printSessionsDedupPlan(plans, apply, stdout) {
  if (!plans.length) {
    stdout(`golem agent dedup: no project-scoped named duplicates found (${apply ? 'applied' : 'dry-run'})`);
    return;
  }
  stdout(`golem agent dedup ${apply ? '--apply' : '(dry-run; pass --apply to write)'}`);
  for (const plan of plans) {
    const reason = plan.liveKept ? 'freshest live' : 'freshest ended';
    const scope = sessionProjectScope(plan.keep.row) || '(no project)';
    stdout(`name ${plan.name} @ ${scope}: would keep ${keptSessionLabel(plan.keep.row, reason)}`);
    if (plan.mark.length) {
      stdout(`name ${plan.name} @ ${scope}: would mark ended: ${plan.mark.map(({ row }) => sessionLabel(row)).join(', ')}`);
    } else {
      stdout(`name ${plan.name} @ ${scope}: no un-ended duplicates to mark`);
    }
  }
}

function resolveSessionArg(value, sessions) {
  if (!value) return null;
  const exact = sessions.find((s) => s.session_id === value || s.name === value);
  if (exact) return exact;
  const pref = sessions.filter((s) => typeof s.session_id === 'string' && s.session_id.startsWith(value));
  if (pref.length === 1) return pref[0];
  if (pref.length > 1) {
    throw new Error(`ambiguous session prefix "${value}" (${pref.length} matches)`);
  }
  throw new Error(`session not found: ${value}`);
}

function liveSessionLines(sessions) {
  return sessions
    .slice()
    .sort((a, b) => String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')))
    .map((s) => `  ${s.session_id}${s.name ? `  ${s.name}` : ''}${s.project_path ? `  ${s.project_path}` : ''}`);
}

// --- notify (moved unchanged from session notify apart from help wording) ----

async function readText(file, stdin) {
  const stream = file === '-' ? stdin : fs.createReadStream(file);
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > notificationBodyLimit) throw new NotificationError(`message input exceeds ${notificationBodyLimit} bytes`, 'NOTIFICATION_TOO_LARGE', 413);
    chunks.push(bytes);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new NotificationError('message file/stdin must contain valid UTF-8 text'); }
}

async function requireProtocol(client, scheduling = false) {
  let capability;
  try { capability = await client.request('GET', '/api/messages/notify', { timeoutMs: 5000 }); }
  catch (error) {
    if (error.status === 404 || error.status === 405) throw new Error('dashboard does not support idempotent notifications; update it before sending');
    throw error;
  }
  if (capability?.notification_protocol !== 1 || capability?.idempotency !== true) throw new Error('dashboard does not support idempotent notifications; update it before sending');
  if (scheduling && capability.scheduling !== true) throw new Error('dashboard does not support scheduling; update it before sending');
}

async function runNotify(o, { stdout, stdin, context, client, operationId, onMutating }) {
  if (context && o['--human']) throw new NotificationError('bound agents cannot use --human', 'INVALID_CALLER_CONTEXT');
  if (!context && !o['--human']) throw new NotificationError('unbound mutation requires --human', 'INVALID_CALLER_CONTEXT');
  if (!o['--to'] || (o['--to'] === 'self' && !context)) throw new NotificationError('--to requires an exact id; self requires a bound session');
  if (Object.hasOwn(o, '--message') === Object.hasOwn(o, '--message-file')) throw new NotificationError('provide exactly one of --message or --message-file');
  if (o['--ticket'] !== undefined && !o['--ticket'].trim()) throw new NotificationError('--ticket requires nonblank context');
  let text;
  try { text = validateNotificationText(Object.hasOwn(o, '--message') ? o['--message'] : await readText(o['--message-file'], stdin)); }
  catch (error) { if (error instanceof NotificationError) throw error; throw new NotificationError(error.message, 'MESSAGE_INPUT_ERROR'); }
  const timing = o['--after'] !== undefined || o['--every'] !== undefined ? normalizeNotificationTiming({
    ...(o['--after'] !== undefined ? { after_ms: parseNotificationDuration(o['--after']) } : {}),
    ...(o['--every'] !== undefined ? { every_ms: parseNotificationDuration(o['--every']) } : {}),
  }) : null;
  const body = { operation_id: operationId, sender_id: context?.sessionId || 'human:cli',
    session_id: o['--to'], text, ...(context?.projectId ? { project_id: context.projectId } : {}),
    ...(o['--ticket'] ? { ticket: o['--ticket'] } : {}), ...(o['--human'] ? { human: true } : {}), ...(timing ? { timing } : {}) };
  validateNotificationSize(body);
  await requireProtocol(client, !!timing);
  onMutating();
  const result = await client.notifySession(body);
  if (result?.operation_id !== operationId || result?.receipt?.id !== operationId) throw new Error('notification response did not confirm the original operation id');
  return { operationId, result };
}

// --- verb implementations -----------------------------------------------------

async function cmdAgentList(o, { stdout, cwd, manager, query }) {
  const resolution = query.resolution;
  const scope = { projectId: resolution.project_id, teamId: resolution.team_id };
  const teams = query.evidence.teams;
  const projectInput = scope.projectId;
  // --scope project/all keep the wider scope even for a caller with a team.
  // herdr_state stays on the CLI path: one agent-list fetch per project
  // session per request (multi-project scope skips it).
  let herdrStates = new Map();
  if (scope.projectId != null) {
    try {
      herdrStates = listHerdrAgentStates(projectHerdrSession(scope.projectId));
    } catch { herdrStates = new Map(); }
  }
  const { roster, ended } = await manager.listAgentRoster({
    project: scope.projectId == null ? null : projectInput,
    projectId: scope.projectId,
    includeDead: Boolean(o['--ended']),
    cwd,
    herdrStates,
  });
  const inScope = (row) => {
    if (scope.projectId != null && row?.project_id !== scope.projectId) return false;
    if (scope.teamId == null) return true;
    const canonical = query.evidence.agents.find(a => a.session_id === row?.session_id);
    return (canonical?.team_id ?? row?.team_id) === scope.teamId;
  };
  const physical = row => !o['--session'] || (row.worker?.herdr_session ?? query.evidence.agents.find(a => a.session_id === row.session_id)?.herdr_session) === resolution.session;
  const rows = buildRosterRows(roster.filter(inScope).concat(ended.filter(inScope)).filter(physical), { teams });
  stdout(o['--json'] ? JSON.stringify(listReceipt(rows, resolution)) : formatAgentTable(rows));
}

async function cmdAgentCreate(role, o, positional, { stdout, cwd, manager, query }) {
  void positional;
  let name = null;
  if (o['--name'] != null) {
    name = String(o['--name']).trim();
    if (!name) throw new NotificationError('golem agent create --name requires a value');
  }
  let profile = null;
  if (o['--profile'] != null) {
    profile = String(o['--profile']).trim();
    if (!profile) throw new NotificationError('golem agent create --profile requires a value');
  }
  const teams = query.evidence.teams;
  const team = teams.find(t => t.team_id === query.resolution.team_id);
  const created = await manager.spawnWorker({
    role,
    name,
    project: managementProjectInput(query),
    cwd,
    profile,
    teamId: team.team_id,
    ...(o['--session'] ? { nativeSession: query.resolution.session } : {}),
  });
  const rows = buildAgentRows([created], { teams });
  stdout(o['--json'] ? JSON.stringify({ ...rows[0], resolution: query.resolution }) : formatAgentTable(rows));
}

function managedTarget(query) {
  const row = query.resolution.target;
  if (!row?.worker_id) {
    const error = new Error(`control unavailable for known agent ${row?.id}: no managed control record; inspect/adopt exact native identity`);
    error.code = 'UNAVAILABLE_CAPABILITY'; error.resolution = query.resolution; throw error;
  }
  return row;
}

function externalControl(query, operation, native) {
  const sid = query.resolution.target?.session_id ?? query.resolution.target?.id;
  const target = query.evidence.agents.find(a => a.session_id === sid);
  const row = managementRosterSnapshot([target], { snapshot: query.evidence.snapshot, facts: query.evidence.sources.facts.value ?? [], native })[0];
  if (row.capabilities[operation].state !== 'available') throw Object.assign(new Error(`known agent ${sid}: ${row.capabilities[operation].reason}`), { code: 'UNAVAILABLE_CAPABILITY', capabilities: row.capabilities });
  return row;
}
async function cmdAgentRead(ref, o, { stdout, manager, query, native }) {
  let lines = null;
  if (o['--lines'] != null) {
    lines = Number(o['--lines']);
    if (!Number.isInteger(lines) || lines < 1) throw new NotificationError('golem agent read --lines requires a positive integer');
  }
  if (!query.resolution.target?.worker_id) {
    const row = externalControl(query, 'read', native);
    const text = native.paneRead({ session: row.placement.session, paneId: row.placement.pane_id, lines });
    stdout(o['--json'] ? JSON.stringify({ text, capabilities: row.capabilities, resolution: query.resolution }) : text); return;
  }
  const row = managedTarget(query);
  const output = await manager.peekWorker(row.name, { ...managedControlOptions(query.resolution, o), lines });
  stdout(o['--json'] ? JSON.stringify({ text: output, resolution: query.resolution }) : output);
}

async function cmdAgentAttach(ref, o, { stdout, manager, query, native }) {
  if (!query.resolution.target?.worker_id) {
    const row = externalControl(query, 'attach', native);
    const status = native.agentAttach({ session: row.placement.session, agentTarget: row.placement.pane_id, outputToStderr: !!o['--json'] });
    if (o['--json']) stdout(JSON.stringify({ attached: status === 0, status, session_id: row.session_id, capabilities: row.capabilities, resolution: query.resolution }));
    return status;
  }
  const row = managedTarget(query);
  const status = await manager.attachWorker(row.name, { ...managedControlOptions(query.resolution, o), ...(o['--json'] ? { outputToStderr: true } : {}) });
  if (o['--json']) stdout(JSON.stringify({ attached: status === 0, status, session_id: row.session_id, resolution: query.resolution }));
  return status;
}

async function cmdAgentStop(ref, o, { stdout, manager, query, native }) {
  if (!query.resolution.target?.worker_id) externalControl(query, 'stop', native);
  const row = managedTarget(query);
  const stopped = await manager.killWorker(row.name, managedControlOptions(query.resolution, o));
  const rows = buildAgentRows([stopped], { teams: listTeams({ projectId: row.project_id }) });
  stdout(o['--json'] ? JSON.stringify({ ...rows[0], resolution: query.resolution }) : formatAgentTable(rows));
}

async function cmdAgentRole(roleArg, positional, o, { stdout, resolveContext }) {
  let role = roleArg;
  if (roleArg === 'list' || roleArg === '--list') {
    stdout(roleNamesSnapshot().join('\n'));
    return;
  }
  if (roleArg === 'clear') role = null;
  else if (!roleNamesSnapshot().includes(roleArg)) {
    throw new NotificationError(`invalid role: ${roleArg} (expected ${roleNamesSnapshot().join('|')} or clear)`);
  }
  const ref = positional[0] ?? null;
  const sessions = readSessionsRegistry();
  // Shared resolution supplied the exact conversation, including self.
  const target = sessions.find(s => s.session_id === ref);
  if (!target) throw new NotificationError(`session not found: ${ref}`);
  const targetId = target.session_id;
  const updated = setSessionRole(targetId, role, { by: 'human:cli' });
  const activation = role ? await pushRoleBriefDirect(updated.session_id, role, updated) : null;
  const receipt = {
    ok: true,
    session_id: updated.session_id,
    name: updated.name ?? null,
    role: updated.role,
    role_updated_at: updated.role_updated_at,
    role_updated_by: updated.role_updated_by,
    activation,
  };
  stdout(o['--json'] ? JSON.stringify(receipt) : `agent ${receipt.session_id} role ${receipt.role ?? 'cleared'}`);
}

async function cmdAgentDedup(o, { stdout }) {
  const apply = Boolean(o['--apply']);
  const file = sessionsJsonPath();
  const run = () => {
    const reg = readSessionsRegistryObject(file);
    const plans = [...sessionsDedupPlan(reg.sessions)];
    printSessionsDedupPlan(plans, apply, stdout);
    if (!apply) return;
    const now = new Date().toISOString();
    let changed = false;
    for (const plan of plans) {
      for (const { index } of plan.mark) {
        if (reg.sessions[index]?.ended_at) continue;
        reg.sessions[index] = { ...reg.sessions[index], status: 'superseded', ended_at: now };
        changed = true;
      }
    }
    if (changed) writeSessionsRegistryObject(file, reg);
    stdout(changed ? `applied: marked duplicate/stale sessions ended_at=${now}` : 'applied: no changes');
  };
  if (apply) withFileLock(`${file}.lock`, run);
  else run();
}

// --- entry point ---------------------------------------------------------------

export async function runAgent(family, args, {
  stdout = (text) => process.stdout.write(`${text}\n`),
  stderr = (text) => process.stderr.write(`${text}\n`),
  stdin = process.stdin,
  cwd = process.cwd(),
  resolveContext = resolveCliSessionContext,
  client: injectedClient,
  manager = { spawnWorker, listWorkerViews, listAgentRoster, peekWorker, attachWorker, killWorker },
  native = nativeDriver,
  ...collector
} = {}) {
  let resolution = null;
  let operationId = null;
  let mutationStarted = false;
  let json = args.includes('--json');
  const fail = (error) => {
    const refused = ['ECONNREFUSED', 'ENOTFOUND'].includes(error?.cause?.cause?.code ?? error?.cause?.code);
    const invalid = error.exitCode === 2 || error instanceof NotificationError || (error.status >= 400 && error.status < 500)
      || /unknown command|unknown option|duplicate option|requires a value|invalid scope|invalid role|agent (name is ambiguous|not found|is retired)|no team|unknown team|session not found|bound session|requires an exact id|provide exactly one/.test(error.message);
    const uncertain = mutationStarted && !invalid && !refused;
    const output = { ok: false, code: error.code || 'AGENT_FAILED', error: error.message,
      ...(operationId ? { operation_id: operationId } : {}), ...(error.capabilities ? { capabilities: error.capabilities } : {}), ...(resolution || error.resolution ? { resolution: error.resolution ?? resolution } : {}), state: uncertain ? 'uncertain' : 'rejected',
      ...(uncertain ? { next_action: 'inspect or retry the same request id; do not create a fresh message' } : {}) };
    if (json) stdout(JSON.stringify(output)); else stderr(`golem agent: ${output.error}${operationId ? ` (operation ${operationId})` : ''}`);
    return uncertain ? 3 : invalid ? 2 : 1;
  };
  try {
    const parsed = parse(family, args);
    if (parsed.options) json = Boolean(parsed.options['--json']);
    if (parsed.help) { stdout(json ? JSON.stringify({ help: parsed.help }) : parsed.help); return 0; }
    const { key, options: o, positional } = parsed;
    let query = null;
    if (key === 'agent rename') { try { normalizeName(positional[1]); } catch (error) { throw new NotificationError(error.message); } }
    if (key === 'agent create' && !roleNamesSnapshot().includes(positional[0])) throw new NotificationError(`unknown role: ${positional[0]}`);
    if (key === 'agent role' && ![...roleNamesSnapshot(), 'clear', 'list'].includes(positional[0])) throw new NotificationError(`invalid role: ${positional[0]}`);
    if (managementVerbs.has(key) && !(key === 'agent role' && positional[0] === 'list')) {
      if (o['--scope'] && !['team', 'project', 'all'].includes(o['--scope'])) throw new NotificationError(`invalid scope: ${o['--scope']}`);
      query = await managementQuery({ operation: key, kind: 'agent', options: o,
        target: ['agent read', 'agent attach', 'agent stop', 'agent inspect', 'agent rename', 'agent move', 'agent adopt'].includes(key) ? positional[0] : key === 'agent role' ? positional[1] ?? 'self' : null,
        requiresTeam: ['agent create', 'agent adopt'].includes(key), cwd, resolveContext, ...collector });
      resolution = query.resolution;
      if (key === 'agent move' && !o['--workspace']) { resolution.ok = false; resolution.missing.push({ field: 'workspace', message: 'agent move requires --workspace <exact-id>' }); }
      if (key === 'agent adopt' && !o['--team']) { resolution.ok = false; resolution.missing.push({ field: 'team', message: 'agent adopt requires --team <exact-id>' }); }
      const dry = writeDryRun(query, o, stdout, { ...(key === 'agent create' ? { role: positional[0], name: o['--name'] ?? null, profile: o['--profile'] ?? null } : {}), ...(key === 'agent rename' ? { name: positional[1] } : {}), ...(o['--workspace'] ? { workspace_id: o['--workspace'] } : {}), ...(o['--pane'] ? { pane_id: o['--pane'] } : {}) });
      if (dry != null) return dry;
      requireManagementResolution(resolution);
    }
    if (['agent inspect', 'agent rename', 'agent move', 'agent adopt'].includes(key)) {
      const result = key === 'agent inspect' ? inspectManagedAgent(query, { native })
        : key === 'agent rename' ? renameManagedAgent(query, positional[1], { native })
        : key === 'agent move' ? moveManagedAgent(query, o['--workspace'], { native, session: o['--session'] ?? null })
        : adoptManagedAgent(query, { native, paneId: o['--pane'] ?? null });
      stdout(json ? JSON.stringify({ ...result, resolution }) : result.error ?? `agent ${result.name ?? result.logical_name ?? resolution.target.id} ${key.split(' ')[1]}${result.noop ? ' (no-op)' : ''}`);
      return result.ok === false ? 1 : 0;
    }
    if (key === 'agent list') {
      await cmdAgentList(o, { stdout, cwd, manager, query });
      return 0;
    }
    if (key === 'agent create') {
      await cmdAgentCreate(positional[0], o, positional, { stdout, cwd, manager, query });
      return 0;
    }
    if (key === 'agent read') {
      await cmdAgentRead(positional[0], o, { stdout, manager, query, native });
      return 0;
    }
    if (key === 'agent attach') {
      const status = await cmdAgentAttach(positional[0], o, { stdout, manager, query, native });
      return status ?? 0;
    }
    if (key === 'agent stop') {
      await cmdAgentStop(positional[0], o, { stdout, manager, query, native });
      return 0;
    }
    if (key === 'agent role') {
      const roleOut = text => stdout(o['--json'] && resolution ? JSON.stringify({ ...JSON.parse(text), resolution }) : text);
      await cmdAgentRole(positional[0], [resolution?.target?.session_id ?? resolution?.target?.id], o, { stdout: roleOut, resolveContext });
      return 0;
    }
    if (key === 'agent dedup') {
      await cmdAgentDedup(o, { stdout });
      return 0;
    }
    if (key === 'agent notify') {
      const context = callerSession(resolveContext);
      const client = injectedClient ?? createGolemClient({ baseUrl: resolveGolemDashboardBaseUrl({ dashboardFile: dashboardJsonPath() }), callerSessionId: context?.sessionId });
      operationId = validateOperationId(o['--request-id'] ?? crypto.randomUUID());
      const { result } = await runNotify(o, {
        stdout, stdin, context, client, operationId,
        onMutating: () => { mutationStarted = true; },
      });
      const exit = notificationExit(result.receipt);
      stdout(json ? JSON.stringify(result.receipt) : `${result.receipt.kind} ${operationId}: ${result.receipt.state}${result.receipt.reason ? ` — ${result.receipt.reason}` : ''}`);
      return exit;
    }
    throw new NotificationError(`unknown command: ${key}`);
  } catch (error) {
    return fail(error);
  }
}
