import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const mode = process.argv[2];
if (mode === 'absent-fake') {
  fs.unlinkSync(`${process.env.PATH.split(':')[0]}/pi`);
  const missing = spawnSync('pi', ['--version']);
  assert.equal(missing.error?.code, 'ENOENT');
  assert.ok(
    missing.error.path.startsWith(
      `${process.env.GOLEM_W2_SANDBOX}/missing-native/`,
    ),
  );
} else if (mode === 'production-port') {
  assert.throws(
    () => net.connect(7420, '127.0.0.1'),
    /refused production port/,
  );
  assert.throws(
    () => net.createServer().listen(7421, '127.0.0.1'),
    /refused production port/,
  );
  assert.throws(
    () => fetch('http://127.0.0.1:7420/api/health'),
    /refused production port/,
  );
  assert.throws(() => fetch('https://example.com/'), /refused external host/);
} else if (mode === 'fail-group' || mode === 'timeout-group') {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  await new Promise((resolve) => child.once('spawn', resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (mode === 'fail-group') throw Error('deliberate adapter failure');
  await new Promise(() => {});
} else throw Error('unknown safety probe mode');
console.log(`safety proof: ${mode}`);
