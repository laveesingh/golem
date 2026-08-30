// Throwaway E2E verification for model-switch-with-resume (GOL-39).
import { spawnWorker, switchWorkerModel, killWorker } from '../lib/worker-manager.js';
import { readWorkers } from '../lib/worker-registry.js';
import { readSessionFacts } from '../lib/session-facts.js';
import fs from 'node:fs';

const NAME = 'resume-final-2';
const PROJECT = 'golem-961090';

async function postBrief(sessionId, text) {
  const res = await fetch('http://dashboard.golem.localhost:7420/api/native-sessions/' + encodeURIComponent(sessionId) + '/message', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, mode: 'steer' }),
  });
  return res.json();
}

const worker = await spawnWorker({ role: 'explorer', name: NAME, project: PROJECT, profile: 'gemini-flash-3.7' });
console.log('spawned:', worker.session_id?.slice(0, 10), worker.model);
const oldSessionId = worker.session_id;

// Take a turn so pi persists the session file.
await postBrief(oldSessionId, 'Reply with exactly: OK-GO');
await new Promise((r) => setTimeout(r, 25_000));
const fact = readSessionFacts().find((f) => f.canonical_id === oldSessionId);
const oldFile = fact?.locator?.session_file;
const fileExists = oldFile ? fs.existsSync(oldFile) : false;
const linesBefore = fileExists ? fs.readFileSync(oldFile, 'utf8').split('\n').filter(Boolean).length : 0;
console.log('session file:', fileExists, 'lines:', linesBefore);
if (!fileExists) { await killWorker(NAME, { projectId: PROJECT }); throw new Error('no session file — pi did not persist'); }

// Switch models with resume.
const t0 = Date.now();
const switched = await switchWorkerModel(NAME, { projectId: PROJECT, profile: 'deepseek-v4-flash', resume: true });
console.log('switched in', ((Date.now() - t0) / 1000).toFixed(1) + 's', { model: switched.model, resumed: switched.resumed, state: switched.state, dispatchable: switched.dispatchable });

// The resumed pi continues the SAME session file — the new turn appends to it.
await new Promise((r) => setTimeout(r, 4_000));
const linesAfter = fs.readFileSync(oldFile, 'utf8').split('\n').filter(Boolean).length;
console.log('conversation carried over:', linesAfter > linesBefore ? `YES (${linesBefore} → ${linesAfter})` : 'NO');
await killWorker(NAME, { projectId: PROJECT });
console.log('cleaned up');
