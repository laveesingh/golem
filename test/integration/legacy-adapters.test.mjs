import { test } from 'vitest';
import inventory from '../support/adapter-inventory.json' with { type: 'json' };
import { runScript } from '../support/run-script.mjs';

for (const entry of inventory) {
  test(
    entry.file,
    async () => {
      await runScript(entry.file, entry);
    },
    entry.timeout + 10000,
  );
}
