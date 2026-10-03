import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageRoot } from '../lib/package-root.ts';

/** Emitted callers use the staged asset view; native callers use the checkout. */
export function tokenStyleRoot(caller: string | URL): string {
  const root = packageRoot(caller);
  const relative = path
    .relative(root, fileURLToPath(caller))
    .split(path.sep)
    .join('/');
  return relative.startsWith('dist/') ? path.join(root, 'dist/assets') : root;
}
export function defaultTokenRoot(caller: string | URL): string {
  return path.join(tokenStyleRoot(caller), 'dashboard/web/src/ui/tokens');
}
