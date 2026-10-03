import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { channelBundle } from '../../lib/compiler/render-runtime.ts';

test('MCP plan hashes its transitive emitted closure and fails closed on missing imports', () => {
  const root = fs.mkdtempSync(
    path.join(process.env.GOLEM_W2_SANDBOX, 'bundle-plan-'),
  );
  try {
    const channel = path.join(root, 'mcp/channel');
    fs.mkdirSync(channel, { recursive: true });
    fs.writeFileSync(
      path.join(channel, 'index.ts'),
      "import {value} from './helper.ts'; console.log(value);",
    );
    const helper = path.join(channel, 'helper.ts');
    fs.writeFileSync(helper, 'export const value: number = 1;');
    const first = channelBundle(root);
    assert.equal(channelBundle(root).sourceSha256, first.sourceSha256);
    assert.doesNotMatch(first.build(), /: number/);
    fs.writeFileSync(helper, 'export const value: number = 2;');
    assert.notEqual(channelBundle(root).sourceSha256, first.sourceSha256);
    fs.unlinkSync(helper);
    assert.throws(() => channelBundle(root), /Could not resolve/);
    assert.deepEqual(fs.readdirSync(root), ['mcp']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
