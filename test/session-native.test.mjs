#!/usr/bin/env node
// Session phase integration: real herdr, no harness launches, disposable state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-session-native-'));
const xdg = `/tmp/golem-sess-${process.pid}`;
const home = path.join(root, 'home'), state = path.join(root, 'state'), project = path.join(root, 'project');
for (const dir of [home, state, project]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# disposable session test\n');
const env = { ...process.env, HOME: home, GOLEM_HOME: state, XDG_CONFIG_HOME: xdg, HERDR_ENV: '0' };
for (const key of ['GOLEM_HERDR_SESSION', 'HERDR_SESSION', 'HERDR_SOCKET_PATH', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID', 'GOLEM_SESSION_ID', 'CLAUDE_SESSION_ID', 'PI_SESSION_ID', 'PI_SESSION_FILE']) delete env[key];
const cli = (args, family = 'session') => {
  const result = spawnSync(process.execPath, [path.join(repo, 'cli/golem.js'), family, ...args, '--json'], { cwd: project, env, encoding: 'utf8', timeout: 45000 });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.error?.message ?? result.stderr} ${result.stdout}`);
  return JSON.parse(result.stdout);
};
const native = args => spawnSync('herdr', args, { env, encoding: 'utf8', timeout: 10000 });
let session;
try {
  const dry = cli(['start', '--project', project, '--dry-run']);
  assert.equal(dry.plan.association, 'allocation-required-on-real-mutation');
  assert.equal(fs.existsSync(path.join(state, 'herdr-mappings.json')), false);
  const started = cli(['start', '--project', project]); session = started.session;
  assert.match(session, /^g-[0-9a-f]{28}$/); assert.equal(started.started, true);
  const again = cli(['start', '--project', project]); assert.equal(again.noop, true); assert.equal(again.session, session);
  const team = cli(['create', 'Native Team', '--project', project], 'team');
  const teamInspect = cli(['inspect', team.team_id], 'team'); assert.equal(teamInspect.capabilities.focus.state, 'available');
  assert.equal(cli(['focus', team.team_id], 'team').focused, true);
  const renamed = cli(['rename', team.team_id, 'Renamed Native Team'], 'team'); assert.equal(renamed.team_id, team.team_id); assert.equal(renamed.herdr_workspace_id, team.herdr_workspace_id); assert.equal(renamed.display_updated, true);
  const ws = native(['--session', session, 'workspace', 'create', '--label', 'Unowned Native Workspace']); assert.equal(ws.status, 0, ws.stderr);
  const workspaceId = JSON.parse(ws.stdout).result.workspace.workspace_id; assert.ok(workspaceId);
  const panes = native(['--session', session, 'pane', 'list']); assert.equal(panes.status, 0);
  const originalPane = JSON.parse(panes.stdout).result.panes.find(p => p.workspace_id === team.herdr_workspace_id); assert.ok(originalPane);
  const labelResult = native(['--session', session, 'pane', 'rename', originalPane.pane_id, 'Logical pane display']); assert.equal(labelResult.status, 0);
  const moveResult = native(['--session', session, 'pane', 'move', originalPane.pane_id, '--workspace', workspaceId, '--new-tab', '--no-focus']); assert.equal(moveResult.status, 0, moveResult.stderr);
  const movedPane = JSON.parse(moveResult.stdout).result.move_result.pane; assert.ok(movedPane?.pane_id && movedPane?.tab_id, moveResult.stdout); assert.equal(movedPane.workspace_id, workspaceId);
  const adopted = cli(['adopt', 'Adopted Native Team', '--workspace', workspaceId, '--project', project], 'team'); assert.equal(adopted.herdr_workspace_id, workspaceId);
  assert.equal(cli(['adopt', 'Adopted Native Team', '--workspace', workspaceId, '--project', project], 'team').noop, true);
  const inspect = cli(['inspect', session]); assert.equal(inspect.native_running, true);
  const stopped = cli(['stop', session]); assert.equal(stopped.lifecycle, 'stopped'); assert.equal(stopped.native_stopped, true);
  const retained = cli(['inspect', session]); assert.equal(retained.native_registered, true); assert.equal(retained.native_running, false);
  const retainedTeams = JSON.parse(fs.readFileSync(path.join(state, 'teams.json'), 'utf8')).teams;
  assert.equal(retainedTeams.find(t => t.team_id === team.team_id).lifecycle, 'open'); assert.equal(retainedTeams.find(t => t.team_id === adopted.team_id).lifecycle, 'open');
  const restarted = cli(['start', '--project', project]); assert.equal(restarted.session, session); assert.equal(restarted.started, true);
  const closed = cli(['close', session]); assert.equal(closed.native_deleted, true); assert.equal(closed.lifecycle, 'closed');
  const retry = cli(['close', session]); assert.equal(retry.noop, true);
  console.log('session/team native passed: real container lifecycle plus exact team create/inspect/focus/rename/adopt/no-op and retained definitions');
} finally {
  // Stop/delete before destroying the HOME/socket tree, even on assertion failure.
  if (!session) {
    const file = path.join(state, 'herdr-mappings.json');
    if (fs.existsSync(file)) session = Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).projects ?? {})[0]?.session;
  }
  if (session) { native(['session', 'stop', session]); native(['session', 'delete', session]); }
  const processes = spawnSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' });
  assert.equal(processes.status, 0, processes.stderr);
  const survivors = session ? processes.stdout.split('\n').filter(line => line.includes(`--session ${session}`) && /\bherdr\b/.test(line)) : [];
  assert.deepEqual(survivors, [], 'owned native process survived cleanup; resources retained for diagnosis');
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(xdg, { recursive: true, force: true });
  console.log('session native cleanup passed: owned server absent; HOME/socket trees removed after stop/delete');
}
