import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repo } from '../support/sandbox.mjs';

const home = process.env.GOLEM_HOME;
assert.ok(home && process.env.GOLEM_W2_SANDBOX);
fs.mkdirSync(home, { recursive: true });
const file = path.join(home, 'config.json');
const priorNames = fs.readdirSync(home);
const original = '{"extension":"original exact bytes"}\n';
fs.writeFileSync(file, original);
const gate = path.join(process.env.GOLEM_W2_SANDBOX, 'config-save-release');
const owner = pathToFileURL(path.join(repo, 'lib/golem-config.ts')).href;
const code = `import fs from 'node:fs'; import {saveConfig} from ${JSON.stringify(owner)};
const targets=new Map(); const open=fs.openSync; fs.openSync=(file,...args)=>{const fd=open(file,...args);targets.set(fd,String(file));return fd;};
const sync=fs.fsyncSync; let paused=false; fs.fsyncSync=(fd)=>{if(!paused&&targets.get(fd)?.includes('.tmp-')){paused=true;process.send({ready:true});const deadline=Date.now()+10000;while(!fs.existsSync(${JSON.stringify(gate)})){if(Date.now()>deadline)throw Error('bounded writer barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}return sync(fd);};
saveConfig({extension:'first writer'}); process.stdout.write('saved'); process.disconnect();`;
const first = spawn(process.execPath, ['--input-type=module', '-e', code], {
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
let stdout = '',
  stderr = '';
first.stdout.on('data', (chunk) => {
  stdout += chunk;
});
first.stderr.on('data', (chunk) => {
  stderr += chunk;
});
const exited = new Promise((resolve, reject) => {
  first.once('error', reject);
  first.once('exit', (status) => resolve(status));
});
let timer;
try {
  await new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(Error('writer never reached held-lock barrier')),
      8000,
    );
    first.once('message', (message) =>
      message?.ready ? resolve() : reject(Error('unexpected writer message')),
    );
    first.once('exit', () =>
      reject(Error(`writer exited before barrier: ${stderr}`)),
    );
  });
  clearTimeout(timer);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  const competing = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';import {saveConfig} from ${JSON.stringify(owner)};assert.throws(()=>saveConfig({extension:'competing writer'}),(error)=>error.code==='VERSIONED_FILE_CHANGED'&&error.statusCode===409);process.stdout.write('refused');`,
    ],
    { env: process.env, encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(competing.status, 0, competing.stderr);
  assert.equal(competing.stdout, 'refused');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
} finally {
  clearTimeout(timer);
  fs.writeFileSync(gate, 'release');
  const status = await exited;
  assert.equal(status, 0, stderr);
}
assert.equal(stdout, 'saved');
assert.deepEqual(JSON.parse(fs.readFileSync(file)), {
  schema_version: 1,
  extension: 'first writer',
});
assert.deepEqual(
  fs.readdirSync(home).sort(),
  [...priorNames, 'config.json'].sort(),
);
console.log(
  'actual concurrent saves: held owner preserved; second409; first complete v1; no partial/residual config files',
);
