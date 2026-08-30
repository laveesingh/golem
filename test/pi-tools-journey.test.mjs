#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-pi-tools-'));
const state = path.join(temp, 'state');
const trackerDb = path.join(temp, 'tracker.db');
fs.mkdirSync(state, { recursive: true });

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function linkPiTui(render) {
  const piCli = fs.realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
  let current = path.dirname(piCli);
  let source = null;
  while (current && current !== path.dirname(current)) {
    const candidate = path.join(current, 'node_modules', '@earendil-works', 'pi-tui');
    if (fs.existsSync(candidate)) {
      source = candidate;
      break;
    }
    current = path.dirname(current);
  }
  if (!source) throw new Error(`Could not find @earendil-works/pi-tui starting from ${piCli}`);
  const scope = path.join(render, 'node_modules', '@earendil-works');
  fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(source, path.join(scope, 'pi-tui'), 'dir');
}
async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch {}
    await sleep(30);
  }
  throw new Error(message);
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function harness(extension, sessionId) {
  const handlers = new Map();
  const tools = new Map();
  const sent = [];
  let idle = true;
  const pi = {
    on(name, fn) { handlers.set(name, [...(handlers.get(name) || []), fn]); },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendUserMessage(text) { sent.push(text); },
  };
  extension(pi);
  const ctx = {
    cwd: repo, mode: 'tui', model: { provider: 'ollama', id: 'deepseek-v4-flash:0731-cloud' },
    isIdle: () => idle, hasPendingMessages: () => false, abort() { idle = true; }, shutdown() {},
    sessionManager: {
      getSessionId: () => sessionId, getSessionFile: () => path.join(temp, `${sessionId}.jsonl`),
      getSessionName: () => 'pi-tool-worker', getLeafId: () => 'pi-tool-leaf',
    },
  };
  const emit = async (name, event = {}) => {
    let result;
    for (const fn of handlers.get(name) || []) {
      const next = await fn(event, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  };
  return { ctx, tools, sent, emit };
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, PORT: String(port), HOST: '127.0.0.1', GOLEM_HOME: state,
  GOLEM_TRACKER_DB: trackerDb, HOME: path.join(temp, 'home'),
  XDG_CONFIG_HOME: path.join(temp, 'xdg'), GOLEM_PROJECTS_ROOT: path.join(temp, 'projects'),
  GOLEM_IDEAS_ROOT: path.join(temp, 'ideas'), GOLEM_ROOT: repo,
};
process.env.GOLEM_HOME = state;
process.env.HOME = env.HOME;
process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
process.env.GOLEM_SMOKE_API = baseUrl;

let dashboard;
let worker;
let ticket;
try {
  dashboard = spawn(process.execPath, [path.join(repo, 'dashboard/server/index.js')], {
    cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let dashboardError = '';
  dashboard.stderr.on('data', (chunk) => { dashboardError += chunk; });
  await waitFor(async () => (await fetch(`${baseUrl}/api/health`)).ok, `dashboard did not start: ${dashboardError}`);
  fs.writeFileSync(path.join(state, 'dashboard.json'), JSON.stringify({ url: baseUrl, pid: dashboard.pid }));

  execFileSync(process.execPath, [path.join(repo, 'cli/golem.js'), 'sync', '--target', 'pi'], { cwd: repo, env });
  const render = path.join(state, 'renders', 'pi');
  linkPiTui(render);
  fs.copyFileSync(path.join(render, 'golem.ts'), path.join(render, 'golem.mjs'));
  const extension = (await import(`${pathToFileURL(path.join(render, 'golem.mjs')).href}?t=${Date.now()}`)).default;
  worker = harness(extension, 'pi-tools-worker');
  await worker.emit('session_start', { reason: 'startup' });

  const role = await worker.tools.get('session_role').execute('role-call', { role: 'builder' }, undefined, undefined, worker.ctx);
  assert.equal(role.details.ok, true, role.content[0].text);

  const scratch = await import('../dashboard/scripts/_scratch.mjs');
  ticket = await scratch.createScratchTicket({ title: 'Pi native tools', body: '# Pi tool journey\n', assignee: 'pi-tools-worker' });
  const fetched = await worker.tools.get('ticket_get').execute('get-call', { id: ticket.display_id }, undefined, undefined, worker.ctx);
  assert.equal(fetched.details.ok, true, fetched.content[0].text);
  assert.equal(fetched.details.result.display_id, ticket.display_id);

  const commented = await worker.tools.get('ticket_comment').execute('comment-call', {
    id: ticket.display_id, body: 'Pi wrote this through the shared native tool runtime.',
  }, undefined, undefined, worker.ctx);
  assert.equal(commented.details.ok, true, commented.content[0].text);
  assert.equal(commented.details.result.author, 'pi-tools-worker', 'caller identity is injected by the adapter');

  const transitioned = await worker.tools.get('ticket_update').execute('state-call', {
    id: ticket.display_id, state: 'in_progress',
  }, undefined, undefined, worker.ctx);
  assert.equal(transitioned.details.ok, true, transitioned.content[0].text);
  assert.equal(transitioned.details.result.state, 'in_progress');

  const context = await worker.tools.get('project_context').execute('context-call', {}, undefined, undefined, worker.ctx);
  assert.equal(context.details.ok, true, context.content[0].text);
  assert.match(context.content[0].text, /Recent commits/, 'project context renders bounded repo context');

  const roleChange = await fetch(`${baseUrl}/api/sessions/pi-tools-worker/role`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'reviewer' }),
  });
  const roleChangeBody = await roleChange.json();
  assert.equal(roleChange.ok, true, JSON.stringify(roleChangeBody));
  assert.equal(roleChangeBody.activation?.ok, true, JSON.stringify(roleChangeBody));
  assert.equal(worker.sent.length, 0, 'role assignment never starts a Pi turn');
  const prompt = await worker.emit('before_agent_start', { prompt: 'review next', systemPrompt: 'Pi base prompt' });
  assert.match(prompt.systemPrompt, /Role: reviewer/, 'dashboard role change applies at the next safe boundary');

  // Pi is a full participant: the lead role is assignable like any other
  // harness, and the lead card is injected at the next safe boundary.
  const leadChange = await fetch(`${baseUrl}/api/sessions/pi-tools-worker/role`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'lead' }),
  });
  const leadChangeBody = await leadChange.json();
  assert.equal(leadChange.ok, true, JSON.stringify(leadChangeBody));
  const leadPrompt = await worker.emit('before_agent_start', { prompt: 'lead next', systemPrompt: 'Pi base prompt' });
  assert.match(leadPrompt.systemPrompt, /Role: lead/, 'lead role card applies at the next safe boundary');

  // Back to a worker role for the rest of the journey.
  const backToReviewer = await fetch(`${baseUrl}/api/sessions/pi-tools-worker/role`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'reviewer' }),
  });
  assert.equal(backToReviewer.ok, true, JSON.stringify(await backToReviewer.json()));
  const afterRole = await worker.emit('before_agent_start', { prompt: 'review remains', systemPrompt: 'Pi base prompt' });
  assert.match(afterRole.systemPrompt, /Role: reviewer/, 'role change applies at the next safe boundary');

  console.log('Pi native tool journey passed: shared tracker identity, read/comment/transition, L4, and safe-boundary role refresh');
} finally {
  if (ticket) {
    try {
      const scratch = await import('../dashboard/scripts/_scratch.mjs');
      await scratch.archiveTicket(ticket.display_id || ticket.id);
    } catch {}
  }
  if (worker) await worker.emit('session_shutdown', { reason: 'quit' }).catch(() => {});
  if (dashboard?.pid) dashboard.kill('SIGTERM');
  fs.rmSync(temp, { recursive: true, force: true });
}
