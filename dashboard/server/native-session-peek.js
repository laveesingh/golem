// Per-native-session "peek" for the dashboard drawer (fix round 2, defect 1).
//
// Given a session_id, gather everything the dashboard can cheaply show without
// touching the heavy per-project journal store:
//
//   - events:    the most-recent central-journal hook lines whose
//                outer-envelope session_id matches, newest first, summarised.
//   - milestones: the milestone events for that session_id (newest first).
//   - transcript_path: best-effort path to the Claude Code transcript jsonl.
//                Prefer the ground-truth `transcript_path` the hook payload
//                already carries; fall back to the documented encoding
//                (~/.claude/projects/<cwd-with-slashes→dashes>/<session>.jsonl)
//                only when it actually exists on disk. null when neither
//                resolves — never a guessed path.
//
// Central journals live under ~/.config/golem/journals/<project_id>/hook.jsonl
// (see project-id.js). A session's events can be spread across more than one of
// these dirs (the same session_id is stamped on every line it fires regardless
// of which project_id the line was routed to), so we scan them all and merge.
// Sessions started before v4 / never registered have no central journal at all
// → events:[] (+ a note), which the UI renders as a clear empty state.

import { claudeConfigDir } from '../../lib/claude-paths.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import { CENTRAL_JOURNALS_DIR } from './project-id.js';
import { safeJsonParse, tsMs } from './util.js';

const CLAUDE_PROJECTS_DIR = path.join(claudeConfigDir(), 'projects');

// How many recent matching events to surface in the drawer.
const EVENT_CAP = 40;

// Encode a cwd the way Claude Code names its ~/.claude/projects/ subdirs:
// every path separator becomes "-" (a leading "/" therefore yields a leading
// "-"). VERIFIED against on-disk dir names for known cwds before relying on it
// (e.g. /Users/.../experiments/golem → -Users-...-experiments-golem). We still
// only RETURN this path if it exists, so a wrong guess can never leak out.
function encodeCwd(cwd) {
  return String(cwd).replace(/\//g, '-');
}

// Flatten the hook line's stringified payload (same convention as journal.js)
// so we can read tool_name / tool_input / message / transcript_path directly.
function parsePayload(ev) {
  let payload = ev.payload;
  if (typeof payload === 'string' && payload.length > 0) {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }
  return payload && typeof payload === 'object' ? payload : {};
}

// A short human summary for one event — mirrors journal.js's summariseToolPre
// vocabulary so the drawer reads consistently with the per-agent timeline.
function summariseEvent(ev, payload) {
  const ti = payload.tool_input ?? {};
  const tool = payload.tool_name ?? null;
  switch (ev.event) {
    case 'session-start': return 'Session started';
    case 'session-end': return 'Session ended';
    case 'user-prompt': {
      const msg = payload.message ?? ti.prompt ?? '';
      return msg ? `User: ${String(msg).slice(0, 160)}` : 'User prompt';
    }
    case 'tool-pre': {
      if (tool === 'Bash' && ti.command) return `Bash: ${ti.command}`.slice(0, 200);
      if (tool === 'Read' && ti.file_path) return `Read: ${ti.file_path}`;
      if (tool === 'Write' && ti.file_path) return `Write: ${ti.file_path}`;
      if (tool === 'Edit' && ti.file_path) return `Edit: ${ti.file_path}`;
      if (tool === 'Skill' && ti.skill) return `Skill: ${ti.skill}`;
      if (tool === 'Agent' && ti.subagent_type) return `Spawn: ${ti.subagent_type}`;
      if (tool === 'SendMessage' && ti.to) return `Msg → ${ti.to}`;
      return tool || 'Tool call';
    }
    case 'tool-post': {
      const ok = payload.tool_response?.ok;
      return `${tool || 'Tool'} ${ok === false ? 'failed' : 'returned'}`;
    }
    case 'agent-spawn': return `Spawned ${ti.subagent_type ?? payload.subagent_type ?? 'sub-agent'}`;
    case 'agent-return': return `Sub-agent ${ti.subagent_type ?? ''} returned`.trim();
    case 'subagent-stop': return 'Sub-agent stopped';
    case 'teammate-idle': return 'Teammate idle';
    case 'notification': return payload.message ? String(payload.message).slice(0, 160) : 'Notification';
    case 'pre-compact': return 'Context compacted';
    case 'milestone': return ev.text ?? payload.text ?? payload.message ?? 'Milestone';
    case 'stop': return 'Response finished';
    default: return ev.event || 'event';
  }
}

// Tail the last N lines of a file cheaply via a streamed line reader, keeping a
// rolling window. Bounded memory regardless of file size.
async function tailMatchingLines(filePath, sessionId, keep) {
  const window = [];
  await new Promise((resolve) => {
    let stream;
    try {
      stream = createReadStream(filePath, { encoding: 'utf8' });
    } catch {
      return resolve();
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line) return;
      // Cheap pre-filter before JSON.parse — the session_id appears verbatim.
      if (!line.includes(sessionId)) return;
      const raw = safeJsonParse(line);
      if (!raw || raw.session_id !== sessionId) return;
      window.push(raw);
      if (window.length > keep) window.shift();
    });
    rl.on('close', resolve);
    rl.on('error', resolve);
    stream.on('error', resolve);
  });
  return window;
}

/**
 * Build the peek payload for one native session.
 *
 * @param {string} sessionId
 * @param {object|null} session  the matching native_sessions[] row (cwd/pid/…),
 *   or null when the session isn't in the live list.
 * @returns {Promise<{session, events, milestones, transcript_path, note}>}
 */
export async function readNativeSessionPeek(sessionId, session) {
  const result = {
    session: session ?? null,
    events: [],
    milestones: [],
    transcript_path: null,
    note: null,
  };
  if (!sessionId) {
    result.note = 'no session_id supplied';
    return result;
  }

  // 1) Scan every central journal dir for matching lines.
  let dirs = [];
  try {
    dirs = await fs.readdir(CENTRAL_JOURNALS_DIR, { withFileTypes: true });
  } catch {
    dirs = [];
  }
  const hookFiles = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    hookFiles.push(path.join(CENTRAL_JOURNALS_DIR, d.name, 'hook.jsonl'));
  }

  const collected = [];
  for (const f of hookFiles) {
    // Keep a generous per-file window so the merged newest-N is accurate even
    // when several files contribute.
    const rows = await tailMatchingLines(f, sessionId, EVENT_CAP);
    for (const r of rows) collected.push(r);
  }

  if (collected.length === 0) {
    result.note = 'no central journal for this session — it predates v4 or was never registered';
  }

  // 2) Split into events + milestones, summarise, newest first.
  const events = [];
  const milestones = [];
  for (const raw of collected) {
    const t = tsMs(raw.ts);
    const payload = parsePayload(raw);
    // Capture a ground-truth transcript path from any line that carries one.
    if (!result.transcript_path && typeof payload.transcript_path === 'string' && payload.transcript_path) {
      result._payloadTranscript = payload.transcript_path;
    }
    if (raw.event === 'milestone') {
      const text = (raw.text ?? payload.text ?? payload.message ?? '').toString().trim();
      if (text) milestones.push({ t, text });
      continue;
    }
    events.push({
      t,
      event: raw.event,
      summary: summariseEvent(raw, payload),
    });
  }
  events.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  milestones.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  result.events = events.slice(0, EVENT_CAP);
  result.milestones = milestones;

  // 3) Resolve the transcript path — only ever return one that exists on disk.
  const candidates = [];
  if (result._payloadTranscript) candidates.push(result._payloadTranscript);
  const cwd = session?.cwd;
  if (cwd) {
    candidates.push(path.join(CLAUDE_PROJECTS_DIR, encodeCwd(cwd), `${sessionId}.jsonl`));
  }
  for (const c of candidates) {
    try {
      await fs.access(c);
      result.transcript_path = c;
      break;
    } catch {
      /* try next */
    }
  }
  if (!result.transcript_path && (result._payloadTranscript || cwd)) {
    result.note = result.note
      ? result.note
      : 'transcript not found on disk (session may be too old or relocated)';
  }
  delete result._payloadTranscript;

  return result;
}
