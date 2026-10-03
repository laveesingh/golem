import { runScript } from '../test/support/run-script.mjs';

await runScript('tools/native-import.mjs');
await runScript('cli/golem-bin.js', { args: ['help'] });
