// GOL-435: real multi-process group, native observation seam, no auth/app substitute.
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {spawn} from 'node:child_process'; import {once} from 'node:events';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'golemtest-ancestor-'));
process.env.GOLEM_HOME=root; delete process.env.GOLEM_HERDR_SESSION;
const parent=spawn(process.execPath,['-e',`const {spawn}=require('node:child_process');let c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.send({pid:c.pid});process.on('message',async()=>{const exit=new Promise(r=>c.once('exit',r));c.kill('SIGKILL');await exit;c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.send({pid:c.pid});});setInterval(()=>{},1000);`],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
const parentExit=once(parent,'exit');
try {
 const [first]=await once(parent,'message'); let app=first.pid;
 const {captureProcessGroup}=await import('../lib/process-group.js');
 const {workerProcessEvidence}=await import('../lib/worker-control.js');
 const {claimWorker,updateWorker}=await import('../lib/worker-registry.js');
 const {killWorker}=await import('../lib/worker-manager.js');
 const recorded=captureProcessGroup(parent.pid); assert.ok(recorded.members.some(r=>r.pid===first.pid));
 const claim=claimWorker({role:'builder',projectId:'ancestor-abcdef',preset:{}});
 const worker=updateWorker(claim.worker_id,{state:'live',session_id:'A',herdr_pane_id:'pane-A',process_ownership:recorded});
 const fact={canonical_id:'A',locator:{raw_session_id:'A',session_file:'/fixture/A.jsonl'}};
 let exactArgs=false;
 const native={agentGet:()=>({agent:'pi',pane_id:'pane-A',agent_session:{kind:'path',value:fact.locator.session_file}}),paneProcessInfo:()=>({foreground_process_group_id:parent.pid,foreground_processes:[{pid:parent.pid,argv0:'node',argv:['node','golem.js']},{pid:app,argv0:'pi',argv:exactArgs?['pi','--session',fact.locator.session_file]:['pi']}]}),paneClose:()=>{throw Error('must not close');}};
 const options={native,facts:[fact],leases:[],refreshLeases:()=>[]};
 assert.equal(workerProcessEvidence(worker,options).state,'available','original captured actual app, not just wrapper, remains controllable');
 let signalled=false;
 await assert.rejects(killWorker(worker.name,{workerId:worker.worker_id,native,evidenceOptions:options,terminate:async(_,{beforeSignal})=>{
  const ready=once(parent,'message');parent.send('replace');const [next]=await ready;app=next.pid;
  beforeSignal();signalled=true;return [];
 }}),/binding changed before teardown signal/);
 assert.equal(signalled,false);process.kill(app,0);
 assert.equal(workerProcessEvidence(worker,options).state,'unavailable','surviving ancestor plus staleA cannot own opaque replacementB');
 const now=captureProcessGroup(parent.pid), lease={canonical_id:'A',harness:'pi',kind:'typed-worker',owner_token:'current-owned-test-app',pid:app,process_birth:now.members.find(r=>r.pid===app).birth,expires_at:new Date(Date.now()+60000).toISOString()};
 assert.equal(workerProcessEvidence(worker,{...options,leases:[lease],refreshLeases:()=>[lease]}).state,'available','exact current canonical application lease can recover');
 exactArgs=true;assert.equal(workerProcessEvidence(worker,options).state,'available','exact current conversation arguments can recover');
 console.log('ancestor regression passed: original app positive; pre-signal replacement refused; stale ancestor unavailable; exact restart/application lease positives; replacement alive');
} finally {
 process.kill(-parent.pid,'SIGKILL');await parentExit;fs.rmSync(root,{recursive:true,force:true});
 console.log('ancestor cleanup passed: owned group stopped before state removal');
}
