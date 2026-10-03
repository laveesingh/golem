#!/usr/bin/env node
// Private DB behavior fixture, not control-plane scratch tickets: default-human
// attribution and cascade deletion require explicit fixture entities. The W2
// adapter owns the complete DB lifetime; no shared tracker is contacted.
// WS1 verification — exercises every method of the tracker data layer against
// a throwaway DB. Prints a PASS/FAIL line per check and exits non-zero on the
// first failure (after running all checks so the full picture prints).
//
//   node dashboard/scripts/tracker-smoke.mjs

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { openTrackerDb } from '../server/tracker-db.js';

const TMP = path.join(os.tmpdir(), `golem-tracker-smoke-${crypto.randomBytes(6).toString('hex')}.db`);

let failures = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failures++;
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(TMP + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
}

const db = openTrackerDb(TMP);
try {
  // --- meta / open ----------------------------------------------------
  const raw = db.raw();
  const schemaVersion = raw.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value;
  check('open: schema_version seeded', /^\d+$/.test(schemaVersion ?? ''), `got ${schemaVersion}`);
  check('open: WAL journal mode', raw.pragma('journal_mode', { simple: true }) === 'wal');
  check('open: foreign_keys ON', raw.pragma('foreign_keys', { simple: true }) === 1);

  const PID = 'smoke-project';


  // --- ticket id allocation -------------------------------------------
  const t1 = db.createTicket({ project_id: PID, kind: 'task', title: 'First task', body: 'do the thing' });
  const t2 = db.createTicket({ project_id: PID, kind: 'spec', title: 'A design spec', priority: 'P1', labels: ['urgent'] });
  const t3 = db.createTicket({ project_id: PID, kind: 'doc', title: 'An open question', created_by: 'human' });
  check('createTicket: t1 id is TKT-0001', t1.id === 'TKT-0001', t1.id);
  check('createTicket: t2 id is TKT-0002', t2.id === 'TKT-0002', t2.id);
  check('createTicket: t3 id is TKT-0003', t3.id === 'TKT-0003', t3.id);
  check('createTicket: seq increments monotonically', t1.seq === 1 && t2.seq === 2 && t3.seq === 3, `${t1.seq},${t2.seq},${t3.seq}`);
  check('createTicket: labels round-trip as array', Array.isArray(t2.labels) && t2.labels[0] === 'urgent');
  check('createTicket: defaults (state=todo, created_by=human)', t1.state === 'todo' && t1.created_by === 'human');

  // allocateTicketId is independent and keeps climbing.
  const alloc = db.allocateTicketId();
  check('allocateTicketId: continues counter to TKT-0004', alloc.id === 'TKT-0004' && alloc.seq === 4, alloc.id);

  // invalid kind/state rejected
  let threwKind = false;
  try {
    db.createTicket({ project_id: PID, title: 'bad', kind: 'nonsense' });
  } catch {
    threwKind = true;
  }
  check('createTicket: rejects invalid kind', threwKind);
  let threwState = false;
  try {
    db.createTicket({ project_id: PID, title: 'bad', state: 'nope' });
  } catch {
    threwState = true;
  }
  check('createTicket: rejects invalid state', threwState);

  // --- get / list -----------------------------------------------------
  const got = db.getTicket(t1.id);
  check('getTicket: returns ticket with comments+links arrays', got && Array.isArray(got.comments) && Array.isArray(got.links));
  check('getTicket: unknown id → null', db.getTicket('TKT-9999') === null);

  const allForProject = db.listTickets({ project_id: PID });
  check('listTickets: project filter returns 3', allForProject.length === 3, `got ${allForProject.length}`);
  check('listTickets: sorted by seq', allForProject[0].seq === 1 && allForProject[2].seq === 3);
  const specs = db.listTickets({ project_id: PID, kind: 'spec' });
  check('listTickets: kind filter', specs.length === 1 && specs[0].id === t2.id);

  // --- update state + assignee ----------------------------------------
  db.updateTicket(t1.id, { state: 'in_progress', actor: 'session-abc' });
  const afterInProgress = db.getTicket(t1.id);
  check('updateTicket: todo→in_progress', afterInProgress.state === 'in_progress');
  const updated = db.updateTicket(t1.id, { state: 'done', assignee: 'alice' });
  check('updateTicket: in_progress→done', updated.state === 'done');
  check('updateTicket: assignee set', updated.assignee === 'alice');
  check('updateTicket: updated_at bumped', updated.updated_at >= t1.created_at);
  const byAssignee = db.listTickets({ project_id: PID, assignee: 'alice' });
  check('listTickets: assignee filter', byAssignee.length === 1 && byAssignee[0].id === t1.id);

  // setDispatched
  const dispatched = db.setDispatched(t2.id, { session_id: 'session-xyz', actor: 'ceo' });
  check('setDispatched: assignee+dispatched_to set', dispatched.assignee === 'session-xyz' && dispatched.dispatched_to === 'session-xyz' && !!dispatched.dispatched_at);

  // --- comments -------------------------------------------------------
  const c1 = db.addComment(t1.id, { author: 'human', body: 'looks good' });
  const c2 = db.addComment(t1.id, { author: 'session-abc', body: 'on it' });
  check('addComment: returns row with uuid id', !!c1.id && c1.id !== c2.id);
  const t1full = db.getTicket(t1.id);
  check('getTicket: comments attached', t1full.comments.length === 2);

  // --- links ----------------------------------------------------------
  db.addLink(t1.id, t2.id, 'blocks');
  const links1 = db.listLinks(t1.id);
  check('addLink + listLinks: link present', links1.some((l) => l.from_ticket === t1.id && l.to_ticket === t2.id && l.type === 'blocks'));
  let threwLink = false;
  try {
    db.addLink(t1.id, t2.id, 'bogus');
  } catch {
    threwLink = true;
  }
  check('addLink: rejects invalid type', threwLink);
  const rm = db.removeLink(t1.id, t2.id, 'blocks');
  check('removeLink: removes the link', rm.removed === 1 && db.listLinks(t1.id).length === 0);

  // --- events ---------------------------------------------------------
  const t1Events = db.listEvents({ ticket_id: t1.id });
  const types = t1Events.map((e) => e.type);
  check('listEvents: created recorded', types.includes('created'));
  check('listEvents: state_change recorded', types.includes('state_change'));
  check('listEvents: assigned recorded', types.includes('assigned'));
  check('listEvents: commented recorded', types.includes('commented'));
  check('listEvents: newest-first ordering', t1Events.length >= 2 && t1Events[0].id > t1Events[t1Events.length - 1].id);
  const stateEvt = t1Events.find((e) => e.type === 'state_change');
  check('listEvents: state_change carries {from,to}', stateEvt && stateEvt.data.from && stateEvt.data.to);
  const projEvents = db.listEvents({ project_id: PID, limit: 5 });
  check('listEvents: project filter + limit', projEvents.length <= 5 && projEvents.length > 0);
  const dispatchEvt = db.listEvents({ ticket_id: t2.id }).find((e) => e.type === 'dispatched');
  check('listEvents: dispatched recorded', !!dispatchEvt);

  // recordEvent (exported helper)
  const ev = db.recordEvent({ project_id: PID, type: 'note', actor: 'human', data: { hi: 1 } });
  check('recordEvent: returns row with parsed data', ev.id > 0 && ev.data.hi === 1);

  // --- archived exclusion ---------------------------------------------
  db.updateTicket(t3.id, { state: 'archived' });
  const defaultList = db.listTickets({ project_id: PID });
  check('listTickets: archived excluded by default', !defaultList.some((t) => t.id === t3.id), `got ${defaultList.length} tickets`);
  const withArchived = db.listTickets({ project_id: PID, includeArchived: true });
  check('listTickets: includeArchived surfaces archived', withArchived.some((t) => t.id === t3.id));
  const onlyArchived = db.listTickets({ project_id: PID, state: 'archived' });
  check('listTickets: state=archived returns archived', onlyArchived.length === 1 && onlyArchived[0].id === t3.id);

  // --- cascade delete sanity (FK on) ----------------------------------
  raw.prepare('DELETE FROM tickets WHERE id = ?').run(t1.id);
  const orphanComments = raw.prepare('SELECT COUNT(*) n FROM comments WHERE ticket_id = ?').get(t1.id).n;
  check('cascade: comments deleted with ticket', orphanComments === 0);
} catch (err) {
  failures++;
  console.log(`[FAIL] unexpected exception — ${err && err.stack ? err.stack : err}`);
} finally {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  cleanup();
}

if (failures === 0) {
  console.log('\nALL CHECKS PASSED');
  process.exit(0);
} else {
  console.log(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
