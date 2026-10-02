import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repo } from '../support/sandbox.mjs';

const home = process.env.GOLEM_HOME;
const sandbox = process.env.GOLEM_W2_SANDBOX;
assert.ok(home && sandbox, 'owned sandbox required');
fs.mkdirSync(home, { recursive: true });
const file = path.join(home, 'config.json');
const bytes = '{"schema_version":9,"extension":"synthetic-future"}';
fs.writeFileSync(file, bytes);
let owner;
const old = process.argv.includes('--before');
if (old) {
  // Actual accepted pre-change source, not a parallel hand-written old reader.
  const baseline = execFileSync(
    'git',
    ['show', '5bb4fe53ea8b9af9fef791a595472c9948abe5ca:lib/golem-config.js'],
    { cwd: repo, encoding: 'utf8' },
  );
  const target = path.join(sandbox, 'accepted-config-before.mjs');
  const source = baseline.replace(
    "'./golem-home.js'",
    JSON.stringify(pathToFileURL(path.join(repo, 'lib/golem-home.js')).href),
  );
  assert.notEqual(source, baseline);
  fs.writeFileSync(target, source, { flag: 'wx', mode: 0o600 });
  owner = await import(pathToFileURL(target).href);
} else owner = await import('../../lib/golem-config.ts');
let regressionPassed = true;
try {
  assert.throws(() => owner.loadConfig(), /VERSIONED_VERSION_UNSUPPORTED/);
} catch {
  regressionPassed = false;
}
assert.equal(fs.readFileSync(file, 'utf8'), bytes);
console.log(JSON.stringify({ old, regressionPassed, unchanged: true }));
if (!old)
  assert.equal(
    regressionPassed,
    true,
    'current future-file refusal regression',
  );
