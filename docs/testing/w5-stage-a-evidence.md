# W5 Stage A evidence — not complete W5 acceptance

Base: `b0ab5796efb5494af15152b9b1293986f241a643`

Branch/worktree: `feat/gol-438-simulators`, `.worktrees/GOL-465-simulators`

Only new `tools/scenario-*`, `test/sim/` and `docs/testing/` sources are included.
No package/lock/runner/config/W2 fixture or production clock/seam file changes.
Both dependency trees were copied from main with `cp -Rc`, not installed.

## GOL-476 bounded repair

The first Stage A review found canonical argv slot bypass and a generated/caller
identity collision at `ef451ef`. That checkpoint is superseded for acceptance.
Raw and canonical argv now use one positional/flag grammar before values can be
symbols/markers. Runtime matching uses the same slots; relative paths and a
structural flag hidden in a prompt/label wildcard fail before output/cursor write.
Generated bindings use the same typed-domain validation/injectivity checks as
caller bindings, selecting the first deterministic non-colliding candidate before
persistence/emission. Numeric PID/port identities are canonicalized; malformed
persisted numeric bindings are rejected. No production/native integration change.

The complete recipe below includes the reviewer's exact two argv cases and
workspace collision, missing/wrong-kind slots, relative path, two generated IDs,
multiple caller-bound collisions, numeric port collision, reopen/next-cursor
consistency and unchanged pre-existing collision files. All pass on the repair.

## Commands actually run

From the ticket worktree:

```sh
for file in tools/scenario-format.ts tools/scenario-scrub-core.ts tools/scenario-io.ts tools/scenario-scrub.ts test/sim/support.ts test/sim/claude test/sim/pi test/sim/herdr; do node --check "$file" || exit; done
node /tmp/gol465-stage-a-smoke.mjs
```

Syntax command: **exit 0**, no output. The scratch smoke script is an owned
synthetic-only temporary program, not a landed runner test. It imports the pure
modules, invokes only these Node CLI prototypes (plus `mkfifo` for an owned
non-regular-input rejection case), creates 0700/0600 scratch resources and reaps
owned children before removing its private root. Child environments contain only
PATH, temporary HOME/TMPDIR and explicit scenario/state variables. It does not
call Golem/harness executables, any model, network, or production seam.

Final smoke command and the self-contained clean-parent heredoc below both
ran successfully: **exit 0**, actual output:

```text
format/scrub: exact schema+sequence, bounded structural allowlist, stable typed symbols, semantic redactions/no secret bytes, unknown/malformed/mixed input exit2, exclusive600 candidate and non-golden label PASS
failure cleanup: external TERM during inherited-open stdin retains signal after cleanup; unread stdout exits2 within2s; dangling unknown cursor symlink preserved PASS
sim prototypes: all three exact argv/stdout/exit paths, symbol continuity, mismatch/exhaustion exit2, stdin+stderr, own SIGTERM after lock cleanup, collision preserved, no fallback/network/model/clock integration PASS
GOL476 repairs: raw/canonical typed-slot grammar, leading hidden flags/wildcards/symbols/missing values refused, relative path and prompt-hidden flag exit2 before cursor/output; caller/generated + double-collision fresh IDs, two generated distinct IDs, numeric port collision, reopen consistency and retained collision files PASS
owned scratch inputs/cursors/candidates removed PASS
```

Observed negative cases include unknown schema/scenario/version/field, inherited
Object-prototype field names, wrong direction/sequence/time, PID0, raw/symbol
mixture, already-existing output, FIFO input, unknown argv, symbol retargeting,
exhausted scenario, absent stdin, cursor/lock collision and dangling cursor link.
Preflight/argv-rejected requests do not advance/create cursors; post-consumption
IO failure is uncertain, as disclosed below. Recorded nonzero exit7 and
recorded SIGTERM are preserved; external TERM during blocked stdin cleans its
owned lock before termination. Backpressured stdout fails by its real IO deadline
and dedicated CLI exit does not await an unread pipe forever.

One intermediate **failed** scratch fault probe exposed the unread-output case:
`simulator: stdio write deadline exceeded` appeared, but the child did not exit
until the parent safety-killed it (`null !== 2`). The dedicated CLI was corrected
to exit only **after** resource cleanup, even with a pending pipe drain; the final
probe above then passed. This is prototype IO cleanup, not a production/W2 edit.

`git diff --check` — **exit 0**. New-file staged/committed diff checks and exact
commit are reported on GOL-465 after checkpoint creation.

## Reproducible full scratch smoke

Run from the ticket worktree. This is the complete synthetic scratch recipe,
not a registered runner test or a recording job. It clears the parent environment,
creates/reaps its own child processes, and removes only owned temporary trees.
No `/tmp/gol465-stage-a-smoke.mjs` file is required to reproduce the evidence.

```sh
runner=$(mktemp -d /tmp/w5-smoke-parent.XXXXXX)
chmod 700 "$runner"
mkdir "$runner/home"
trap 'rm -rf "$runner"' EXIT
env -i PATH="$PATH" HOME="$runner/home" TMPDIR="$runner" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
const repo = process.cwd(), root = fs.mkdtempSync('/tmp/gol465-smoke-'); fs.chmodSync(root,0o700);
const {scrubScenario,validateScenario}=await import(pathToFileURL(path.join(repo,'tools/scenario-scrub-core.ts')));
const node=process.execPath, cli=path.join(repo,'tools/scenario-scrub.ts');
const env={PATH:process.env.PATH,HOME:path.join(root,'home'),TMPDIR:root};fs.mkdirSync(env.HOME,{mode:0o700});
const demo=JSON.parse(fs.readFileSync(path.join(repo,'docs/testing/examples/synthetic-processes.json'),'utf8'));
const file=name=>path.join(root,name), write=(name,value)=>{const p=file(name);fs.writeFileSync(p,JSON.stringify(value),{mode:0o600});return p;};
const run=(args)=>spawnSync(node,[cli,...args],{env,encoding:'utf8',timeout:5000});
const stateDirs=[], asyncChildren=[];
function sim(name,args,{scenario=input,state,stdin}={}) {
  if(!state){state=path.join(root,`state-${name}-${stateDirs.length}`);fs.mkdirSync(state,{mode:0o700});stateDirs.push(state);}
  const result=spawnSync(node,[path.join(repo,'test/sim',name),...args],{env:{...env,GOLEM_SIM_SCENARIO:scenario,GOLEM_SIM_STATE_DIR:state},input:stdin,encoding:'utf8',timeout:5000});
  assert.equal(result.error,undefined,'simulator must complete within bounded parent timeout');return {...result,state};
}
let input;
try {
  assert.deepEqual(validateScenario(demo),demo);
  const raw={schema:1,scenario:'synthetic-typed-brief-accepted-settled',source:{harness:'pi',harness_version:'synthetic',golem_version:'synthetic'},seed:1,events:[
    {seq:1,at_ms:0,boundary:'typed-http',direction:'in',operation:'typed-submit',fields:{envelope_id:'synthetic-private-id',attempt_id:'synthetic-attempt',session_id:'synthetic-session',path:'/Users/synthetic-person/private',pid:42424,port:12345,content:'synthetic prompt secret',body:'synthetic ticket body',tool_output:{raw:'synthetic file contents'},env:{TOKEN:'synthetic-token'},credentials:'synthetic-credential',username:'synthetic-person'}},
    {seq:2,at_ms:10,boundary:'typed-http',direction:'out',operation:'typed-accepted',fields:{envelope_id:'synthetic-private-id',accepted:true,state:'accepted'}}]};
  const clean=scrubScenario(raw);validateScenario(clean);
  const text=JSON.stringify(clean);for(const value of ['synthetic-private-id','synthetic-attempt','synthetic-session','/Users/','synthetic-person','synthetic-token','synthetic-credential','synthetic prompt secret','synthetic file contents'])assert.equal(text.includes(value),false);
  assert.equal(clean.events[0].fields.envelope_id,clean.events[1].fields.envelope_id);assert.equal(clean.events[0].fields.content,'<redacted:content>');assert.equal(clean.events[0].fields.body,'<redacted:body>');assert.equal(Object.hasOwn(clean.events[0].fields,'credentials'),false);
  const rawFile=write('raw-synthetic.json',raw), output=file('candidate.json');let r=run(['--input',rawFile,'--output',output]);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/NOT a golden recording/);assert.equal(fs.statSync(output).mode&0o777,0o600);
  assert.equal(run(['--check',output]).status,0);
  const fifo=file('fifo-input');assert.equal(spawnSync('mkfifo',[fifo],{env,encoding:'utf8',timeout:2000}).status,0);assert.equal(run(['--check',fifo]).status,2);
  const before=fs.readFileSync(output,'utf8');r=run(['--input',rawFile,'--output',output]);assert.equal(r.status,2);assert.equal(fs.readFileSync(output,'utf8'),before);
  for(const mutate of [s=>s.schema=2,s=>s.scenario='unknown',s=>s.source.harness_version='uncertain',s=>s.events[0].fields.unknown_private_payload='synthetic secret',s=>s.events[0].fields.constructor='synthetic secret',s=>s.events[0].direction='out',s=>s.events[1].seq=10,s=>s.events[1].at_ms=-1,s=>s.events[0].fields.pid=0]) {
    const value=structuredClone(raw);mutate(value);const p=write('bad.json',value);r=run(['--input',p,'--output',file('forbidden-output.json')]);assert.equal(r.status,2);assert.equal(fs.existsSync(file('forbidden-output.json')),false);assert.equal(r.stderr.includes('synthetic secret'),false);
  }
  const mixed=structuredClone(raw);mixed.events[1].fields.envelope_id='$envelope:1';assert.throws(()=>scrubScenario(mixed),/mixed raw and symbolic/);
  console.log('format/scrub: exact schema+sequence, bounded structural allowlist, stable typed symbols, semantic redactions/no secret bytes, unknown/malformed/mixed input exit2, exclusive600 candidate and non-golden label PASS');
  input=write('demo.json',demo);
  let herdr=sim('herdr',['workspace','delete']);assert.equal(herdr.status,2);assert.equal(fs.existsSync(path.join(herdr.state,'herdr.json')),false);
  const state=herdr.state;herdr=sim('herdr',['--version'],{state});assert.equal(herdr.status,0,herdr.stderr);assert.equal(herdr.stdout,'herdr synthetic\n');
  herdr=sim('herdr',['--session','synthetic-requested-session','workspace','create','--label','synthetic-label','--no-focus'],{state});assert.equal(herdr.status,0,herdr.stderr);const id=JSON.parse(herdr.stdout).result.workspace.workspace_id;
  herdr=sim('herdr',['--session','wrong-symbol-identity','workspace','list'],{state});assert.equal(herdr.status,2);
  herdr=sim('herdr',['--session','synthetic-requested-session','workspace','list'],{state});assert.equal(herdr.status,0,herdr.stderr);assert.equal(JSON.parse(herdr.stdout).result.workspaces[0].workspace_id,id);
  herdr=sim('herdr',['--session','synthetic-requested-session','session','stop','synthetic-requested-session'],{state});assert.equal(herdr.status,0);assert.equal(herdr.stdout,'');
  herdr=sim('herdr',['--version'],{state});assert.equal(herdr.status,2);assert.match(herdr.stderr,/exhausted/);
  let r2=sim('claude',['agents','--json']);assert.equal(r2.status,0,r2.stderr);assert.deepEqual(JSON.parse(r2.stdout),{agents:[]});
  r2=sim('pi',['--version']);assert.equal(r2.status,7,r2.stderr);assert.equal(r2.stdout,'synthetic\n');
  const lock=path.join(state,'herdr.json.lock');fs.writeFileSync(lock,'owned-lock-fixture',{mode:0o600});assert.equal(sim('herdr',['--version'],{state}).status,2);assert.equal(fs.readFileSync(lock,'utf8'),'owned-lock-fixture');fs.unlinkSync(lock);
  const stdinCase={...demo,events:[
    {seq:1,at_ms:0,boundary:'process',direction:'in',operation:'process-spawn',fields:{harness:'claudecode',argv:['--print','<redacted:prompt>']}},
    {seq:2,at_ms:0,boundary:'process',direction:'in',operation:'process-stdin',fields:{harness:'claudecode',stdin:'<redacted:stdin>'}},
    {seq:3,at_ms:0,boundary:'process',direction:'out',operation:'process-stderr',fields:{harness:'claudecode',stderr:'<redacted:stderr>'}},
    {seq:4,at_ms:0,boundary:'process',direction:'out',operation:'process-exit',fields:{harness:'claudecode',exit_code:0}}]};
  validateScenario(stdinCase);const stdinFile=write('stdin.json',stdinCase);r2=sim('claude',['--print','synthetic-prompt'],{scenario:stdinFile,stdin:'synthetic input'});assert.equal(r2.status,0,r2.stderr);assert.equal(r2.stderr,'<redacted:stderr>\n');
  r2=sim('claude',['--print','synthetic-prompt'],{scenario:stdinFile,stdin:''});assert.equal(r2.status,2);assert.match(r2.stderr,/stdin was absent/);
  const signalCase=structuredClone(demo);signalCase.events=signalCase.events.slice(-3).map((e,i)=>({...e,seq:i+1,at_ms:0}));delete signalCase.events[2].fields.exit_code;signalCase.events[2].fields.signal='SIGTERM';const signalFile=write('signal.json',signalCase);r2=sim('pi',['--version'],{scenario:signalFile});assert.equal(r2.signal,'SIGTERM');assert.equal(fs.existsSync(path.join(r2.state,'pi.json.lock')),false);
  const cancelledState=path.join(root,'state-cancelled');fs.mkdirSync(cancelledState,{mode:0o700});stateDirs.push(cancelledState);
  const pending=spawn(node,[path.join(repo,'test/sim/claude'),'--print','synthetic-prompt'],{env:{...env,GOLEM_SIM_SCENARIO:stdinFile,GOLEM_SIM_STATE_DIR:cancelledState},stdio:['pipe','pipe','pipe']});const pendingExit=once(pending,'exit');asyncChildren.push({child:pending,ended:pendingExit});
  for(let i=0;i<100&&!fs.existsSync(path.join(cancelledState,'claudecode.json.lock'));i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(fs.existsSync(path.join(cancelledState,'claudecode.json.lock')),true);pending.kill('SIGTERM');let deadline=setTimeout(()=>pending.kill('SIGKILL'),4000);let outcome=await pendingExit;clearTimeout(deadline);assert.equal(outcome[1],'SIGTERM');assert.equal(fs.existsSync(path.join(cancelledState,'claudecode.json.lock')),false);
  const largeCase=structuredClone(demo);largeCase.events=demo.events.slice(12,15).map((e,i)=>({...structuredClone(e),seq:i+1,at_ms:0}));
  largeCase.events[1].fields.result={agents:Array.from({length:256},(_,i)=>({session_id:`$session:${i+1}`,workspace_id:`$workspace:${i+1}`,pane_id:`$pane:${i+1}`,team_id:`$team:${i+1}`,worker_id:`$worker:${i+1}`,path:`$path:${i+1}`,label:'<redacted:label>',body:'<redacted:body>',content:'<redacted:content>',tool_input:'<redacted:tool-input>',tool_output:'<redacted:tool-output>',transcript:'<redacted:transcript>',ticket_body:'<redacted:ticket-body>',file_contents:'<redacted:file-contents>',assistant_text:'<redacted:assistant-text>',stdin:'<redacted:stdin>',stdout:'<redacted:stdout>',stderr:'<redacted:stderr>',error_message:'<redacted:error-message>'}))};validateScenario(largeCase);
  const largeFile=write('large-stdout.json',largeCase), blockedState=path.join(root,'state-blocked');fs.mkdirSync(blockedState,{mode:0o700});stateDirs.push(blockedState);
  const blocked=spawn(node,[path.join(repo,'test/sim/claude'),'agents','--json'],{env:{...env,GOLEM_SIM_SCENARIO:largeFile,GOLEM_SIM_STATE_DIR:blockedState},stdio:['ignore','pipe','pipe']});let errorText='';blocked.stderr.on('data',d=>errorText+=d);const blockedExit=once(blocked,'exit');asyncChildren.push({child:blocked,ended:blockedExit});deadline=setTimeout(()=>blocked.kill('SIGKILL'),5000);outcome=await blockedExit;clearTimeout(deadline);assert.equal(outcome[0],2,errorText);assert.match(errorText,/stdio write deadline exceeded/);assert.equal(fs.existsSync(path.join(blockedState,'claudecode.json.lock')),false);
  const unknownState=path.join(root,'state-symlink');fs.mkdirSync(unknownState,{mode:0o700});stateDirs.push(unknownState);const dangling=path.join(unknownState,'pi.json');fs.symlinkSync(path.join(root,'never-create'),dangling);r2=sim('pi',['--version'],{state:unknownState});assert.equal(r2.status,2);assert.equal(fs.lstatSync(dangling).isSymbolicLink(),true);fs.unlinkSync(dangling);
  console.log('failure cleanup: external TERM during inherited-open stdin retains signal after cleanup; unread stdout exits2 within2s; dangling unknown cursor symlink preserved PASS');
  for(const dir of stateDirs)assert.equal(fs.readdirSync(dir).some(n=>n.endsWith('.lock')||n.endsWith('.tmp')),false);
  console.log('sim prototypes: all three exact argv/stdout/exit paths, symbol continuity, mismatch/exhaustion exit2, stdin+stderr, own SIGTERM after lock cleanup, collision preserved, no fallback/network/model/clock integration PASS');
  const transaction=(argv,result)=>[
    {seq:1,at_ms:0,boundary:'process',direction:'in',operation:'process-spawn',fields:{harness:'herdr',argv}},
    {seq:2,at_ms:0,boundary:'process',direction:'out',operation:'process-stdout',fields:{harness:'herdr',stdout_recipe:'json',result}},
    {seq:3,at_ms:0,boundary:'process',direction:'out',operation:'process-exit',fields:{harness:'herdr',exit_code:0}}];
  const caseScenario=(argv,result={ok:true},repeat=1)=>({...demo,events:Array.from({length:repeat},(_,n)=>transaction(argv,result).map((e,i)=>({...e,seq:n*3+i+1,at_ms:n}))).flat()});
  for(const args of [['--cwd','$session:1'],['<redacted:argv>'],['$path:1'],['--cwd'],['--label'],['--provider'],['--session','<redacted:argv>'],['workspace','close','<redacted:argv>'],['--print','<redacted:label>'],['--unknown-private-flag'],['workspace','rename','$workspace:1']]) {
    const bad=caseScenario(args);assert.throws(()=>scrubScenario(bad));assert.throws(()=>validateScenario(bad));
    const p=write('bad-argv.json',bad);r2=sim('herdr',args[0]==='<redacted:argv>'?['--unknown-private-flag']:args,{scenario:p});assert.equal(r2.status,2);assert.equal(r2.stdout,'');assert.equal(fs.existsSync(path.join(r2.state,'herdr.json')),false);
  }
  const cwdCase=caseScenario(['--cwd','$path:1']);validateScenario(cwdCase);const cwdFile=write('cwd.json',cwdCase);
  r2=sim('herdr',['--cwd','relative-path'],{scenario:cwdFile});assert.equal(r2.status,2);assert.equal(r2.stdout,'');assert.equal(fs.existsSync(path.join(r2.state,'herdr.json')),false);
  r2=sim('herdr',['--cwd',path.join(root,'owned-cwd')],{scenario:cwdFile});assert.equal(r2.status,0,r2.stderr);
  const promptFile=write('prompt-flag.json',caseScenario(['--print','<redacted:prompt>']));r2=sim('herdr',['--print','--unknown-private-flag'],{scenario:promptFile});assert.equal(r2.status,2);assert.equal(r2.stdout,'');
  const workspaces={workspaces:[{workspace_id:'$workspace:1'},{workspace_id:'$workspace:2'}]};
  const boundCase=caseScenario(['--workspace','$workspace:1','workspace','list'],workspaces,2);validateScenario(boundCase);const boundFile=write('bound-generated.json',boundCase);
  r2=sim('herdr',['--workspace','sim-7-workspace-2','workspace','list'],{scenario:boundFile});assert.equal(r2.status,0,r2.stderr);const boundState=r2.state, first=JSON.parse(r2.stdout).workspaces.map(x=>x.workspace_id);
  assert.equal(first[0],'sim-7-workspace-2');assert.equal(first[1],'sim-7-workspace-2-fresh-1');assert.notEqual(first[0],first[1]);
  r2=sim('herdr',['--workspace','sim-7-workspace-2','workspace','list'],{scenario:boundFile,state:boundState});assert.equal(r2.status,0,r2.stderr);assert.deepEqual(JSON.parse(r2.stdout).workspaces.map(x=>x.workspace_id),first);
  const boundCursor=path.join(boundState,'herdr.json'), retained=fs.readFileSync(boundCursor,'utf8');assert.equal(JSON.parse(retained).cursor,2);
  const retainedLock=boundCursor+'.lock';fs.writeFileSync(retainedLock,'retained-collision',{mode:0o600});r2=sim('herdr',['--workspace','sim-7-workspace-2','workspace','list'],{scenario:boundFile,state:boundState});assert.equal(r2.status,2);assert.equal(fs.readFileSync(retainedLock,'utf8'),'retained-collision');assert.equal(fs.readFileSync(boundCursor,'utf8'),retained);fs.unlinkSync(retainedLock);
  const generatedCase=caseScenario(['workspace','list'],workspaces,2), generatedFile=write('two-generated.json',generatedCase);r2=sim('herdr',['workspace','list'],{scenario:generatedFile});assert.equal(r2.status,0,r2.stderr);const generatedState=r2.state, generated=JSON.parse(r2.stdout).workspaces.map(x=>x.workspace_id);assert.notEqual(generated[0],generated[1]);
  r2=sim('herdr',['workspace','list'],{scenario:generatedFile,state:generatedState});assert.equal(r2.status,0,r2.stderr);assert.deepEqual(JSON.parse(r2.stdout).workspaces.map(x=>x.workspace_id),generated);
  const doubleBoundCase=caseScenario(['--workspace','$workspace:1','workspace','rename','$workspace:3','<redacted:label>'],workspaces), doubleBoundFile=write('double-bound.json',doubleBoundCase);
  r2=sim('herdr',['--workspace','sim-7-workspace-2','workspace','rename','sim-7-workspace-2-fresh-1','synthetic-label'],{scenario:doubleBoundFile});assert.equal(r2.status,0,r2.stderr);assert.equal(JSON.parse(r2.stdout).workspaces[1].workspace_id,'sim-7-workspace-2-fresh-2');
  const portCase=caseScenario(['workspace','list'],{sessions:[{port:'$port:1'},{port:'$port:2'}]}), portFile=write('port-collision.json',portCase), portState=path.join(root,'state-ports');fs.mkdirSync(portState,{mode:0o700});stateDirs.push(portState);fs.writeFileSync(path.join(portState,'herdr.json'),JSON.stringify({schema:1,scenario:portCase,cursor:0,bindings:{'$port:1':'30009'}}),{mode:0o600});
  r2=sim('herdr',['workspace','list'],{scenario:portFile,state:portState});assert.equal(r2.status,0,r2.stderr);assert.deepEqual(JSON.parse(r2.stdout).sessions.map(x=>x.port),[30009,30010]);
  for(const dir of stateDirs)assert.equal(fs.readdirSync(dir).some(n=>n.endsWith('.lock')||n.endsWith('.tmp')),false);
  console.log('GOL476 repairs: raw/canonical typed-slot grammar, leading hidden flags/wildcards/symbols/missing values refused, relative path and prompt-hidden flag exit2 before cursor/output; caller/generated + double-collision fresh IDs, two generated distinct IDs, numeric port collision, reopen consistency and retained collision files PASS');
} finally {for(const {child,ended} of asyncChildren){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');const timeout=setTimeout(()=>child.kill('SIGKILL'),3000);try{await ended;}finally{clearTimeout(timeout);child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();}}fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false);console.log('owned scratch inputs/cursors/candidates removed PASS');}

JS
```

## Reproducible small demonstration

This is a demonstration, not a runner/recording/integration test:

```sh
root=$(mktemp -d /tmp/w5-demo.XXXXXX)
chmod 700 "$root"
mkdir "$root/state"
chmod 700 "$root/state"
trap 'rm -rf "$root"' EXIT
sample="$PWD/docs/testing/examples/synthetic-processes.json"
node tools/scenario-scrub.ts --check "$sample"
GOLEM_SIM_SCENARIO="$sample" GOLEM_SIM_STATE_DIR="$root/state" node test/sim/herdr --version
```

Expected `herdr synthetic`, not a native version/recording. No recordings or
native binaries are required. The source sample's synthetic label is mandatory.

## Unrun gates and remaining evidence

- W2 accepted integration and explicit Stage B release; no spec merge slot yet.
- Strict/native/Vitest/Linux gates and landed unit/integration failure tests wait
  W2. These eight native syntax checks and scratch assertions are not those gates.
- Recorder implementation, shared clock/socket and actual endpoint/Pi/drainer
  timing injection are design only; no under-one-wall-second timeout claim.
- Genuine authorized source recordings, pinned run provenance, scrub review and
  reviewer sign-off for all four golden scenarios: none available/authorized now.
- Four actual delivery-path replays and one behavioral mutation per journey,
  actor/pipe/SIGKILL/socket teardown failure evidence, W3 canonical contracts and
  journal/spool-header coordination, emitted helper distribution and fresh
  review/independent verification remain Stage B.
- Same-harness overlapping processes and multi-record stdin need the Stage B
  broker model, not the independent untimed prototype cursors. Unbound PID
  output is refused. Generated port/path consequences are not listeners/files.
- Cursor consumption before output means failed IO after consumption is uncertain;
  no safe replay/exactly-once/native delivery guarantee is asserted.

No raw private journals/transcripts, real harness/model/browser, credentials,
ports7420/7421, live restart, global sync, main merge or version changes occurred.
