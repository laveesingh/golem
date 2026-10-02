import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { JsonValue, pilotSchemas } from '../lib/contracts/pilot.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function contractOutputs(): Promise<Record<string, string>> {
  // Native child starts the actual private Fastify/SQLite route graph; Swagger
  // uses registered schemas, not a second hand-authored OpenAPI document.
  const { runScript } = await import('../test/support/run-script.mjs');
  const result = await runScript('test/fixtures/w3-openapi-export.mjs');
  const openapi = JSON.parse(result.stdout);
  const outputs: Record<string, string> = {};
  for (const [name, schema] of Object.entries({ ...pilotSchemas, JsonValue }))
    outputs[`contracts/dist/${name}.schema.json`] =
      `${JSON.stringify(schema, null, 2)}\n`;
  outputs['contracts/dist/openapi.json'] =
    `${JSON.stringify(openapi, null, 2)}\n`;
  const typedPilot = {
    ...openapi,
    paths: Object.fromEntries(
      Object.entries(openapi.paths)
        .filter(([key]) => key === '/api/health' || key === '/api/tickets')
        .map(([key, methods]) => [
          key,
          key === '/api/tickets'
            ? { post: (methods as Record<string, unknown>).post }
            : methods,
        ]),
    ),
  };
  outputs['dashboard/web/src/api/types.d.ts'] = astToString(
    await openapiTS(typedPilot),
  );
  return outputs;
}
export function assertContractFreshness(
  outputs: Record<string, string>,
  base = root,
): void {
  const stale = Object.entries(outputs)
    .filter(
      ([file, content]) =>
        !fs.existsSync(path.join(base, file)) ||
        fs.readFileSync(path.join(base, file), 'utf8') !== content,
    )
    .map(([file]) => file);
  if (stale.length) throw Error(`stale contracts: ${stale.join(', ')}`);
}
export async function buildContracts(check = false): Promise<void> {
  const outputs = await contractOutputs();
  if (check) assertContractFreshness(outputs);
  for (const [file, content] of Object.entries(outputs)) {
    const target = path.join(root, file);
    if (!check) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }
  console.log(
    check
      ? 'contracts freshness: pass'
      : `contracts generated: ${Object.keys(outputs).length} files`,
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  buildContracts(process.argv.includes('--check')).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
