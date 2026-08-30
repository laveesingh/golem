#!/usr/bin/env node
// Hermes Agent lifecycle hook bridge for Golem (GOL-39).
// Maps Hermes shell hooks (on_session_start, pre_tool_call, post_tool_call, on_session_end)
// into Golem session facts, session registry, central hook journal, and L4 context.

import fs from 'node:fs';
import path from 'node:path';
import { upsertSessionFact } from '../lib/session-facts.js';
import { upsertSessionRegistration, markSessionsEnded } from '../lib/session-registry.js';
import { golemHome, journalDirFor } from '../lib/golem-home.js';
import { resolveProjectRoot, projectIdFor } from '../lib/project-id.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let input = {};
try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { process.exit(0); }

const event = process.argv[2] || 'unknown';
const rawSessionId = input.session_id || process.env.HERMES_SESSION_ID || `hermes-${Date.now()}`;
const canonicalId = process.env.HERMES_SESSION_ID || process.env.GOLEM_CEO_SESSION_ID || rawSessionId;
const workerName = process.env.HERMES_SESSION_NAME || process.env.GOLEM_WORKER_NAME || input.name || null;
const model = input.model || process.env.HERMES_MODEL || 'hermes';

let projectRoot = input.cwd || process.env.GOLEM_PROJECT_DIR || process.cwd();
let projectId = process.env.GOLEM_PROJECT_ID || null;
try {
  projectRoot = await resolveProjectRoot(projectRoot);
  if (!projectId) projectId = projectIdFor(projectRoot);
} catch {
  // fallback
}

// 1. Session Start Registration
if (event === 'session-start') {
  try {
    await upsertSessionRegistration({
      sessionId: canonicalId,
      cwd: projectRoot,
      harness: 'hermes',
      name: workerName,
      model,
    });
  } catch {}

  try {
    upsertSessionFact({
      canonical_id: canonicalId,
      continuation_key: canonicalId,
      harness: 'hermes',
      locator: { raw_session_id: rawSessionId },
      project_path: projectRoot,
      name: workerName,
      model,
      status: 'idle',
      delivery: { mode: 'typed-worker', push: true, ready: true },
      capabilities: { typed_worker: true },
      trust: 'host-full-trust',
      lifecycle_event: 'session-start',
      observed_at: new Date().toISOString(),
    });
  } catch {}
}

// 2. Tool & State Events
if (event === 'tool-pre' || event === 'tool-post' || event === 'stop') {
  const isStopping = event === 'stop';
  const status = isStopping ? 'idle' : 'active';
  try {
    upsertSessionFact({
      canonical_id: canonicalId,
      continuation_key: canonicalId,
      harness: 'hermes',
      locator: { raw_session_id: rawSessionId },
      project_path: projectRoot,
      name: workerName,
      model,
      status,
      delivery: { mode: 'typed-worker', push: true, ready: true },
      capabilities: { typed_worker: true },
      trust: 'host-full-trust',
      lifecycle_event: event,
      observed_at: new Date().toISOString(),
    });
  } catch {}

  // Journal tool call to central journal ~/.golem/journals/<projectId>/hook.jsonl
  if (projectId && (event === 'tool-pre' || event === 'tool-post')) {
    try {
      const journalDir = journalDirFor(projectId);
      fs.mkdirSync(journalDir, { recursive: true });
      const journalFile = path.join(journalDir, 'hook.jsonl');
      const entry = {
        ts: new Date().toISOString(),
        session_id: canonicalId,
        harness: 'hermes',
        event,
        tool: input.tool_name || input.tool || 'hermes-tool',
        args: input.tool_input || input.args || null,
        result: input.tool_response || input.result || null,
      };
      fs.appendFileSync(journalFile, JSON.stringify(entry) + '\n');
    } catch {}
  }
}

// 3. Session End
if (event === 'stop' && input.session_ended) {
  try {
    markSessionsEnded([canonicalId], { status: 'stopped' });
  } catch {}
}

// 4. L4 Ambient Context on Session Start
if (event === 'session-start') {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const script = path.join(here, 'tracker-context.sh');
    if (fs.existsSync(script)) {
      const { execFileSync } = await import('node:child_process');
      const args = [script];
      if (canonicalId) args.push('--session', canonicalId);
      const out = execFileSync('bash', args, {
        encoding: 'utf8',
        timeout: 3000,
        cwd: projectRoot,
        input: JSON.stringify({ session_id: canonicalId || '', cwd: projectRoot, harness: 'hermes' }),
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const additionalContext = JSON.parse(out)?.hookSpecificOutput?.additionalContext;
      if (additionalContext) {
        process.stdout.write(`${JSON.stringify({
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
        })}\n`);
      }
    }
  } catch {}
}
