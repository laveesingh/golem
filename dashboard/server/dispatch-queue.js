// TKT-0245: dispatch drainer — background loop that delivers queued dispatches
// when their target session goes idle.
//
// Why this exists: a brief pushed while the target is mid-turn gets buried
// under the in-flight tool stream and is effectively ignored. Delivering on
// idle (the session has finished its turn and is waiting for input) makes the
// brief the next thing the agent sees. The queue lives in SQLite
// (tracker.db dispatch_queue) so it survives dashboard restarts (routine).
//
// Semantics (preserve in comments when editing):
//   • One delivery per session per tick + a 60s per-session cooldown — never
//     stack a second brief onto a session that hasn't visibly gone busy yet.
//     Status freshness is 3s (state.js poll) and Claude's status flip lags a
//     prompt by seconds; without the cooldown we'd double-deliver.
//   • `waiting` is NOT idle — waiting = mid-task blocked on human input;
//     delivering there recreates the original bug. Both busy AND waiting hold.
//   • Durable-first: setDispatched BEFORE pushBrief (a crash between leaves
//     the ticket assigned, not lost).
//   • A session that is offline is NOT immediately expired — it may come back.
//     Only after 60m offline does the oldest pending row expire.
//   • Alive but no registered channel = unreachable (TKT-0369): treated like
//     offline — rows held pending, same 60m expiry. Never attempt a push that
//     would burn the row (setDispatched already run); the row auto-delivers
//     when the channel re-registers (e.g. after /reload-plugins).
//
// This module does NOT add another session poll. It reads state.nativeSessions()
// (already refreshed every 3s by state.js) on its own 5s tick.

import { loadConfig } from '../../lib/golem-config.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { checkpointPiPickupAck, claimPiPickupAcks, completePiPickupAck } from '../../lib/pi-inbox.js';
import { isChannelDeliveryReady, isTypedWorkerChannel } from './channels.js';
import { hasTypedWorkerCapability, readSessionFacts } from '../../lib/session-facts.js';
import { isLegacyReplayFence } from './typed-delivery.js';
import { publishDurableEnvelope, settleDurableEnvelope } from './envelope-delivery.js';
import { createNotificationScheduleRuntime } from './notification-schedule-runtime.js';

const TICK_MS = 5_000;
const COOLDOWN_MS = 60_000;
const OFFLINE_EXPIRY_MS = 60 * 60_000; // 60 min

// Pi's old Tier-B extension names its delivery boundary explicitly. Absence of
// a fact or a temporarily released typed lease is not evidence that a session
// may receive a new filesystem spool; only this legacy declaration permits it.
function hasExplicitLegacyPiDelivery(fact) {
  if (fact?.harness !== 'pi' || hasTypedWorkerCapability(fact)) return false;
  return fact?.delivery?.mode === 'next_turn' && fact?.delivery?.push === false;
}

export function initDispatchDrainer({
  tracker,
  state,
  chat,
  pushBrief,
  pushControlEnvelope,
  buildDispatchBrief,
  broadcastWS,
  listChannels,
  nowMs = () => Date.now(),
}) {
  const deliverControl = pushControlEnvelope ?? (({ content }, sessionId) => pushBrief(content, sessionId));
  // session_id → ts(ms) of the most recent successful delivery. Used by the
  // cooldown check so we never deliver twice to a session within 60s.
  const lastDeliveredAt = new Map();
  const publishing = new Set();
  const publishingOwner = crypto.randomUUID();
  const ackOwner = crypto.randomUUID();
  let timer = null;
  let stopped = false;
  let runningTick = null;
  const schedules = createNotificationScheduleRuntime({ tracker });
  async function runTargets(entries, run) {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (!stopped && cursor < entries.length) {
        const entry = entries[cursor++];
        try { await run(entry); } catch (error) { console.error('[dispatch-drainer] target failed:', error); }
      }
    }));
  }

  function unackedWindowMinutes() {
    const n = Number(loadConfig()?.dispatch?.unackedWindowMinutes);
    return Number.isFinite(n) && n >= 0 ? n : 5;
  }

  async function checkUnackedDispatches() {
    const windowMinutes = unackedWindowMinutes();
    let changed = false;
    const deliverChild = async (claimed, purpose) => {
      const child = claimed.envelope;
      let content = '';
      try { content = JSON.parse(child.payload || '{}').content || ''; } catch { /* durable fallback below */ }
      let typedTarget = false;
      try {
        typedTarget = (await listChannels()).some((channel) => (
          channel.session_id === child.recipient_session_id && isTypedWorkerChannel(channel)
        ));
      } catch { /* durable facts below preserve typed retry semantics */ }
      if (!typedTarget) {
        try {
          const fact = readSessionFacts().find((entry) => entry?.canonical_id === child.recipient_session_id);
          typedTarget = hasTypedWorkerCapability(fact)
            || (fact?.harness === 'pi' && !hasExplicitLegacyPiDelivery(fact));
        } catch { /* absent facts retain established legacy delivery */ }
      }
      const publication = await publishDurableEnvelope({
        tracker,
        envelope: child,
        sessionId: child.recipient_session_id,
        content,
        legacy: { path: '/brief', body: content },
        typedTarget,
        durableRetry: true,
        // Root ping/escalation linkage is advanced by the shared completion
        // path only after the child's accepted retry has settled.
        settlement: null,
        publish: ({ content, metadata }) => pushBrief(content, child.recipient_session_id, metadata),
      });
      const result = publication.delivery;
      const delivered = publication.delivered && publication.settled;
      const error = delivered ? null : (result?.error || `status ${result?.status ?? '?'}`);
      chat.record(delivered ? 'user' : 'system', delivered ? 'brief' : 'error',
        delivered ? content : `${purpose} for ${claimed.root.ticket_id} failed — ${error}`,
        { session_id: child.recipient_session_id || null, ticket_id: claimed.root.ticket_id });
      const ticket = tracker.getTicket(claimed.root.ticket_id);
      if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
      changed = true;
    };
    try {
      // New durable envelopes use explicit acknowledgement facts. Escalations
      // go first, so a failed ping (which stamps escalate_after=now) waits for
      // the next five-second pass rather than escalating in its own ping pass.
      for (;;) {
        const claimed = tracker.claimDueEscalation();
        if (!claimed) break;
        if (!claimed.envelope.recipient_session_id) {
          tracker.markEnvelopeDelivery(claimed.envelope.id, { error: 'no stored reply route for escalation' });
          const ticket = tracker.getTicket(claimed.root.ticket_id);
          if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
          changed = true;
          continue;
        }
        await deliverChild(claimed, 'dispatch escalation');
      }
      for (;;) {
        const claimed = tracker.claimDueAckPing(windowMinutes);
        if (!claimed) break;
        await deliverChild(claimed, 'dispatch acknowledgement ping');
      }
    } catch (err) {
      console.error('[dispatch-drainer] unacked check failed:', err);
      return changed;
    }
    // GOL-140 legacy deliveries predate envelope facts and retain their
    // event/activity heuristic unchanged.
    let rows = [];
    try {
      rows = tracker.unackedDispatchesForWindow(windowMinutes);
    } catch (err) {
      console.error('[dispatch-drainer] legacy unacked check failed:', err);
      return changed;
    }
    for (const row of rows) {
      try {
        tracker.recordUnackedDispatchWarning(row, { windowMinutes });
        const label = row.display_id || row.ticket_id;
        chat.record(
          'system',
          'warning',
          `dispatch of ${label} to ${row.session_id} appears unacknowledged — no ticket activity from target since delivery attempt at ${row.delivered_at} (${windowMinutes}m window)`,
          { session_id: row.session_id, ticket_id: row.ticket_id },
        );
        const ticket = tracker.getTicket(row.ticket_id);
        if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
        changed = true;
      } catch (err) {
        console.error('[dispatch-drainer] unacked warning failed:', err);
      }
    }
    return changed;
  }

  function retryJson(value, fallback = null) {
    try { return JSON.parse(value); } catch { return fallback; }
  }

  function compareDeliveryOrder(left, right) {
    const leftTime = Date.parse(left?.created_at || '');
    const rightTime = Date.parse(right?.created_at || '');
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1;
    const leftId = String(left?.id || left?.envelope_id || '');
    const rightId = String(right?.id || right?.envelope_id || '');
    return leftId.localeCompare(rightId);
  }

  async function drainEnvelopeRetries({ byId, channelsBySession, pendingQueue, retries }) {
    let changed = false;
    // This is a required shared-tracker capability. Do not downgrade a missing
    // dependency to a noisy successful tick: callers/tests must see the error
    // rather than silently skipping durable typed retries.
    if (!Array.isArray(retries)) throw new Error('durable retry snapshot is required');
    // Retries are delivery work too: preserve FIFO and never stack multiple
    // native opportunities onto one session in the same tick.
    const blockedRetrySessions = new Set();
    const queueBlockedByRetry = new Set();
    const queueRowsBySession = new Map();
    for (const row of pendingQueue) {
      const rows = queueRowsBySession.get(row.session_id) ?? [];
      rows.push(row);
      queueRowsBySession.set(row.session_id, rows);
    }
    for (const retry of retries) {
      if (stopped) break;
      if (blockedRetrySessions.has(retry.session_id)) continue;
      let envelope = tracker.getEnvelope(retry.envelope_id);
      if (!envelope) {
        if (tracker.claimEnvelopeRetry(retry.envelope_id, { ownerToken: publishingOwner })) {
          tracker.releaseEnvelopeRetry(retry.envelope_id, { ownerToken: publishingOwner, error: 'durable envelope missing' });
        }
        continue;
      }
      const persistedState = envelope.delivery_state || 'pending';
      const notification = envelope.kind === 'session_notify';
      // A recorded acceptance is authoritative even when the process/lease is
      // presently absent. Finalize retry settlement without waiting to route a
      // second transport attempt through a restarted worker.
      if (['published', 'settled', 'interrupted', 'recovery_required'].includes(persistedState)) {
        if (!tracker.claimEnvelopeRetry(retry.envelope_id, { ownerToken: publishingOwner, settlementOnly: true })) continue;
        if (settleDurableEnvelope({ tracker, envelope, retry, retryOwnerToken: publishingOwner })) {
          changed = true;
        }
        continue;
      }
      // Acceptance owns a native turn but is not settlement. It holds queued
      // ticket work, not ordinary notifications, until a terminal callback;
      // it never replays or retires the stored owners.
      if (persistedState === 'accepted' || (persistedState === 'claimed' && envelope.accepted_attempt_id)) {
        // Queued native admission already fixed the first attempt. Wait for its
        // callback, without holding ordinary notifications behind settlement.
        queueBlockedByRetry.add(retry.session_id);
        continue;
      }
      // Pick one native opportunity across both durable sources. A retry row
      // for a queued ticket represents that same queue row, so exclude its own
      // envelope when comparing age. Any genuinely older queued item wins.
      const olderQueue = (queueRowsBySession.get(retry.session_id) ?? []).find((row) => (
        row.envelope_id !== retry.envelope_id
        && compareDeliveryOrder(row, retry) < 0
      ));
      // Preserve FIFO when the older ticket is eligible. A ticket waiting for
      // idle is not a reason to withhold a busy-session notification.
      if (olderQueue && (!notification || byId.get(retry.session_id)?.status === 'idle')) continue;
      const session = byId.get(retry.session_id);
      const channel = channelsBySession.get(retry.session_id);
      if (!session?.alive || !channel || (!notification && session.status !== 'idle')) continue;
      // A typed retry never falls through to a similarly named legacy route
      // while a restarted endpoint has not rebound its lease.
      if (retry.require_typed && !isTypedWorkerChannel(channel)) {
        blockedRetrySessions.add(retry.session_id);
        continue;
      }
      const last = lastDeliveredAt.get(retry.session_id);
      if (!notification && last != null && nowMs() - last < COOLDOWN_MS) continue;
      if (!tracker.claimEnvelopeRetry(retry.envelope_id, { ownerToken: publishingOwner })) {
        blockedRetrySessions.add(retry.session_id);
        continue;
      }
      blockedRetrySessions.add(retry.session_id);
      queueBlockedByRetry.add(retry.session_id);
      if (persistedState === 'claimed') {
        // No accepted-attempt evidence was recorded. Retry the same envelope;
        // the receiver's admission marker owns any lost-response lineage.
        tracker.recordTypedEnvelopeLifecycle(envelope.id, {
          state: 'pending',
          attempt_id: envelope.delivery_attempt_id,
          error: 'retry publishing lease recovered before correlated acceptance',
        });
        envelope = tracker.getEnvelope(envelope.id);
      }
      envelope = tracker.renewEnvelopeExpiry(envelope.id);
      const legacy = retryJson(retry.legacy_json, null);
      const result = await publishDurableEnvelope({
        tracker,
        envelope,
        sessionId: retry.session_id,
        content: retry.content,
        legacy,
        typedTarget: !!retry.require_typed,
        durableRetry: true,
        settlement: retryJson(retry.settlement_json, null),
        retryOwnerToken: publishingOwner,
        retryAlreadyOwned: true,
        publish: ({ envelope: targetEnvelope, content, legacy: targetLegacy, metadata }) => (
          targetEnvelope.kind === 'ticket_dispatch'
            ? pushBrief(content, retry.session_id, metadata)
            : deliverControl({ envelope: targetEnvelope, content, legacy: targetLegacy, metadata }, retry.session_id)
        ),
      });
      if (result.delivered) {
        if (result.settled) {
          chat.record('user', 'brief', retry.content, { session_id: retry.session_id, delivery: 'retry' });
          if (result.typedOutcome?.duplicate === true) {
            // A duplicate terminal response only settles tracker ownership; it
            // did not start a native turn and therefore must not consume the
            // worker's queue opportunity or cooldown for this tick.
            blockedRetrySessions.delete(retry.session_id);
            queueBlockedByRetry.delete(retry.session_id);
          } else {
            if (!notification) lastDeliveredAt.set(retry.session_id, nowMs());
          }
          changed = true;
        } else blockedRetrySessions.add(retry.session_id);
      } else {
        tracker.releaseEnvelopeRetry(retry.envelope_id, {
          ownerToken: publishingOwner,
          error: result.delivery?.error || `status ${result.delivery?.status ?? '?'}`,
        });
      }
    }
    return { changed, queueBlockedByRetry };
  }
  async function performTick() {
    if (stopped) return;
    let pending;
    for (const ack of claimPiPickupAcks({ ownerToken: ackOwner })) {
      try {
        const meta = ack.value?.metadata || {}; const settled = ack.value.settled || {};
        const step = (name, fn) => { if (!settled[name]) { fn(); settled[name] = true; ack.value.settled = settled; checkpointPiPickupAck(ack.file, ack.value); } };
        if (meta.queue_id) step('queue', () => tracker.markQueueDelivered(meta.queue_id, { envelope_id: meta.envelope_id || null }));
        if (meta.envelope_id) step('envelope', () => tracker.markEnvelopeDelivery(meta.envelope_id, { error: null }));
        if (meta.ticket_id) step('comments', () => tracker.markCommentDispatchesDeliveredForTicket(meta.ticket_id, meta.session_id));
        completePiPickupAck(ack);
      } catch (err) { console.error('[dispatch-drainer] Pi pickup settlement failed:', err); }
    }
    try {
      pending = tracker.listPendingDispatches();
    } catch (err) {
      console.error('[dispatch-drainer] listPendingDispatches failed:', err);
      return;
    }
    let queueChanged = await checkUnackedDispatches();
    pending = pending || [];

    // Recover stale typed publishing leases before reachability checks. An
    // accepted/terminal endpoint fact can finalize its owned queue row even if
    // the process has not rebound a new channel yet; a claimed-only boundary
    // is returned to pending and will wait safely for that channel.
    for (const row of pending) {
      if (row.status !== 'publishing' || !row.envelope_id) continue;
      const envelope = tracker.getEnvelope(row.envelope_id);
      // An accepted typed producer may still own settlement in the shared
      // retry record. Do not retire its ticket queue before that record has
      // committed exact comment/queue/root effects.
      const ownedRetry = tracker.getEnvelopeRetry?.(row.envelope_id);
      if (ownedRetry && ownedRetry.status !== 'delivered') continue;
      if (!['claimed', 'accepted', 'settled', 'interrupted', 'recovery_required'].includes(envelope?.delivery_state)) continue;
      try {
        if (!tracker.claimQueuePublishing(row.id, { ownerToken: publishingOwner })) continue;
        const recovery = tracker.reconcileTypedQueuePublishing(row.id, { ownerToken: publishingOwner });
        if (recovery.action === 'retry') tracker.releaseQueuePublishing(row.id, { ownerToken: publishingOwner });
        if (recovery.action !== 'not_owned') queueChanged = true;
      } catch (error) {
        console.error('[dispatch-drainer] stale typed publishing reconciliation failed:', error);
      }
    }
    // Re-read after durable recovery so stale publishing rows are never routed
    // again through the normal delivery loop in this same tick.
    if (queueChanged) {
      try { pending = tracker.listPendingDispatches(); } catch { /* preserve initial snapshot on transient read failure */ }
    }

    const sessions = state.nativeSessions();
    // TKT-0369: sessions whose channel MCP is down are UNREACHABLE — treat
    // them like offline sessions (hold rows pending, 60m expiry), never attempt
    // a push that would burn the row with setDispatched already run. Built once
    // per tick so a transient readChannels failure makes everyone wait one tick
    // (safe), not burn.
    let channelIds = new Set();
    let channelsBySession = new Map();
    let allChannels = [];
    try {
      // A typed worker can keep a healthy loopback lease while it
      // is busy/recovering. Treat delivery_ready:false exactly like an absent
      // channel here so a queued envelope is held, never burned on a 409.
      // Legacy CC/OC rows remain eligible by their established presence rule.
      allChannels = await listChannels();
      const nonReceivingClaude = new Set(sessions.filter((session) => (
        session.harness === 'claudecode' && session.kind === 'background'
      )).map((session) => session.session_id));
      const readyChannels = allChannels.filter((channel) => (
        isChannelDeliveryReady(channel) && !nonReceivingClaude.has(channel.session_id)
      ));
      channelIds = new Set(readyChannels.map((channel) => channel.session_id));
      channelsBySession = new Map(readyChannels.map((channel) => [channel.session_id, channel]));
    } catch { /* transient → everyone waits a tick */ }
    const byId = new Map();
    for (const s of sessions) if (s.session_id) byId.set(s.session_id, s);
    if (schedules.prepare({ sessions, channels: allChannels, nowMs: nowMs() })) queueChanged = true;
    const retrySnapshot = tracker.listPendingEnvelopeRetries();
    const retriesBySession = new Map();
    for (const retry of retrySnapshot) {
      const rows = retriesBySession.get(retry.session_id) ?? [];
      rows.push(retry); retriesBySession.set(retry.session_id, rows);
    }

    // Group pending rows by session_id. listPendingDispatches returns FIFO by
    // created_at globally, so within each session the rows are also FIFO.
    const bySession = new Map();
    for (const row of pending) {
      const arr = bySession.get(row.session_id) ?? [];
      arr.push(row);
      bySession.set(row.session_id, arr);
    }

    for (const sessionId of retriesBySession.keys()) if (!bySession.has(sessionId)) bySession.set(sessionId, []);
    const now = nowMs();
    // FIFO is per target; one slow target must not monopolize unrelated work.
    const processTarget = async ([sessionId, rows]) => {
      const retryDrain = await drainEnvelopeRetries({ byId, channelsBySession, pendingQueue: rows, retries: retriesBySession.get(sessionId) ?? [] });
      if (retryDrain.changed) queueChanged = true;
      if (retryDrain.queueBlockedByRetry.has(sessionId)) return;
      const s = byId.get(sessionId);
      const isTypedWorker = isTypedWorkerChannel(channelsBySession.get(sessionId));

      // Session unknown, dead, OR unreachable (channel MCP down — TKT-0369):
      // hold rows pending (60m expiry), never burn one on a push that can't land.
      if (!s || !s.alive || !channelIds.has(sessionId)) {
        const oldest = rows[0];
        if (!oldest) return;
        const createdMs = Date.parse(oldest.created_at);
        if (Number.isFinite(createdMs) && now - createdMs > OFFLINE_EXPIRY_MS) {
          try {
            tracker.expireQueuedDispatch(oldest.id, 'target offline or channel unreachable > 60m');
            chat.record(
              'system',
              'error',
              `queued dispatch ${oldest.id.slice(0, 8)} for ${sessionId} expired — target offline or channel unreachable > 60m`,
            );
            const ticket = tracker.getTicket(oldest.ticket_id);
            if (ticket) broadcastWS({ type: 'ticket-updated', ticket });
            queueChanged = true;
          } catch (err) {
            console.error('[dispatch-drainer] expire failed:', err);
          }
        }
        // else skip — the session may come back.
        return;
      }

      // Cooldown: never stack a second brief onto a session that hasn't
      // visibly gone busy yet. Status freshness is 3s and Claude's status
      // flip lags a prompt by seconds.
      const last = lastDeliveredAt.get(sessionId);
      if (last != null && now - last < COOLDOWN_MS) return;

      // waiting = mid-task blocked on human input — delivering there recreates
      // the original bug. Both busy AND waiting hold.
      if (s.status !== 'idle') return;

      // GOL-151: dependency waves are gone, so the queue is plain FIFO —
      // deliver the oldest pending row only (one per session per tick).
      const row = rows[0];
      if (!row || stopped) return;
      try {
        const ticket = tracker.getTicket(row.ticket_id);
        if (!ticket) {
          // Ticket vanished (deleted). Cancel the orphaned queue row.
          tracker.cancelQueuedDispatch(row.id, { actor: 'golem-drainer' });
          queueChanged = true;
          const refreshed = tracker.getTicket(row.ticket_id);
          if (refreshed) broadcastWS({ type: 'ticket-updated', ticket: refreshed });
          return;
        }
        // Ticket dispatched to another session meanwhile (dispatched_at newer
        // than the queue row's created_at) → the queue row is stale; cancel
        // it. A typed pre-acceptance retry is already dispatched to *this*
        // session, so retaining its queue row is what makes the guarded retry
        // and legacy-fence reissue replayable.
        if (ticket.dispatched_at && ticket.dispatched_to !== sessionId) {
          const dispatchedMs = Date.parse(ticket.dispatched_at);
          const createdMs = Date.parse(row.created_at);
          if (
            Number.isFinite(dispatchedMs) &&
            Number.isFinite(createdMs) &&
            dispatchedMs > createdMs
          ) {
            tracker.cancelQueuedDispatch(row.id, { actor: 'golem-drainer' });
            try { await pushBrief(`Dispatch revoked for ${ticket.display_id || ticket.id}: ${ticket.title || ''}\n\nReason: superseded before queued delivery. Stand down unless you receive a new dispatch.`, row.session_id); } catch { /* best-effort */ }
            queueChanged = true;
            const refreshed = tracker.getTicket(row.ticket_id);
            if (refreshed) broadcastWS({ type: 'ticket-updated', ticket: refreshed });
            return;
          }
        }

        const ownedRetry = row.envelope_id ? tracker.getEnvelopeRetry(row.envelope_id) : null;
        if (['blocked', 'cancelled'].includes(ownedRetry?.status)) {
          const blocked = tracker.blockQueuedDispatch(row.id, { error: ownedRetry.last_error || 'delivery requires inspection', nowMs: nowMs() });
          if (blocked?.status === 'blocked') queueChanged = true;
          return;
        }
        if (ownedRetry && ownedRetry.status !== 'delivered') return;
        // Every transport owns publication before bytes, including Claude.
        if (publishing.has(row.id)) return;
        if (!tracker.claimQueuePublishing(row.id, { ownerToken: publishingOwner })) return;
        publishing.add(row.id);

        let envelope = row.envelope_id ? tracker.getEnvelope(row.envelope_id) : null;
        if (isTypedWorker && row.envelope_id) {
          // A stale publishing lease is not permission to overwrite durable
          // endpoint truth. Reconcile accepted/terminal rows first; only a
          // pre-acceptance claim returns to pending for same-id retry.
          const reconciliation = tracker.reconcileTypedQueuePublishing(row.id, { ownerToken: publishingOwner });
          if (reconciliation.action === 'finalized') {
            queueChanged = true;
            const refreshed = tracker.getTicket(row.ticket_id);
            if (refreshed) broadcastWS({ type: 'ticket-updated', ticket: refreshed });
            return;
          }
          if (reconciliation.action === 'accepted') return;
          if (reconciliation.action === 'not_owned') return;
          envelope = reconciliation.envelope;
        }

        // Durable-first: setDispatched BEFORE pushBrief (crash between →
        // ticket assigned, not lost).
        let assigned = ticket;
        // An immediate typed publish can lose its response after native
        // acceptance. Its original envelope is queued for the shared retry
        // below, but the ticket is already dispatched to this same session.
        // Repeating setDispatched would cancel that very queue row before the
        // duplicate-safe retry reaches the endpoint.
        if (ticket.dispatched_to !== sessionId) {
          assigned = tracker.setDispatched(ticket.id, { session_id: sessionId, actor: 'golem-drainer' });
        }
        if (assigned.revoked_session_id) {
          try { await pushBrief(`Dispatch revoked for ${assigned.display_id || assigned.id}: ${assigned.title || ''}\n\nReason: queued dispatch delivered to another session. Stand down unless you receive a new dispatch.`, assigned.revoked_session_id); } catch { /* best-effort */ }
        }
        // A queued typed envelope may wait behind a busy turn longer than its
        // original TTL. Extend the durable source before
        // rendering, so the endpoint receives exactly the expiry the tracker
        // now authorizes rather than a synthetic or stale timestamp.
        if (isTypedWorker && envelope) envelope = tracker.renewEnvelopeExpiry(envelope.id);
        // Rebuild delegated briefs from the durable envelope identity. Older
        // queue rows may contain a pre-GOL-132 payload without the authenticated
        // return block; the immutable sender id must still be rendered before
        // that row is delivered. Human-originated rows may retain their stored
        // payload because they have no peer return route to reconstruct.
        let briefString = buildDispatchBrief(ticket, row.note, row.workspace || undefined, row.envelope_id || null, envelope?.sender_session_id || null);
        if (!envelope?.sender_session_id) {
          try {
            const payload = envelope?.payload ? JSON.parse(envelope.payload) : null;
            if (typeof payload?.content === 'string') briefString = payload.content;
          } catch { /* legacy rows retain reconstructed brief behavior */ }
        }

        // Freeze the exact comment rows alongside this queued envelope before
        // transport. A later batch for the same ticket/session must remain
        // pending when this older retry settles after a lost response.
        const commentDispatches = tracker.listPendingCommentDispatchesForTicket?.(ticket.id, sessionId) ?? [];
        const commentDispatchIds = commentDispatches.map((dispatch) => dispatch.id);
        let pushResult;
        let publication = null;
        try {
          {
            if (!envelope) throw new Error(`queued dispatch ${row.id} is missing its durable envelope`);
            // One publisher owns typed and legacy queue completion, so a
            // legacy crash cannot escape the uncertainty/retry fence.
            publication = await publishDurableEnvelope({
              tracker,
              envelope,
              sessionId,
              content: briefString,
              legacy: { path: '/brief', body: briefString },
              typedTarget: isTypedWorker,
              durableRetry: true,
              retryOwnerToken: publishingOwner,
              settlement: {
                comment_dispatch: commentDispatchIds.length
                  ? {
                      dispatch_ids: commentDispatchIds,
                      batch_ids: [...new Set(commentDispatches.map((dispatch) => dispatch.batch_id).filter(Boolean))],
                    }
                  : null,
                queue: { id: row.id, owner_token: publishingOwner },
              },
              publish: ({ content, metadata }) => pushBrief(content, sessionId, metadata ?? {
                envelope_id: envelope.id, sender_session_id: envelope.sender_session_id, target_session_id: sessionId,
              }),
            });
            pushResult = publication.delivery;
          }
        } catch (err) {
          pushResult = { ok: false, error: String(err?.message ?? err) };
        }
        const typedOutcome = publication?.typedOutcome ?? null;
        const typedAccepted = typedOutcome?.accepted === true;
        if (typedAccepted && !pushResult?.accepted) pushResult = { ...pushResult, accepted: true };
        const deliveryAccepted = !!publication?.delivered;
        if (isTypedWorker && row.envelope_id && !typedAccepted) {
          if (isLegacyReplayFence(pushResult)) {
            const replacement = tracker.rotatePendingEnvelope(row.envelope_id, {
              actor: 'golem-drainer',
              reason: 'legacy typed replay fence before native acceptance',
            });
            // The shared helper reserved the old identity before learning of
            // the fence. Retire only that now-superseded retry; the rotated
            // queue/envelope remains the replayable source of truth.
            if (tracker.claimEnvelopeRetry(row.envelope_id, { ownerToken: publishingOwner })) {
              tracker.markEnvelopeRetryDelivered(row.envelope_id, { ownerToken: publishingOwner });
            }
            pushResult = {
              ...pushResult,
              reissued_envelope_id: replacement.id,
              error: `legacy replay fence; atomically reissued pending envelope ${replacement.id}`,
            };
          }
        }

        // Set the outcome from the delivery opportunity before queue/envelope
        // writes: their failure must not replay context that already landed.
        if (pushResult.queued) {
          if (assigned.dispatched_to !== sessionId) {
            assigned = tracker.setDispatched(ticket.id, { session_id: sessionId, actor: 'golem-drainer' });
          }
          if (assigned.revoked_session_id) {
            try { await pushBrief(`Dispatch revoked for ${assigned.display_id || assigned.id}: ${assigned.title || ''}\n\nReason: queued dispatch delivered to another session. Stand down unless you receive a new dispatch.`, assigned.revoked_session_id); } catch { /* best-effort */ }
          }
          tracker.markQueueNextTurn(row.id, { ownerToken: publishingOwner });
        // Queue/comment completion belongs only to the shared publisher.
        } else if (deliveryAccepted) { /* settled or retained for terminal callback */ }
        else if (['blocked', 'cancelled'].includes(publication?.retry?.status)) {
          tracker.blockQueuedDispatch(row.id, { ownerToken: publishingOwner,
            error: publication.retry.last_error || 'delivery requires inspection' });
        } else tracker.releaseQueuePublishing(row.id, { ownerToken: publishingOwner });

        if (pushResult && deliveryAccepted) {
          chat.record('user', 'brief', briefString, { session_id: sessionId, delivery: pushResult.queued ? 'next_turn' : 'push' });
        } else {
          const detail = pushResult?.error || `status ${pushResult?.status ?? '?'}`;
          chat.record(
            'system',
            'error',
            `dispatch of ${ticket.id} to ${sessionId} — channel ${detail} (ticket assigned; session will pick it up on resume)`,
          );
        }

        const delivered = tracker.getTicket(ticket.id);
        if (delivered) broadcastWS({ type: 'ticket-updated', ticket: delivered });
        queueChanged = true;
        lastDeliveredAt.set(sessionId, nowMs());
      } catch (err) {
        try { tracker.releaseQueuePublishing(row.id, { ownerToken: publishingOwner }); } catch {}
        console.error(`[dispatch-drainer] delivery for ${row.id} failed:`, err);
      } finally {
        publishing.delete(row.id);
      }
    };
    await runTargets([...bySession], processTarget);
    schedules.reconcile(nowMs());
    // TKT-0286: one signal per tick if any queue row transitioned (deliver,
    // expire, or a drainer-internal cancel) — queue-aware surfaces refetch.
    if (queueChanged) {
      broadcastWS({ type: 'dispatch-queue-updated' });
      // Envelope delivery/ping/escalation facts changed. The Agents health
      // drawer listens for this signal and refetches once; it never polls.
      broadcastWS({ type: 'communication-health-updated' });
    }
  }

  function tick() {
    if (stopped) return Promise.resolve();
    if (!runningTick) runningTick = performTick().finally(() => { runningTick = null; });
    return runningTick;
  }

  timer = setInterval(() => {
    tick().catch((err) => console.error('[dispatch-drainer] tick threw:', err));
  }, TICK_MS);
  timer.unref();

  return {
    // Exposed for deterministic journey coverage; production still runs it on
    // the interval above.
    tick,
    close() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
