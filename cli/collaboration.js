import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createGolemClient, resolveGolemDashboardBaseUrl } from '../lib/golem-client.js';
import { dashboardJsonPath } from '../lib/golem-home.js';
import { resolveCliSessionContext } from '../lib/cli-session-context.js';
import { projectIdFor, resolveProjectRoot } from '../lib/project-id.js';
import { NotificationError, notificationBodyLimit, validateNotificationSize, validateNotificationText, validateOperationId, notificationExit } from '../lib/notification-contract.js';

const commands = {
  'session list': { flags: { '--project': 'value', '--all': 'bool', '--json': 'bool' }, args: 0,
    help: 'golem session list [--project <id-or-path>] [--all] [--json]\nList live canonical session ids, status and delivery readiness; defaults to the caller project.' },
  'session notify': { flags: { '--to': 'value', '--message': 'value', '--message-file': 'value', '--ticket': 'value', '--request-id': 'value', '--json': 'bool', '--human': 'bool' }, args: 0,
    help: 'golem session notify --to <id|self> (--message <text>|--message-file <path|->) [--ticket <ref>] [--request-id <uuid>] [--json] [--human]\nFile - reads stdin. The message is captured once. Reuse the request id after response loss; a fresh id is a new message. Unbound mutations require --human; bound agents must not use it.\nExit 0: durably admitted, not work completed. Exit 1: operational failure. Exit 2: invalid input/context. Exit 3: uncertain; inspect the original operation.' },
  'message inspect': { flags: { '--content': 'bool', '--json': 'bool' }, args: 1,
    help: 'golem message inspect <message-id> [--content] [--json]\nInspect durable delivery metadata. Content is opt-in; settlement does not mean task completion.' },
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
async function readText(file, stdin) {
  const stream = file === '-' ? stdin : fs.createReadStream(file);
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > notificationBodyLimit) throw new NotificationError(`message input exceeds ${notificationBodyLimit} bytes`, 'NOTIFICATION_TOO_LARGE', 413);
    chunks.push(bytes);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new NotificationError('message file/stdin must contain valid UTF-8 text'); }
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
    if (key === 'session list') {
      if (o['--all'] && o['--project']) throw new NotificationError('--all and --project are mutually exclusive');
      const explicit = o['--project'];
      const project = o['--all'] ? null : explicit
        ? (/^[\w-]+-[a-f0-9]{6}$/.test(explicit) ? explicit : projectIdFor(await resolveProjectRoot(path.resolve(cwd, explicit))))
        : context?.projectId || projectIdFor(await resolveProjectRoot(context?.projectPath || cwd));
      const rows = await client.request('GET', '/api/native-sessions');
      if (!Array.isArray(rows)) throw new Error('invalid session-list response');
      const items = rows.filter((row) => row.alive === true && (!project || row.project_id === project)).map((row) => ({
        session_id: row.session_id, name: row.name || row.label || null, project_id: row.project_id,
        alive: row.alive, status: row.status, harness: row.harness, role: row.role,
        delivery_ready: row.delivery_ready, reason: row.delivery_reason,
      }));
      stdout(json ? JSON.stringify(items) : items.map((row) => `${row.session_id}\t${JSON.stringify(row.name)}\t${row.status}\t${row.delivery_ready ? 'ready' : row.reason || 'not ready'}`).join('\n'));
      return 0;
    }
    if (key === 'message inspect') {
      const receipt = await client.request('GET', `/api/message-envelopes/${encodeURIComponent(positional[0])}`, { params: { view: 'receipt', ...(o['--content'] ? { content: '1' } : {}) } });
      notificationExit(receipt);
      if (receipt.id !== positional[0]) throw new Error('inspection returned a different message id');
      stdout(JSON.stringify(receipt, null, json ? 0 : 2)); return 0;
    }
    operationId = validateOperationId(o['--request-id'] ?? crypto.randomUUID());
    if (context && o['--human']) throw new NotificationError('bound agents cannot use --human', 'INVALID_CALLER_CONTEXT');
    if (!context && !o['--human']) throw new NotificationError('unbound mutation requires --human', 'INVALID_CALLER_CONTEXT');
    if (!o['--to'] || (o['--to'] === 'self' && !context)) throw new NotificationError('--to requires an exact id; self requires a bound session');
    if (Object.hasOwn(o, '--message') === Object.hasOwn(o, '--message-file')) throw new NotificationError('provide exactly one of --message or --message-file');
    if (o['--ticket'] !== undefined && !o['--ticket'].trim()) throw new NotificationError('--ticket requires nonblank context');
    let text;
    try { text = validateNotificationText(Object.hasOwn(o, '--message') ? o['--message'] : await readText(o['--message-file'], stdin)); }
    catch (error) { if (error instanceof NotificationError) throw error; throw new NotificationError(error.message, 'MESSAGE_INPUT_ERROR'); }
    const body = { operation_id: operationId, sender_id: context?.sessionId || 'human:cli',
      session_id: o['--to'], text, ...(context?.projectId ? { project_id: context.projectId } : {}),
      ...(o['--ticket'] ? { ticket: o['--ticket'] } : {}), ...(o['--human'] ? { human: true } : {}) };
    validateNotificationSize(body);
    let capability;
    try { capability = await client.request('GET', '/api/messages/notify', { timeoutMs: 5000 }); }
    catch (error) {
      if (error.status === 404 || error.status === 405) throw new Error('dashboard does not support idempotent notifications; update it before sending');
      throw error;
    }
    if (capability?.notification_protocol !== 1 || capability?.idempotency !== true) throw new Error('dashboard does not support idempotent notifications; update it before sending');
    mutationStarted = true;
    const result = await client.notifySession(body);
    if (result?.operation_id !== operationId || result?.receipt?.id !== operationId) throw new Error('notification response did not confirm the original operation id');
    const exit = notificationExit(result.receipt);
    stdout(json ? JSON.stringify(result.receipt) : `message ${operationId}: ${result.receipt.state}${result.receipt.reason ? ` — ${result.receipt.reason}` : ''}`);
    return exit;
  } catch (error) {
    const refused = ['ECONNREFUSED', 'ENOTFOUND'].includes(error?.cause?.cause?.code ?? error?.cause?.code);
    const invalid = error instanceof NotificationError || (error.status >= 400 && error.status < 500);
    const uncertain = mutationStarted && !invalid && !refused;
    const output = { ok: false, code: error.code || 'COLLABORATION_FAILED', error: error.message,
      ...(operationId ? { operation_id: operationId } : {}), state: uncertain ? 'uncertain' : 'rejected',
      ...(uncertain ? { next_action: 'inspect or retry the same request id; do not create a fresh message' } : {}) };
    if (json) stdout(JSON.stringify(output)); else stderr(`${output.error}${operationId ? ` (operation ${operationId})` : ''}`);
    return uncertain ? 3 : invalid ? 2 : 1;
  }
}
