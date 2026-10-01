import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { cleanupGroups } from './cleanup-groups.mjs';
import { createSandbox, repo } from './sandbox.mjs';

async function stopMainGroup(child, root) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error(`owned child group survived cleanup; retained ${root}`);
}
export async function runScript(
  file,
  { timeout = 90000, ports = [], args = [] } = {},
) {
  const sandbox = createSandbox();
  let child,
    timer,
    receipt,
    failure,
    stdout = '',
    stderr = '',
    timedOut = false;
  try {
    for (const port of ports) {
      if ([7420, 7421].includes(port)) throw Error('production port forbidden');
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      await new Promise((resolve) => server.close(resolve));
    }
    child = spawn(process.execPath, [path.join(repo, file), ...args], {
      cwd: repo,
      env: sandbox.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'close');
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') stderr += String(error);
      }
    }, timeout);
    const [code, signal] = await exited;
    receipt = {
      file,
      code,
      signal,
      timedOut,
      stdout,
      stderr,
      sandboxRoot: sandbox.root,
    };
    const evidenceDir = path.join(repo, '.test-results');
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(
      path.join(evidenceDir, `${file.replaceAll('/', '__')}.json`),
      JSON.stringify(receipt, null, 2),
    );
    console.log(JSON.stringify(receipt));
    if (code !== 0 || signal || timedOut)
      throw Object.assign(Error(JSON.stringify(receipt, null, 2)), { receipt });
  } catch (error) {
    failure = error;
  }
  clearTimeout(timer);
  try {
    await stopMainGroup(child, sandbox.root);
    await cleanupGroups(sandbox.root);
    sandbox.cleanup();
  } catch (error) {
    // Preserve both execution failure and cleanup failure; retain roots on uncertain teardown.
    failure = failure
      ? new AggregateError(
          [failure, error],
          'adapter execution and cleanup failed',
        )
      : error;
  }
  if (failure) throw failure;
  return receipt;
}
