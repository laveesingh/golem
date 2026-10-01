import { spawnSync } from 'node:child_process';

let failed = false;
for (const [label, args] of [
  ['Biome', ['node_modules/@biomejs/biome/bin/biome', 'check']],
  ['TypeScript strict', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['Knip debt', ['tools/knip-check-child.mjs']],
  ['Native backend import', ['tools/native-import.mjs']],
]) {
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  console.log(`${label}: exit ${result.status}`);
  if (result.error || result.status !== 0) failed = true;
}
console.log(
  'Pending later gates: W3 contract freshness/diff; W4 token literals; W3/W7 shipped artefacts.',
);
process.exitCode = failed ? 1 : 0;
