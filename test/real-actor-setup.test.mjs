// Hermetic setup safety only. No actual actor, provider, credential or login call.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {planRealActorSetup,verifyRealActorSetup,realActorEnvironment,createRealJourneyResources} from './_real-actor-setup.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'golemtest-actor-setup-')),home=path.join(root,'home'),pi=path.join(root,'private-pi'),claude=path.join(root,'private-claude'),reporter=path.join(root,'reporter.ts');
for(const p of [home,pi,claude])fs.mkdirSync(p);fs.writeFileSync(reporter,'// metadata fixture only');
const base={HOME:home,GOLEM_REAL_ACTORS:'pi',GOLEM_REAL_PI_AGENT_DIR:pi,GOLEM_REAL_HERDR_PI_REPORTER:reporter};
try {
 let touches=[];const io={realpathSync:p=>{touches.push(p);return fs.realpathSync(p);},statSync:p=>{touches.push(p);return fs.statSync(p);}};
 const guarded=new Proxy({...base},{get:(env,key)=>{if(key==='GOLEM_REAL_CLAUDE_CONFIG_DIR')throw Error('Pi cannot inspect Claude prerequisite');return env[key];}});
 assert.deepEqual(verifyRealActorSetup(planRealActorSetup(guarded),io).actors,['pi']);assert.ok(!touches.some(p=>p.includes('claude')));
 touches=[];assert.deepEqual(verifyRealActorSetup(planRealActorSetup({HOME:home,GOLEM_REAL_ACTORS:'claude',GOLEM_REAL_CLAUDE_CONFIG_DIR:claude}),io).actors,['claude']);assert.ok(!touches.some(p=>p.includes('private-pi')||p===reporter));
 assert.throws(()=>planRealActorSetup({HOME:home}),/INCOMPLETE.*GOLEM_REAL_PI_AGENT_DIR/);
 assert.throws(()=>planRealActorSetup({...base,GOLEM_REAL_ACTORS:'pi,unknown'}),/INCOMPLETE/);
 assert.throws(()=>planRealActorSetup({...base,GOLEM_REAL_ACTORS:'pi,pi'}),/INCOMPLETE/);
 assert.throws(()=>planRealActorSetup({...base,GOLEM_REAL_PI_AGENT_DIR:path.join(home,'.pi','agent')}),/live HOME/);
 fs.mkdirSync(path.join(home,'.pi','agent'),{recursive:true});const alias=path.join(root,'alias');fs.symlinkSync(path.join(home,'.pi','agent'),alias,'dir');
 assert.throws(()=>verifyRealActorSetup(planRealActorSetup({...base,GOLEM_REAL_PI_AGENT_DIR:alias})),/resolves to live/);
 const nonOwnedXdg=path.join(root,'existing-non-owned-xdg');fs.mkdirSync(nonOwnedXdg);const suppliedPi=path.join(nonOwnedXdg,'private-pi'),suppliedCc=path.join(nonOwnedXdg,'private-claude');fs.mkdirSync(suppliedPi);fs.mkdirSync(suppliedCc);
 const suppliedAlias=path.join(root,'supplied-alias');fs.symlinkSync(suppliedPi,suppliedAlias,'dir');
 const both=verifyRealActorSetup(planRealActorSetup({...base,GOLEM_REAL_ACTORS:'pi,claude',GOLEM_REAL_PI_AGENT_DIR:suppliedAlias,GOLEM_REAL_CLAUDE_CONFIG_DIR:suppliedCc}));
 const resources=createRealJourneyResources(both,{tempParent:root,xdgParent:nonOwnedXdg});assert.notEqual(resources.xdg,nonOwnedXdg);resources.cleanup();
 assert.equal(fs.existsSync(resources.root),false);assert.equal(fs.existsSync(resources.xdg),false);for(const p of [nonOwnedXdg,suppliedPi,suppliedCc,suppliedAlias])assert.equal(fs.existsSync(p),true,'supplied directories/alias/non-owned parent retained');
 assert.throws(()=>createRealJourneyResources(both,{tempParent:suppliedPi,xdgParent:nonOwnedXdg}),/overlaps a resource allocation parent/);assert.deepEqual(fs.readdirSync(suppliedPi),[],'overlap fails before allocation');
 const short=createRealJourneyResources(both);assert.ok(short.xdg.length<40,'exclusive XDG remains short for native socket limit');short.cleanup();
 const raced=createRealJourneyResources(both,{tempParent:root,xdgParent:nonOwnedXdg});const original=both.facilities.pi.directory;both.facilities.pi.directory=raced.xdg;
 assert.throws(()=>raced.cleanup(),/overlaps resource cleanup/);assert.ok(fs.existsSync(raced.root)&&fs.existsSync(raced.xdg),'ALL cleanup refused before any deletion');both.facilities.pi.directory=original;raced.cleanup();
 const isolated=realActorEnvironment({PATH:'/fixture',TERM:'xterm',OPENAI_API_KEY:'fixture-not-a-key',CLAUDE_CONFIG_DIR:'/live',PI_CODING_AGENT_DIR:'/live',ARBITRARY_PROVIDER_SECRET:'fixture-not-a-key',NODE_OPTIONS:'--import /live/helper'});
 assert.deepEqual(isolated,{PATH:'/fixture',TERM:'xterm'});
 const guard=path.join(root,'guard.mjs');fs.writeFileSync(guard,`import fs from 'node:fs';for(const method of ['readFileSync','copyFileSync','writeFileSync','mkdirSync']){const original=fs[method];fs[method]=function(p,...args){if(/(?:auth\\.json|models\\.json|credentials\\.json|\\.claude)/.test(String(p)))throw Error('FORBIDDEN credential/config touch');return original.call(this,p,...args);};}`);
 const script=fileURLToPath(new URL('./management-real-journey.test.mjs',import.meta.url));
 const environment={PATH:process.env.PATH,HOME:home,TMPDIR:root,GOLEM_REAL_HARNESS:'1',GOLEM_REAL_ACTORS:'pi',GOLEM_REAL_SETUP_ONLY:'1'};
 const before=fs.readdirSync(root).sort();
 const missing=spawnSync(process.execPath,['--import',guard,script],{env:environment,encoding:'utf8',timeout:10000});assert.equal(missing.status,3);assert.match(missing.stderr,/INCOMPLETE.*GOLEM_REAL_PI_AGENT_DIR/);assert.deepEqual(fs.readdirSync(root).sort(),before,'missing prerequisite fails before any resource/credential setup');
 const ready=spawnSync(process.execPath,['--import',guard,script],{env:{...environment,...base},encoding:'utf8',timeout:10000});assert.equal(ready.status,0,ready.stderr);const receipt=JSON.parse(ready.stdout);assert.deepEqual(receipt.actors,['pi']);assert.equal(receipt.auth_run,false);assert.equal(receipt.state,'INCOMPLETE');assert.deepEqual(fs.readdirSync(root).sort(),before,'metadata-only selected Pi creates no resource/Claude config/auth copy');
 const combined=spawnSync(process.execPath,['--import',guard,script],{env:{...environment,...base,GOLEM_REAL_ACTORS:'pi,claude'},encoding:'utf8',timeout:10000});assert.equal(combined.status,3);assert.match(combined.stderr,/INCOMPLETE.*GOLEM_REAL_CLAUDE_CONFIG_DIR/);assert.deepEqual(fs.readdirSync(root).sort(),before);
 console.log('real actor setup passed: selection first; missing/unknown/live-alias prereqs refuse before setup; Pi/Claude metadata separation; no inherited auth/helper env; no credential reads/copies or actor calls');
}finally{fs.rmSync(root,{recursive:true,force:true});console.log('actor setup cleanup passed: only owned metadata fixtures removed');}
