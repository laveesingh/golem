import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { runScript } from '../support/run-script.mjs';

test('scrub wave 1 removes dead routes without breaking retained consumers', async () => {
  await runScript('test/fixtures/w3-scrub-probe.mjs');
});

test('checked-in OpenAPI excludes the five removed routes and retains consumed ones', () => {
  const { paths } = JSON.parse(
    fs.readFileSync(
      new URL('../../contracts/dist/openapi.json', import.meta.url),
      'utf8',
    ),
  );
  for (const route of [
    '/api/tickets/{id}/move',
    '/api/channels',
    '/api/channel/health',
    '/api/projects/{id}',
    '/api/projects/{id}/plan',
  ])
    assert.ok(!(route in paths), route);
  for (const route of [
    '/api/workspaces',
    '/api/chat',
    '/api/tickets/{id}/links',
  ]) {
    assert.ok(route in paths, route);
  }
});
