import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'type-negative-'));
const config = path.join(temp, 'tsconfig.json');
fs.writeFileSync(
  config,
  JSON.stringify({
    extends: path.join(repo, 'tsconfig.json'),
    include: ['types.ts', 'consumer.ts'],
    compilerOptions: { typeRoots: [path.join(repo, 'node_modules/@types')] },
  }),
);
fs.writeFileSync(
  path.join(temp, 'types.ts'),
  'export interface Item { value: number }\n',
);
const consumer = path.join(temp, 'consumer.ts');
const typecheck = () =>
  spawnSync(
    process.execPath,
    [
      path.join(repo, 'node_modules/typescript/bin/tsc'),
      '--project',
      config,
      '--noEmit',
    ],
    { encoding: 'utf8', timeout: 30000 },
  );
const native = () =>
  spawnSync(process.execPath, [consumer], { encoding: 'utf8', timeout: 30000 });
const receipt = (label, result) => {
  console.log(
    JSON.stringify({
      label,
      code: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }),
  );
  assert.equal(result.error, undefined);
};
try {
  // Temp .ts files must be ESM independently of the checkout's package scope.
  fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(
    consumer,
    "import type { Item } from './types.ts'; const item: Item = { value: 'bad' }; console.log(item);\n",
  );
  const typeError = typecheck();
  receipt('type-error', typeError);
  assert.notEqual(typeError.status, 0);
  assert.match(typeError.stdout, /TS2322/);
  fs.writeFileSync(
    consumer,
    "import { Item } from './types.ts'; const item: Item = { value: 1 }; console.log(item);\n",
  );
  const bareType = typecheck();
  receipt('bare-interface tsc', bareType);
  assert.notEqual(bareType.status, 0);
  assert.match(bareType.stdout, /TS1484/);
  const bareNative = native();
  receipt('bare-interface native Node', bareNative);
  assert.notEqual(bareNative.status, 0);
  assert.match(bareNative.stderr, /does not provide an export named 'Item'/);
  fs.writeFileSync(
    consumer,
    "import type { Item } from './types.ts'; const item: Item = { value: 1 }; console.log(item.value);\n",
  );
  const clean = typecheck();
  receipt('restored tsc', clean);
  assert.equal(clean.status, 0);
  const cleanNative = native();
  receipt('restored native', cleanNative);
  assert.equal(cleanNative.status, 0);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
