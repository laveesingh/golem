#!/usr/bin/env node
// GOL-382 R10: the dashboard's intake suggestion follows roles.default, not a
// fixed role name.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golemtest-intake-'));
process.env.GOLEM_HOME = temp;

try {
  const { teamAssists } = await import('../dashboard/server/team-assist.js');
  const { defaultSessionRole } = await import('../lib/session-role.js');
  const rows = [
    { session_id: 'lead-busy', role: 'lead', alive: true, in_progress_tickets: [1, 2] },
    { session_id: 'lead-free', role: 'lead', alive: true, in_progress_tickets: [] },
    { session_id: 'planner-1', role: 'planner', alive: true, in_progress_tickets: [] },
  ];

  assert.equal(defaultSessionRole(), 'lead', 'no config: the default role is lead');
  assert.equal(teamAssists(rows, { intakeRole: defaultSessionRole() }).suggested_intake.session_id, 'lead-free', 'least-loaded session of the default role');

  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({ roles: { default: 'planner' } }));
  assert.equal(defaultSessionRole(), 'planner');
  assert.equal(teamAssists(rows, { intakeRole: defaultSessionRole() }).suggested_intake.session_id, 'planner-1', 'the intake follows roles.default');

  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({ roles: { default: null } }));
  assert.equal(defaultSessionRole(), null);
  assert.equal(teamAssists(rows, { intakeRole: defaultSessionRole() }).suggested_intake, null, 'no default role: no suggestion');

  console.log('intake suggestion test passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
