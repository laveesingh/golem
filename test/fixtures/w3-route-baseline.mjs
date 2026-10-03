import assert from 'node:assert/strict';
import {
  archiveTicket,
  createScratchTicket,
  SMOKE_PROJECT,
} from '../../dashboard/scripts/_scratch.mjs';
import { startPrivateDashboard } from '../support/private-dashboard.mjs';

const dashboard = await startPrivateDashboard();
const ids = [],
  cases = [];
const previous = process.env.GOLEM_SMOKE_API;
process.env.GOLEM_SMOKE_API = dashboard.base;
const normalize = (value) => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        ['server_time', 'created_at', 'updated_at'].includes(key) && v
          ? '<timestamp>'
          : key === 'projects_root'
            ? '<private-projects>'
            : normalize(v),
      ]),
    );
  return value;
};
const request = async (name, body, options = {}) => {
  const response = await fetch(`${dashboard.base}/api/tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: SMOKE_PROJECT,
      created_by: 'smoke',
      title: `SMOKE-${name}`,
      ...body,
    }),
    signal: AbortSignal.timeout(5000),
    ...options,
  });
  const data = await response.json();
  if (response.ok && data.id) ids.push(data.id);
  cases.push({ name, status: response.status, body: normalize(data) });
};
try {
  const health = await fetch(`${dashboard.base}/api/health?unknown=3`, {
    signal: AbortSignal.timeout(5000),
  });
  cases.push({
    name: 'health',
    status: health.status,
    body: normalize(await health.json()),
  });
  const created = await createScratchTicket({
    title: 'baseline valid',
    labels: ['known'],
    source_ref: 'github:example/repo#1',
    unknown_extension: 'preserve-at-ingress',
  });
  ids.push(created.id);
  cases.push({
    name: 'created-markdown',
    status: 201,
    body: normalize(created),
  });
  const html = await createScratchTicket({
    title: 'baseline html',
    kind: 'spec',
    body_format: 'html',
    body: '<h2>fixture</h2><p>body</p>',
  });
  ids.push(html.id);
  cases.push({ name: 'created-html', status: 201, body: normalize(html) });
  await request('missing-project', { project_id: null });
  await request('missing-title', { title: '' });
  await request('invalid-kind', { kind: 'nonsense' });
  await request('unsupported-html', {
    kind: 'task',
    body_format: 'html',
    body: '<p>x</p>',
  });
  await request('malformed-html', {
    kind: 'spec',
    body_format: 'html',
    body: '<p data-block-id="wrong">x</p>',
  });
  await request('numeric-title', { title: 123 });
  await request('numeric-project', { project_id: 123 });
  await request('malformed-json', {}, { body: '{' });
  assert.ok(
    cases.every((item) => [200, 201, 400].includes(item.status)),
    JSON.stringify(cases),
  );
  console.log(JSON.stringify({ cases }, null, 2));
} finally {
  for (const id of ids) await archiveTicket(id);
  if (previous === undefined) delete process.env.GOLEM_SMOKE_API;
  else process.env.GOLEM_SMOKE_API = previous;
  await dashboard.stop();
}
