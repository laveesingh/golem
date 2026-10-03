// Bounded framing observer for a run-owned real MCP child. Forwards unchanged;
// extracts only public request metadata and structural success at the stdio seam.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordScenarioProjection } from '../lib/scenario-recorder.ts';

const child = spawn(
  process.execPath,
  [fileURLToPath(new URL('../mcp/channel/index.js', import.meta.url))],
  { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] },
);
let pending = Promise.resolve();
const calls = new Map();
let envelope = null;
const observe = (projection) => {
  pending = pending.then(() => recordScenarioProjection(projection));
  pending.catch(() => {
    child.kill('SIGTERM');
    process.exitCode = 2;
  });
};
function frames(source, target, inspect) {
  let buffer = '';
  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) {
      child.kill('SIGTERM');
      process.exitCode = 2;
      return;
    }
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        inspect(JSON.parse(frame));
      } catch {
        child.kill('SIGTERM');
        process.exitCode = 2;
        return;
      }
      if (!target.write(`${frame}\n`)) {
        source.pause();
        target.once('drain', () => source.resume());
      }
    }
  });
  source.on('end', () => target.end());
}
frames(process.stdin, child.stdin, (message) => {
  if (message.method !== 'tools/call') return;
  const name = message.params.name;
  if (!['ack', 'ticket_comment'].includes(name)) return;
  const args = message.params.arguments ?? {};
  const id = args.envelope_id ?? envelope;
  if (!id) throw Error('uncorrelated recorder call');
  calls.set(message.id, { name, id });
  observe({
    boundary: 'mcp',
    direction: 'in',
    operation: 'mcp-call',
    fields: { method: 'tools/call', tool_name: name, envelope_id: id },
  });
});
frames(child.stdout, process.stdout, (message) => {
  if (message.method === 'notifications/claude/channel') {
    envelope = message.params.meta.envelope_id;
    observe({
      boundary: 'mcp',
      direction: 'out',
      operation: 'mcp-return',
      fields: {
        method: message.method,
        envelope_id: envelope,
        state: 'accepted',
      },
    });
  }
  const call = calls.get(message.id);
  if (!call) return;
  calls.delete(message.id);
  observe({
    boundary: 'mcp',
    direction: 'out',
    operation: 'mcp-return',
    fields: {
      tool_name: call.name,
      envelope_id: call.id,
      ok: !message.error && !message.result?.isError,
      state: call.name === 'ack' ? 'acknowledged' : 'returned',
    },
  });
});
child.stderr.resume();
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
child.once('exit', async (code) => {
  await pending;
  process.exitCode = code ?? 2;
});
