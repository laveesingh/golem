import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { systemClock } from "./clock.js";
import { privateTempDirectory, writeCandidate } from "./scenario-io.js";
import { scrubScenario } from "./scenario-scrub-core.js";
const MAX_FRAME = 16 * 1024;
/** One run-owned broker orders projections. It never receives journals or credentials. */
export async function createScenarioRecorder(candidate, header, { clock = systemClock } = {}) {
    if (!path.isAbsolute(candidate))
        throw Error('recorder candidate must be absolute');
    const root = privateTempDirectory(path.dirname(candidate));
    if (fs.existsSync(candidate))
        throw Error('recorder candidate already exists');
    const socket = path.join(root, 'rec.sock');
    if (Buffer.byteLength(socket) > 103)
        throw Error('recorder socket path too long');
    const capability = randomUUID();
    const start = clock.now();
    const events = [];
    const participants = new Set();
    let failure = null;
    let closing = false;
    const fail = (code) => {
        failure ??= code;
    };
    const record = (projection) => {
        if (closing || failure)
            throw Error('recorder unavailable');
        // The first validation or overflow failure latches: a partial run must
        // never publish as a candidate, on either the direct or socket path.
        try {
            const event = {
                ...projection,
                seq: events.length + 1,
                at_ms: clock.now() - start,
            };
            // Validate before retention, including closed projection fields. Retain only
            // scrub-safe selected metadata; symbols are normalized across the entire run.
            const proposed = [...events, event];
            const cleaned = scrubScenario({ ...header, events: proposed });
            if (Buffer.byteLength(JSON.stringify(cleaned)) > 1024 * 1024)
                throw Error('recorder overflow');
            events.push(event);
        }
        catch (error) {
            fail(error instanceof Error ? error.message : 'projection_rejected');
            throw error;
        }
    };
    const server = net.createServer((peer) => {
        participants.add(peer);
        let buffer = '';
        let authenticated = false;
        peer.setEncoding('utf8');
        peer.on('data', (chunk) => {
            buffer += chunk;
            if (Buffer.byteLength(buffer) > MAX_FRAME) {
                fail('frame_overflow');
                peer.destroy();
                return;
            }
            for (;;) {
                const end = buffer.indexOf('\n');
                if (end < 0)
                    break;
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 1);
                try {
                    const message = JSON.parse(frame);
                    if (message.capability !== capability)
                        throw Error('authentication');
                    authenticated = true;
                    record(message.projection);
                    peer.write('{"ok":true}\n');
                }
                catch {
                    fail('projection_rejected');
                    peer.end('{"ok":false}\n');
                }
            }
        });
        peer.on('error', () => {
            if (authenticated && !closing)
                fail('participant_error');
        });
        peer.on('close', () => {
            participants.delete(peer);
            if (buffer)
                fail('partial_frame');
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socket, resolve);
    });
    fs.chmodSync(socket, 0o600);
    const identity = fs.lstatSync(socket);
    return {
        env: {
            GOLEM_RECORD_SCENARIO: candidate,
            GOLEM_RECORD_SOCKET: socket,
            GOLEM_RECORD_CAPABILITY: capability,
        },
        record,
        abort: fail,
        async close() {
            closing = true;
            for (const peer of participants)
                peer.destroy();
            const current = fs.lstatSync(socket);
            if (identity.dev !== current.dev || identity.ino !== current.ino)
                throw Error('recorder socket identity changed');
            await new Promise((resolve) => server.close(() => resolve()));
            if (failure || !events.length)
                throw Error(`recorder rejected: ${failure ?? 'empty'}`);
            const scenario = scrubScenario({ ...header, events });
            writeCandidate(candidate, scenario);
            return scenario;
        },
    };
}
/** Production seam helper: observation failure never mutates delivery state. */
export function tryRecordScenarioProjection(projection) {
    try {
        void recordScenarioProjection(projection).catch(() => { });
    }
    catch {
        /* recorder off or misconfigured: delivery continues */
    }
}
/** Observation failure invalidates the candidate, never the delivery state. */
export async function recordScenarioProjection(projection) {
    if (!process.env.GOLEM_RECORD_SCENARIO)
        return;
    const socket = process.env.GOLEM_RECORD_SOCKET;
    const capability = process.env.GOLEM_RECORD_CAPABILITY;
    if (!socket || !capability)
        throw Error('recorder configuration incomplete');
    const frame = JSON.stringify({ capability, projection });
    if (Buffer.byteLength(frame) > MAX_FRAME - 1)
        throw Error('recorder projection overflow');
    await new Promise((resolve, reject) => {
        const peer = net.createConnection(socket);
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            peer.destroy();
            error ? reject(error) : resolve();
        };
        const timer = setTimeout(() => finish(Error('recorder safety deadline')), 2000);
        peer.once('connect', () => peer.write(`${frame}\n`));
        peer.once('data', (chunk) => {
            try {
                if (JSON.parse(String(chunk)).ok !== true)
                    throw Error();
                finish();
            }
            catch {
                finish(Error('recorder rejected projection'));
            }
        });
        peer.once('error', () => finish(Error('recorder transport failed')));
        peer.once('close', () => finish(Error('recorder participant lost')));
    });
}
