import fs from 'node:fs';
import path from 'node:path';
import { projectsJsonPath } from '../../lib/golem-home.js';
import { projectIdFor } from '../../lib/project-id.js';

// TKT-0245: build a self-contained brief so the receiving session knows exactly
// what it's been handed and how to pick it up. Extracted from the inline
// construction in the dispatch handler so the drainer (dispatch-queue.js)
// produces byte-identical briefs — no format drift between the two delivery
// paths. `note` is an already-trimmed string or null.
// `workspace` is an optional directive ('worktree' | undefined) that appends
// a workspace setup block to the brief (GOL-316 §2.7).

function ticketSlug(title) {
  return String(title || 'ticket')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

// GOL-382 R7: briefs carry facts. What a session does with a dispatch — state
// moves, worktree setup, merge ownership, return routing — is workflow and
// lives in the instructions. A project may add its own text in
// .agents/briefs/dispatch.md; it is appended verbatim with {{ticket_id}},
// {{ticket_slug}}, {{ticket_title}} and {{workspace}} filled in.
function projectBriefTemplate(ticket, workspace) {
  let root = null;
  try {
    const registry = JSON.parse(fs.readFileSync(projectsJsonPath(), 'utf8'));
    root = (registry.projects ?? []).find((entry) => entry?.path && (
      entry.id === ticket.project_id || projectIdFor(path.resolve(entry.path)) === ticket.project_id
    ))?.path ?? null;
  } catch {
    root = null;
  }
  if (!root) return null;
  let template = null;
  try {
    template = fs.readFileSync(path.join(root, '.agents', 'briefs', 'dispatch.md'), 'utf8').trim();
  } catch {
    return null;
  }
  if (!template) return null;
  const values = {
    ticket_id: ticket.display_id || ticket.id,
    ticket_slug: ticketSlug(ticket.title),
    ticket_title: ticket.title ?? '',
    workspace: workspace || '',
  };
  return template.replace(/\{\{(ticket_id|ticket_slug|ticket_title|workspace)\}\}/g, (_match, key) => values[key]);
}

function briefFacts(ticket, { messageId = null, senderSessionId = null, workspace = null } = {}) {
  return [
    messageId ? `Dispatch message_id: ${messageId} (pass it as envelope_id when you ack this dispatch)` : null,
    senderSessionId ? `Authenticated delegating session_id: ${senderSessionId}` : null,
    workspace ? `Workspace: ${workspace}` : null,
  ].filter(Boolean);
}

export function buildDispatchBrief(ticket, note, workspace, messageId = null, senderSessionId = null) {
  if (ticket?.kind === 'spec') return buildSpecBrief(ticket, note, workspace, messageId, senderSessionId);
  const id = ticket.display_id || ticket.id;
  const lines = [
    `Ticket dispatch: ${id} "${ticket.title}" (project ${ticket.project_id}, kind ${ticket.kind}, state ${ticket.state ?? 'unknown'}).`,
    note ? `\nNote:\n${note}` : null,
    '',
    ...briefFacts(ticket, { messageId, senderSessionId, workspace }),
    `Read it with ticket_get ${id} (or golem ticket get ${id}).`,
    projectBriefTemplate(ticket, workspace),
  ];
  return lines.filter((line) => line != null).join('\n');
}

// A spec brief is a pointer like a task brief (the receiver reads the spec
// with ticket_get, which is compact and current). It still names the active
// comments so a re-dispatched spec hands over its open review feedback; their
// text comes with the ticket read.
function buildSpecBrief(ticket, note, workspace, messageId = null, senderSessionId = null) {
  const id = ticket.display_id || ticket.id;
  const comments = (ticket.comments || []).filter((c) => c.dispatch_state === 'undispatched' || c.dispatch_state === 'dispatched');
  const children = ticket.children || [];
  const commentLine = comments.length
    ? `Active comments to address (${comments.length}): ${comments.map((c) => `${c.id} by ${c.author_label || c.author || 'unknown'}`).join(', ')}.`
    : 'No active comments.';
  const lines = [
    `Spec dispatch: ${id} "${ticket.title}" (project ${ticket.project_id}, state ${ticket.state}).`,
    note ? `\nNote:\n${note}` : null,
    '',
    ...briefFacts(ticket, { messageId, senderSessionId, workspace }),
    commentLine,
    `Children: ${children.length}.`,
    `Read it with ticket_get ${id} (or golem ticket get ${id}): body, comments and children.`,
    projectBriefTemplate(ticket, workspace),
  ];
  return lines.filter((line) => line != null).join('\n');
}
