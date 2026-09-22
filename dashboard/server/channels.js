// Channel registry reader (v4). The channel server spawned by each Claude Code
// session registers itself under ~/.config/golem/channels.json. This module
// exposes just the live-channel passthrough that the rest of the dashboard needs
// after the v3 orchestrator was removed.

import fs from 'node:fs/promises';
import { channelsJsonPath } from '../../lib/golem-home.js';
import { readEndpointLeases } from '../../lib/session-facts.js';
import { TYPED_WORKER_PROTOCOL_VERSION } from '../../lib/typed-worker-endpoint.js';

const CHANNELS_REGISTRY = channelsJsonPath();

// GOL-365: Pi and Claude are the only harnesses. A typed worker has an
// authenticated, lease-backed /brief endpoint and owns its own native-turn
// readiness gate; Claude Code must publish an initialized/eligible
// channel-consumer signal. Unknown harness kinds are treated generically and
// stay non-deliverable (historical rows may still carry retired kinds).
export function isTypedWorkerChannel(channel) {
  return channel?.kind === 'typed-worker' || channel?.typed_worker === true;
}

// Reachability means the endpoint's target transport is currently eligible,
// not merely that its PID/HTTP listener exists. Pi owns the typed-worker
// transport; Claude Code must publish an explicit initialized/eligible
// channel-consumer signal.
export function isChannelDeliveryReady(channel) {
  if (!channel) return false;
  if (isTypedWorkerChannel(channel)) return channel.delivery_ready === true;
  return channel.consumer_ready === true && channel.delivery_ready === true;
}

export function channelDeliveryError(channel) {
  if (isTypedWorkerChannel(channel)) return 'typed worker target is not delivery-ready';
  if (String(channel?.consumer_reason || '').startsWith('unsupported_')) {
    return 'Claude Code channel is ineligible under this provider configuration. Claude Channels require Anthropic authentication through claude.ai or a Console API key; unset Bedrock/Vertex/Foundry or non-default ANTHROPIC_BASE_URL configuration, then restart with --dangerously-load-development-channels plugin:golem@golem-workspace.';
  }
  if (channel?.consumer_reason === 'mcp_not_initialized') {
    return 'Claude Code channel MCP initialization has not completed; wait for plugin startup or restart the channel-enabled session.';
  }
  return 'Claude Code channel consumer readiness is unknown; restart the session with an Anthropic-authenticated channel configuration.';
}

function pidAlive(pid) {
  if (!pid || pid === 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but is owned by another user — treat as alive.
    return err && err.code === 'EPERM';
  }
}

async function readRegistry(file, listKey) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const json = JSON.parse(raw);
    return Array.isArray(json[listKey]) ? json[listKey] : [];
  } catch (err) {
    console.error('[channels] failed to parse', file, err.message);
    return [];
  }
}

// Endpoint owner tokens authenticate loopback delivery. Dashboard internals need
// the token to call a typed supervisor adapter, but channel rows are also sent
// to browser clients. Keep it non-enumerable so JSON/API broadcasts never turn
// a local lease credential into UI data.
function withPrivateOwnerToken(channel, ownerToken) {
  if (ownerToken) Object.defineProperty(channel, 'owner_token', {
    value: ownerToken,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return channel;
}

/** Return live channel registrations with a computed `url`. */
export async function readChannels() {
  const leases = readEndpointLeases();
  const healthy = (await Promise.all(leases.map(async (lease) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);
    try {
      const query = new URLSearchParams({ session_id: lease.canonical_id, owner_token: lease.owner_token });
      const response = await fetch(`http://${lease.host}:${lease.port}/healthz?${query}`, { signal: controller.signal });
      const body = response.ok ? await response.json() : null;
      const typedWorker = isTypedWorkerChannel(lease);
      if (!(response.ok && body?.canonical_id === lease.canonical_id && body?.owner_token === lease.owner_token
        && (!typedWorker || (body?.protocol_version === TYPED_WORKER_PROTOCOL_VERSION && body?.kind === lease.kind)))) return null;
      const { owner_token, ...publicLease } = lease;
      return withPrivateOwnerToken({
          ...publicLease,
          session_id: lease.canonical_id,
          url: `http://${lease.host}:${lease.port}`,
          endpoint_health: 'healthy',
          // The authenticated health response is newer than the persisted
          // explicit consumer readiness for CC; old unknown CC rows fail
          // bridge retains its independent readiness contract.
          consumer_ready: body.consumer_ready ?? lease.consumer_ready ?? null,
          consumer_reason: body.consumer_reason ?? lease.consumer_reason ?? null,
          consumer_transport: body.consumer_transport ?? lease.consumer_transport ?? null,
          typed_worker: typedWorker,
          delivery_ready: typedWorker
            ? body.delivery_ready === true
            : null
              ? body.delivery_ready !== false
              : body.consumer_ready === true && body.delivery_ready === true,
        }, owner_token);
    } catch { return null; } finally { clearTimeout(timer); }
  }))).filter(Boolean);
  const channels = await readRegistry(CHANNELS_REGISTRY, 'channels');
  const canonicalIds = new Set(leases.map((lease) => lease.canonical_id));
  const legacy = channels
    .filter((c) => !canonicalIds.has(c.session_id))
    .filter((c) => pidAlive(c.pid))
    .map((c) => ({
      ...c,
      url: `http://${c.host}:${c.port}`,
      endpoint_health: 'legacy-pid-only',
      delivery_ready: false
        ? c.delivery_ready !== false
        : c.consumer_ready === true && c.delivery_ready === true,
    }));
  return [...healthy, ...legacy];
}
