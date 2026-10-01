import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { captureProcessGroup } from '../../lib/process-group.js';
import { cleanupGroups } from './cleanup-groups.mjs';
import { stopMainGroup } from './main-group.mjs';
import { createSandbox, repo } from './sandbox.mjs';

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
  {
    timeout = 90000,
    ports = [],
    args = [],
    drainTimeout = 2000,
    mainControls = {},
  } = {},
) {
  const sandbox = createSandbox();
  let child,
    timer,
    failure,
    closed = Promise.resolve(true),
    code = null,
    signal = null,
    mainOwnership = null,
    allocationHandler;
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
    const grant = randomUUID();
    child = spawn(process.execPath, [path.join(repo, file), ...args], {
      cwd: repo,
      env: { ...sandbox.env, GOLEM_W2_MAIN_GRANT: grant },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const allocated = new Promise((resolve, reject) => {
      allocationHandler = (message) => {
        try {
          if (
            message?.kind !== 'w2-main-ready' ||
            message.grant !== grant ||
            message.pid !== child.pid
          )
            throw Error('invalid main allocation handshake');
          mainOwnership = captureProcessGroup(child.pid);
          if (!mainOwnership.members.some((member) => member.pid === child.pid))
            throw Error('allocated main leader incarnation missing');
          fs.writeFileSync(
            path.join(sandbox.root, 'main-ownership.json'),
            JSON.stringify(mainOwnership),
            { flag: 'wx', mode: 0o400 },
          );
          child.send({ kind: 'w2-main-run', grant });
          resolve(true);
        } catch (error) {
          reject(error);
        }
      };
      child.once('message', allocationHandler);
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
    const allocation = await Promise.race([
      allocated,
      exited.then(() => false),
      deadline.then(() => false),
    ]);
    if (allocation === true) await Promise.race([exited, deadline]);
  } catch (error) {
    failure = error;
  }
  clearTimeout(timer);
  if (allocationHandler) child?.off('message', allocationHandler);
  // This path runs on deadline even when inherited pipes keep CLOSE pending.
  try {
    if (child?.pid)
      await stopMainGroup(mainOwnership, sandbox.root, mainControls);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    ownedGroups = await cleanupGroups(sandbox.root);
  } catch (error) {
    cleanupErrors.push(error);
  }
  // A capture failure leaves source entry ungranted; close only this private
  // IPC allocation channel, never borrow a numeric PID as signal authority.
  if (child?.connected) child.disconnect();
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
    mainOwnership,
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
