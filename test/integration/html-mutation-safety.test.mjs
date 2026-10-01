import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'vitest';
import {
  createHtmlMutationFixture,
  writeHtmlMutant,
} from '../support/html-mutation.mjs';
import { runScript } from '../support/run-script.mjs';
import { repo } from '../support/sandbox.mjs';

const production = path.join(repo, 'dashboard/server/html-body.js');
test('owned mirrors are independent and exclusive creation cannot overwrite a collision', async () => {
  const source = fs.readFileSync(production, 'utf8');
  const first = createHtmlMutationFixture(),
    second = createHtmlMutationFixture();
  try {
    assert.notEqual(first.root, second.root);
    const bytes = fs.readFileSync(first.mutantPath);
    assert.throws(() => writeHtmlMutant(first), { code: 'EEXIST' });
    assert.deepEqual(fs.readFileSync(first.mutantPath), bytes);
    for (const fixture of [first, second]) {
      const normal = await import(
        pathToFileURL(path.join(fixture.root, 'html-body.js')).href
      );
      const mutant = await import(pathToFileURL(fixture.mutantPath).href);
      assert.doesNotMatch(
        normal.normalizeHtmlBody('<p>x<script>x</script></p>').html,
        /<script/,
      );
      assert.match(
        mutant.normalizeHtmlBody('<p>x<script>x</script></p>').html,
        /<script/,
      );
    }
    assert.equal(fs.readFileSync(production, 'utf8'), source);
    assert.equal(
      fs.existsSync(path.join(repo, 'dashboard/server/.gol343-mutant.mjs')),
      false,
    );
  } finally {
    fs.rmSync(first.root, { recursive: true, force: true });
    fs.rmSync(second.root, { recursive: true, force: true });
  }
});
for (const mode of ['timeout', 'interrupt'])
  test(`mutation ${mode} cannot leave checkout residue`, async () => {
    const source = fs.readFileSync(production, 'utf8');
    let failure;
    try {
      await runScript('test/fixtures/w2-html-mutation-probe.mjs', {
        args: [mode],
        timeout: mode === 'timeout' ? 1000 : 5000,
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure?.receipt, String(failure));
    const marker = JSON.parse(failure.receipt.stdout.trim());
    assert.equal(marker.ordinarySafe, true);
    assert.equal(marker.mutantUnsafe, true);
    assert.ok(marker.mirror.startsWith(failure.receipt.sandboxRoot + path.sep));
    assert.equal(fs.existsSync(marker.mirror), false);
    assert.equal(fs.existsSync(failure.receipt.sandboxRoot), false);
    assert.equal(fs.readFileSync(production, 'utf8'), source);
    assert.equal(
      fs.existsSync(path.join(repo, 'dashboard/server/.gol343-mutant.mjs')),
      false,
    );
    if (mode === 'timeout') assert.equal(failure.receipt.timedOut, true);
    else assert.equal(failure.receipt.signal, 'SIGTERM');
  });
