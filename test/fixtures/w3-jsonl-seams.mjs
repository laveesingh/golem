// S1 JSONL seam proofs inside an owned sandbox. Prints one JSON receipt.
// Modes: `race` (16 processes x 200 files lose zero events) and
// `spool-future` (a v2 spool is refused untouched with nothing submitted).
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { repo } from '../support/sandbox.mjs';

const mode = process.argv[2];
const home = process.env.GOLEM_HOME;
const sandbox = process.env.GOLEM_W2_SANDBOX;
assert.ok(home && sandbox, 'owned sandbox required');

if (mode === 'race-child') {
  const { appendJsonl } = await import('../../lib/jsonl-header.ts');
  const [root, id] = process.argv.slice(3);
  process.send('ready');
  process.once('message', () => {
    for (let i = 0; i < 200; i++)
      appendJsonl(path.join(root, `${i}.jsonl`), 'journal', {
        id: Number(id),
      });
    process.disconnect();
  });
} else if (mode === 'race') {
  const N = 16;
  const R = 200;
  const root = fs.mkdtempSync(path.join(sandbox, 's1-jsonl-race-'));
  const children = Array.from({ length: N }, (_, i) =>
    fork(new URL(import.meta.url), ['race-child', root, String(i)], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    }),
  );
  await Promise.all(
    children.map(
      (child) => new Promise((resolve) => child.once('message', resolve)),
    ),
  );
  const done = children.map(
    (child) => new Promise((resolve) => child.once('exit', resolve)),
  );
  for (const child of children) child.send('go');
  await Promise.all(done);
  const bad = [];
  for (let i = 0; i < R; i++) {
    const raw = fs
      .readFileSync(path.join(root, `${i}.jsonl`), 'utf8')
      .trim()
      .split('\n');
    const invalid = [];
    const lines = raw.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        invalid.push(line);
        return {};
      }
    });
    const data = lines.filter((value) => value.id !== undefined);
    const headers = lines.filter((value) => value.kind === 'journal');
    const firstIsHeader =
      lines.length > 0 &&
      lines[0].kind === 'journal' &&
      lines[0].schema_version === 1;
    if (
      data.length !== N ||
      headers.length !== 1 ||
      !firstIsHeader ||
      invalid.length
    )
      bad.push({
        file: i,
        events: data.length,
        headers: headers.length,
        firstIsHeader,
        invalid: invalid.length,
      });
  }
  console.log(
    JSON.stringify({ mode, N, R, badCount: bad.length, bad: bad.slice(0, 8) }),
  );
  assert.equal(bad.length, 0, `lost events in ${bad.length} files`);
  fs.rmSync(root, { recursive: true, force: true });
} else if (mode === 'spool-future') {
  const { createSandbox } = await import('../support/sandbox.mjs');
  const inner = createSandbox();
  try {
    const project = path.join(inner.root, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# private');
    const jq =
      ['/opt/homebrew/bin/jq', '/usr/bin/jq', '/usr/local/bin/jq'].find(
        (candidate) => fs.existsSync(candidate),
      ) ?? 'jq';
    fs.symlinkSync(jq, path.join(inner.root, 'bin', 'jq'));
    const log = path.join(inner.root, 'curl-log');
    fs.writeFileSync(
      path.join(inner.root, 'bin', 'curl'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$REPRO_CURL_LOG"\nexit 0\n',
      { mode: 0o700 },
    );
    const spool = path.join(inner.env.GOLEM_HOME, 'spool', 'future.jsonl');
    fs.mkdirSync(path.dirname(spool), { recursive: true });
    const before =
      '{"schema_version":2,"kind":"spool"}\n{"uuid":"future-event","class":"lifecycle","event":"session-start"}\n';
    fs.writeFileSync(spool, before);
    const run = spawnSync(
      '/bin/bash',
      [path.join(repo, 'substrate/hooks/journal-route.sh'), 'session-start'],
      {
        cwd: project,
        input: JSON.stringify({
          session_id: 'future',
          cwd: project,
          harness: 'synthetic',
        }),
        env: {
          ...inner.env,
          REPRO_CURL_LOG: log,
          CLAUDE_CONFIG_DIR: path.join(inner.env.HOME, '.claude'),
        },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    const after = fs.readFileSync(spool, 'utf8');
    console.log(
      JSON.stringify({
        mode,
        exit: run.status,
        spoolUnchanged: after === before,
        submitted: fs.existsSync(log),
      }),
    );
    assert.equal(run.status, 0);
    assert.equal(after, before, 'future spool bytes stay untouched');
    assert.equal(fs.existsSync(log), false, 'nothing is submitted');
  } finally {
    inner.cleanup();
  }
} else {
  throw new Error(`unknown seam mode: ${mode}`);
}
