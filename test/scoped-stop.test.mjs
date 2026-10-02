#!/usr/bin/env node
// Target selection is the only authorization boundary. Own real native session.
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'golemtest-scoped-stop-'));
const xdg=fs.mkdtempSync('/tmp/gstop-');
Object.assign(process.env,{HOME:root,GOLEM_HOME:path.join(root,'state'),XDG_CONFIG_HOME:xdg,HERDR_ENV:'0'});
for(const k of ['GOLEM_HERDR_SESSION','HERDR_SESSION','HERDR_SOCKET_PATH','HERDR_PANE_ID','HERDR_WORKSPACE_ID','HERDR_TAB_ID','PI_SESSION_ID','GOLEM_SESSION_ID','CLAUDE_CODE_SESSION_ID']) delete process.env[k];
const native=await import('../lib/herdr-driver.js');
const {createTeam}=await import('../lib/team-registry.js');
const {claimWorker,updateWorker,readWorkers}=await import('../lib/worker-registry.js');
const {killWorker}=await import('../lib/worker-manager.js');
const {runAgent}=await import('../cli/agent.js');
const {runTeam}=await import('../cli/team.js');
const session=`gstop-${process.pid}`,projectId='scoped-stop-abcdef';
let children=[];
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const invoke=async(run,family,args)=>{let out='',err='';const exit=await run(family,args,{cwd:root,env:{},resolveContext:()=>null,projectForPath:()=>({project_id:projectId,path:root}),stdout:t=>out+=t,stderr:t=>err+=t});return{exit,out,err};};
try {
 await native.ensureSession(session,{pollMs:50});
 const teams=[];
 for(const label of ['Alpha','Beta']) {
  const ws=native.workspaceCreate({session,label,cwd:root});
  const team=createTeam({label,projectId,herdrSession:session,herdrWorkspaceId:ws.workspace_id});teams.push(team);
  const tab=native.tabCreate({session,workspaceId:ws.workspace_id,label:'target',cwd:root});
  native.paneRun({session,paneId:tab.pane.pane_id,command:['sleep','600']});
  let info;for(let i=0;i<50;i++){info=native.paneProcessInfo({session,paneId:tab.pane.pane_id});if(info.foreground_processes?.some(p=>p.name==='sleep'))break;await new Promise(r=>setTimeout(r,50));}
  assert.ok(info.foreground_processes?.some(p=>p.name==='sleep'),'actual child running');children.push(...info.foreground_processes.map(p=>p.pid));
  const worker=claimWorker({projectId,role:'builder',teamId:team.team_id,preset:{harness:'pi'},name:'builder1'});
  updateWorker(worker.worker_id,{state:'live',session_id:`sid-${label}`,herdr_pane_id:tab.pane.pane_id,herdr_tab_id:tab.tab.tab_id,herdr_workspace_id:ws.workspace_id,process_ownership:{pgid:99999,members:[{pid:99999,birth:'expired'}]}});
 }
 const ambiguous=await invoke(runAgent,'agent',['stop','builder1','--session',session,'--json']);
 assert.equal(ambiguous.exit,2,ambiguous.out);const result=JSON.parse(ambiguous.out);assert.equal(result.code,'TARGET_AMBIGUOUS');assert.equal(result.state,'needs_selection');assert.equal(result.candidates.length,2);assert.deepEqual(new Set(result.candidates.map(c=>c.team_id)),new Set(teams.map(t=>t.team_id)));
 assert.ok(children.some(alive),'ambiguous command changes nothing');
 const text=await invoke(runAgent,'agent',['stop','builder1','--session',session]);assert.equal(text.exit,2);assert.match(text.out,/More than one agent matches/);assert.equal(text.err,'');
 const selected=await invoke(runAgent,'agent',['stop','builder1','--team',teams[0].team_id,'--json']);assert.equal(selected.exit,0,selected.out+selected.err);assert.equal(JSON.parse(selected.out).state,'dead');
 const retry=await invoke(runAgent,'agent',['stop','sid-Alpha','--json']);assert.equal(retry.exit,0,retry.out);
 const closed=await invoke(runTeam,'team',['close',teams[1].team_id,'--json']);assert.equal(closed.exit,0,closed.out+closed.err);assert.equal(JSON.parse(closed.out).targets.length,1);
 assert.ok(readWorkers().every(w=>w.state==='dead'));
 for(let i=0;i<50&&children.some(alive);i++)await new Promise(r=>setTimeout(r,50));
 assert.ok(children.every(pid=>!alive(pid)),`native pane close left children: ${children.filter(alive)}`);
 // Runtime errors are plain failures, not authority errors; no false tombstone.
 const bad=claimWorker({projectId,role:'builder',teamId:teams[0].team_id,preset:{},name:'native-failure'});updateWorker(bad.worker_id,{state:'live',session_id:'bad',herdr_pane_id:'missing'});
 await assert.rejects(killWorker(bad.name,{workerId:bad.worker_id,native:{paneClose:()=>{throw Error('connection lost');}}}),/Could not stop native-failure: connection lost/);
 assert.equal(readWorkers().find(w=>w.worker_id===bad.worker_id).state,'live');
 console.log('scoped stop PASS: real native stale-identity stop, team close, zero surviving children, idempotent stop, session ambiguity candidates/text, team disambiguation, honest native error');
} finally {
 native.sessionStop(session);native.sessionDelete(session);
 const ps=spawnSync('ps',['-axo','args='],{encoding:'utf8'});assert.ok(!ps.stdout.split('\n').some(l=>l.includes(`--session ${session}`)&&/herdr/.test(l)),'owned server cleanup');
 fs.rmSync(root,{recursive:true,force:true});fs.rmSync(xdg,{recursive:true,force:true});
}
