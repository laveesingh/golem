import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { repo } from './sandbox.mjs';

export async function startPrivateDashboard({
  root = repo,
  env = process.env,
} = {}) {
  assert.ok(
    env.GOLEM_W2_SANDBOX && env.HOME.startsWith(`${env.GOLEM_W2_SANDBOX}/`),
    'private env required before dashboard allocation',
  );
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  assert.ok(![7420, 7421].includes(port));
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(
    process.execPath,
    [path.join(root, 'dashboard/server/index.js')],
    {
      cwd: root,
      env: { ...env, PORT: String(port), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const closed = once(child, 'close');
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw Error(`private dashboard exited: ${stdout}${stderr}`);
      try {
        const response = await fetch(`${base}/api/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok)
          return { base, child, stop, logs: () => ({ stdout, stderr }) };
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error(`private dashboard readiness deadline: ${stdout}${stderr}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
