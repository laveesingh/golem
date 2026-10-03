#!/usr/bin/env node
// GOL-421 keeps the queue scenario in dispatch-smoke so immediate and queued
// envelopes share one isolated dashboard. This named entry point is useful for
// CI/operators that specifically want the when-idle contract.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const run = promisify(execFile);
try {
  const { stdout, stderr } = await run(process.execPath, [path.join(here, 'dispatch-smoke.mjs')], { timeout: 60000 });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (!stdout.includes('when_idle: envelope is undelivered without relying on status')) throw new Error('queue assertions did not run');
} catch (err) {
  process.stderr.write(`${err?.stderr || ''}${err?.stdout || ''}`);
  throw err;
}
