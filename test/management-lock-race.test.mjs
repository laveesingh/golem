// Deterministic release/successor windows using private state and real owned PID birth.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';
import {withManagementLock,ownerIncarnation,processBirth} from '../lib/management-lock.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'golemtest-lock-race-')),file=path.join(root,'management.lock');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}),exit=once(child,'exit');const birth=processBirth(child.pid);child.kill('SIGKILL');await exit;
const dead={pid:child.pid,birth,token:'owned-ended-token'};
try {
 let calls=0;fs.writeFileSync(file,JSON.stringify(dead));withManagementLock(()=>calls++,{file,timeoutMs:0,probe:()=>{fs.unlinkSync(file);return null;}});assert.equal(calls,1);assert.equal(fs.existsSync(file),false,'release during probe acquires atomically, not ENOENT');
 const successor=ownerIncarnation();fs.writeFileSync(file,JSON.stringify(dead));calls=0;
 assert.throws(()=>withManagementLock(()=>calls++,{file,timeoutMs:0,probe:()=>{fs.unlinkSync(file);fs.writeFileSync(file,JSON.stringify(successor));return null;}}),/owner changed/);assert.equal(calls,0);assert.equal(JSON.parse(fs.readFileSync(file)).token,successor.token,'stale probe cannot unlink live successor');
 assert.throws(()=>withManagementLock(()=>calls++,{file,timeoutMs:0}),/management lock busy/);assert.equal(calls,0);fs.unlinkSync(file);
 fs.writeFileSync(file,JSON.stringify(dead));let nested=0;calls=0;
 withManagementLock(()=>calls++,{file,timeoutMs:0,probe:()=>{fs.unlinkSync(file);assert.throws(()=>withManagementLock(()=>nested++,{file,timeoutMs:0}),/reclamation uncertain/);return null;}});assert.equal(calls,1);assert.equal(nested,0,'normal successor acquisitions also honor reclamation guard');
 fs.writeFileSync(file,'unknown owner');assert.throws(()=>withManagementLock(()=>calls++,{file,timeoutMs:0}),/owner unknown/);assert.equal(fs.readFileSync(file,'utf8'),'unknown owner');fs.unlinkSync(file);
 fs.writeFileSync(file,JSON.stringify(ownerIncarnation()));let prior;
 try{withManagementLock(()=>{throw Error('prior callback must not enter');},{file,timeoutMs:0});}catch(error){prior=error;}
 assert.equal(prior?.code,'MANAGEMENT_LOCK_BUSY');fs.unlinkSync(file);let replayCalls=0;
 assert.throws(()=>withManagementLock(()=>{replayCalls++;throw prior;},{file,timeoutMs:150}),error=>error===prior,'genuine earlier contention propagates unchanged after callback entry');
 assert.equal(replayCalls,1,'callback effects must NEVER replay, regardless of genuine contention provenance');assert.equal(fs.existsSync(file)||fs.existsSync(`${file}.reclaim`),false);
 let failedCalls=0;assert.throws(()=>withManagementLock(()=>{failedCalls++;throw Error('callback failure');},{file,timeoutMs:0}),/callback failure/);assert.equal(failedCalls,1);
 assert.equal(fs.existsSync(file),false,'failed callback releases its own lock');
 console.log('lock race passed: release during probe safe; successor preserved; every acquisition fenced; live/unknown not evicted; callback never replayed');
} finally {fs.rmSync(root,{recursive:true,force:true});console.log('lock race cleanup passed: owned PID ended/private state removed');}
