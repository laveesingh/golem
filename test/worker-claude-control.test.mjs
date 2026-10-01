// Original managed Claude UUID binding with real owned process incarnation;
// native observations are seams, not actual Claude/auth acceptance.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'golemtest-claude-control-'));process.env.GOLEM_HOME=root;delete process.env.GOLEM_HERDR_SESSION;
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}),exit=once(child,'exit');
try {
 const {captureProcessGroup}=await import('../lib/process-group.js');const {workerProcessEvidence}=await import('../lib/worker-control.js');const {claimWorker,updateWorker}=await import('../lib/worker-registry.js');const {killWorker}=await import('../lib/worker-manager.js');
 const identity=captureProcessGroup(child.pid),id='12345678-1234-1234-1234-123456789abc',b='87654321-4321-4321-4321-cba987654321';
 const claim=claimWorker({role:'builder',projectId:'cc-control-abcdef',preset:{harness:'claude'}}),worker=updateWorker(claim.worker_id,{state:'live',session_id:id,herdr_pane_id:'owned-pane',process_ownership:identity});
 const app=uuid=>({pid:child.pid,argv0:'node',argv:['node','/owned/bin/claude','--session-id',uuid]});let rows=[app(id)];
 const native={agentGet:()=>({agent:'claude',pane_id:'owned-pane'}),paneProcessInfo:()=>({foreground_process_group_id:child.pid,foreground_processes:rows}),paneClose:()=>{throw Error('must not close');}};
 const options={native,facts:[],leases:[],refreshLeases:()=>[]};
 assert.equal(workerProcessEvidence(worker,options).state,'available','original app UUID/current captured birth needs no synthetic native descriptor or facts');
 rows=[app(b)];assert.equal(workerProcessEvidence(worker,options).state,'unavailable','current B UUID cannot borrow captured A');
 rows=[{pid:child.pid,argv0:'node',argv:['node','golem.js','claude','--session-id',id]}];assert.equal(workerProcessEvidence(worker,options).state,'unavailable','wrapper UUID never binds application');
 rows=[{...app(id),argv:[...app(id).argv,'--session-id',id]}];assert.equal(workerProcessEvidence(worker,options).state,'unavailable','duplicate app UUID flags ambiguous');
 rows=[app(id)];assert.equal(workerProcessEvidence({...worker,operation_id:null},options).state,'unavailable','no original launch provenance cannot borrow chosen UUID');
 const stale={...identity,members:identity.members.map(p=>({...p,birth:'old'}))};assert.equal(workerProcessEvidence({...worker,process_ownership:stale},options).state,'unavailable','matching UUID alone cannot replace missing captured app birth');
 let count=0;assert.equal(workerProcessEvidence(worker,{...options,native:{...native,paneProcessInfo:()=>({foreground_process_group_id:child.pid,foreground_processes:[app(++count===1?id:b)]})}}).state,'unavailable','UUID A-to-B between binding brackets refuses');
 let signalled=false;await assert.rejects(killWorker(worker.name,{workerId:worker.worker_id,native,evidenceOptions:options,terminate:async(_,{beforeSignal})=>{rows=[app(b)];beforeSignal();signalled=true;return[];}}),/binding changed before teardown signal/);assert.equal(signalled,false);process.kill(child.pid,0);
 console.log('Claude original-control passed: current app UUID+captured birth positive; B/wrapper/duplicate/no-origin/stale-birth/bracket/pre-signal negatives; child alive');
}finally{process.kill(-child.pid,'SIGKILL');await exit;fs.rmSync(root,{recursive:true,force:true});console.log('Claude control cleanup passed: only owned group/state removed');}
