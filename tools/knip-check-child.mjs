import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { addedDebt, issueKeys } from './knip-report.mjs';

const result = spawnSync(
  process.execPath,
  ['node_modules/knip/bin/knip.js', '--reporter', 'json'],
  { encoding: 'utf8', timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
);
if (result.error || ![0, 1].includes(result.status))
  throw Error(
    'knip operational failure: ' +
      result.status +
      ' ' +
      result.error +
      ' ' +
      result.stderr,
  );
const report = JSON.parse(result.stdout);
const keys = issueKeys(report);
const baseline = JSON.parse(
  fs.readFileSync(new URL('./knip-baseline.json', import.meta.url), 'utf8'),
);
const added = addedDebt(keys, baseline.issues);
const removed = baseline.issues.filter((key) => !keys.includes(key));
const reportPath = path.join(process.env.GOLEM_W2_SANDBOX, 'knip-raw.json');
fs.writeFileSync(reportPath, result.stdout);
console.log(
  JSON.stringify({
    knip: '6.39.0',
    raw_exit: result.status,
    baseline: baseline.issues.length,
    current: keys.length,
    added,
    resolved: removed,
    raw_report: reportPath,
  }),
);
if (added.length) {
  console.error('new knip debt:', added);
  process.exitCode = 1;
}
