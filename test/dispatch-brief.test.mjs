#!/usr/bin/env node
// Dispatch briefs: task and spec briefs are pointers to ticket_get. A spec
// brief still names its active comments (a re-dispatch hands over open review
// feedback) and appends the project's .agents/briefs/dispatch.md template.
// Temp GOLEM_HOME only.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-dispatch-brief-'));
process.env.GOLEM_HOME = path.join(temp, 'state');
delete process.env.XDG_CONFIG_HOME;
const root = path.join(temp, 'proj');
fs.mkdirSync(path.join(root, '.agents', 'briefs'), { recursive: true });
fs.mkdirSync(process.env.GOLEM_HOME, { recursive: true });
fs.writeFileSync(path.join(root, '.agents', 'briefs', 'dispatch.md'), 'Project rule for {{ticket_id}} ({{ticket_slug}}).');
fs.writeFileSync(path.join(process.env.GOLEM_HOME, 'projects.json'), JSON.stringify({ projects: [{ id: 'demo-abcdef', path: root }] }));

const { buildDispatchBrief } = await import('../dashboard/server/dispatch-brief.js');

const body = 'SPEC-BODY-MARKER '.repeat(2000);
const spec = {
  id: 'TKT-1', display_id: 'GOL-1', project_id: 'demo-abcdef', kind: 'spec', title: 'Share specs', state: 'in_progress', body,
  comments: [
    { id: 'c-open', author: 's-1', author_label: 'human', dispatch_state: 'undispatched', body: 'COMMENT-TEXT-MARKER' },
    { id: 'c-sent', author: 's-2', author_label: 'reviewer1', dispatch_state: 'dispatched', body: 'x' },
    { id: 'c-done', author: 's-3', dispatch_state: 'addressed', body: 'y' },
  ],
  children: [{ display_id: 'GOL-2', title: 'build', state: 'todo', body }],
};

const brief = buildDispatchBrief(spec, 'Locked; watch the tunnel.', null, 'env-1', 's-lead');
assert.ok(!brief.includes('SPEC-BODY-MARKER'), 'spec brief does not carry the body');
assert.ok(!brief.includes('COMMENT-TEXT-MARKER'), 'spec brief does not carry comment text');
assert.ok(brief.startsWith('Spec dispatch: GOL-1 "Share specs" (project demo-abcdef, state in_progress).'));
assert.match(brief, /\nNote:\nLocked; watch the tunnel\./);
assert.match(brief, /Dispatch message_id: env-1 /);
assert.match(brief, /Authenticated delegating session_id: s-lead/);
assert.match(brief, /Active comments to address \(2\): c-open by human, c-sent by reviewer1\./);
assert.match(brief, /Children: 1\./);
assert.match(brief, /Read it with ticket_get GOL-1 \(or golem ticket get GOL-1\): body, comments and children\./);
assert.ok(brief.endsWith('Project rule for GOL-1 (share-specs).'), 'project template appended');
assert.ok(brief.length < 1_000, `spec brief is small (${brief.length} chars)`);

const quiet = buildDispatchBrief({ ...spec, comments: [], children: [] }, null);
assert.match(quiet, /No active comments\./);
assert.match(quiet, /Children: 0\./);

const task = buildDispatchBrief({ ...spec, kind: 'task', display_id: 'GOL-3' }, null);
assert.ok(task.startsWith('Ticket dispatch: GOL-3 "Share specs" (project demo-abcdef, kind task, state in_progress).'));
assert.match(task, /Read it with ticket_get GOL-3 \(or golem ticket get GOL-3\)\./);
assert.ok(!task.includes('SPEC-BODY-MARKER'));

fs.rmSync(temp, { recursive: true, force: true });
console.log(`dispatch brief passed: spec brief ${brief.length} chars (body ${body.length} not carried), active comments named, template appended; task brief unchanged`);
