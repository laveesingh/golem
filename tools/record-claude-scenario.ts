// Real Claude channel recording on the rec profile. Interactive Claude needs
// a terminal to stay resident, so it runs in a herdr pane (a real pty) under
// the rec profile env; the initial prompt is typed via pane send-keys. The
// dashboard briefs the discovered channel session; the agent acks via
// mcp__golem__ack and returns via mcp__golem__ticket_comment. Hard model rule:
// claude-haiku-4-5 only. macOS Keychain lookup follows HOME, so the pane keeps
// the real user HOME while CLAUDE_CONFIG_DIR pins rec state (lead-confirmed).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPortBlockFree, resolveProfile } from '../cli/bootstrap.ts';
import { createScratchTicket } from '../dashboard/scripts/_scratch.mjs';
import { createScenarioRecorder } from '../lib/scenario-recorder.ts';

assert.equal(process.env.GOLEM_RECORD_REAL, '1');
const repo = fileURLToPath(new URL('../', import.meta.url));
const rec = path.join(process.env.HOME ?? '', '.golem-profiles', 'rec');
const env: Record<string, string | undefined> = { ...process.env };
const profile = resolveProfile(['--profile', 'rec'], env);
env.HOME = path.join(rec, 'home');
await assertPortBlockFree(profile.port);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 's4-'));
fs.chmodSync(root, 0o700);
const version = spawnSync('claude', ['--version'], {
  env,
  encoding: 'utf8',
  timeout: 10000,
});
assert.equal(version.status, 0);
const pinned = /(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1];
assert.ok(pinned);
const broker = await createScenarioRecorder(
  path.join(root, 'claude-dispatch-ack-return.json'),
  {
    schema: 1,
    scenario: 'claude-dispatch-ack-return',
    seed: 524,
    source: {
      harness: 'claudecode',
      harness_version: pinned,
      golem_version: JSON.parse(
        fs.readFileSync(path.join(repo, 'package.json'), 'utf8'),
      ).version,
    },
  },
);
const base = String(env.GOLEM_DASHBOARD_URL);
const children: Array<ReturnType<typeof spawn> & { closed: Promise<unknown> }> =
  [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function actor(
  binary: string,
  args: string[],
): ReturnType<typeof spawn> & { closed: Promise<unknown> } {
  const child = spawn(binary, args, {
    cwd: repo,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ReturnType<typeof spawn> & { closed: Promise<unknown> };
  child.closed = new Promise((resolve) =>
    child.once('exit', () => resolve(undefined)),
  );
  const log = fs.createWriteStream(
    path.join(root, `actor-${children.length}.log`),
    { mode: 0o600 },
  );
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  children.push(child);
  return child;
}
async function wait(fn: () => Promise<unknown>, ms = 30000): Promise<unknown> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {}
    if (Date.now() > end)
      throw new Error('native Claude recording boundary timed out');
    await sleep(200);
  }
}
async function request(
  route: string,
  body: unknown,
  method = 'POST',
): Promise<unknown> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `private dashboard status ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  return response.json();
}
let ticket: { id: string } | undefined;
const herdrSession = `s4-claude-${Date.now().toString(36)}`;
try {
  process.env.GOLEM_HERDR_SESSION = herdrSession;
  if (env.XDG_CONFIG_HOME)
    process.env.XDG_CONFIG_HOME = String(env.XDG_CONFIG_HOME);
  const driver = await import('../lib/herdr-driver.js');
  console.error('phase: dashboard');
  const dashboard = actor(process.execPath, [
    path.join(repo, 'dashboard/server/index.js'),
  ]);
  console.error(`dashboard pid ${dashboard.pid}`);
  await wait(() => request('/api/health', null, 'GET'));
  // Canary: a brief to a dead session must return the current envelope shape.
  // A stale dashboard from an earlier run answers with the old bare-delivery
  // shape and would silently invalidate the recording.
  const canary = await fetch(`${base}/api/brief`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 's4-canary-dead-session',
      brief: 'canary',
    }),
    signal: AbortSignal.timeout(10000),
  }).then((response) => response.json());
  assert.ok(
    canary.envelope_id,
    `stale dashboard serving ${base}: ${JSON.stringify(canary).slice(0, 200)}`,
  );
  ticket = await createScratchTicket(
    { title: 'S4 Claude channel return' },
    (body) => request('/api/tickets', body),
  );
  const channelsFile = path.join(String(env.GOLEM_HOME), 'channels.json');
  const channelIdsBefore = new Set(
    fs.existsSync(channelsFile)
      ? JSON.parse(fs.readFileSync(channelsFile, 'utf8')).channels.map(
          (row: { session_id: string }) => row.session_id,
        )
      : [],
  );
  // The real channel server (not the framing observer): its production ack
  // and comment seams record into the run broker via the env below.
  const config = path.join(root, 'mcp.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        golem: {
          command: process.execPath,
          args: [path.join(repo, 'mcp/channel/index.js')],
          env: { GOLEM_CHANNEL_PORT: '0', ...broker.env },
        },
      },
    }),
    { mode: 0o600 },
  );
  const settings = path.join(root, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ model: 'claude-haiku-4-5' }), {
    mode: 0o600,
  });
  // Pane env: explicit allowlist (a whole-environment export breaks shell
  // quoting). HOME stays the real user home for the Keychain lookup.
  const paneEnv: string[] = [];
  for (const key of [
    'PATH',
    'TERM',
    'LANG',
    'GOLEM_HOME',
    'GOLEM_PROFILE',
    'GOLEM_PROFILE_ROOT',
    'GOLEM_TRACKER_DB',
    'GOLEM_ASSETS_DIR',
    'GOLEM_TYPED_DELIVERY_TOMBSTONES_DB',
    'GOLEM_PROJECTS_ROOT',
    'CLAUDE_CONFIG_DIR',
    'PI_CODING_AGENT_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR',
    'GOLEM_DASHBOARD_URL',
    'GOLEM_CHANNEL_PORT',
    'GOLEM_RECORD_SCENARIO',
    'GOLEM_RECORD_SOCKET',
    'GOLEM_RECORD_CAPABILITY',
  ]) {
    const value = { ...env, ...broker.env }[key];
    if (typeof value === 'string' && value && !value.includes(`'`))
      paneEnv.push(`${key}=${value}`);
  }
  paneEnv.push('HOME=/Users/laveesingh');
  // No --dangerously-skip-permissions: the two MCP tools are pre-granted via
  // --allowedTools, so there is no bypass-mode confirm. The dev-channel list
  // is answered with option 1. cwd is the main checkout, which the rec
  // identity already trusts, so no trust prompt appears.
  const argv = [
    '--model',
    'claude-haiku-4-5',
    '--mcp-config',
    config,
    '--strict-mcp-config',
    '--settings',
    settings,
    '--dangerously-load-development-channels',
    'server:golem',
    '--allowedTools',
    'mcp__golem__ack mcp__golem__ticket_comment',
  ];
  broker.record({
    boundary: 'process',
    direction: 'in',
    operation: 'process-spawn',
    fields: { harness: 'claudecode', argv },
  });
  console.error('phase: herdr pane');
  await driver.ensureSession(herdrSession);
  const created = driver.workspaceCreate({
    session: herdrSession,
    label: 's4-claude',
  });
  const workspaceId = created.workspace_id ?? created.id;
  assert.ok(workspaceId);
  const tab = driver.tabCreate({
    session: herdrSession,
    workspaceId: String(workspaceId),
    label: 's4-agent',
    cwd: '/Users/laveesingh/Documents/software/golem',
  });
  const paneId = tab.pane?.pane_id ?? tab.root_pane?.pane_id;
  assert.ok(paneId);
  // Pane typing stalls on multi-KB lines, so the environment rides in a
  // launcher file; the typed command stays short. Recorded argv is the real
  // harness invocation.
  const launcher = path.join(root, 'launch-claude.sh');
  fs.writeFileSync(
    `${launcher}`,
    `#!/bin/sh\n${paneEnv.map((pair) => `export ${pair}`).join('\n')}\nexec claude ${argv.map((word) => `'${word.replaceAll(`'`, `'\\''`)}'`).join(' ')}\n`,
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(root, 'launch-command.json'),
    JSON.stringify(['claude', ...argv], null, 1),
    { mode: 0o600 },
  );
  assert.equal(
    driver.paneRun({
      session: herdrSession,
      paneId: String(paneId),
      command: ['sh', launcher],
    }),
    true,
  );
  const sendText = (text: string): void => {
    const result = spawnSync(
      driver.herdrBinary(),
      ['--session', herdrSession, 'pane', 'send-text', String(paneId), text],
      { env: process.env, encoding: 'utf8', timeout: 20000 },
    );
    assert.equal(result.status, 0);
  };
  // paneRun types slowly; wait until the Claude TUI is up before typing over
  // it, otherwise keystrokes interleave into the launch command line.
  await wait(
    async () =>
      /development channels|Claude Code v/.test(
        driver.paneRead({ session: herdrSession, paneId: String(paneId) }),
      )
        ? true
        : null,
    120000,
  );
  await sleep(2000);
  sendText('1');
  await driver.paneSendKeys({
    session: herdrSession,
    paneId: String(paneId),
    keys: ['enter'],
  });
  await sleep(3000);
  sendText(
    'Reply READY. Then wait for a Golem channel notification. On a brief, call mcp__golem__ack with its envelope_id and kind brief, then call mcp__golem__ticket_comment with id ' +
      ticket.id +
      ' and body RECORDING_RETURN. Do not call any other tool.',
  );
  await driver.paneSendKeys({
    session: herdrSession,
    paneId: String(paneId),
    keys: ['enter'],
  });
  await wait(
    async () =>
      driver
        .paneRead({ session: herdrSession, paneId: String(paneId) })
        .includes('READY')
        ? true
        : null,
    120000,
  );
  const channel = await wait(async () => {
    if (!fs.existsSync(channelsFile)) return null;
    const rows = JSON.parse(fs.readFileSync(channelsFile, 'utf8')).channels;
    return (
      rows.find(
        (row: { session_id: string; pid: number; delivery_ready: boolean }) => {
          if (
            channelIdsBefore.has(row.session_id) ||
            !row.pid ||
            row.delivery_ready !== true
          )
            return false;
          try {
            process.kill(row.pid, 0);
          } catch {
            return false;
          }
          return true;
        },
      ) ?? null
    );
  });
  const session = channel.session_id as string;
  console.error(`phase: brief ${session}`);
  let loggedBriefError = false;
  const delivery = await wait(async () => {
    try {
      const response = await request('/api/brief', {
        session_id: session,
        brief: `Recording brief. Acknowledge this envelope with kind brief and post RECORDING_RETURN on task ${ticket.id}.`,
      });
      console.error(
        `brief receipt: ${JSON.stringify(response.delivery ?? response)}`,
      );
      return response.ok && !response.queued ? response : null;
    } catch (error) {
      if (!loggedBriefError) {
        loggedBriefError = true;
        console.error(`brief error: ${(error as Error).message}`);
      }
      return null;
    }
  }, 60000);
  assert.ok(delivery.envelope_id);
  // The agent return is the durable proof on the run-isolated ticket (fresh
  // ticket, single writer, minute-scale window). The ack event in the fixture
  // carries the live envelope id from the production MCP seam, which links
  // the acknowledged envelope to this return. (The envelope view exposes no
  // acknowledged_at field.)
  await wait(async () => {
    const task = await request(`/api/tickets/${ticket.id}`, null, 'GET');
    return task.comments?.some(
      (comment: { body: string }) => comment.body === 'RECORDING_RETURN',
    )
      ? true
      : null;
  }, 180000);
  console.error('phase: acknowledged and returned');
  // The MCP seam observations (ack call/return, comment call/return) come
  // from the run-owned wrapper, not from here. Exit Claude cleanly and prove
  // it: the pane foreground process stops being claude before recording exit.
  sendText('/exit');
  await driver.paneSendKeys({
    session: herdrSession,
    paneId: String(paneId),
    keys: ['enter'],
  });
  await wait(async () => {
    try {
      const info = driver.paneProcessInfo({
        session: herdrSession,
        paneId: String(paneId),
      });
      const foreground = JSON.stringify(info ?? {}).toLowerCase();
      return foreground && !foreground.includes('claude') ? true : null;
    } catch {
      return null;
    }
  }, 30000);
  broker.record({
    boundary: 'process',
    direction: 'out',
    operation: 'process-exit',
    fields: { harness: 'claudecode', exit_code: 0 },
  });
  try {
    await driver.paneClose({ session: herdrSession, paneId: String(paneId) });
  } catch {}
  const scenario = await broker.close();
  console.error(
    `candidate ${path.join(root, 'claude-dispatch-ack-return.json')}; channel ack plus durable comment return; model claude-haiku-4-5; ${scenario.events.length} events`,
  );
} catch (error) {
  try {
    const driver = await import('../lib/herdr-driver.js');
    const panes = driver.paneList(herdrSession);
    for (const pane of panes?.panes ?? panes ?? []) {
      const id = pane.pane_id ?? pane;
      const transcript = driver.paneRead({
        session: herdrSession,
        paneId: String(id),
      });
      console.error(`pane ${id} head: ${transcript.slice(0, 2000)}`);
      console.error(`pane ${id} tail: ${transcript.slice(-800)}`);
    }
  } catch {}
  broker.abort('native_run_failed');
  try {
    await broker.close();
  } catch {}
  console.error(`recording failed: ${(error as Error).message}; root ${root}`);
  process.exitCode = 1;
} finally {
  if (ticket)
    await request(
      `/api/tickets/${ticket.id}`,
      { state: 'archived', actor: 'smoke' },
      'PATCH',
    ).catch(() => {});
  for (const child of [...children].reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.stdin?.end();
      } catch {}
      child.kill('SIGTERM');
      await Promise.race([child.closed, sleep(3000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await child.closed;
      }
    }
  }
  try {
    const driver = await import('../lib/herdr-driver.js');
    await driver.sessionStop(herdrSession);
  } catch {}
  for (const name of ['mcp.json', 'settings.json'])
    fs.rmSync(path.join(root, name), { force: true });
}
