#!/usr/bin/env node
// Explicit real-app acceptance. No fake harness or silent skip/pass substitute.
import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import crypto from 'node:crypto'; import http from 'node:http'; import { spawn, spawnSync } from 'node:child_process'; import { once } from 'node:events'; import { fileURLToPath } from 'node:url';
if (process.env.GOLEM_REAL_HARNESS !== '1') { console.error('UNVERIFIED: real harness opt-in required: GOLEM_REAL_HARNESS=1'); process.exit(2); }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), cli = path.join(repo,'cli/golem.js');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'golemtest-management-real-'))), xdg = `/tmp/golem-real-${process.pid}`;
const home = path.join(root,'home'), state = path.join(root,'state'), project = path.join(root,'project'), outside = path.join(root,'outside');
for (const dir of [home,state,project,outside]) fs.mkdirSync(dir,{recursive:true}); fs.chmodSync(root,0o700); fs.writeFileSync(path.join(project,'CLAUDE.md'),'# Disposable actual management acceptance\n');
const originalHome = process.env.HOME, nativeName = `golem-test-${process.pid}-real`;
const env = { ...process.env, HOME: home, GOLEM_HOME: state, XDG_CONFIG_HOME: xdg, GOLEM_HERDR_SESSION: nativeName, HERDR_ENV:'0', GOLEM_TRACKER_DB:path.join(root,'tracker.db'), GOLEM_PROJECTS_ROOT:path.join(root,'projects'), GOLEM_IDEAS_ROOT:path.join(root,'ideas'), GOLEM_ROOT:repo, HOST:'127.0.0.1', CLAUDE_CONFIG_DIR:path.join(home,'.claude') };
for (const dir of [env.GOLEM_PROJECTS_ROOT,env.GOLEM_IDEAS_ROOT,env.CLAUDE_CONFIG_DIR,path.join(home,'.pi','agent')]) fs.mkdirSync(dir,{recursive:true});
for (const key of ['PI_SESSION_ID','PI_SESSION_FILE','PI_MODEL','PI_PROVIDER','PI_REASONING_LEVEL','GOLEM_SESSION_ID','GOLEM_CEO_SESSION_ID','CLAUDE_CODE_SESSION_ID','CLAUDECODE','CLAUDE_CODE_CHILD_SESSION','HERDR_SESSION','HERDR_SOCKET_PATH','HERDR_PANE_ID','HERDR_TAB_ID','HERDR_WORKSPACE_ID','PI_CODING_AGENT_DIR','PI_CODING_AGENT_SESSION_DIR']) delete env[key];
// Private credential copies only: original files never changed, contents never
// printed/staged. OAuth refreshes, if needed, affect only these mode0600 copies.
for (const name of ['auth.json','models.json']) { const source = path.join(originalHome,'.pi','agent',name); if(fs.existsSync(source)) { const dest=path.join(home,'.pi','agent',name); fs.copyFileSync(source,dest); fs.chmodSync(dest,0o600); } }
for (const name of ['.credentials.json','settings.json']) { const source=path.join(originalHome,'.claude',name); if(fs.existsSync(source)) { const dest=path.join(env.CLAUDE_CONFIG_DIR,name); fs.copyFileSync(source,dest); fs.chmodSync(dest,0o600); } }
const ccConfig=path.join(originalHome,'.claude.json'); if(fs.existsSync(ccConfig)) { fs.copyFileSync(ccConfig,path.join(home,'.claude.json')); fs.chmodSync(path.join(home,'.claude.json'),0o600); }
const shell = value => `'${String(value).replace(/'/g,"'\\''")}'`;
const run = (args,{json=true,timeout=45000}={}) => { const result=spawnSync(process.execPath,[cli,...args],{cwd:project,env,encoding:'utf8',timeout}); assert.equal(result.status,0,`${args.slice(0,3).join(' ')}: ${result.error?.message ?? result.stderr} ${result.stdout}`); return json?JSON.parse(result.stdout):result.stdout; };
const native = args => { const result=spawnSync('herdr',['--session',nativeName,...args],{env,encoding:'utf8',timeout:10000}); assert.equal(result.status,0,result.stderr||result.stdout); return result.stdout.trim() ? JSON.parse(result.stdout).result : null; };
const waitFile = async (file,timeout=120000,log=null) => { const deadline=Date.now()+timeout; while(Date.now()<deadline){if(fs.existsSync(file)){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{}} if(log&&fs.existsSync(log)&&/Not logged in.*Please run \/login/.test(fs.readFileSync(log,'utf8')))throw new Error('UNVERIFIED: actual Claude reports Not logged in · Please run /login'); await new Promise(r=>setTimeout(r,250));} throw new Error(`UNVERIFIED: actual actor never produced ${path.basename(file)} within ${timeout}ms`); };
let dashboard, dashExit, dashboardLog=''; const actorLogs=[];
try {
  const socket=http.createServer(); await new Promise(r=>socket.listen(0,'127.0.0.1',r)); const port=socket.address().port; await new Promise(r=>socket.close(r)); env.PORT=String(port); env.GOLEM_DASHBOARD_URL=`http://127.0.0.1:${port}`;
  dashboard=spawn(process.execPath,[path.join(repo,'dashboard/server/index.js')],{cwd:repo,env,stdio:['ignore','pipe','pipe']}); dashExit=once(dashboard,'exit'); dashboard.stdout.on('data',d=>dashboardLog+=d); dashboard.stderr.on('data',d=>dashboardLog+=d);
  let ready=false; for(let i=0;i<150;i++){try{ready=(await fetch(`${env.GOLEM_DASHBOARD_URL}/api/health`)).ok;}catch{}if(ready)break;if(dashboard.exitCode!=null)throw new Error(dashboardLog);await new Promise(r=>setTimeout(r,100));} assert.equal(ready,true,'owned dashboard startup');
  const registered=JSON.parse(fs.readFileSync(path.join(state,'dashboard.json'),'utf8')); assert.equal(registered.url,env.GOLEM_DASHBOARD_URL,'private endpoint must be verified');
  const piRender=path.join(root,'pi-render'), ccRender=path.join(root,'cc-render');
  run(['sync','--target','pi','--out',piRender,'--force'],{json:false}); run(['sync','--target','cc','--out',ccRender,'--force'],{json:false});
  const team=run(['team','create','Real Team','--project',project,'--json']);
  const human= native(['tab','create','--workspace',team.herdr_workspace_id,'--label','Actual human shell']).root_pane;
  assert.ok(human?.pane_id);
  const humanFile=path.join(root,'human-context.json');
  native(['pane','run',human.pane_id,...['bash','-c',`${shell(process.execPath)} ${shell(cli)} context --json > ${shell(humanFile)}`].map(shell)]);
  const humanContext=await waitFile(humanFile,10000); assert.equal(humanContext.resolution.team_id,team.team_id); assert.equal(humanContext.resolution.provenance.team_id,'caller-pane-workspace');
  console.log(JSON.stringify({actual_human:'native shell inferred mapped workspace',team_id:team.team_id}));
  const actors = process.env.GOLEM_REAL_ACTORS ? process.env.GOLEM_REAL_ACTORS.split(',') : ['pi','claude'];
  if (actors.length !== 2) console.log('PARTIAL DIAGNOSTIC: selected real actors only; never full acceptance');
  for (const harness of actors) {
    const sourceTeam = harness === 'claude' ? run(['team','create','Claude Source','--project',project,'--json']) : team;
    const sourceHuman = harness === 'claude' ? native(['tab','create','--workspace',sourceTeam.herdr_workspace_id,'--label','Claude human shell']).root_pane : human;
    const actorFile=path.join(root,`${harness}-context.json`), cwdFile=path.join(root,`${harness}-cwd-context.json`), log=path.join(root,`${harness}.log`); actorLogs.push(log);
    const logicalFile=path.join(root,`${harness}-logical-context.json`), movedFile=path.join(root,`${harness}-moved-context.json`);
    const logicalTrigger=path.join(root,`${harness}-logical-ready`), moveTrigger=path.join(root,`${harness}-move-ready`), controlTrigger=path.join(root,`${harness}-control-ready`), probeScript=path.join(root,`${harness}-probe.sh`);
    const contextCommand=`GOLEM_HERDR_SESSION=wrong-owned-test-target ${shell(process.execPath)} ${shell(cli)} context --json`;
    fs.writeFileSync(probeScript, `#!/bin/bash\nset -e\n${contextCommand} > ${shell(actorFile)}\ncd ${shell(outside)}\n${contextCommand} > ${shell(cwdFile)}\nfor i in {1..600}; do [ -f ${shell(logicalTrigger)} ] && break; sleep .2; done\n${contextCommand} > ${shell(logicalFile)}\nfor i in {1..600}; do [ -f ${shell(moveTrigger)} ] && break; sleep .2; done\n${contextCommand} > ${shell(movedFile)}\nfor i in {1..600}; do [ -f ${shell(controlTrigger)} ] && break; sleep .2; done\n`, { mode: 0o700 });
    const probeCommand=`bash ${shell(probeScript)}`;
    const prompt=`Actual application acceptance test. Use your bash/Bash tool to execute exactly this command once (allow up to240seconds for the bounded phase handshakes): ${probeCommand}. Do not read credentials or other files. Then answer DONE. These are disposable resources authorized by the owner.`;
    const promptFile=path.join(root,`${harness}-prompt.txt`); fs.writeFileSync(promptFile,prompt);
    const created=native(['tab','create','--workspace',sourceTeam.herdr_workspace_id,'--label',`Actual ${harness}`]).root_pane; assert.ok(created?.pane_id);
    let command;
    if(harness==='pi') command=['pi','--no-extensions','-e',path.join(piRender,'golem.ts'),'-e',process.env.GOLEM_REAL_HERDR_PI_REPORTER || path.join(originalHome,'.pi','agent','extensions','herdr-agent-state.ts'),'--no-skills','--no-context-files','--provider','openai-codex','--model','gpt-6.1-sol','--thinking','xhigh','--tools','bash',`@${promptFile}`];
    else command=['claude','--plugin-dir',ccRender,'--session-id',crypto.randomUUID(),'--permission-mode','bypassPermissions','--tools','Bash','--allowedTools','Bash','--output-format','stream-json','--verbose','-p',prompt];
    const runner = path.join(root, `${harness}-runner.sh`);
    fs.writeFileSync(runner, `#!/bin/bash\ncd ${shell(project)}\n${command.map(shell).join(' ')}${harness === 'claude' ? ` >${shell(log)} 2>&1` : ''}\n`, { mode: 0o700 });
    // Keep the typed native launch line short: a long inline Claude prompt
    // exceeds the terminal canonical input buffer before Claude even starts.
    native(['pane','run',created.pane_id,...['bash',runner].map(shell)]);
    let context;
    try { context=await waitFile(actorFile,120000,log); }
    catch(error){ const text=fs.existsSync(log)?fs.readFileSync(log,'utf8'):''; const screen=spawnSync('herdr',['--session',nativeName,'pane','read',created.pane_id],{env,encoding:'utf8',timeout:10000});
      const processState=spawnSync('herdr',['--session',nativeName,'pane','process-info','--pane',created.pane_id],{env,encoding:'utf8',timeout:10000});
      const diagnostic = text + '\nOWNED PANE: '+screen.stdout+'\nOWNED PROCESS: '+processState.stdout;
      const redacted=diagnostic.replaceAll(root,'<private-test-root>').replaceAll(originalHome,'<user-home>').replace(/(Bearer\s+)[^\s"']+/gi,'$1[REDACTED]').replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token)["'\s:=]+)[^\s,"'}]+/gi,'$1[REDACTED]'); throw new Error(`${error.message}; ${harness} startup/output: ${redacted.slice(-1800)}`); }
    const changed=await waitFile(cwdFile,30000);
    assert.equal(context.resolution.evidence.callerAgent.status,'resolved',`${harness} must be a real authenticated native caller`);
    assert.equal(context.resolution.project_id,team.project_id, JSON.stringify({ harness, resolution: context.resolution, expected_project: team.project_id })); assert.equal(changed.resolution.project_id,team.project_id,'native registered project survives cwd change');
    const facts=JSON.parse(fs.readFileSync(path.join(state,'session-facts.json'),'utf8')).facts;
    const actorFact=facts.find(f=>f.harness==='pi'&&harness==='pi'||harness==='claude'&&['claude','claudecode'].includes(f.harness)); assert.ok(actorFact?.canonical_id,'actual registered identity required');
    const destination=run(['team','create',`${harness} Destination`,'--project',project,'--json']);
    run(['team','join',destination.team_id,'--agent',actorFact.canonical_id,'--project',project,'--json']); fs.writeFileSync(logicalTrigger,'ready');
    const logical=await waitFile(logicalFile,30000); assert.equal(logical.resolution.team_id,destination.team_id,'logical transfer wins old pane'); assert.equal(logical.resolution.placement.workspace_id,sourceTeam.herdr_workspace_id);
    const movement=native(['pane','move',created.pane_id,'--workspace',destination.herdr_workspace_id,'--new-tab','--no-focus']).move_result.pane; fs.writeFileSync(moveTrigger,'ready');
    const moved=await waitFile(movedFile,30000); assert.equal(moved.resolution.placement.pane_id,movement.pane_id); assert.equal(moved.resolution.placement.workspace_id,destination.herdr_workspace_id); assert.equal(moved.resolution.team_id,destination.team_id);
    const inspected=run(['agent','inspect',actorFact.canonical_id,'--project',project,'--json']);
    let nativeIdentity; try { const actual=native(['agent','get',movement.pane_id]).agent; nativeIdentity={agent:actual?.agent,session_kind:actual?.agent_session?.kind,session_value:actual?.agent_session?.value?.replaceAll(root,'<private-test-root>'),registered_locator:actorFact.locator?.session_file?.replaceAll(root,'<private-test-root>'),sdk_report:actorFact.observations?.native_session_report}; } catch(error) { nativeIdentity={error:error.message}; }
    console.log(JSON.stringify({native_identity:nativeIdentity}));
    console.log(JSON.stringify({actual_harness:harness,caller:'resolved',project_pinned_after_cwd:true,logical_transfer_without_move:true,actual_moved_alias_context:true,controls:inspected.capabilities}));
    native(['workspace','focus',destination.herdr_workspace_id]);
    const humanStill=path.join(root,`${harness}-human-still.json`);
    native(['pane','run',sourceHuman.pane_id,...['bash','-c',`GOLEM_HERDR_SESSION=wrong-owned-test-target ${shell(process.execPath)} ${shell(cli)} context --json > ${shell(humanStill)}`].map(shell)]);
    assert.equal((await waitFile(humanStill,10000)).resolution.team_id,sourceTeam.team_id,'separate human shell remains in A');
    if (harness === 'pi') {
      assert.equal(inspected.capabilities.read.state,'available','standard integrated real Pi must map exact native identity');
      const actualApiRows=await (await fetch(`${env.GOLEM_DASHBOARD_URL}/api/sessions/dispatchable?project=${encodeURIComponent(team.project_id)}`)).json(); assert.ok(Array.isArray(actualApiRows));
      const apiActor=actualApiRows.find(r=>r.session_id===actorFact.canonical_id); assert.ok(apiActor,'actual populated dashboard must include real actor'); assert.equal(apiActor.team_id,destination.team_id); assert.equal(apiActor.host,'external'); assert.equal(apiActor.capabilities.read.state,'available');
      const actualCliRows=run(['agent','list','--scope','project','--project',project,'--json']).items; const cliActor=actualCliRows.find(r=>r.session_id===actorFact.canonical_id); assert.ok(cliActor); assert.deepEqual(cliActor.capabilities,apiActor.capabilities);
      const mcpProbe=`import assert from 'node:assert/strict';import {dashboardBaseUrl,listDispatchable} from ${JSON.stringify(new URL('../mcp/channel/tracker-client.js',import.meta.url).href)};assert.equal(dashboardBaseUrl(),${JSON.stringify(env.GOLEM_DASHBOARD_URL)});const rows=await listDispatchable(${JSON.stringify(team.project_id)});console.log(JSON.stringify(rows));`;
      const mcpResult=spawnSync(process.execPath,['--input-type=module','-e',mcpProbe],{cwd:project,env,encoding:'utf8',timeout:30000}); assert.equal(mcpResult.status,0,mcpResult.stderr); const mcpActor=JSON.parse(mcpResult.stdout).find(r=>r.session_id===actorFact.canonical_id); assert.ok(mcpActor); assert.deepEqual(mcpActor.capabilities,apiActor.capabilities);
      const read=run(['agent','read',actorFact.canonical_id,'--project',project,'--json']); assert.equal(typeof read.text,'string');
      const adopted=run(['agent','adopt',actorFact.canonical_id,'--team',destination.team_id,'--pane',movement.pane_id,'--project',project,'--json']); assert.equal(adopted.session_id,actorFact.canonical_id);
      const renamed=run(['agent','rename',actorFact.canonical_id,'actual-pi-renamed','--project',project,'--json']); assert.equal(renamed.herdr_agent_name,adopted.herdr_agent_name);
      const controlledMove=run(['agent','move',actorFact.canonical_id,'--workspace',team.herdr_workspace_id,'--team',destination.team_id,'--project',project,'--json']); assert.equal(controlledMove.team_id,destination.team_id); assert.equal(controlledMove.herdr_workspace_id,team.herdr_workspace_id);
      const attachProbe=spawnSync('python3',[path.join(repo,'test','_interactive-attach.py'),process.execPath,cli,'agent','attach',actorFact.canonical_id,'--project',project],{cwd:project,env,encoding:'utf8',timeout:30000}); assert.equal(attachProbe.status,0,attachProbe.stderr || attachProbe.stdout); const attachResult=JSON.parse(attachProbe.stdout); assert.equal(attachResult.actual_pi_screen,true); assert.equal(attachResult.client_exited,true);
      assert.equal(native(['agent','get',controlledMove.herdr_pane_id]).agent.agent_session.value,actorFact.locator.session_file,'client disconnect leaves actual app in its exact pane');
      const closedOld=run(['team','close',team.team_id,'--project',project,'--json']); assert.deepEqual(closedOld.stopped,[]); assert.equal(closedOld.workspace_closed,false); assert.ok(closedOld.workspace_kept_for.includes(controlledMove.herdr_pane_id),'old team retains transferred real app');
      fs.writeFileSync(controlTrigger,'ready');
      const reporterAfterMove=path.join(root,'pi-reporter-after-move.json');
      const failedPs=path.join(root,'failed-process-probe'); fs.writeFileSync(failedPs,'#!/bin/sh\nexit 1\n',{mode:0o700});
      const explicitFile=path.join(root,'pi-explicit-without-caller.json'), selfError=path.join(root,'pi-self-without-caller.json');
      const failureEnv=`env -u GOLEM_SESSION_ID -u GOLEM_CEO_SESSION_ID -u PI_SESSION_ID -u CLAUDE_CODE_SESSION_ID HERDR_ENV=0 GOLEM_PS_BIN=${shell(failedPs)}`;
      const explicitScript=path.join(root,'pi-explicit-probe.sh'); fs.writeFileSync(explicitScript,`set -e\n${shell(process.execPath)} ${shell(cli)} context --json > ${shell(reporterAfterMove)}\n${failureEnv} ${shell(process.execPath)} ${shell(cli)} agent inspect ${shell(actorFact.canonical_id)} --project ${shell(project)} --json > ${shell(explicitFile)}\nif ${failureEnv} ${shell(process.execPath)} ${shell(cli)} agent inspect self --project ${shell(project)} --json > ${shell(selfError)} 2>&1; then exit 91; fi\n`);
      const message=`Use bash to run exactly: bash ${shell(explicitScript)}. Then answer DONE. This is the same disposable acceptance test.`;
      run(['agent','notify','--to',actorFact.canonical_id,'--message',message,'--human','--json']);
      const reportedAfterMove=await waitFile(reporterAfterMove,120000); assert.equal(reportedAfterMove.resolution.placement.pane_id,controlledMove.herdr_pane_id);
      const explicitWithoutCaller=await waitFile(explicitFile,30000); assert.equal(explicitWithoutCaller.session_id,actorFact.canonical_id); for(let i=0;i<100 && (!fs.existsSync(selfError)||fs.statSync(selfError).size===0);i++) await new Promise(r=>setTimeout(r,100)); assert.match(fs.readFileSync(selfError,'utf8'),/caller|context|self/i);
      const reporterIdentity=native(['agent','get',controlledMove.herdr_pane_id]).agent.agent_session; assert.equal(reporterIdentity.kind,'path'); assert.equal(reporterIdentity.value,actorFact.locator.session_file,'existing real reporter re-reports through its old inherited pane alias');
      await new Promise(r=>setTimeout(r,1000));
      const stopped=run(['agent','stop',actorFact.canonical_id,'--project',project,'--json']); assert.equal(stopped.state,'dead');
      const { processIdsInGroup }=await import('../lib/process-group.js'); assert.deepEqual(processIdsInGroup(adopted.pid),[],'actual adopted runtime group has no survivors');
      console.log(JSON.stringify({actual_pi_controls:'read/adopt/rename/move/owned-TTY attach/client disconnect/old-team foreign retention/verified stop',stable_native_handle:true}));
    } else fs.writeFileSync(controlTrigger,'ready');
  }
  console.log(`REAL PARTIAL JOURNEY PASS: actual ${actors.join('/')} caller/cwd/transfer/move assertions only; Claude authentication/control and full-matrix acceptance remain separate unverified gaps`);
} finally {
  // Physical session belongs exclusively to this test. Stop/delete before
  // deleting HOME/auth/socket paths; never use caller/shared native session.
  spawnSync('herdr',['session','stop',nativeName],{env,encoding:'utf8',timeout:10000}); await new Promise(r=>setTimeout(r,500));
  spawnSync('herdr',['session','delete',nativeName],{env,encoding:'utf8',timeout:10000});
  const ps=spawnSync('ps',['-axo','pid=,args='],{encoding:'utf8'}); assert.equal(ps.status,0); assert.equal(ps.stdout.split('\n').some(line=>line.includes(`--session ${nativeName}`)&&/\bherdr\b/.test(line)),false,'owned native server must be gone before private resource removal');
  if(dashboard?.exitCode===null)dashboard.kill('SIGTERM'); if(dashExit)await dashExit;
  fs.rmSync(root,{recursive:true,force:true}); fs.rmSync(xdg,{recursive:true,force:true});
  console.log('real management cleanup passed: owned native/dashboard stopped before HOME/credential/socket removal');
}
