// golem ticket — the flat agent authoring family (GOL-326 D5, GOL-344).
//
// One durable grammar: `golem ticket <operation> [args] [flags]`. Flat
// kebab-case operation names, AWS-CLI style; resource nouns never create a
// nested command layer. Large payloads travel through --body-file /
// --operations-file / --message-file with a path or `-` for stdin — complete
// bodies never belong in shell arguments.
//
// Caller binding: mutations resolve the same trusted CLI session context as
// unsupported-caller result naming their compatibility limits; model-supplied
// author/actor ids are never accepted. Unbound human shells must pass --human.
//
// Output contract: stdout carries only result JSON (compact); diagnostics go
// to stderr; failures exit non-zero with the server's machine-readable error
// payload (code plus current revision/outline when relevant) on stdout.
import fs from 'node:fs';
import path from 'node:path';
import { createGolemClient, resolveGolemDashboardBaseUrl } from '../lib/golem-client.js';
import { dashboardJsonPath } from '../lib/golem-home.js';
import { resolveCliSessionContext } from '../lib/cli-session-context.js';
import { projectIdFor, resolveProjectRoot } from '../lib/project-id.js';
import { NotificationError } from '../lib/notification-contract.js';

const OPS = {
  'list': { args: 0, mutation: false,
    help: `golem ticket list [--project <id-or-path>] [--kind spec|task|doc] [--state <state>] [--assignee <id>] [--parent <id>]

Usage: list tickets, most recently updated first.
Input: defaults to the caller's project; --project takes a contract id or a project path.
Output: JSON array of compact ticket summaries (id, display_id, title, kind,
state, assignee, body_format, body_revision) — no body echo; golem ticket get
is the deliberate full-body read.
Examples:
  golem ticket list --project golem-38ab8a --kind spec --json
  golem ticket list --kind task --state todo --json` },
  'get': { args: 1, mutation: false,
    help: `golem ticket get <ticket-id>

Usage: read one ticket: full canonical body, body_format and body_revision.
Input: the ticket id (display id or canonical id).
Output: full ticket JSON with comments, children and event history.
Examples:
  golem ticket get GOL-326 --json` },
  'create': { args: 0, mutation: true,
    help: `golem ticket create --project <id-or-path> --title <title> [--kind spec|task|doc] [--body-format markdown|html] [--body-file <path|->] [--parent <id>] [--assignee <id>]

Usage: create a ticket. HTML bodies are spec-only; the server sanitizes, assigns
stable block ids and returns the normalized outline.
Input: --body-file takes a path or - for stdin; complete bodies never belong in
shell arguments.
Output: compact ticket summary with body_format and body_revision — for html
also the normalized outline with assigned block ids. The body never echoes
back; golem ticket get is the deliberate full-body read.
Examples:
  golem ticket create --project golem-38ab8a --kind spec --title "Spec" --body-format html --body-file spec.html --json
  golem ticket create --project . --title "Task" --body-file - --json < body.md` },
  'update': { args: 1, mutation: true,
    help: `golem ticket update <ticket-id> [--state <state>] [--title <t>] [--priority <p>] [--assignee <id>] [--parent <id>] [--labels a,b]

Usage: metadata or state update. Never touches the body — body edits go through
replace-body or patch-blocks.
Output: compact ticket summary (no body echo).
Examples:
  golem ticket update GOL-326 --state review --json` },
  'replace-body': { args: 1, mutation: true,
    help: `golem ticket replace-body <ticket-id> --body-file <path|-> [--body-format markdown|html] --expected-revision <n>

Usage: the deliberate full-rewrite escape hatch — initial format conversion,
recovery, or a human-directed complete rewrite. Not the routine edit path:
agents fold agreed changes through patch-blocks instead.
Input: --body-file path or -; --body-format is required for the first html
conversion of a non-empty markdown spec; --expected-revision is required for
every html write and for any format change.
Output: compact ticket summary — for html also the normalized outline. The body
never echoes back.
Examples:
  golem ticket replace-body GOL-326 --body-format html --body-file body.html --expected-revision 7 --json` },
  'get-outline': { args: 1, mutation: false,
    help: `golem ticket get-outline <ticket-id>

Usage: ordered block outline of a spec: kinds, headings, sections, short
texts (plus block ids/hashes/comment counts for html). Orient here before
each edit cluster.
Output: { ticket_id, body_revision, blocks: [...] }.
Examples:
  golem ticket get-outline GOL-326 --json` },
  'get-block': { args: 1, minArgs: 1, maxArgs: 2, mutation: false,
    help: `golem ticket get-block <ticket-id> <block-id>
golem ticket get-block <ticket-id> --anchor <text> [--prefix <t>] [--suffix <t>] [--section]

Usage: read one canonical block (html: outer html, hash, anchored comments,
child blocks) or, with --anchor, the block whose text matches (both formats).
--section returns the whole section under a heading anchor. Read only the
blocks a decision touches.
Output: { block_id/html, ... } for html; { kind, section, source, ... } for markdown.
Examples:
  golem ticket get-block GOL-326 b-1a2b3c4d5e6f --json
  golem ticket get-block GOL-400 --anchor '### Data flow' --json
  golem ticket get-block GOL-400 --anchor '### Data flow' --section --json` },
  'patch-blocks': { args: 1, mutation: true,
    help: `golem ticket patch-blocks <ticket-id> --expected-revision <n> --op <op> [--anchor <text> | --block-id <id>] [--prefix <t>] [--suffix <t>] [--to-anchor <text> | --anchor-block-id <id>] [--old <text>] [--json] < content
       --operations-file <path|-> for a batch (mutually exclusive with --op)

Usage: one edit, one call, no file, no JSON. The op and anchor ride on flags;
raw content (or the edit's new text) arrives on stdin through a quoted
heredoc. Markdown bodies target by anchor; html also takes --block-id.
Input: stdin is read only for ops with a payload (replace, insert_before,
insert_after, edit, replace_section, append_to_section). remove and move_*
never read stdin, so they cannot hang. One final heredoc newline is stripped;
nothing else is touched.
Output: { body_revision, inserted, removed, detached, outline } — plus
mermaid_errors when a changed diagram fails the server check (the write still
commits; fix that diagram with one edit).
Examples:
  golem ticket patch-blocks GOL-400 --expected-revision 7 \\
    --op insert_after --anchor '### Data flow' --json <<'EOF'
  New paragraph in **Markdown**, no escaping.
  EOF
  golem ticket patch-blocks GOL-400 --expected-revision 8 \\
    --op edit --old 'retries: 3' --json <<'EOF'
  retries: 5
  EOF
  golem ticket patch-blocks GOL-326 --expected-revision 7 --operations-file ops.json --json
  golem ticket patch-blocks GOL-326 --expected-revision 7 --operations-file - --json < ops.json` },
  'add-comment': { args: 1, mutation: true,
    help: `golem ticket add-comment <ticket-id> [--message-file <path|->] [--block-id <block-id>] [--anchor-kind block|text] [--tag <tag>] [--quote <text>]

Usage: comment on a ticket; html block anchors are validated against the
current document and replies inherit the parent anchor.
Input: --message-file path or -; body is Markdown.
Output: created comment JSON.
Examples:
  golem ticket add-comment GOL-326 --block-id b-1a2b3c4d5e6f --message-file - --json < note.md` },
  'reply-comment': { args: 2, mutation: true,
    help: `golem ticket reply-comment <ticket-id> <comment-id> [--message-file <path|->]

Usage: reply in an existing thread; the reply inherits the parent block anchor
and addressing behavior. Editing a block never marks a comment addressed.
Output: created reply JSON.
Examples:
  golem ticket reply-comment GOL-326 c0mment1d --message-file - --json < reply.md` },
  'update-comment': { args: 2, mutation: true,
    help: `golem ticket update-comment <ticket-id> <comment-id> [--status open|resolved] [--block-id <block-id>] [--message-file <path|->]

Usage: resolve/reopen a comment or explicitly retarget its html block anchor
(server-validated; a removed anchor never silently jumps to unrelated content).
Output: updated comment JSON.
Examples:
  golem ticket update-comment GOL-326 c0mment1d --status resolved --json
  golem ticket update-comment GOL-326 c0mment1d --block-id b-1a2b3c4d5e6f --json` },
};

const BOOLEAN_FLAGS = new Set(['--json', '--human', '--help', '-h', '--section']);
const VALUE_FLAGS = new Set(['--project', '--kind', '--state', '--assignee', '--parent', '--title',
  '--body-format', '--body-file', '--expected-revision', '--operations-file', '--message-file',
  '--block-id', '--anchor-kind', '--tag', '--quote', '--status', '--priority', '--labels',
  '--op', '--anchor', '--prefix', '--suffix', '--anchor-block-id', '--to-anchor', '--old']);

function parseArgs(args) {
  const options = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    if (BOOLEAN_FLAGS.has(token)) {
      options[token] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(token)) {
      throw new SyntaxError(`unknown flag: ${token}`);
    }
    const value = args[i + 1];
    if (value === undefined) {
      throw new SyntaxError(`${token} requires a value`);
    }
    options[token] = value;
    i++;
  }
  return { options, positional };
}

async function readPayloadFile(filePath, stdin) {
  if (filePath === '-') {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }
  try {
    return fs.readFileSync(path.resolve(filePath), 'utf8');
  } catch (cause) {
    const error = new Error(`cannot read ${filePath}: ${cause?.message ?? cause}`);
    error.cliCode = 'input_error';
    throw error;
  }
}

function requireFlag(options, name, operation) {
  const value = options[name];
  if (value == null || value === '') {
    const error = new Error(`${operation}: ${name} is required`);
    error.cliCode = 'invalid_input';
    throw error;
  }
  return value;
}

// GOL-369 D6: ops that carry a content payload read raw stdin; remove and
// move_* never read stdin, so they cannot hang waiting for input.
const SINGLE_OP_PAYLOAD_OPS = new Set(['replace', 'insert_before', 'insert_after', 'edit',
  'replace_section', 'append_to_section']);

async function readStdinRaw(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** Build one block operation from the single-op flags (D6). */
async function buildSingleOp(options, stdin, operation) {
  const op = String(requireFlag(options, '--op', operation));
  const invalid = (message) => Object.assign(new Error(`patch-blocks: ${message}`), { cliCode: 'invalid_input' });
  const single = { op };
  if (op === 'edit') {
    if (options['--block-id'] != null || options['--anchor'] != null) {
      throw invalid('edit targets the whole body; drop --block-id/--anchor');
    }
    single.old = requireFlag(options, '--old', operation);
    if (options['--prefix'] != null) single.prefix = options['--prefix'];
    if (options['--suffix'] != null) single.suffix = options['--suffix'];
    // stdin is the new text; strip one final heredoc newline, nothing else.
    const raw = await readStdinRaw(stdin);
    single.new = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    return single;
  }
  if (options['--block-id'] != null && options['--anchor'] != null) {
    throw invalid('give --block-id or --anchor, never both');
  }
  if (options['--block-id'] != null) single.block_id = options['--block-id'];
  else if (options['--anchor'] != null) {
    single.anchor = { text: options['--anchor'] };
    if (options['--prefix'] != null) single.anchor.prefix = options['--prefix'];
    if (options['--suffix'] != null) single.anchor.suffix = options['--suffix'];
  } else {
    throw invalid('a target is required: --block-id or --anchor');
  }
  if (op === 'move_before' || op === 'move_after') {
    if (options['--anchor-block-id'] != null && options['--to-anchor'] != null) {
      throw invalid('give --anchor-block-id or --to-anchor, never both');
    }
    if (options['--anchor-block-id'] != null) single.anchor_block_id = options['--anchor-block-id'];
    else if (options['--to-anchor'] != null) single.to_anchor = { text: options['--to-anchor'] };
    else throw invalid('a move destination is required: --anchor-block-id or --to-anchor');
    return single;
  }
  if (op === 'remove') return single;
  if (!SINGLE_OP_PAYLOAD_OPS.has(op)) {
    // Unknown op: never read stdin; the server rejects it with invalid_operation.
    return single;
  }
  const raw = await readStdinRaw(stdin);
  single.content = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  return single;
}

function exitPayload(payload) {
  return JSON.stringify(payload, null, 2);
}

// GOL-349 response shaping: machine-facing ticket outputs are compact. The
// ticket body, comments, events and children never echo back — `golem ticket
// get` is the deliberate full-body read.
const TICKET_SUMMARY_FIELDS = ['id', 'display_id', 'seq', 'project_id', 'kind', 'title', 'state',
  'priority', 'assignee', 'assignee_label', 'parent_id', 'labels', 'body_format', 'body_revision',
  'created_by', 'created_at', 'updated_at'];
function compactTicket(ticket) {
  if (!ticket || typeof ticket !== 'object') return ticket;
  const summary = {};
  for (const field of TICKET_SUMMARY_FIELDS) {
    if (ticket[field] !== undefined) summary[field] = ticket[field];
  }
  // D3: html create/update responses carry the normalized outline with the
  // assigned block ids — that is the useful payload, not the body.
  if (Array.isArray(ticket.outline)) summary.outline = ticket.outline;
  // GOL-369 D7: the server checks changed Mermaid diagrams on every write.
  // The write commits; broken diagrams report here so the next edit fixes
  // only that diagram.
  if (Array.isArray(ticket.mermaid_errors)) summary.mermaid_errors = ticket.mermaid_errors;
  return summary;
}

function errorPayload(err) {
  // The server's owned payload (code + revision/outline recovery fields) is
  // the machine contract; the human message stays in `error`.
  if (err?.body && typeof err.body === 'object') {
    return { ...err.body, message: err.message };
  }
  if (err instanceof NotificationError || err?.cliCode || err?.code === 'INVALID_CALLER_CONTEXT') {
    const code = err.cliCode ?? err.code ?? 'invalid_input';
    return { code, error: err.message, message: err.message };
  }
  return { code: 'transport_failure', error: 'transport failure', message: err?.message ?? String(err) };
}

/**
 * Run one ticket operation.
 * @returns exit code: 0 success, 1 operational/transport failure, 2
 *   input/context error (including unsupported caller and revision conflicts).
 */
export async function runTicket(args, {
  stdout = (text) => process.stdout.write(`${text}\n`),
  stderr = (text) => process.stderr.write(`${text}\n`),
  stdin = process.stdin,
  cwd = process.cwd(),
  resolveContext = resolveCliSessionContext,
  client: injectedClient,
} = {}) {
  const jsonOut = (payload) => stdout(exitPayload(payload));
  const fail = (_code, payload, err) => {
    jsonOut(payload);
    stderr(`${payload.code ?? payload.error}: ${payload.message ?? ''}`.trim());
    return 2;
  };
  try {
    if (!args.length || ['--help', '-h', 'help'].includes(args[0])) {
      stdout([...Object.entries(OPS).map(([name, op]) => op.help)].join('\n\n'));
      return 0;
    }
    const operation = args[0];
    const spec = OPS[operation];
    if (!spec) {
      throw Object.assign(new Error(
        `unknown operation: ${operation}\nRun \`golem ticket --help\` for the flat operation list.`),
        { cliCode: 'unknown_operation' });
    }
    const { options, positional } = parseArgs(args.slice(1));
    if (options['--help'] || options['-h']) {
      stdout(spec.help);
      return 0;
    }
    const minPositional = spec.minArgs ?? spec.args;
    const maxPositional = spec.maxArgs ?? spec.args;
    if (positional.length < minPositional || positional.length > maxPositional) {
      throw Object.assign(new Error(
        `${operation}: expected ${spec.args} positional argument${spec.args === 1 ? '' : 's'}, got ${positional.length}\n${spec.help.split('\n')[0]}`),
        { cliCode: 'invalid_input' });
    }

    let context = null;
    try {
      context = resolveContext();
    } catch (cause) {
      // A caller context that cannot resolve on a MUTATION: a stable
      // unsupported-caller result naming the binding requirement (GOL-326 D5);
      // no identity fallback. Reads degrade to unbound — reads work without a
      // CLI caller binding.
      if (spec.mutation) {
        return fail('unsupported_caller', {
          error: 'golem ticket mutations require Pi/Claude CLI caller binding',
          code: 'unsupported_caller',
          message: 'caller binding is unavailable. Reads work without binding; mutations require a trusted Pi/Claude session.',
        }, cause);
      }
      // Reads stay unbound when the ambient context cannot resolve (e.g. a
      // foreign ancestry); an explicit --project still scopes the read.
      context = null;
    }
    if (!spec.mutation) {
      // Reads are safe unbound; callers still pass --human harmlessly.
    } else if (context && options['--human']) {
      throw Object.assign(new Error('bound agents cannot use --human'), { cliCode: 'invalid_caller_context' });
    } else if (!context && !options['--human']) {
      throw Object.assign(new Error(
        'unbound mutation requires --human (or a bound Pi/Claude session context)'),
        { cliCode: 'invalid_caller_context' });
    }
    const actor = context?.sessionId ?? (options['--human'] ? 'human:cli' : null);

    const client = injectedClient ?? createGolemClient({
      baseUrl: resolveGolemDashboardBaseUrl({ dashboardFile: dashboardJsonPath() }),
      callerSessionId: context?.sessionId ?? null,
    });
    const resolveProject = async (explicit) => {
      if (explicit) {
        return /^[\w-]+-[a-f0-9]{6}$/.test(explicit)
          ? explicit
          : projectIdFor(await resolveProjectRoot(path.resolve(cwd, explicit)));
      }
      if (context?.projectId) return context.projectId;
      if (context?.projectPath) return projectIdFor(await resolveProjectRoot(context.projectPath));
      if (options['--human'] && cwd) return projectIdFor(await resolveProjectRoot(cwd));
      throw Object.assign(new Error('could not resolve a project — pass --project <id-or-path>'),
        { cliCode: 'invalid_input' });
    };

    switch (operation) {
      case 'list': {
        const project = await resolveProject(options['--project']);
        const params = { project };
        if (options['--kind']) params.kind = options['--kind'];
        if (options['--state']) params.state = options['--state'];
        if (options['--assignee']) params.assignee = options['--assignee'];
        if (options['--parent']) params.parent = options['--parent'];
        const rows = await client.listTickets(params);
        return jsonOut(Array.isArray(rows) ? rows.map(compactTicket) : rows), 0;
      }
      case 'get':
        return jsonOut(await client.getTicket(positional[0])), 0;
      case 'create': {
        const project = await resolveProject(options['--project']);
        const bodyFile = options['--body-file'];
        if (!options['--title']) {
          throw Object.assign(new Error('create: --title is required'), { cliCode: 'invalid_input' });
        }
        const payload = {
          project_id: project,
          kind: options['--kind'] ?? 'task',
          title: options['--title'],
          body: bodyFile ? await readPayloadFile(bodyFile, stdin) : '',
          ...(options['--body-format'] ? { body_format: options['--body-format'] } : {}),
          created_by: actor ?? undefined,
          ...(options['--parent'] ? { parent_id: options['--parent'] } : {}),
          ...(options['--assignee'] ? { assignee: options['--assignee'] } : {}),
        };
        return jsonOut(compactTicket(await client.createTicket(payload))), 0;
      }
      case 'update': {
        const patch = { actor };
        for (const [flag, key] of [['--state', 'state'], ['--title', 'title'], ['--priority', 'priority'],
          ['--assignee', 'assignee'], ['--parent', 'parent_id']]) {
          if (options[flag]) patch[key] = options[flag];
        }
        if (options['--labels']) patch.labels = options['--labels'].split(',').map((l) => l.trim()).filter(Boolean);
        return jsonOut(compactTicket(await client.updateTicket(positional[0], patch))), 0;
      }
      case 'replace-body': {
        const payload = {
          body: await readPayloadFile(requireFlag(options, '--body-file', operation), stdin),
          expected_revision: Number(requireFlag(options, '--expected-revision', operation)),
          actor,
          ...(options['--body-format'] ? { body_format: options['--body-format'] } : {}),
        };
        return jsonOut(compactTicket(await client.updateTicket(positional[0], payload))), 0;
      }
      case 'get-outline':
        return jsonOut(await client.getTicketOutline(positional[0])), 0;
      case 'get-block': {
        // Positional block id keeps its meaning; --anchor reads by text
        // through the T1 route (both formats), with --section for sections.
        if (positional[1] != null && options['--anchor'] != null) {
          throw Object.assign(new Error('get-block: give a block id or --anchor, never both'),
            { cliCode: 'invalid_input' });
        }
        if (positional[1] != null) {
          return jsonOut(await client.getTicketBlock(positional[0], positional[1])), 0;
        }
        return jsonOut(await client.getTicketBlockQuery(positional[0], {
          anchor: options['--anchor'] != null ? {
            text: options['--anchor'],
            ...(options['--prefix'] != null ? { prefix: options['--prefix'] } : {}),
            ...(options['--suffix'] != null ? { suffix: options['--suffix'] } : {}),
          } : null,
          section: options['--section'] === true,
        })), 0;
      }
      case 'patch-blocks': {
        const hasFile = options['--operations-file'] != null;
        const hasSingle = options['--op'] != null;
        if (hasFile && hasSingle) {
          throw Object.assign(new Error(
            'patch-blocks: --op and --operations-file are mutually exclusive — one edit rides on flags with stdin content, a batch rides on --operations-file'),
            { cliCode: 'invalid_input' });
        }
        if (hasSingle) {
          const payload = {
            expected_revision: Number(requireFlag(options, '--expected-revision', operation)),
            operations: [await buildSingleOp(options, stdin, operation)],
            actor,
          };
          // The single-op result prints whole: revision, outline and any
          // server-reported mermaid_errors.
          return jsonOut(await client.patchTicketBlocks(positional[0], payload)), 0;
        }
        let parsedOps;
        try {
          parsedOps = JSON.parse(await readPayloadFile(requireFlag(options, '--operations-file', operation), stdin));
        } catch (cause) {
          if (cause.cliCode) throw cause;
          throw Object.assign(new Error(`patch-blocks: operations file is not valid JSON: ${cause?.message ?? cause}`),
            { cliCode: 'invalid_input' });
        }
        // The operations file carries either the bare operations array or the
        // full payload ({ expected_revision, operations }) per the spec example.
        const operations = Array.isArray(parsedOps) ? parsedOps : parsedOps?.operations;
        if (!Array.isArray(operations) || operations.length === 0) {
          throw Object.assign(new Error('patch-blocks: operations file must contain a non-empty operations array'),
            { cliCode: 'invalid_operations' });
        }
        const payload = {
          expected_revision: Number(options['--expected-revision'] ?? parsedOps?.expected_revision
            ?? requireFlag(options, '--expected-revision', operation)),
          operations,
          actor,
        };
        return jsonOut(await client.patchTicketBlocks(positional[0], payload)), 0;
      }
      case 'add-comment': {
        const payload = {
          author: actor,
          body: await readPayloadFile(requireFlag(options, '--message-file', operation), stdin),
          ...(options['--block-id'] ? { block_id: options['--block-id'] } : {}),
          ...(options['--anchor-kind'] ? { anchor_kind: options['--anchor-kind'] } : {}),
          ...(options['--tag'] ? { tag: options['--tag'] } : {}),
          ...(options['--quote'] ? { quote: options['--quote'] } : {}),
        };
        return jsonOut(await client.addComment(positional[0], payload)), 0;
      }
      case 'reply-comment': {
        const payload = {
          author: actor,
          body: await readPayloadFile(requireFlag(options, '--message-file', operation), stdin),
        };
        return jsonOut(await client.replyComment(positional[0], positional[1], payload)), 0;
      }
      case 'update-comment': {
        const patch = { actor };
        if (options['--status']) patch.status = options['--status'];
        if (options['--block-id']) patch.block_id = options['--block-id'];
        if (options['--message-file']) patch.body = await readPayloadFile(options['--message-file'], stdin);
        if (!Object.keys(patch).some((k) => k !== 'actor')) {
          throw Object.assign(new Error('update-comment: nothing to update — pass --status, --block-id or --message-file'),
            { cliCode: 'invalid_input' });
        }
        return jsonOut(await client.updateComment(positional[0], positional[1], patch)), 0;
      }
      default:
        throw Object.assign(new Error(`unknown operation: ${operation}`), { cliCode: 'unknown_operation' });
    }
  } catch (err) {
    const payload = errorPayload(err);
    // Conflicts and validation errors are input/context-class: the recovery
    // payload (current revision/outline) goes to stdout under the machine
    // contract; transport failures are operational.
    const conflictClass = ['revision_conflict', 'unsupported_caller', 'invalid_input', 'invalid_operation',
      'invalid_move', 'invalid_target', 'block_not_found', 'unsupported_format', 'expected_revision_required',
      'invalid_body_format', 'body_required_for_format_change', 'empty_html_body', 'invalid_html',
      'duplicate_block_id', 'malformed_block_id', 'invalid_block_html', 'invalid_operations',
      'invalid_block_operations', 'anchor_not_found', 'anchor_ambiguous', 'protected_attribute',
      'section_target_not_heading', 'unknown_operation', 'input_error', 'invalid_caller_context',
      'invalid_block_id', 'block_id_required'].includes(payload.code)
      || (err?.status != null && err.status >= 400 && err.status < 500 && err.status !== 409 ? true : false);
    const isConflict = payload.code === 'revision_conflict' || err?.status === 409;
    stderr(`${payload.code ?? payload.error}: ${payload.message ?? payload.error ?? ''}`.trim());
    jsonOut(payload);
    return isConflict || conflictClass ? 2 : 1;
  }
}