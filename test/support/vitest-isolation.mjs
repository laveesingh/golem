import { afterAll } from 'vitest';
import { createSandbox } from './sandbox.mjs';

const sandbox = createSandbox();
const before = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (
    /^(GOLEM_|HERDR_|CLAUDE_|PI_|XDG_|GIT_|NODE_OPTIONS$|PORT$|HOST$|HOME$|TMP|TEMP$)/.test(
      key,
    )
  )
    delete process.env[key];
}
Object.assign(process.env, sandbox.env);
afterAll(() => {
  sandbox.cleanup();
  for (const key of Object.keys(process.env))
    if (!(key in before)) delete process.env[key];
  Object.assign(process.env, before);
});
