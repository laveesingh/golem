import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { cleanupGroups, groupPresent } from './cleanup-groups.mjs';
import { createSandbox, repo } from './sandbox.mjs';

async function stopMainGroup(child, root) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (
      error.code !== 'ESRCH' &&
      !(error.code === 'EPERM' && !groupPresent(child.pid))
    )
      throw error;
  }
  for (let i = 0; i < 100; i++) {
    if (!groupPresent(child.pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error(`owned child group survived cleanup; retained ${root}`);
}
async function waitBounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function runScript(
  file,
  { timeout = 90000, ports = [], args = [], drainTimeout = 2000 } = {},
) {
  const sandbox = createSandbox();
  let child,
    timer,
    failure,
    closed = Promise.resolve(true),
    code = null,
    signal = null;
  let stdout = '',
    stderr = '',
    timedOut = false,
    pipeDrainTimedOut = false,
    ownedGroups = [];
  const cleanupErrors = [];
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
    // EXIT, not CLOSE, is the process deadline. Detached inherited-pipe holders
    // are torn down independently before waiting for the pipe-close boundary.
    closed = new Promise((resolve) => child.once('close', () => resolve(true)));
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode, exitSignal) => {
        code = exitCode;
        signal = exitSignal;
        resolve();
      });
    });
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeout);
    });
    await Promise.race([exited, deadline]);
  } catch (error) {
    failure = error;
  }
  clearTimeout(timer);
  // This path runs on deadline even when inherited pipes keep CLOSE pending.
  try {
    await stopMainGroup(child, sandbox.root);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    ownedGroups = await cleanupGroups(sandbox.root);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (!(await waitBounded(closed, drainTimeout))) {
    pipeDrainTimedOut = true;
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    cleanupErrors.push(
      Error(`pipe drain indeterminate; retained ${sandbox.root}`),
    );
  }
  code = child?.exitCode ?? code;
  signal = child?.signalCode ?? signal;
  const receipt = {
    file,
    code,
    signal,
    timedOut,
    pipeDrainTimedOut,
    stdout,
    stderr,
    sandboxRoot: sandbox.root,
    ownedGroups,
    cleanupErrors: cleanupErrors.map((error) => error.message),
  };
  // Receipts exist even after timeout, launch failure, uncertain cleanup or
  // bounded pipe-drain failure. No throw can bypass this evidence boundary.
  const evidenceDir = path.join(repo, '.test-results');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, `${file.replaceAll('/', '__')}.json`),
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt));
  if (code !== 0 || signal || timedOut || failure)
    failure = Object.assign(Error(JSON.stringify(receipt, null, 2)), {
      receipt,
      cause: failure,
    });
  if (cleanupErrors.length)
    failure = Object.assign(
      new AggregateError(
        [...(failure ? [failure] : []), ...cleanupErrors],
        'adapter execution/cleanup failed',
      ),
      { receipt },
    );
  else sandbox.cleanup();
  if (failure) throw failure;
  return receipt;
}
