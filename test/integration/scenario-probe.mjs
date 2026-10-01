// Native Node consumer/fault fixture under the existing W2-owned runner.
// All data synthetic; no recording, native harness, clock or delivery claim.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScenario } from '../../tools/scenario-scrub-core.ts';
import {
  processTransaction,
  scenario,
  typedCandidate,
} from '../sim/scenario-fixture.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = fs.mkdtempSync(path.join(process.env.TMPDIR, 'w5-probe-'));
fs.chmodSync(root, 0o700);
const children = [],
  states = [];
const write = (name, data) => {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  return file;
};
const state = () => {
  const dir = path.join(root, `state-${states.length}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  states.push(dir);
  return dir;
};
const env = (input, dir) => ({
  ...process.env,
  GOLEM_SIM_SCENARIO: input,
  GOLEM_SIM_STATE_DIR: dir,
});
function invoke(binary, args, input, dir = state(), stdin) {
  const result = spawnSync(
    process.execPath,
    [path.join(repo, 'test/sim', binary), ...args],
    {
      env: env(input, dir),
      input: stdin,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(
    result.error,
    undefined,
    'native consumer timeout is not success',
  );
  return { ...result, dir };
}
function launch(binary, args, input, dir = state()) {
  const child = spawn(
    process.execPath,
    [path.join(repo, 'test/sim', binary), ...args],
    { env: env(input, dir), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const record = { child, ended: once(child, 'exit'), dir };
  children.push(record);
  return record;
}
async function exitBounded(record, milliseconds = 4500) {
  const timer = setTimeout(() => record.child.kill('SIGKILL'), milliseconds);
  try {
    return await record.ended;
  } finally {
    clearTimeout(timer);
  }
}
async function lockReady(record, harness) {
  const lock = path.join(record.dir, `${harness}.json.lock`);
  for (let i = 0; i < 150 && !fs.existsSync(lock); i++) {
    assert.equal(record.child.exitCode, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(lock), true);
  return lock;
}
try {
  const mode = process.argv[2];
  if (mode === 'cli') {
    const input = write('candidate-input.json', typedCandidate()),
      output = path.join(root, 'candidate.json'),
      cli = path.join(repo, 'tools/scenario-scrub.ts');
    const call = (args) =>
      spawnSync(process.execPath, [cli, ...args], {
        env: process.env,
        encoding: 'utf8',
        timeout: 5000,
      });
    let result = call(['--input', input, '--output', output]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /NOT a golden recording/);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const clean = JSON.parse(fs.readFileSync(output, 'utf8'));
    validateScenario(clean);
    assert.equal(JSON.stringify(clean).includes('synthetic-token'), false);
    assert.equal(call(['--check', output]).status, 0);
    const bytes = fs.readFileSync(output);
    assert.equal(call(['--input', input, '--output', output]).status, 2);
    assert.deepEqual(fs.readFileSync(output), bytes);
    const bad = typedCandidate();
    bad.events[0].fields.unknown_private_payload = 'synthetic-secret';
    const badFile = write('bad.json', bad),
      absent = path.join(root, 'absent.json');
    result = call(['--input', badFile, '--output', absent]);
    assert.equal(result.status, 2);
    assert.equal(result.stderr.includes('synthetic-secret'), false);
    assert.equal(fs.existsSync(absent), false);
    const fifo = path.join(root, 'fifo');
    assert.equal(
      spawnSync('mkfifo', [fifo], { env: process.env, timeout: 2000 }).status,
      0,
    );
    assert.equal(call(['--check', fifo]).status, 2);
  } else if (mode === 'contracts') {
    for (const [binary, harness, argv, recipe, exitCode] of [
      ['claude', 'claudecode', ['agents', '--json'], 'json', 0],
      ['pi', 'pi', ['--version'], 'version', 7],
      ['herdr', 'herdr', ['--version'], 'version', 0],
    ]) {
      const data = scenario(
          processTransaction(harness, argv, {
            recipe,
            result: { agents: [] },
            exitCode,
          }),
        ),
        input = write(`${binary}.json`, data);
      let result = invoke(binary, argv, input);
      assert.equal(result.status, exitCode, result.stderr);
      assert.equal(
        result.stdout,
        recipe === 'json'
          ? '{"agents":[]}\n'
          : binary === 'herdr'
            ? 'herdr synthetic\n'
            : 'synthetic\n',
      );
      const cursor = path.join(result.dir, `${harness}.json`),
        bytes = fs.readFileSync(cursor);
      result = invoke(binary, argv, input, result.dir);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /exhausted/);
      assert.deepEqual(fs.readFileSync(cursor), bytes);
    }
    for (const argv of [
      ['--cwd', '$session:1'],
      ['<redacted:argv>'],
      ['$path:1'],
      ['--cwd'],
      ['--label'],
      ['workspace', 'rename', '$workspace:1'],
    ]) {
      const input = write(
        'bad-argv.json',
        scenario(processTransaction('herdr', argv)),
      );
      const result = invoke(
        'herdr',
        argv[0] === '<redacted:argv>' ? ['--unknown-private-flag'] : argv,
        input,
      );
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.equal(fs.existsSync(path.join(result.dir, 'herdr.json')), false);
    }
    const pathInput = write(
      'path.json',
      scenario(processTransaction('herdr', ['--cwd', '$path:1'])),
    );
    let result = invoke('herdr', ['--cwd', 'relative-path'], pathInput);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(path.join(result.dir, 'herdr.json')), false);
    result = invoke(
      'herdr',
      ['--cwd', path.join(root, 'owned-path')],
      pathInput,
    );
    assert.equal(result.status, 0, result.stderr);
  } else if (mode === 'identities') {
    const argv = ['--workspace', '$workspace:1', 'workspace', 'list'],
      response = {
        workspaces: [
          { workspace_id: '$workspace:1' },
          { workspace_id: '$workspace:2' },
        ],
      };
    const input = write(
      'collision.json',
      scenario([
        ...processTransaction('herdr', argv, { result: response }),
        ...processTransaction('herdr', argv, { result: response }),
      ]),
    );
    let result = invoke(
      'herdr',
      ['--workspace', 'sim-7-workspace-2', 'workspace', 'list'],
      input,
    );
    assert.equal(result.status, 0, result.stderr);
    const dir = result.dir,
      ids = JSON.parse(result.stdout).workspaces.map((row) => row.workspace_id);
    assert.deepEqual(ids, ['sim-7-workspace-2', 'sim-7-workspace-2-fresh-1']);
    result = invoke(
      'herdr',
      ['--workspace', 'sim-7-workspace-2', 'workspace', 'list'],
      input,
      dir,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout).workspaces.map((row) => row.workspace_id),
      ids,
    );
    const cursor = path.join(dir, 'herdr.json'),
      retained = fs.readFileSync(cursor),
      lock = `${cursor}.lock`;
    fs.writeFileSync(lock, 'owned collision', { mode: 0o600 });
    result = invoke('herdr', argv, input, dir);
    assert.equal(result.status, 2);
    assert.deepEqual(fs.readFileSync(cursor), retained);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'owned collision');
    fs.unlinkSync(lock);
    const generated = write(
      'generated.json',
      scenario(
        processTransaction('herdr', ['workspace', 'list'], {
          result: response,
        }),
      ),
    );
    result = invoke('herdr', ['workspace', 'list'], generated);
    assert.equal(result.status, 0, result.stderr);
    const pair = JSON.parse(result.stdout).workspaces;
    assert.notEqual(pair[0].workspace_id, pair[1].workspace_id);
    const double = write(
      'double.json',
      scenario(
        processTransaction(
          'herdr',
          [
            '--workspace',
            '$workspace:1',
            'workspace',
            'rename',
            '$workspace:3',
            '<redacted:label>',
          ],
          { result: response },
        ),
      ),
    );
    result = invoke(
      'herdr',
      [
        '--workspace',
        'sim-7-workspace-2',
        'workspace',
        'rename',
        'sim-7-workspace-2-fresh-1',
        'synthetic-label',
      ],
      double,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).workspaces[1].workspace_id,
      'sim-7-workspace-2-fresh-2',
    );
    const numericData = scenario(
        processTransaction('herdr', ['workspace', 'list'], {
          result: { sessions: [{ port: '$port:1' }, { port: '$port:2' }] },
        }),
      ),
      numeric = write('numeric.json', numericData),
      numericDir = state(),
      numericCursor = path.join(numericDir, 'herdr.json');
    fs.writeFileSync(
      numericCursor,
      JSON.stringify({
        schema: 1,
        scenario: numericData,
        cursor: 0,
        bindings: { '$port:1': '030009' },
      }),
      { mode: 0o600 },
    );
    const negative = fs.readFileSync(numericCursor);
    result = invoke('herdr', ['workspace', 'list'], numeric, numericDir);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.deepEqual(fs.readFileSync(numericCursor), negative);
    fs.writeFileSync(
      numericCursor,
      JSON.stringify({
        schema: 1,
        scenario: numericData,
        cursor: 0,
        bindings: { '$port:1': '30009' },
      }),
    );
    result = invoke('herdr', ['workspace', 'list'], numeric, numericDir);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout).sessions.map((row) => row.port),
      [30009, 30010],
    );
    const unknownDir = state(),
      link = path.join(unknownDir, 'herdr.json');
    fs.symlinkSync(path.join(root, 'absent'), link);
    result = invoke('herdr', ['workspace', 'list'], generated, unknownDir);
    assert.equal(result.status, 2);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    const pidInput = write(
      'pid.json',
      scenario(
        processTransaction('herdr', ['workspace', 'list'], {
          result: { pid: '$pid:1' },
        }),
      ),
    );
    result = invoke('herdr', ['workspace', 'list'], pidInput);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(path.join(result.dir, 'herdr.json')), false);
  } else if (mode === 'faults') {
    const data = scenario(
        processTransaction('claudecode', ['--print', '<redacted:prompt>'], {
          stdin: true,
          stderr: true,
          recipe: 'empty',
        }),
      ),
      input = write('stdin.json', data);
    let result = invoke(
      'claude',
      ['--print', 'synthetic-prompt'],
      input,
      undefined,
      'synthetic input',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '<redacted:stderr>\n');
    result = invoke(
      'claude',
      ['--print', 'synthetic-prompt'],
      input,
      undefined,
      '',
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /stdin was absent/);
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      const record = launch('claude', ['--print', 'synthetic-prompt'], input),
        lock = await lockReady(record, 'claudecode');
      record.child.kill(signal);
      const [, actual] = await exitBounded(record);
      assert.equal(actual, signal);
      assert.equal(fs.existsSync(lock), false);
      assert.equal(
        fs.existsSync(path.join(record.dir, 'claudecode.json')),
        false,
      );
    }
    const killed = launch('claude', ['--print', 'synthetic-prompt'], input),
      stale = await lockReady(killed, 'claudecode');
    killed.child.kill('SIGKILL');
    const [, killSignal] = await exitBounded(killed);
    assert.equal(killSignal, 'SIGKILL');
    assert.equal(
      fs.existsSync(stale),
      true,
      'SIGKILL bypasses child finally; parent must retain until reaped',
    );
    const stillBlocked = invoke(
      'claude',
      ['--print', 'synthetic-prompt'],
      input,
      killed.dir,
      'synthetic input',
    );
    assert.equal(stillBlocked.status, 2);
    assert.equal(fs.existsSync(stale), true);
    const rows = Array.from({ length: 256 }, (_, i) => ({
      session_id: `$session:${i + 1}`,
      workspace_id: `$workspace:${i + 1}`,
      pane_id: `$pane:${i + 1}`,
      team_id: `$team:${i + 1}`,
      worker_id: `$worker:${i + 1}`,
      path: `$path:${i + 1}`,
      label: '<redacted:label>',
      body: '<redacted:body>',
      content: '<redacted:content>',
      tool_input: '<redacted:tool-input>',
      tool_output: '<redacted:tool-output>',
      transcript: '<redacted:transcript>',
      ticket_body: '<redacted:ticket-body>',
      file_contents: '<redacted:file-contents>',
      assistant_text: '<redacted:assistant-text>',
      stdin: '<redacted:stdin>',
      stdout: '<redacted:stdout>',
      stderr: '<redacted:stderr>',
      error_message: '<redacted:error-message>',
    }));
    const large = write(
        'blocked-output.json',
        scenario(
          processTransaction('claudecode', ['agents', '--json'], {
            result: { agents: rows },
          }),
        ),
      ),
      blocked = launch('claude', ['agents', '--json'], large);
    let stderr = '';
    blocked.child.stderr.on('data', (chunk) => (stderr += chunk));
    const [code, signal] = await exitBounded(blocked);
    assert.equal(signal, null);
    assert.equal(code, 2, stderr);
    assert.match(stderr, /stdio write deadline exceeded/);
    assert.equal(
      fs.existsSync(path.join(blocked.dir, 'claudecode.json.lock')),
      false,
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(blocked.dir, 'claudecode.json'), 'utf8'),
      ).cursor,
      1,
      'post-consumption IO is uncertain, not safe replay',
    );
    const recorded = write(
      'recorded-signal.json',
      scenario(
        processTransaction('pi', ['--version'], {
          recipe: 'version',
          signal: 'SIGTERM',
        }),
      ),
    );
    result = invoke('pi', ['--version'], recorded);
    assert.equal(result.signal, 'SIGTERM');
    assert.equal(fs.existsSync(path.join(result.dir, 'pi.json.lock')), false);
  } else throw Error('unknown scenario probe mode');
  console.log(
    `W5 B1 ${mode}: native synthetic consumer/failure assertions PASS`,
  );
} finally {
  for (const record of children) {
    if (record.child.exitCode === null && record.child.signalCode === null)
      record.child.kill('SIGTERM');
    await exitBounded(record);
    record.child.stdin?.destroy();
    record.child.stdout?.destroy();
    record.child.stderr?.destroy();
  }
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false);
  console.log('W5 owned probe children reaped before root removal PASS');
}
