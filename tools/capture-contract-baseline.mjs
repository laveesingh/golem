import fs from 'node:fs';
import { runScript } from '../test/support/run-script.mjs';

const target = new URL(
  '../test/fixtures/contracts/pilot-before.json',
  import.meta.url,
);
if (fs.existsSync(target))
  throw Error(
    'BEFORE snapshot already captured; never overwrite historical evidence after conversion',
  );
const receipt = await runScript('test/fixtures/w3-route-baseline.mjs');
const snapshot = JSON.parse(receipt.stdout);
fs.mkdirSync(new URL('../test/fixtures/contracts/', import.meta.url), {
  recursive: true,
});
fs.writeFileSync(
  new URL('../test/fixtures/contracts/pilot-before.json', import.meta.url),
  `${JSON.stringify(snapshot, null, 2)}\n`,
);
