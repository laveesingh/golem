import { spawnSync } from 'node:child_process';

let failed = false;
for (const [label, args] of [
  ['Biome', ['node_modules/@biomejs/biome/bin/biome', 'check']],
  ['TypeScript strict', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['Knip debt', ['tools/knip-check-child.mjs']],
  ['Native backend import', ['tools/native-import.mjs']],
  ['Contracts freshness', ['tools/contracts-build.ts', '--check']],
  ['Contract baseline policy', ['tools/contracts-compatibility.mjs']],
  ['Token generation freshness', ['tools/tokens-build.ts', '--check']],
  ['Converted token literals', ['tools/lint-tokens.ts']],
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
  'Pending later gates: actual released-schema compatibility after initial6.0 bootstrap; W3 versioned stores/complete installed tooling; W4 component/browser/axe/glyph; W3 token package materialization; W7 emitted renders.',
);
process.exitCode = failed ? 1 : 0;
