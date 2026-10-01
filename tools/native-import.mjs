import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Read configuration, never instruction text. Explicit converted file growth.
const config = JSON.parse(
  fs.readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'),
);
const root = path.resolve(new URL('../', import.meta.url).pathname);
for (const file of config.include) {
  if (!file.endsWith('.ts') || file.includes('*'))
    throw Error(
      `native smoke needs an explicit converted backend file: ${file}`,
    );
  await import(pathToFileURL(path.join(root, file)).href);
  console.log(`native import: ${file}`);
}
