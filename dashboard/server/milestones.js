// Project-level milestone feed reader (v4).
//
// Reads a project's hook.jsonl + summary.jsonl and returns milestone events:
//   { t, text, session_id }
//
// Unlike journal.js, this module does NOT synthesize agents or tool hooks — it
// only surfaces the v4 milestone feed that the command-center home renders.

import { readJsonl } from '../../lib/jsonl-header.ts';
import { tsMs } from './util.js';

const EVENT_CAP = 200;

function milestoneFromValue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.event !== 'milestone') return null;
  let text = '';
  if (typeof raw.text === 'string' && raw.text.trim()) {
    text = raw.text.trim();
  } else if (raw.payload && typeof raw.payload === 'object') {
    const p = raw.payload;
    if (typeof p.text === 'string' && p.text.trim()) text = p.text.trim();
    else if (typeof p.message === 'string' && p.message.trim()) text = p.message.trim();
  }
  if (!text) return null;
  const t = tsMs(raw.ts) ?? tsMs(raw.t) ?? Date.now();
  return { t, text, session_id: raw.session_id ?? null };
}

// Journal files may start with a v1 header line; summary files stay legacy.
// A higher header version refuses instead of reading as an empty feed.
async function readMilestoneFile(filePath, out) {
  let parsed;
  try {
    parsed = readJsonl(filePath, 'journal');
  } catch (error) {
    if (
      error?.code === 'VERSIONED_VERSION_UNSUPPORTED' ||
      error?.code === 'VERSIONED_VERSION_INVALID' ||
      error?.code === 'VERSIONED_DATA_INVALID'
    )
      throw error;
    return;
  }
  for (const raw of parsed.values) {
    const m = milestoneFromValue(raw);
    if (m) out.push(m);
  }
}

/**
 * Read milestones for a project record (carries hookFile, summaryFile).
 * Returns a newest-first array capped to EVENT_CAP.
 * @param {object} project
 * @returns {Promise<Array<{t:number,text:string,session_id:string|null}>>}
 */
export async function readProjectMilestones(project) {
  if (!project || (!project.hookFile && !project.summaryFile)) return [];
  const out = [];
  await Promise.all([
    project.hookFile ? readMilestoneFile(project.hookFile, out) : Promise.resolve(),
    project.summaryFile ? readMilestoneFile(project.summaryFile, out) : Promise.resolve(),
  ]);
  out.sort((a, b) => b.t - a.t);
  if (out.length > EVENT_CAP) out.length = EVENT_CAP;
  return out;
}
