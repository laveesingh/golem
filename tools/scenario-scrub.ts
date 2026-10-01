#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScenarioError } from './scenario-format.ts';
import { readScenarioFile, writeCandidate } from './scenario-io.ts';
import { scrubScenario, validateScenario } from './scenario-scrub-core.ts';

export function runScenarioCli(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'scenario-scrub --input ABSOLUTE_JSON --output ABSOLUTE_TEMP_CANDIDATE\nscenario-scrub --check ABSOLUTE_SCRUBBED_JSON\nNo raw journals, default paths, overwrite, or recording/provenance claim.',
    );
    return 0;
  }
  if (args.length === 2 && args[0] === '--check') {
    validateScenario(readScenarioFile(args[1]));
    console.log(
      'canonical scrubbed scenario; provenance review still required',
    );
    return 0;
  }
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output')
    throw new ScenarioError('unknown scrub CLI arguments');
  const clean = scrubScenario(readScenarioFile(args[1]));
  validateScenario(clean);
  writeCandidate(args[3], clean);
  console.log(
    clean.scenario.startsWith('synthetic-')
      ? 'synthetic candidate written; NOT a golden recording'
      : 'scrubbed candidate written; NOT approved recording provenance',
  );
  return 0;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = runScenarioCli(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof ScenarioError
        ? error.message
        : 'scenario input/output ownership or I/O rejected',
    );
    process.exitCode = 2;
  }
}
