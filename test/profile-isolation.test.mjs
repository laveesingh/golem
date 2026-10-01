// W1: native bootstrap + real dashboard/Vite proxies; no real harness calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveProfile, assertPortBlockFree, assertNativeSocketLength } from '../cli/bootstrap.ts';
import { createScratchTicket, archiveTicket, SMOKE_PROJECT } from '../dashboard/scripts/_scratch.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gol457-'));
const home = path.join(temp, 'home');
const bin = path.join(temp, 'bin');
fs.mkdirSync(home); fs.mkdirSync(bin);
const node = process.execPath;
const entry = path.join(repo, 'cli/golem-bin.js');
const children = [], tickets = [], watches = [], events = [], aliases = [];
const previousApi = process.env.GOLEM_SMOKE_API;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const native = (name, code) => {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!${node}\n${code}\n`, { mode: 0o700 });
  return file;
};
native('claude', 'console.log(JSON.stringify({agents:[]}));');
native('pi', 'throw Error("real Pi forbidden in W1");');
// Herdr 0.9.1 session.rs: data_dir_for/list_sessions use config_dir()/sessions.
// This simulator checks the Golem boundary; source proof is in docs/profiles.md.
const herdr = native('herdr', `const fs=require('fs'),path=require('path');
const root=path.join(process.env.XDG_CONFIG_HOME,'herdr','sessions');
const rows=fs.existsSync(root)?fs.readdirSync(root).map(name=>({name,running:false,default:false,session_dir:path.join(root,name),socket_path:path.join(root,name,'herdr.sock')})):[];
const args=process.argv.slice(2);
if(args.join(' ')==='session list --json')console.log(JSON.stringify({sessions:rows}));
else if(args[0]==='--session' && args[2]==='pane' && args[3]==='run') {
  const session=args[1],dir=path.join(root,session);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'pane-launch.json'),JSON.stringify({session,socket:path.join(dir,'herdr.sock'),config:process.env.XDG_CONFIG_HOME,args}));
} else throw Error('native calls forbidden: '+args.join(' '));`);
const sentinelRoots = ['.golem', '.claude', '.pi', '.agents', '.config/herdr', '.local/state/herdr'].map(rel => path.join(home, rel));
for (const dir of sentinelRoots) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sentinel'), `untouched:${dir}`);
  watches.push(fs.watch(dir, { recursive: true }, (event, file) => events.push([dir, event, String(file)])));
}
fs.mkdirSync(path.join(home, '.claude', 'sessions'));
fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), 'fake credential: MUST NOT COPY');
// Allow initial sentinel writes to settle before the observed interval.
await sleep(100);
const dirty = {
  ...process.env, HOME: home, TMPDIR: temp, PATH: `${bin}:${process.env.PATH}`, LOG_LEVEL: 'error',
  GOLEM_HOME: path.join(home, '.golem'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  PI_CODING_AGENT_DIR: path.join(home, '.pi'), PI_CODING_AGENT_SESSION_DIR: path.join(home, '.pi', 'sessions'),
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local/state'),
  XDG_DATA_HOME: home, XDG_CACHE_HOME: home, XDG_RUNTIME_DIR: home,
  GOLEM_USER_SKILLS_ROOT: path.join(home, '.agents'), GOLEM_PROJECTS_ROOT: home, GOLEM_IDEAS_ROOT: home,
  GOLEM_TRACKER_DB: path.join(home, '.golem', 'tracker.db'), GOLEM_ASSETS_DIR: home,
  GOLEM_TYPED_DELIVERY_TOMBSTONES_DB: path.join(home, '.golem', 'typed.db'),
  GOLEM_VITE_CACHE_DIR: path.join(home, '.golem', 'live-vite-cache'),
  GOLEM_DASHBOARD_URL: 'http://127.0.0.1:7420', GOLEM_CHANNEL_URL: 'http://127.0.0.1:7421', GOLEM_CHANNEL_PORT: '7421', PORT: '7420', HOST: '0.0.0.0',
  GOLEM_HERDR_BIN: herdr, GOLEM_HERDR_SESSION: 'live', HERDR_SESSION: 'live', HERDR_SOCKET_PATH: '/forbidden/live.sock',
  HERDR_CLIENT_SOCKET_PATH: '/forbidden/client.sock', HERDR_CONFIG_PATH: '/forbidden/config.toml', HERDR_ENV: '1', HERDR_PANE_ID: 'live-pane',
  GOLEM_SESSION_ID: 'live', GOLEM_CEO_SESSION_ID: 'live', CLAUDE_CODE_SESSION_ID: 'live', PI_SESSION_ID: 'live', PI_SESSION_FILE: '/forbidden/session',
  GOLEM_SUBSTRATE_ROOT: '/forbidden/substrate', GOLEM_ROLES_DIR: '/forbidden/roles', CLAUDE_PLUGIN_ROOT: '/forbidden/plugin', GOLEM_RENDER_ROOT: '/forbidden/render',
};
const run = (args, options = {}) => spawnSync(node, [entry, ...args], { cwd: repo, env: dirty, encoding: 'utf8', timeout: 60000, ...options });
async function freeBlock(exclude = []) {
  for (let port = 22000 + Math.floor(Math.random() * 10000); port < 60000; port += 3) {
    if (exclude.some(p => Math.abs(p - port) < 3)) continue;
    try { await assertPortBlockFree(port); return port; } catch {}
  }
  throw Error('no private port block');
}
function launch(name) {
  const child = spawn(node, [entry, '--profile', name, 'dev'], { cwd: repo, env: dirty, stdio: ['ignore', 'pipe', 'pipe'] });
  const row = { child, ended: once(child, 'exit'), log: '' };
  child.stdout.on('data', data => row.log += data); child.stderr.on('data', data => row.log += data);
  children.push(row); return row;
}
async function ready(base, row) {
  for (let i = 0; i < 200; i++) {
    if (row.child.exitCode !== null) throw Error(row.log);
    try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw Error(`startup timeout ${base}\n${row.log}`);
}
async function json(base, route) {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.ok, true, `${route}: ${response.status} ${await (!response.ok ? response.text() : Promise.resolve(''))}`);
  return response.json();
}
async function stop(row) {
  if (row.child.exitCode === null && row.child.signalCode === null) row.child.kill('SIGTERM');
  const timeout = setTimeout(() => row.child.kill('SIGKILL'), 10000);
  try { await row.ended; } finally { clearTimeout(timeout); }
}
try {
  fs.writeFileSync(path.join(sentinelRoots[0], 'sentinel'), `untouched:${sentinelRoots[0]}`);
  for (let i = 0; i < 60 && !events.length; i++) await sleep(50);
  assert.ok(events.length > 0, 'fixture write must exercise the sentinel watcher');
  // Let the native recursive watch's initial coalescing window drain.
  await sleep(1500); events.length = 0;
  const unprofiled = { ...dirty }, unprofiledArgs = ['agent', 'create', '--profile', 'model-preset'];
  assert.equal(resolveProfile(unprofiledArgs, unprofiled), null);
  assert.deepEqual(unprofiled, dirty); assert.deepEqual(unprofiledArgs, ['agent', 'create', '--profile', 'model-preset']);
  for (const name of ['../escape', '', 'Dev', 'a/b', 'a'.repeat(33)]) {
    const r = run(['--profile', name, 'help']); assert.equal(r.status, 2); assert.match(r.stderr, /profile name|requires a value/);
  }
  const zero = run(['--profile', 'zero', '--port', '0', 'dev']); assert.equal(zero.status, 2); assert.match(zero.stderr, /port 0/);
  const ports = [await freeBlock()]; ports.push(await freeBlock(ports));
  const envs = ['alpha', 'beta'].map((name, i) => {
    const env = { ...dirty }; const args = ['--profile', name, '--port', String(ports[i]), 'help'];
    const profile = resolveProfile(args, env);
    aliases.push({ alias: env.XDG_CONFIG_HOME, target: path.join(env.GOLEM_PROFILE_ROOT, 'xdg/config') });
    assert.equal(profile.port, ports[i]); assert.deepEqual(args, ['help']);
    for (const key of ['GOLEM_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'GOLEM_USER_SKILLS_ROOT', 'GOLEM_PROJECTS_ROOT', 'GOLEM_IDEAS_ROOT']) assert.ok(fs.realpathSync(env[key]).startsWith(fs.realpathSync(env.GOLEM_PROFILE_ROOT) + path.sep), key);
    assert.equal(env.PORT, String(ports[i])); assert.equal(env.HOST, '127.0.0.1'); assert.equal(env.GOLEM_VITE_PORT, String(ports[i] + 1)); assert.equal(env.GOLEM_LADLE_PORT, String(ports[i] + 2));
    assert.equal(env.GOLEM_DASHBOARD_URL, `http://127.0.0.1:${ports[i]}`);
    assert.equal(env.GOLEM_CHANNEL_PORT, '0', 'dirty inherited channel port must be reset before any MCP listener can start');
    const rawPort = env.GOLEM_CHANNEL_PORT;
    const consumerPort = rawPort != null && rawPort.trim() !== '' && Number.isFinite(Number(rawPort)) ? Number(rawPort) : 0;
    assert.equal(consumerPort, 0);
    for (const key of ['GOLEM_HERDR_SESSION', 'HERDR_SESSION', 'HERDR_SOCKET_PATH', 'HERDR_CONFIG_PATH', 'HERDR_PANE_ID', 'GOLEM_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'PI_SESSION_FILE', 'CLAUDE_PLUGIN_ROOT', 'GOLEM_RENDER_ROOT']) assert.equal(env[key], undefined, key);
    assert.equal(fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json')), false);
    assert.equal(fs.existsSync(path.join(env.PI_CODING_AGENT_DIR, 'auth.json')), false);
    return env;
  });
  for (const key of ['GOLEM_HOME', 'GOLEM_TRACKER_DB', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'GOLEM_PROJECTS_ROOT', 'GOLEM_IDEAS_ROOT']) assert.notEqual(envs[0][key], envs[1][key]);
  assert.notEqual(envs[0].XDG_CONFIG_HOME, envs[1].XDG_CONFIG_HOME);
  const stable = { ...dirty }; resolveProfile(['--profile', 'alpha', 'help'], stable); assert.equal(stable.PORT, String(ports[0]));
  const localArgs = ['--profile', 'alpha', 'pi', '--profile', 'model-preset'];
  resolveProfile(localArgs, { ...dirty }); assert.deepEqual(localArgs, ['pi', '--profile', 'model-preset']);
  const forwardedArgs = ['--profile', 'alpha', 'claude', '--', '--port', '9999'];
  resolveProfile(forwardedArgs, { ...dirty }); assert.deepEqual(forwardedArgs, ['claude', '--', '--port', '9999']);
  assert.throws(() => resolveProfile(['--profile', 'alpha', '--port', String(ports[1]), 'dev'], { ...dirty }), /persisted block/);
  const alias = aliases[0].alias, owner = path.dirname(alias), target = aliases[0].target;
  fs.chmodSync(owner, 0o755);
  assert.throws(() => resolveProfile(['--profile', 'alpha', 'help'], { ...dirty }), /unsafe.*owner/);
  fs.chmodSync(owner, 0o700);
  fs.renameSync(owner, owner + '-owned-fixture'); fs.symlinkSync(home, owner);
  assert.throws(() => resolveProfile(['--profile', 'alpha', 'help'], { ...dirty }), /unsafe.*owner/);
  assert.equal(fs.readlinkSync(owner), home); fs.unlinkSync(owner); fs.renameSync(owner + '-owned-fixture', owner);
  fs.writeFileSync(path.join(owner, 'unknown'), 'owned collision fixture');
  assert.throws(() => resolveProfile(['--profile', 'alpha', 'help'], { ...dirty }), /unknown entries/);
  assert.equal(fs.readFileSync(path.join(owner, 'unknown'), 'utf8'), 'owned collision fixture');
  fs.unlinkSync(path.join(owner, 'unknown'));
  fs.unlinkSync(alias); fs.symlinkSync(home, alias);
  assert.throws(() => resolveProfile(['--profile', 'alpha', 'help'], { ...dirty }), /unsafe.*alias/);
  assert.equal(fs.readlinkSync(alias), home); fs.unlinkSync(alias); fs.symlinkSync(target, alias);
  assert.throws(() => assertNativeSocketLength('/too-long/' + 'x'.repeat(100)), /exceeds 103/);
  // Exercise an actual Unix listener at the source-derived alias spelling,
  // without starting native herdr or any harness. The canonical path is long.
  const aliasSocket = path.join(alias, 'herdr/sessions', `g-${'a'.repeat(28)}`, 'herdr-client.sock');
  fs.mkdirSync(path.dirname(aliasSocket), { recursive: true });
  const unix = net.createServer(); await new Promise((resolve, reject) => { unix.once('error', reject); unix.listen(aliasSocket, resolve); });
  await new Promise(resolve => unix.close(resolve));
  fs.rmdirSync(path.dirname(aliasSocket));
  console.log('namespace alias: distinct owned 0700 aliases; permissions/unknown-entry/target tamper fail closed; allocated socket byte limit and actual Node Unix bind pass');
  const help = run(['--profile', 'alpha', 'help']); assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /dashboard/);
  const manifestBefore = fs.readFileSync(path.join(envs[0].GOLEM_PROFILE_ROOT, 'profile.json'), 'utf8');
  const privateEntriesBefore = fs.readdirSync(envs[0].GOLEM_HOME);
  const migration = run(['--profile', 'alpha', 'migrate-home']); assert.equal(migration.status, 2); assert.match(migration.stderr, /production-only/);
  assert.equal(fs.readFileSync(path.join(envs[0].GOLEM_PROFILE_ROOT, 'profile.json'), 'utf8'), manifestBefore);
  assert.deepEqual(fs.readdirSync(envs[0].GOLEM_HOME), privateEntriesBefore);
  const normalMigrationHelp = run(['migrate-home', '--help']); assert.equal(normalMigrationHelp.status, 0); assert.match(normalMigrationHelp.stdout, /One-time move/);
  assert.equal(run(['dev']).status, 2);
  for (let offset = 0; offset < 3; offset++) {
    const occupied = net.createServer(); await new Promise(resolve => occupied.listen(ports[0] + offset, '127.0.0.1', resolve));
    try { const r = run(['--profile', 'alpha', 'dev']); assert.equal(r.status, 2); assert.match(r.stderr, /occupied or unavailable/); }
    finally { await new Promise(resolve => occupied.close(resolve)); }
  }
  // Spoof an exact server command/recorded PID but a FOREIGN GOLEM_HOME.
  // The expendable fixture owns alpha's dashboard port; restart must not signal it.
  const foreignChild = spawn(node, ['-e', `require('net').createServer().listen(${ports[0]},'127.0.0.1',()=>console.log('ready'));`], {env:{PATH:dirty.PATH,HOME:home,GOLEM_HOME:path.join(temp,'foreign-state')},stdio:['ignore','pipe','pipe']});
  const foreign = {child:foreignChild,ended:once(foreignChild,'exit'),log:''}; children.push(foreign);
  let foreignReady = false; foreignChild.stdout.on('data', () => { foreignReady = true; });
  foreignChild.stderr.on('data', data => foreign.log += data);
  for (let i = 0; i < 60 && !foreignReady; i++) { assert.equal(foreignChild.exitCode, null, foreign.log); await sleep(50); }
  assert.equal(foreignReady, true, 'foreign fixture startup must be bounded');
  const ps = native('fixture-ps', `const args=process.argv.slice(2);const command=${JSON.stringify(`${node} ${path.join(repo, 'dashboard/server/index.js')}`)};console.log(args.includes('-axo')?${foreignChild.pid}+' '+command:command+' GOLEM_HOME='+${JSON.stringify(path.join(temp,'foreign-state'))});`);
  const recordFile = path.join(envs[0].GOLEM_HOME, 'dashboard.json'); fs.writeFileSync(recordFile, JSON.stringify({pid:foreignChild.pid}));
  try {
    const restart = run(['--profile','alpha','dashboard:restart'], {env:{...dirty,GOLEM_PS_BIN:ps}});
    assert.equal(restart.status, 2, restart.stdout + restart.stderr); assert.match(restart.stderr,/occupied or unavailable/);
    assert.equal(foreignChild.exitCode, null); assert.equal(foreignChild.signalCode, null); process.kill(foreignChild.pid,0);
    assert.match(restart.stdout, /dashboard was not running/);
  } finally { await stop(foreign); fs.unlinkSync(recordFile); }
  console.log('bootstrap: invalid names/port 0, dirty overrides, stable disjoint roots, all occupied ports refused (exit 2); native CLI help exit 0; profile migration refused without writes; unprofiled migration help unchanged; restart foreign owner not signaled');

  // Each instruction render writes only its private native Claude config root.
  for (const [i, env] of envs.entries()) {
    const name = i ? 'beta' : 'alpha';
    const r = run(['--profile', name, 'sync', '--target', 'cc']); assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(env.GOLEM_HOME, 'renders/cc-plugin/.claude-plugin/plugin.json')));
    assert.ok(fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR, 'CLAUDE.md')));
    const custom = run(['--profile', name, 'sync', '--target', 'cc', '--out', path.join(env.GOLEM_PROFILE_ROOT, 'explicit-render')]);
    assert.equal(custom.status, 0, custom.stdout + custom.stderr);
    fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'herdr/sessions', `${name}-owned`), { recursive: true });
    fs.mkdirSync(path.join(env.CLAUDE_CONFIG_DIR, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'sessions', `${process.pid}.json`), JSON.stringify({pid:process.pid,sessionId:`${name}-native`,cwd:env.GOLEM_PROJECTS_ROOT,startedAt:0,procStart:0,kind:'interactive',name:`${name}-private`,updatedAt:Date.now()}));
    const skill = path.join(env.GOLEM_USER_SKILLS_ROOT, `${name}-fixture`); fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: ${name}-fixture\ndescription: private fixture\n---\nfixture`);
    const probe = spawnSync(node, ['--input-type=module', '-e', `
      const {resolveProfile}=await import('./cli/bootstrap.ts'); resolveProfile(['--profile','${name}','help']);
      const {sessionList,herdrSessionForProject,paneRun}=await import('./lib/herdr-driver.js');
      const {ensureProjectAssociation}=await import('./lib/management-registry.js');
      const {claudeConfigDir}=await import('./lib/claude-paths.js');
      const {readClaudeSessionRecord}=await import('./lib/claude-session-context.js');
      const {readNativeSessions}=await import('./dashboard/server/native-sessions.js');
      const {listSubstrateSkills}=await import('./dashboard/server/substrate.js');
      const {CONFIG}=await import('./dashboard/server/config.js');
      const {default:ladle}=await import('./dashboard/.ladle/config.mjs');
      const native=await readNativeSessions(()=>true,[],{cliRaw:[]});
      const skills=listSubstrateSkills({pool:'user'});
      const before=sessionList();
      ensureProjectAssociation('fixture-project');
      const selected=herdrSessionForProject('fixture-project');
      paneRun({session:selected,paneId:'fixture-pane',command:['echo','simulated-private-launch']});
      console.log(JSON.stringify({rows:before,selected,claude:claudeConfigDir(),record:readClaudeSessionRecord(${process.pid}),native,skills,config:CONFIG,ladle}));
    `], { cwd: repo, env: dirty, encoding: 'utf8', timeout: 10000 });
    assert.equal(probe.status, 0, probe.stderr); const snapshot = JSON.parse(probe.stdout);
    assert.equal(snapshot.claude, env.CLAUDE_CONFIG_DIR);
    assert.equal(snapshot.record.sessionId, `${name}-native`);
    assert.ok(snapshot.native.some(row => row.session_id === `${name}-native`));
    assert.ok(snapshot.skills.some(row => row.slug === `${name}-fixture`));
    assert.equal(snapshot.config.projectsRoot, env.GOLEM_PROJECTS_ROOT); assert.equal(snapshot.config.ideasRoot, env.GOLEM_IDEAS_ROOT);
    assert.ok(snapshot.config.channelUrl.startsWith(env.GOLEM_DASHBOARD_URL));
    assert.equal(snapshot.ladle.port, ports[i] + 2);
    const shell = spawnSync('/bin/bash', ['-c', '. "$1"; printf "%s" "$CLAUDE_CONFIG_DIR_RESOLVED"', 'resolver', path.join(repo, 'substrate/hooks/_golem-home.sh')], { env, encoding: 'utf8' });
    assert.equal(shell.status, 0, shell.stderr); assert.equal(shell.stdout, env.CLAUDE_CONFIG_DIR);
    assert.deepEqual(snapshot.rows.map(r => r.name), [`${name}-owned`]);
    assert.ok(snapshot.rows[0].socket_path.startsWith(env.XDG_CONFIG_HOME));
    assert.match(snapshot.selected, /^g-[a-f0-9]{28}$/);
    const launch = JSON.parse(fs.readFileSync(path.join(env.XDG_CONFIG_HOME, 'herdr/sessions', snapshot.selected, 'pane-launch.json')));
    assert.equal(launch.session, snapshot.selected); assert.equal(launch.config, env.XDG_CONFIG_HOME);
    assert.equal(launch.socket, path.join(env.XDG_CONFIG_HOME, 'herdr/sessions', snapshot.selected, 'herdr.sock'));
    assert.notEqual(launch.session, 'live');
    if (!i) {
      const piSync = run(['--profile', name, 'sync', '--target', 'pi']); assert.equal(piSync.status, 0, piSync.stdout + piSync.stderr);
      for (const target of ['cc-plugin', 'pi']) {
        const render = path.join(env.GOLEM_HOME, 'renders', target), childEnv = { ...env };
        delete childEnv.GOLEM_ROLES_DIR; delete childEnv.GOLEM_SUBSTRATE_ROOT;
        const roleUrl = pathToFileURL(path.join(render, 'lib/session-role.js')).href;
        const pathsUrl = pathToFileURL(path.join(render, 'lib/claude-paths.js')).href;
        const artifact = spawnSync(node, ['--input-type=module', '-e', `const {readRoleCard}=await import(${JSON.stringify(roleUrl)}); const {claudeConfigDir}=await import(${JSON.stringify(pathsUrl)}); if(!readRoleCard('lead'))throw Error('missing render-local role card'); if(claudeConfigDir()!==process.env.CLAUDE_CONFIG_DIR)throw Error('wrong native config root'); console.log('render helper import and role discovery pass');`], { cwd: temp, env: childEnv, encoding: 'utf8', timeout: 10000 });
        assert.equal(artifact.status, 0, artifact.stderr);
      }
    }
  }
  const doctor = run(['--profile', 'alpha', 'doctor']);
  assert.ok(doctor.status === 0 || doctor.status === 1, doctor.stderr);
  assert.match(doctor.stdout, /production migration diagnostics skipped for isolated profile/);
  console.log('private CC sync/default and explicit output exit 0; CC/Pi render helper imports pass; doctor skips production migration diagnostics; native inventory boundary simulated from verified v0.9.1 source; no native acceptance claimed');

  // Start BOTH real rendered MCP consumers from the dirty environment. Assert
  // the resolved port before importing the listener, so a regression cannot
  // accidentally bind a production port during this test.
  const mcps = ['alpha', 'beta'].map((name, i) => {
    const url = pathToFileURL(path.join(envs[i].GOLEM_HOME, 'renders/cc-plugin/mcp/channel/index.js')).href;
    const script = `const {resolveProfile}=await import('./cli/bootstrap.ts'); resolveProfile(['--profile','${name}','help']); if(process.env.GOLEM_CHANNEL_PORT!=='0')throw Error('unsafe inherited MCP listener port'); await import(${JSON.stringify(url)});`;
    const child = spawn(node, ['--input-type=module', '-e', script], {cwd:repo,env:dirty,stdio:['pipe','pipe','pipe']});
    const row = {child,ended:once(child,'exit'),log:'',env:envs[i],name};
    child.stderr.on('data', data => row.log += data); children.push(row); return row;
  });
  const mcpConsumers = [];
  for (const row of mcps) {
    let lease;
    for (let i = 0; i < 100; i++) {
      assert.equal(row.child.exitCode, null, row.log);
      try { lease = JSON.parse(fs.readFileSync(path.join(row.env.GOLEM_HOME,'endpoint-leases.json'),'utf8')).leases.find(l => l.pid === row.child.pid); } catch {}
      if (lease) break; await sleep(100);
    }
    assert.ok(lease, 'rendered MCP listener startup must be bounded: ' + row.log);
    assert.equal(lease.host, '127.0.0.1'); assert.ok(lease.port > 0);
    assert.ok(![7420,7421,...ports.flatMap(p=>[p,p+1,p+2])].includes(lease.port));
    const health = `http://127.0.0.1:${lease.port}/healthz?session_id=${encodeURIComponent(lease.canonical_id)}&owner_token=${encodeURIComponent(lease.owner_token)}`;
    const response = await fetch(health, {signal:AbortSignal.timeout(5000)});
    assert.equal(response.status, 200, await (!response.ok ? response.text() : Promise.resolve('')));
    assert.equal((await response.json()).canonical_id, `${row.name}-native`);
    const channels = JSON.parse(fs.readFileSync(path.join(row.env.GOLEM_HOME,'channels.json'),'utf8')).channels;
    assert.ok(channels.some(c => c.pid === row.child.pid && c.port === lease.port && c.session_id === `${row.name}-native`));
    assert.ok(channels.every(c => c.session_id !== `${row.name === 'alpha' ? 'beta' : 'alpha'}-native`));
    mcpConsumers.push({row,lease,health});
  }
  assert.notEqual(mcpConsumers[0].lease.port, mcpConsumers[1].lease.port);
  await stop(mcps[0]); assert.equal(mcps[0].child.exitCode,0,mcps[0].log);
  assert.equal((await fetch(mcpConsumers[1].health,{signal:AbortSignal.timeout(5000)})).status,200);
  await stop(mcps[1]); assert.equal(mcps[1].child.exitCode,0,mcps[1].log);
  for (const {row} of mcpConsumers) {
    const leases = JSON.parse(fs.readFileSync(path.join(row.env.GOLEM_HOME,'endpoint-leases.json'),'utf8')).leases;
    const channels = JSON.parse(fs.readFileSync(path.join(row.env.GOLEM_HOME,'channels.json'),'utf8')).channels;
    assert.ok(leases.every(l => l.pid !== row.child.pid)); assert.ok(channels.every(c => c.pid !== row.child.pid));
  }
  console.log('two real private rendered MCP listeners: dirty channel7421 resets to0, distinct ephemeral ports, isolated lease/registry health, stop alpha retains beta, both registrations cleaned');

  const rows = ['alpha', 'beta'].map(launch);
  const bases = ports.map(port => `http://127.0.0.1:${port + 1}`);
  await Promise.all(bases.map((base, i) => ready(base, rows[i])));
  for (let i = 0; i < 2; i++) {
    const frontend = await fetch(bases[i] + '/', {signal:AbortSignal.timeout(5000)}); assert.equal(frontend.status, 200);
    assert.match(await frontend.text(), /@vite\/client/);
    process.env.GOLEM_SMOKE_API = bases[i];
    const ticket = await createScratchTicket({ title: `profile ${i}`, body: 'Private proxy fixture' });
    tickets.push({ id: ticket.id, base: bases[i] });
    const list = await json(bases[i], `/api/tickets?project=${SMOKE_PROJECT}`);
    assert.equal(list.length, 1); assert.equal(list[0].title, `SMOKE-profile ${i}`);
    const other = await json(bases[1 - i], `/api/tickets?project=${SMOKE_PROJECT}`);
    if (!i) assert.equal(other.length, 0);
    else assert.equal(other[0].title, 'SMOKE-profile 0');
    const config = await json(bases[i], '/api/health'); assert.ok(config);
    const status = run(['--profile', i ? 'beta' : 'alpha', 'status', '--json']);
    assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).dashboard_url, `http://127.0.0.1:${ports[i]}`);
    assert.ok(fs.existsSync(envs[i].GOLEM_TRACKER_DB));
    assert.ok(envs[i].GOLEM_VITE_CACHE_DIR.startsWith(envs[i].GOLEM_HOME + path.sep));
    assert.ok(fs.existsSync(path.join(envs[i].GOLEM_HOME, 'dashboard.json')));
  }
  for (const ticket of tickets.splice(0)) { process.env.GOLEM_SMOKE_API = ticket.base; await archiveTicket(ticket.id); }
  await stop(rows[0]); assert.equal(rows[0].child.exitCode, 0, rows[0].log);
  await assertPortBlockFree(ports[0]);
  assert.ok((await json(bases[1], '/api/health')));
  await stop(rows[1]); assert.equal(rows[1].child.exitCode, 0, rows[1].log);
  await assertPortBlockFree(ports[1]);
  await sleep(100);
  assert.deepEqual(events, [], 'fake live-path watch observed a write');
  for (const dir of sentinelRoots) assert.equal(fs.readFileSync(path.join(dir, 'sentinel'), 'utf8'), `untouched:${dir}`);
  assert.equal(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'), 'fake credential: MUST NOT COPY');
  console.log('two real dashboard/Vite proxies: isolated scratch creates/reads, own DB and registries, status uses private origin; stop alpha retains beta; both port blocks released; sentinel watch 0 events');
} finally {
  for (const ticket of tickets) { process.env.GOLEM_SMOKE_API = ticket.base; try { await archiveTicket(ticket.id); } catch {} }
  for (const row of children) await stop(row);
  for (const watch of watches) watch.close();
  if (previousApi === undefined) delete process.env.GOLEM_SMOKE_API; else process.env.GOLEM_SMOKE_API = previousApi;
  // Remove only the exact owned aliases created by this temporary HOME.
  for (const {alias,target} of aliases) {
    const owner = path.dirname(alias), stat = fs.lstatSync(owner), link = fs.lstatSync(alias);
    assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o777, 0o700);
    assert.equal(stat.isDirectory(), true); assert.equal(link.isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(alias), target); assert.deepEqual(fs.readdirSync(owner), ['c']);
    fs.unlinkSync(alias); fs.rmdirSync(owner);
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
