#!/usr/bin/env node
// Preserve bootstrap's global profile prefix before selecting the dashboard
// command. The shared bin owns checkout/native versus installed/JS selection.
try {
  let prefixEnd = 2;
  while (prefixEnd < process.argv.length) {
    const arg = process.argv[prefixEnd];
    if (arg === '--profile' || arg === '--port') {
      const value = process.argv[prefixEnd + 1];
      if (!value || value.startsWith('--'))
        throw new Error(`${arg} requires a value`);
      prefixEnd += 2;
    } else if (arg.startsWith('--profile=') || arg.startsWith('--port='))
      prefixEnd++;
    else break;
  }
  process.argv.splice(prefixEnd, 0, 'dashboard');
  await import('./golem-bin.js');
} catch (error) {
  console.error(`golem: ${error.message}`);
  process.exitCode = 2;
}
