// Team close stops selected members without authority checks; unrelated panes remain.
import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {spawn} from 'node:child_process'; import {once} from 'node:events';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'golemtest-retained-pane-'));process.env.GOLEM_HOME=root;delete process.env.GOLEM_HERDR_SESSION;
const runtime=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}), shell=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
const runtimeExit=once(runtime,'exit'),shellExit=once(shell,'exit');
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
try {
 const {createTeam}=await import('../lib/team-registry.js');const {claimWorker,updateWorker,listWorkers}=await import('../lib/worker-registry.js');
 const {killWorker}=await import('../lib/worker-manager.js');const {runTeam}=await import('../cli/team.js');
 const team=createTeam({label:'Retained',projectId:'retained-abcdef',herdrSession:'owned-native',herdrWorkspaceId:'workspace-A'});
 const worker=claimWorker({role:'builder',projectId:team.project_id,teamId:team.team_id,preset:{}});
 updateWorker(worker.worker_id,{state:'live',session_id:'A',herdr_pane_id:'pane-A',process_ownership:null});
 let closes=0,stops=0,output,foreign=true;
 const options={cwd:root,env:{HERDR_ENV:'0'},resolveContext:()=>null,projectForPath:()=>({project_id:team.project_id,path:root}),stdout:t=>output=t,
 workers:{listWorkers,killWorker:async(name,options)=>{stops++;return killWorker(name,{...options,native:{paneClose:({paneId})=>{assert.equal(paneId,'pane-A');process.kill(-runtime.pid,'SIGTERM');return true;},paneList:()=>[]}});}},
 herdr:{unmanagedAgentPanes:()=>foreign?[{pane_id:'foreign-pane'}]:[],closeTeamWorkspace:()=>{closes++;return true;}}};
 assert.equal(await runTeam('team',['close',team.team_id,'--json'],options),0);let result=JSON.parse(output);
 assert.equal(result.targets[0].pane_retained,false);assert.equal(result.workspace_closed,false);assert.deepEqual(result.workspace_kept_for,['foreign-pane']);assert.equal(closes,0);assert.equal(alive(shell.pid),true);await runtimeExit;
 assert.equal(await runTeam('team',['close',team.team_id,'--json'],options),0);result=JSON.parse(output);assert.deepEqual(result.workspace_kept_for,['foreign-pane']);assert.equal(closes,0);assert.equal(stops,1);assert.equal(alive(shell.pid),true);
 foreign=false;assert.equal(await runTeam('team',['close',team.team_id,'--json'],options),0);assert.equal(JSON.parse(output).workspace_closed,true);assert.equal(closes,1);
 console.log('team close PASS: no identity veto; selected terminal stopped; unrelated pane retained; retry no-op; absent inventory closes workspace');
} finally {
 for(const child of [runtime,shell])if(alive(child.pid))process.kill(-child.pid,'SIGKILL');await Promise.all([runtimeExit,shellExit]);fs.rmSync(root,{recursive:true,force:true});
}
