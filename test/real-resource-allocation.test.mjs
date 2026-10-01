// GOL450 constructor windows: owned empty metadata only; no actor/auth calls.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createRealJourneyResources} from './_real-actor-setup.mjs';
for(const scenario of ['success-replacement','failure-replacement','failure-alias','failure-unchanged']) {
 const fixture=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'golemtest-allocation-window-'))),facility=path.join(fixture,'facility'),xdgParent=path.join(fixture,'xdg');fs.mkdirSync(facility);fs.mkdirSync(xdgParent);
 const original=fs.mkdtempSync;let count=0,allocated,moved,second;
 fs.mkdtempSync=function(prefix,...args){
  if(++count===1){allocated=original.call(this,prefix,...args);return allocated;}
  if(scenario!=='failure-unchanged') {moved=`${allocated}-original`;fs.renameSync(allocated,moved);if(scenario==='failure-alias')fs.symlinkSync(facility,allocated,'dir');else {fs.mkdirSync(allocated);fs.writeFileSync(path.join(allocated,'replacement-marker'),'owned metadata');}}
  if(scenario==='success-replacement') {second=original.call(this,prefix,...args);return second;}
  throw Error('injected second allocation failure');
 };
 try {
  assert.throws(()=>createRealJourneyResources({facilities:{pi:{directory:facility}}},{tempParent:fixture,xdgParent}),scenario==='failure-unchanged'?/injected second allocation failure/:/cleanup REFUSED/);
  fs.mkdtempSync=original;
  if(scenario==='failure-unchanged')assert.equal(fs.existsSync(allocated),false,'unchanged owned partial allocation safely rolled back');
  else {assert.ok(fs.existsSync(allocated)&&fs.existsSync(moved),'replacement/alias and original both retained');if(second)assert.ok(fs.existsSync(second),'ALL rollback refused, including second owned root');}
  assert.ok(fs.existsSync(facility));console.log(`allocation window passed: ${scenario}; no actor/auth calls`);
 }finally{fs.mkdtempSync=original;fs.rmSync(fixture,{recursive:true,force:true});}
}
console.log('allocation window cleanup passed: only owned metadata fixtures removed');
