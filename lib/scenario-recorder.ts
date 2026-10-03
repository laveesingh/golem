import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import type { Scenario, ScenarioEvent } from './scenario-format.ts';
import { scrubScenario } from './scenario-scrub-core.ts';
import { privateTempDirectory, writeCandidate } from './scenario-io.ts';

export type Projection = Pick<ScenarioEvent, 'boundary' | 'direction' | 'operation' | 'fields'>;
const MAX_FRAME = 16 * 1024;

/** One run-owned broker orders projections. It never receives journals or credentials. */
export async function createScenarioRecorder(candidate: string, header: Omit<Scenario, 'events'>, { clock = systemClock }: { clock?: Clock } = {}) {
  if (!path.isAbsolute(candidate)) throw Error('recorder candidate must be absolute');
  const root = privateTempDirectory(path.dirname(candidate));
  if (fs.existsSync(candidate)) throw Error('recorder candidate already exists');
  const socket = path.join(root, 'rec.sock');
  if (Buffer.byteLength(socket) > 103) throw Error('recorder socket path too long');
  const capability = randomUUID();
  const start = clock.now();
  const events: ScenarioEvent[] = [];
  const participants = new Set<net.Socket>();
  let failure: string | null = null;
  let closing = false;
  const fail = (code: string) => { failure ??= code; };
  const record = (projection: Projection) => {
    if (closing || failure) throw Error('recorder unavailable');
    const event = { ...projection, seq: events.length + 1, at_ms: clock.now() - start };
    // Validate before retention, including closed projection fields. Retain only
    // scrub-safe selected metadata; symbols are normalized across the entire run.
    const proposed = [...events, event];
    const cleaned = scrubScenario({ ...header, events: proposed });
    if (Buffer.byteLength(JSON.stringify(cleaned)) > 1024 * 1024) throw Error('recorder overflow');
    events.push(event);
  };
  const server = net.createServer((peer) => {
    participants.add(peer);
    let buffer = '';
    let authenticated = false;
    peer.setEncoding('utf8');
    peer.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME) { fail('frame_overflow'); peer.destroy(); return; }
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(frame);
          if (message.capability !== capability) throw Error('authentication');
          authenticated = true;
          record(message.projection);
          peer.write('{"ok":true}\n');
        } catch { fail('projection_rejected'); peer.end('{"ok":false}\n'); }
      }
    });
    peer.on('error', () => { if (authenticated && !closing) fail('participant_error'); });
    peer.on('close', () => {
      participants.delete(peer);
      if (buffer) fail('partial_frame');
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  fs.chmodSync(socket, 0o600);
  const identity = fs.lstatSync(socket);
  return {
    env: { GOLEM_RECORD_SCENARIO: candidate, GOLEM_RECORD_SOCKET: socket, GOLEM_RECORD_CAPABILITY: capability },
    record,
    abort: fail,
    async close() {
      closing = true;
      for (const peer of participants) peer.destroy();
      const current = fs.lstatSync(socket);
      if (identity.dev !== current.dev || identity.ino !== current.ino) throw Error('recorder socket identity changed');
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (failure || !events.length) throw Error(`recorder rejected: ${failure ?? 'empty'}`);
      const scenario = scrubScenario({ ...header, events });
      writeCandidate(candidate, scenario);
      return scenario;
    },
  };
}

/** Production seam helper: observation failure never mutates delivery state. */
export function tryRecordScenarioProjection(projection: Projection): void {
  try {
    void recordScenarioProjection(projection).catch(() => {});
  } catch { /* recorder off or misconfigured: delivery continues */ }
}

/** Observation failure invalidates the candidate, never the delivery state. */
export async function recordScenarioProjection(projection: Projection): Promise<void> {
  if (!process.env.GOLEM_RECORD_SCENARIO) return;
  const socket = process.env.GOLEM_RECORD_SOCKET;
  const capability = process.env.GOLEM_RECORD_CAPABILITY;
  if (!socket || !capability) throw Error('recorder configuration incomplete');
  const frame = JSON.stringify({ capability, projection });
  if (Buffer.byteLength(frame) > MAX_FRAME - 1) throw Error('recorder projection overflow');
  await new Promise<void>((resolve, reject) => {
    const peer = net.createConnection(socket);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      peer.destroy();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(Error('recorder safety deadline')), 2000);
    peer.once('connect', () => peer.write(`${frame}\n`));
    peer.once('data', (chunk) => {
      try { if (JSON.parse(String(chunk)).ok !== true) throw Error(); finish(); }
      catch { finish(Error('recorder rejected projection')); }
    });
    peer.once('error', () => finish(Error('recorder transport failed')));
    peer.once('close', () => finish(Error('recorder participant lost')));
  });
}
