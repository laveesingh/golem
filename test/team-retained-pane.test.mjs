// GOL-435: actual owned runtime stop + residual native inventory seam/retry.
import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {spawn} from 'node:child_process'; import {once} from 'node:events';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'golemtest-retained-pane-'));process.env.GOLEM_HOME=root;delete process.env.GOLEM_HERDR_SESSION;
const runtime=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}), shell=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
const runtimeExit=once(runtime,'exit'),shellExit=once(shell,'exit');
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
try {
 const {createTeam}=await import('../lib/team-registry.js');const {claimWorker,updateWorker,listWorkers}=await import('../lib/worker-registry.js');
 const {captureProcessGroup}=await import('../lib/process-group.js');const {killWorker}=await import('../lib/worker-manager.js');
 const {unmanagedAgentPanes}=await import('../lib/team-herdr.js');const {runTeam}=await import('../cli/team.js');
 const team=createTeam({label:'Retained',projectId:'retained-abcdef',herdrSession:'owned-native',herdrWorkspaceId:'workspace-A'});
 const worker=claimWorker({role:'builder',projectId:team.project_id,teamId:team.team_id,preset:{}});
 updateWorker(worker.worker_id,{state:'live',session_id:'A',herdr_pane_id:'pane-A',process_ownership:captureProcessGroup(runtime.pid)});
 const inventory=path.join(root,'inventory.json');fs.writeFileSync(inventory,JSON.stringify({result:{panes:[{pane_id:'pane-A',workspace_id:'workspace-A'}]}}));
 const binary=path.join(root,'herdr');fs.writeFileSync(binary,`#!${process.execPath}\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(inventory)},'utf8'));\n`,{mode:0o700});process.env.GOLEM_HERDR_BIN=binary;
 let closes=0,stops=0,output;
 const options={cwd:root,env:{HERDR_ENV:'0'},resolveContext:()=>null,projectForPath:()=>({project_id:team.project_id,path:root}),stdout:t=>output=t,
 workers:{listWorkers,killWorker:async(name,options)=>{stops++;return killWorker(name,{...options,native:{agentGet:()=>{throw Error('agent_not_found');},paneProcessInfo:()=>({foreground_process_group_id:alive(runtime.pid)?runtime.pid:shell.pid,shell_pid:shell.pid,foreground_processes:[{pid:shell.pid,argv0:'zsh'}]}),paneClose:()=>{throw Error('unknown shell must be retained');}},evidenceOptions:{facts:[],leases:[]}});}},
 herdr:{unmanagedAgentPanes,closeTeamWorkspace:()=>{closes++;return true;}}};
 assert.equal(await runTeam('team',['close',team.team_id,'--json'],options),0);let result=JSON.parse(output);
 assert.equal(result.targets[0].pane_retained,true);assert.equal(result.workspace_closed,false);assert.deepEqual(result.workspace_kept_for,['pane-A']);assert.equal(closes,0);assert.equal(alive(shell.pid),true);await runtimeExit;
 assert.equal(await runTeam('team',['close',team.team_id,'--json'],options),0);result=JSON.parse(output);assert.deepEqual(result.workspace_kept_for,['pane-A']);assert.equal(closes,0);assert.equal(stops,1,'retry does not repeat completed stop');assert.equal(alive(shell.pid),true);
 fs.writeFileSync(inventory,JSON.stringify({result:{panes:[]}}));assert.equal(await runTeam('team',['close',team.team_id,'--json'],options),0);result=JSON.parse(output);assert.equal(result.workspace_closed,true);assert.equal(closes,1,'confirmed absent inventory permits close');
 console.log('retained pane regression passed: real stop retained unknown shell; close/retry keep workspace; absent inventory permits close; foreign shell alive');
} finally {
 for(const child of [runtime,shell])if(alive(child.pid))process.kill(-child.pid,'SIGKILL');await Promise.all([runtimeExit,shellExit]);fs.rmSync(root,{recursive:true,force:true});delete process.env.GOLEM_HERDR_BIN;
 console.log('retained pane cleanup passed: owned groups stopped before state removal');
}
