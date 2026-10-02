#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTokens, TokenError } from './tokens-core.ts';
import {
  checkTokenFreshness,
  loadTokenSources,
  materializeTokens,
  publishTokens,
} from './tokens-io.ts';

export function runTokenBuild(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'tokens-build [--root ABSOLUTE_TOKEN_ROOT] --check|--write|--materialize ABSOLUTE_STAGING_DIR\nBounded DTCG subset; source atomic pointer is not npm-link preservation.',
    );
    return 0;
  }
  let root = fileURLToPath(
    new URL('../dashboard/web/src/ui/tokens', import.meta.url),
  );
  if (args[0] === '--root') {
    if (!args[1] || !path.isAbsolute(args[1])) throw new TokenError('ARGUMENT');
    root = args[1];
    args = args.slice(2);
  }
  if (args.length === 1 && args[0] === '--check') {
    const snapshot = checkTokenFreshness(root);
    console.log(`tokens fresh ${snapshot.id}`);
    return 0;
  }
  if (args.length === 1 && args[0] === '--write') {
    const source = loadTokenSources(root);
    buildTokens(source);
    const snapshot = publishTokens(root, source);
    console.log(`tokens published ${snapshot.id}`);
    return 0;
  }
  if (args.length === 2 && args[0] === '--materialize') {
    const snapshot = checkTokenFreshness(root);
    materializeTokens(snapshot, args[1]);
    console.log(`tokens materialized pinned ${snapshot.id}`);
    return 0;
  }
  throw new TokenError('ARGUMENT');
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = runTokenBuild(process.argv.slice(2));
  } catch (error) {
    console.error(
      JSON.stringify(
        error instanceof TokenError
          ? { code: error.message, token: error.token, set: error.set }
          : { code: 'IO_OWNERSHIP' },
      ),
    );
    process.exitCode =
      error instanceof TokenError && error.message === 'ARGUMENT' ? 2 : 1;
  }
}
