import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { BOUNDARIES, HARNESSES, OPERATIONS, ScenarioError, eventEnvelope, header, integer, member, record } from './scenario-format.ts';
import type { Scenario, Value } from './scenario-format.ts';

// No free-text structural slot. Unknown fields fail; secrets are omitted;
// known content slots become semantic placeholders, never hashes.
const OMIT = new Set(['token', 'tokens', 'api_key', 'access_token', 'credentials', 'password', 'env', 'environment', 'username']);
const CONTENT = new Set(['content', 'prompt', 'assistant_text', 'tool_input', 'tool_output', 'transcript', 'ticket_body', 'body', 'file_contents', 'stdin', 'stdout', 'stderr', 'label', 'name', 'error_message']);
export const SYMBOL_FIELDS: Record<string, string> = { id: 'id', session: 'session', session_id: 'session', canonical_id: 'session', envelope_id: 'envelope', attempt_id: 'attempt', project_id: 'project', team_id: 'team', worker_id: 'worker', workspace_id: 'workspace', tab_id: 'tab', pane_id: 'pane', pid: 'pid', port: 'port', path: 'path', cwd: 'path', model: 'model' };
export const SYMBOL = /^\$(id|session|envelope|attempt|project|team|worker|workspace|tab|pane|pid|port|path|model):([1-9]\d{0,3})$/;
const BOOL = new Set(['ok', 'accepted', 'settled', 'running', 'default', 'delivery_ready']);
const NUM = new Set(['schema_version', 'exit_code', 'http_status', 'duration_ms']);
const CONTAINERS = new Set(['result', 'response', 'workspaces', 'workspace', 'sessions', 'panes', 'pane', 'agents', 'agent', 'items']);
const STATES = ['queued', 'claimed', 'accepted', 'settled', 'acknowledged', 'returned', 'starting', 'working', 'busy', 'idle', 'blocked', 'running', 'stopped', 'failed', 'pending', 'unknown', 'complete', 'todo', 'in_progress', 'review', 'done', 'archived'] as const;
const ARGV_LITERAL = new Set(['--', '--version', '--json', '--session', '--session-id', '--resume', '--cwd', '--label', '--name', '--model', '--provider', '--extension', '--no-focus', '--new-tab', '--workspace', '--no-session', '-p', '--print', 'agents', 'session', 'list', 'start', 'stop', 'status', 'server', 'workspace', 'create', 'close', 'focus', 'rename', 'tab', 'pane', 'run', 'read', 'agent', 'get', 'send-keys']);
const VALUE_FLAGS: Record<string, string> = { '--session': 'session', '--session-id': 'session', '--resume': 'session', '--workspace': 'workspace', '--cwd': 'path', '--extension': 'path', '--model': 'model' };
function safeVersion(value: unknown, synthetic: boolean): string {
  if (value === 'synthetic' && synthetic) return value;
  if (typeof value !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value)) throw new ScenarioError('invalid version metadata');
  return value;
}
class Scrubber {
  symbols = new Map<string, Map<string | number, string>>();
  modes = new Map<string, 'raw' | 'symbol'>();
  budget = 100_000;
  synthetic = false;
  symbolic(type: string, value: unknown): string {
    const mode = typeof value === 'string' && value.startsWith('$') ? 'symbol' : 'raw';
    if (this.modes.has(type) && this.modes.get(type) !== mode) throw new ScenarioError('mixed raw and symbolic identities are uncertain');
    this.modes.set(type, mode);
    if (mode === 'symbol') {
      const parsed = SYMBOL.exec(value as string); if (!parsed || parsed[1] !== type) throw new ScenarioError('invalid typed symbol'); return value as string;
    }
    if (type === 'pid' || type === 'port') { integer(value, type === 'port' ? 65535 : 0x7fffffff); if (type === 'pid' && value === 0) throw new ScenarioError('PID must identify a process'); }
    else if (typeof value !== 'string' || !value || value.length > 8192 || value.includes('\0') || (type === 'path' && !path.isAbsolute(value))) throw new ScenarioError('invalid identity/path metadata');
    let table = this.symbols.get(type); if (!table) { table = new Map(); this.symbols.set(type, table); }
    const key = value as string | number;
    if (!table.has(key)) {
      if (table.size >= 9999) throw new ScenarioError('too many symbolic identities');
      table.set(key, `$${type}:${table.size + 1}`);
    }
    return table.get(key)!;
  }
  argv(value: unknown): Value[] {
    if (!Array.isArray(value) || !value.length || value.length > 128) throw new ScenarioError('invalid bounded argv');
    return value.map((item, i) => {
      if (typeof item !== 'string' || item.length > 8192 || item.includes('\0')) throw new ScenarioError('invalid argv element');
      if (item.startsWith('$')) { const parsed = SYMBOL.exec(item); if (!parsed) throw new ScenarioError('invalid argv symbol'); return this.symbolic(parsed[1]!, item); }
      if (/^<redacted:(?:argv|prompt|label|provider)>$/.test(item)) return item;
      const previous = i ? value[i - 1] : '';
      if (Object.hasOwn(VALUE_FLAGS, previous)) return this.symbolic(VALUE_FLAGS[previous]!, item);
      if (['--label', '--name', '--provider'].includes(previous)) return `<redacted:${previous === '--provider' ? 'provider' : 'label'}>`;
      if (ARGV_LITERAL.has(item)) return item;
      const context = [...value.slice(0, i)].reverse().find(word => ['session', 'workspace', 'tab', 'pane', 'agent'].includes(word));
      if (['stop', 'close', 'focus', 'rename', 'get', 'read', 'run', 'send-keys'].includes(previous) && context) return this.symbolic(context === 'agent' ? 'pane' : context, item);
      if (!i || item.startsWith('-')) throw new ScenarioError('unrecognized argv command/flag');
      // A redacted argument is a semantic wildcard, not code to be executed.
      return '<redacted:argv>';
    });
  }
  fields(input: Record<string, unknown>, depth = 0): { [key: string]: Value } {
    this.budget -= Object.keys(input).length + 1;
    if (this.budget < 0 || depth > 8 || Object.keys(input).length > 64) throw new ScenarioError('structural response is too deep/wide');
    const out: { [key: string]: Value } = {};
    for (const [key, value] of Object.entries(input)) {
      if (OMIT.has(key)) continue;
      if (CONTENT.has(key)) { out[key] = `<redacted:${key.replaceAll('_', '-')}>`; continue; }
      if (Object.hasOwn(SYMBOL_FIELDS, key)) { out[key] = this.symbolic(SYMBOL_FIELDS[key]!, value); continue; }
      if (BOOL.has(key)) { if (typeof value !== 'boolean') throw new ScenarioError('invalid structural boolean'); out[key] = value; continue; }
      if (NUM.has(key)) { out[key] = integer(value, key === 'exit_code' ? 255 : 1_000_000_000); continue; }
      if (CONTAINERS.has(key)) {
        if (Array.isArray(value)) { if (value.length > 256) throw new ScenarioError('structural list is too large'); out[key] = value.map(item => this.fields(record(item), depth + 1)); }
        else out[key] = this.fields(record(value), depth + 1);
        continue;
      }
      if (key === 'argv') out[key] = this.argv(value);
      else if (key === 'harness') out[key] = member(value, HARNESSES);
      else if (key === 'state' || key === 'status' || key === 'outcome') out[key] = member(value, STATES);
      else if (key === 'signal') out[key] = member(value, ['SIGTERM', 'SIGINT', 'SIGHUP']);
      else if (key === 'stdout_recipe') out[key] = member(value, ['version', 'json', 'empty']);
      else if (key === 'version') out[key] = safeVersion(value, this.synthetic);
      else if (key === 'method') out[key] = member(value, ['initialize', 'tools/list', 'tools/call', 'notifications/initialized', 'notifications/claude/channel']);
      else if (key === 'tool_name') out[key] = member(value, ['ack', 'ticket_list', 'ticket_get', 'ticket_create', 'ticket_update', 'ticket_comment', 'ticket_comment_update', 'ticket_comment_reply', 'session_role', 'ticket_dispatch', 'project_context']);
      else if (key === 'kind') out[key] = member(value, ['brief', 'role_assign', 'interrupt', 'halt', 'gate_approve', 'gate_deny', 'gate_cancel', 'task', 'spec', 'doc']);
      else if (key === 'event_type') out[key] = member(value, ['SessionStart', 'Stop', 'UserPromptSubmit', 'PostToolUse', 'session_start', 'agent_start', 'agent_settled', 'tool_call']);
      else if (key === 'transport') out[key] = member(value, ['stdio', 'http', 'herdr']);
      else throw new ScenarioError('unknown field; scrub completeness cannot be established');
    }
    return out;
  }
}
export function scrubScenario(input: unknown): Scenario {
  const top = header(input), scrubber = new Scrubber(); let previous = 0;
  scrubber.synthetic = top.scenario.startsWith('synthetic-');
  const events = top.events.map((value, index) => {
    const event = eventEnvelope(value, index + 1, previous); previous = event.at_ms;
    const fields = scrubber.fields(event.fields);
    const required = event.operation === 'process-spawn' ? ['harness', 'argv']
      : event.operation === 'process-exit' ? ['harness']
      : event.operation === 'process-stdin' ? ['harness', 'stdin']
      : event.operation === 'process-stderr' ? ['harness', 'stderr']
      : event.operation === 'process-stdout' ? ['harness']
      : event.operation === 'hook-input' ? ['event_type']
      : event.operation === 'mcp-call' ? ['method']
      : event.operation.startsWith('typed-') ? ['envelope_id']
      : event.operation === 'herdr-command' ? ['argv'] : [];
    if (required.some(key => !Object.hasOwn(fields, key))) throw new ScenarioError('missing operation fields');
    if (event.operation === 'process-exit' && Object.hasOwn(fields, 'exit_code') === Object.hasOwn(fields, 'signal')) throw new ScenarioError('exit must have exactly one recorded code or signal');
    if (event.operation === 'process-stdout' && !Object.hasOwn(fields, 'stdout') && !Object.hasOwn(fields, 'stdout_recipe')) throw new ScenarioError('missing stdout contract');
    if (fields.stdout_recipe === 'json' && !Object.hasOwn(fields, 'result')) throw new ScenarioError('missing JSON stdout structure');
    return { ...event, fields };
  });
  return { ...top, events };
}
/** Reject replay input that still needs scrubbing. No raw fallback. */
export function validateScenario(input: unknown): Scenario {
  const clean = scrubScenario(input);
  if (!isDeepStrictEqual(clean, input)) throw new ScenarioError('replay input is not canonical scrubbed data');
  return clean;
}
export { BOUNDARIES, OPERATIONS };
