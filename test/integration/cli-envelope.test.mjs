import { test } from 'vitest';
import { runScript } from '../support/run-script.mjs';

test('CLI envelopes across all eight verb families', async () => {
  await runScript('test/fixtures/cli-envelope-probe.mjs');
});
