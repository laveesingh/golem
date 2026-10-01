import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { runScript } from '../support/run-script.mjs';
import { createSandbox } from '../support/sandbox.mjs';

test('dirty caller selectors and credentials are not inherited', () => {
  const dirty = {
    GOLEM_HOME: '/forbidden/live',
    CLAUDE_CONFIG_DIR: '/forbidden/claude',
    PI_SESSION_ID: 'live',
    GOLEM_HERDR_BIN: '/forbidden/herdr',
    NODE_OPTIONS: '--require=/forbidden/preload',
    PORT: '7420',
    XDG_STATE_HOME: '/forbidden/state',
  };
  const before = { ...process.env };
  Object.assign(process.env, dirty);
  const sandbox = createSandbox();
  try {
    for (const [key, value] of Object.entries(dirty))
      assert.notEqual(sandbox.env[key], value);
    assert.equal(sandbox.env.PI_SESSION_ID, undefined);
    assert.equal(sandbox.env.GOLEM_HERDR_BIN, undefined);
    assert.equal(sandbox.env.CLAUDE_CONFIG_DIR, undefined);
    assert.ok(sandbox.env.HOME.startsWith(`${sandbox.root}/`));
  } finally {
    sandbox.cleanup();
    for (const key of Object.keys(dirty)) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});
for (const mode of ['absent-fake', 'production-port']) {
  test(`${mode} fails closed before any native/default connection`, async () => {
    const receipt = await runScript('test/fixtures/w2-safety-probe.mjs', {
      args: [mode],
    });
    assert.equal(fs.existsSync(receipt.sandboxRoot), false);
    assert.match(receipt.stdout, /safety proof:/);
  });
}
for (const mode of ['fail-group', 'timeout-group']) {
  test(`${mode} preserves nonzero/timeout evidence and cleans detached groups`, async () => {
    let failure;
    try {
      await runScript('test/fixtures/w2-safety-probe.mjs', {
        args: [mode],
        timeout: mode === 'timeout-group' ? 1000 : 5000,
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure?.receipt, String(failure));
    assert.equal(fs.existsSync(failure.receipt.sandboxRoot), false);
    if (mode === 'timeout-group') assert.equal(failure.receipt.timedOut, true);
    else {
      assert.equal(failure.receipt.code, 1);
      assert.match(failure.receipt.stderr, /deliberate adapter failure/);
    }
  });
}
