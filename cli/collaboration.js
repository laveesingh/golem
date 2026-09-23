import { createGolemClient, resolveGolemDashboardBaseUrl } from '../lib/golem-client.js';
import { dashboardJsonPath } from '../lib/golem-home.js';
import { resolveCliSessionContext } from '../lib/cli-session-context.js';
import { NotificationError, validateOperationId, notificationExit } from '../lib/notification-contract.js';

const commands = {
  'schedule list': { flags: { '--all': 'bool', '--json': 'bool' }, args: 0,
    help: [
      'golem schedule list [--all] [--json]',
      '',
      'Usage: list your durable schedules. --all (or an unbound human view) includes schedules created by other local sessions.',
      'Input: none. Timing: lists what is stored now; delivery follows runtime ticks, not this command.',
      'Receipts: prints schedule ids; those differ from message ids. Exit codes: 0 listed, 1 operational failure, 2 invalid input/context.',
      'Examples:',
      '  golem schedule list --json                  # all schedules you created, machine-readable',
      '  golem schedule inspect <schedule-id> --json # details for one id (see Examples below for where ids come from)',
    ].join('\n') },
  'schedule inspect': { flags: { '--content': 'bool', '--json': 'bool' }, args: 1,
    help: [
      'golem schedule inspect <schedule-id> [--content] [--json]',
      '',
      'Usage: inspect cadence, occurrence delivery, and (with --content) the stored text of one schedule.',
      'Input: the schedule id as returned by `golem agent notify ... --every/--after` (its receipt is kind "schedule"; save it).',
      'Timing: inspect before and after cancelling; content is opt-in.',
      'Receipts: shows whether occurrences were delivered; settlement is not task completion.',
      'Examples:',
      '  golem schedule inspect <schedule-id>           # cadence + delivery state',
      '  golem schedule inspect <schedule-id> --content # also the stored message text',
      'Exit codes: 0 inspected, 1 operational failure, 2 unknown id/invalid input, 3 uncertain — inspect the original operation.',
    ].join('\n') },
  'schedule cancel': { flags: { '--human': 'bool', '--json': 'bool' }, args: 1,
    help: [
      'golem schedule cancel <schedule-id> [--human] [--json]',
      '',
      'Usage: stop future emission and retries of one schedule.',
      'Input: the schedule id; creators cancel their own schedules, and explicit unbound human mode can cancel any. An in-flight occurrence may still arrive — cancelling does not recall its task.',
      'Timing: effective immediately for future occurrences; an already-admitted occurrence is not affected.',
      'Receipts: the cancelled schedule record. Exit codes: 0 cancelled, 1 operational failure, 2 invalid input/context (e.g. missing --human when unbound), 3 uncertain — inspect with `golem schedule inspect <schedule-id> --json` before repeating.',
      'Examples:',
      '  golem schedule cancel <schedule-id>          # as the bound creator',
      '  golem schedule cancel <schedule-id> --human  # only for an explicitly unbound human shell',
    ].join('\n') },
  'message inspect': { flags: { '--content': 'bool', '--json': 'bool' }, args: 1,
    help: [
      'golem message inspect <message-id> [--content] [--json]',
      '',
      'Usage: inspect durable delivery metadata for one message id; --content adds the stored text.',
      'Input: the message id from a notify receipt (kind "message"); schedule receipts belong to `golem schedule inspect`.',
      'Receipts: shows delivery/settlement state; settlement does not mean task completion.',
      'Examples:',
      '  golem message inspect <message-id> --json # machine-readable delivery metadata',
      'Exit codes: 0 inspected, 1 operational failure, 2 unknown id/invalid input, 3 uncertain — inspect the original operation.',
    ].join('\n') },
};
function parse(family, args) {
  if (!args.length || ['--help', '-h', 'help'].includes(args[0])) return { help: Object.entries(commands).filter(([key]) => key.startsWith(`${family} `)).map(([, value]) => value.help).join('\n\n') };
  const key = `${family} ${args[0]}`, command = commands[key];
  if (!command) throw new NotificationError(`unknown command: ${key}`);
  const options = {}, positional = [];
  for (let i = 1; i < args.length; i++) {
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
  if (positional.length !== command.args) throw new NotificationError(command.help.split('\n')[0]);
  return { key, options, positional };
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
export async function runCollaboration(family, args, {
  stdout = (text) => process.stdout.write(`${text}\n`), stderr = (text) => process.stderr.write(`${text}\n`),
  stdin = process.stdin, cwd = process.cwd(), resolveContext = resolveCliSessionContext, client: injectedClient,
} = {}) {
  let operationId = null, mutationStarted = false;
  let json = args.includes('--json');
  try {
    const parsed = parse(family, args);
    if (parsed.options) json = Boolean(parsed.options['--json']);
    if (parsed.help) { stdout(json ? JSON.stringify({ help: parsed.help }) : parsed.help); return 0; }
    const { key, options: o, positional } = parsed;
    const context = resolveContext();
    const client = injectedClient ?? createGolemClient({ baseUrl: resolveGolemDashboardBaseUrl({ dashboardFile: dashboardJsonPath() }), callerSessionId: context?.sessionId });
    if (key === 'schedule list' || key === 'schedule inspect') {
      const value = await client.request('GET', key === 'schedule list' ? '/api/schedules' : `/api/schedules/${encodeURIComponent(positional[0])}`,
        { timeoutMs: 5000, params: { ...(o['--all'] ? { all: '1' } : {}), ...(o['--content'] ? { content: '1' } : {}) } });
      if (key === 'schedule inspect') {
        notificationExit(value);
        if (value.kind !== 'schedule' || value.id !== positional[0]) throw new Error('inspection returned a different schedule');
      } else if (!Array.isArray(value)) throw new Error('invalid schedule-list response');
      stdout(JSON.stringify(value, null, json ? 0 : 2)); return 0;
    }
    if (key === 'schedule cancel') {
      operationId = validateOperationId(positional[0]);
      if (context && o['--human']) throw new NotificationError('bound agents cannot use --human', 'INVALID_CALLER_CONTEXT');
      if (!context && !o['--human']) throw new NotificationError('unbound cancellation requires --human', 'INVALID_CALLER_CONTEXT');
      await requireProtocol(client, true);
      mutationStarted = true;
      const receipt = await client.request('POST', `/api/schedules/${operationId}/cancel`, { timeoutMs: 40000, body: { human: !!o['--human'] } });
      if (receipt?.kind !== 'schedule' || receipt.id !== operationId || receipt.state !== 'cancelled') throw new Error('cancellation outcome was not confirmed');
      stdout(JSON.stringify(receipt, null, json ? 0 : 2)); return 0;
    }
    if (key === 'message inspect') {
      const receipt = await client.request('GET', `/api/message-envelopes/${encodeURIComponent(positional[0])}`, { params: { view: 'receipt', ...(o['--content'] ? { content: '1' } : {}) } });
      notificationExit(receipt);
      if (receipt.kind !== 'message' || receipt.id !== positional[0]) throw new Error('inspection returned a different message id');
      stdout(JSON.stringify(receipt, null, json ? 0 : 2)); return 0;
    }
  } catch (error) {
    const refused = ['ECONNREFUSED', 'ENOTFOUND'].includes(error?.cause?.cause?.code ?? error?.cause?.code);
    const invalid = error instanceof NotificationError || (error.status >= 400 && error.status < 500);
    const uncertain = mutationStarted && !invalid && !refused;
    const output = { ok: false, code: error.code || 'COLLABORATION_FAILED', error: error.message,
      ...(operationId ? { operation_id: operationId } : {}), state: uncertain ? 'uncertain' : 'rejected',
      ...(uncertain ? { next_action: family === 'schedule' ? 'inspect the schedule or repeat cancellation; do not assume an occurrence was recalled' : 'inspect or retry the same request id; do not create a fresh message' } : {}) };
    if (json) stdout(JSON.stringify(output)); else stderr(`${output.error}${operationId ? ` (operation ${operationId})` : ''}`);
    return uncertain ? 3 : invalid ? 2 : 1;
  }
}
