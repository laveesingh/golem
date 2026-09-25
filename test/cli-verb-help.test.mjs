#!/usr/bin/env node
// GOL-381: `--help`/`-h` on the six in-file CLI verbs (sync, migrate-home,
// dashboard, dashboard:restart, doctor, status) prints that verb's help and
// exits 0 without running the handler. Spawns cli/golem.js with a temp HOME
// and GOLEM_HOME and asserts the temp GOLEM_HOME gains no files.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'cli', 'golem.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gol381-verb-help-'));
const tempHome = path.join(temp, 'home');
const tempGolemHome = path.join(temp, 'golem-home');
fs.mkdirSync(tempHome, { recursive: true });
fs.mkdirSync(tempGolemHome, { recursive: true });

function listFilesRecursively(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursively(full));
    else out.push(path.relative(tempGolemHome, full));
  }
  return out.sort();
}

// Distinctive usage line per verb, taken from the verb's own help entry.
const VERBS = [
  ['sync', 'sync [--check]'],
  ['migrate-home', 'migrate-home         One-time move'],
  ['dashboard', 'dashboard [--public]'],
  ['dashboard:restart', 'dashboard:restart [--public]'],
  ['doctor', 'doctor               Sanity-check'],
  ['status', 'status [--json]'],
];

function runHelp(verb, flag) {
  return spawnSync(process.execPath, [cli, verb, flag], {
    encoding: 'utf8',
    env: { ...process.env, HOME: tempHome, GOLEM_HOME: tempGolemHome },
  });
}

for (const [verb, usage] of VERBS) {
  for (const flag of ['--help', '-h']) {
    test(`golem ${verb} ${flag} prints help and exits 0`, () => {
      const result = runHelp(verb, flag);
      assert.equal(result.status, 0, `exit status with stderr: ${result.stderr}`);
      assert.ok(
        String(result.stdout || '').includes(usage),
        `stdout contains the usage line ${JSON.stringify(usage)}: ${String(result.stdout || '').slice(0, 300)}`,
      );
    });
  }
}

test('help flags create no files under the temp GOLEM_HOME', () => {
  assert.deepEqual(listFilesRecursively(tempGolemHome), []);
});
