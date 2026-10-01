import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One foreground owner, two private children. No detached server survives it.
export async function runDev(args = []) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('golem --profile <name> [--port N] dev\nStarts the private dashboard (N) and Vite (N+1); reserves Ladle (N+2). Ctrl-C stops both.');
    return;
  }
  if (args.length) throw new Error('golem dev accepts only --help; profile and --port precede dev');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const children = [];
  let stopping = false;
  let exitCode = 0;
  let teardownTimer;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    teardownTimer = setTimeout(() => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000);
    teardownTimer.unref();
  };
  const onSignal = () => stop(0);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const commands = [
      [path.join(root, 'dashboard/server/index.js')],
      [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', path.join(root, 'dashboard/vite.config.js')],
    ];
    await Promise.all(commands.map(argv => new Promise(resolve => {
      const child = spawn(process.execPath, argv, { cwd: root, env: process.env, stdio: 'inherit' });
      children.push(child);
      child.once('error', error => { console.error(error.message); stop(1); resolve(); });
      child.once('exit', (code, signal) => { if (!stopping) stop(code || (signal ? 1 : 0)); resolve(); });
    })));
    process.exitCode = exitCode;
  } finally {
    clearTimeout(teardownTimer);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
