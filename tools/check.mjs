import { runScript } from '../test/support/run-script.mjs';

await runScript('tools/check-child.mjs', { timeout: 120000 });
