// Live data store (v4 only).
//
// Backed by REST snapshot + WebSocket deltas. v4 surface:
//   - projects with PLAN.md progress + milestone feeds
//   - native Golem harness sessions
//   - live channel registrations
//   - cross-project tracker.db tickets + comments
//   - chat messages
//
// v3 journal-synthesized agents, markdown tickets, agent detail, and the v3
// orchestrator snapshot were removed in TKT-0009.

(function () {
  const ROLES_FALLBACK = {
    UNK: { label: 'Agent', color: '#8a909c', glyph: '··' },
  };

  const state = {
    ready: false,
    connection: 'connecting',
    projects: [],
    // v4 (fix round 2): per-native-session peek cache, keyed by session_id.
    nativeSessionPeek: new Map(),
    chat: [],
    chatCap: 200,
    roles: { ...ROLES_FALLBACK },
    columns: ['triage', 'open', 'in-progress', 'review', 'blocked', 'done'],
    serverTime: null,
    // v4: all native sessions normalized by Golem.
    nativeSessions: [],
    // v4: live channel registrations keyed by CEO session_id.
    channels: [],
    // v4: cross-project milestone feed (newest first), each project-chipped.
    recentMilestones: [],
    // WS5: cross-project tracker (tracker.db) — a FLAT ticket list across all
    // projects, kept in a Map by id for O(1) upsert.
    trackerTickets: new Map(),
    // WS5b: per-ticket comment threads, keyed by ticket id.
    ticketComments: new Map(),
    // TKT-0286: bumped on every dispatch-queue-updated WS signal so queue-aware
    // surfaces (Agents page, session peek drawer) refetch the queue.
    dispatchQueueRev: 0,
    // GOL-425: a payload-free WS invalidation for read-only envelope health.
    // Consumers fetch once on this revision change; no polling is introduced.
    communicationHealthRev: 0,
    rolesRev: 0,
  };

  const listeners = new Set();
  let notifyTimer = null;
  function notify() {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      for (const fn of [...listeners]) {
        try {
          fn(state);
        } catch (err) {
          console.error('store listener error', err);
        }
      }
    }, 0);
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function applySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    state.projects = Array.isArray(snap.projects) ? snap.projects : [];
    if (Array.isArray(snap.chat)) state.chat = snap.chat.slice();
    if (Array.isArray(snap.native_sessions)) state.nativeSessions = snap.native_sessions.slice();
    if (Array.isArray(snap.channels)) state.channels = snap.channels.slice();
    if (Array.isArray(snap.recent_milestones)) state.recentMilestones = snap.recent_milestones.slice();
    // WS5: flat cross-project tracker slice.
    if (Array.isArray(snap.tickets)) {
      // TKT-0245: MERGE with existing entries instead of replacing wholesale.
      // A snapshot (REST or WS-on-connect) carries only basic ticket fields
      // (from listTickets); a ticket already in the Map from getTicket() may
      // carry extra detail (pending_dispatch, links, events) that the snapshot
      // does NOT. A bare replace would drop those — so the pending-dispatch
      // indicator would vanish on every page reload as the WS snapshot
      // overwrote the getTicket fetch. Merging { ...prev, ...t } preserves the
      // detail fields while still refreshing the basic fields from the
      // snapshot and dropping tickets that no longer exist.
      const m = new Map();
      for (const t of snap.tickets) {
        if (!t || !t.id) continue;
        const prev = state.trackerTickets.get(t.id);
        m.set(t.id, prev ? { ...prev, ...t } : t);
      }
      state.trackerTickets = m;
    }
    state.ready = true;
    notify();
  }

  // ---- WS5: tracker deltas ----
  function applyTicketCreated({ ticket }) {
    if (!ticket || !ticket.id) return;
    state.trackerTickets.set(ticket.id, ticket);
    notify();
  }
  function applyTicketUpdated({ ticket }) {
    if (!ticket || !ticket.id) return;
    state.trackerTickets.set(ticket.id, ticket);
    notify();
  }
  function applyTicketDeleted({ id, display_id }) {
    if (!id) return;
    state.trackerTickets.delete(id);
    if (display_id) state.trackerTickets.delete(display_id);
    state.ticketComments.delete(id);
    notify();
  }
  function upsertTrackerTicket(ticket) {
    if (!ticket || !ticket.id) return;
    state.trackerTickets.set(ticket.id, ticket);
    notify();
  }
  function deleteTrackerTicket(id) {
    if (!id) return;
    state.trackerTickets.delete(id);
    state.ticketComments.delete(id);
    notify();
  }
  function seedTicketComments(id, comments) {
    if (!id) return;
    state.ticketComments.set(id, Array.isArray(comments) ? comments.slice() : []);
    notify();
  }
  function applyTicketComment({ ticket_id, comment }) {
    if (!ticket_id || !comment || comment.id == null) return;
    const cur = state.ticketComments.get(ticket_id) ?? [];
    if (cur.some((c) => c.id === comment.id)) return;
    state.ticketComments.set(ticket_id, [...cur, comment]);
    notify();
  }
  function applyTicketCommentUpdated({ ticket_id, comment }) {
    if (!ticket_id || !comment || comment.id == null) return;
    const cur = state.ticketComments.get(ticket_id) ?? [];
    const idx = cur.findIndex((c) => c.id === comment.id);
    if (idx === -1) {
      state.ticketComments.set(ticket_id, [...cur, comment]);
    } else {
      const next = cur.slice();
      next[idx] = comment;
      state.ticketComments.set(ticket_id, next);
    }
    notify();
  }
  function applyNativeSessionsUpdate({ native_sessions, channels }) {
    if (Array.isArray(native_sessions)) state.nativeSessions = native_sessions.slice();
    if (Array.isArray(channels)) state.channels = channels.slice();
    notify();
  }

  function applyChatMessage({ message }) {
    if (!message || typeof message !== 'object') return;
    if (message.id && state.chat.some((m) => m.id === message.id)) return;
    const next = state.chat.concat(message);
    while (next.length > state.chatCap) next.shift();
    state.chat = next;
    notify();
  }

  // Rebuild the cross-project milestone feed from the per-project summaries.
  // The snapshot ships a server-merged `recent_milestones`, but live WS deltas
  // (project-update / projects-list) only carry a single project's milestones —
  // so we recompute client-side from state.projects to keep the feed fresh.
  function recomputeMilestones(cap = 40) {
    const merged = [];
    for (const p of state.projects) {
      for (const m of p.milestones ?? []) {
        merged.push({
          t: m.t,
          text: m.text,
          session_id: m.session_id ?? null,
          project: p.id,
          project_name: p.name,
          project_color: p.color,
          project_glyph: p.glyph,
        });
      }
    }
    merged.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
    state.recentMilestones = merged.slice(0, cap);
    notify();
  }

  function applyProjectUpdate({ project }) {
    if (!project) return;
    const idx = state.projects.findIndex((p) => p.id === project.id);
    if (idx === -1) state.projects = [...state.projects, project];
    else {
      const next = state.projects.slice();
      next[idx] = project;
      state.projects = next;
    }
    recomputeMilestones();
  }

  function applyProjectsList({ projects }) {
    if (!Array.isArray(projects)) return;
    state.projects = projects;
    recomputeMilestones();
  }

  // ---- Selectors used by components ----

  function getProject(id) {
    return state.projects.find((p) => p.id === id) ?? null;
  }
  // Resolve the dashboard project record for a derived contract project_id.
  function getProjectByContractId(contractId) {
    if (!contractId) return null;
    return (
      state.projects.find((p) => p.project_id === contractId) ??
      state.projects.find((p) => p.id === contractId) ??
      null
    );
  }

  // WS5: cross-project tracker tickets, filtered.
  function getTrackerTickets(filter = {}) {
    const { project_id, state: st, kind, exclude_kind, assignee, includeArchived } = filter;
    const out = [];
    for (const t of state.trackerTickets.values()) {
      if (!includeArchived && t.state === 'archived') continue;
      if (project_id != null && t.project_id !== project_id) continue;
      if (st != null && t.state !== st) continue;
      if (kind != null && t.kind !== kind) continue;
      // TKT-0284: negative-kind filter — the Tracker excludes specs (specs
      // live on their own /specs page). Cheap client-side skip mirroring the
      // server's exclude_kind WHERE clause.
      if (exclude_kind != null && t.kind === exclude_kind) continue;
      if (assignee !== undefined && assignee !== null) {
        if (assignee === '__unassigned__') {
          if (t.assignee != null) continue;
        } else if (t.assignee !== assignee) {
          continue;
        }
      }
      out.push(t);
    }
    return out;
  }
  const EMPTY_COMMENTS = Object.freeze([]);
  function getTicketComments(id) {
    return state.ticketComments.get(id) ?? EMPTY_COMMENTS;
  }
  function getRole(role) {
    if (!role) return state.roles.UNK;
    return state.roles[role] ?? state.roles.UNK;
  }
  function getRoles() {
    return Object.entries(state.roles)
      .filter(([name]) => name !== 'UNK')
      .map(([name, meta]) => ({ name, ...meta }));
  }

  async function loadNativeSessionPeek(sessionId) {
    if (!sessionId) return null;
    try {
      const peek = await window.SubstrateAPI.nativeSessionPeek(sessionId);
      state.nativeSessionPeek.set(sessionId, peek);
      notify();
      return peek;
    } catch (err) {
      console.error('loadNativeSessionPeek failed', err);
      return null;
    }
  }

  // TKT-0194: refresh the projects list (re-fetch from /api/projects) so
  // gate-verdict changes (which mutate a gate file on disk but don't trigger
  // a WS project-update event) are reflected in the UI. The server
  // re-discovers projects on its 30s timer, but calling this gives an
  // instant refresh for the verdict the user just issued.
  async function refreshProjects() {
    try {
      const list = await window.SubstrateAPI.projects();
      if (Array.isArray(list)) {
        state.projects = list;
        recomputeMilestones();
        notify();
      }
    } catch (err) {
      console.error('refreshProjects failed', err);
    }
  }

  function getNativeSessionPeek(sessionId) {
    return sessionId ? (state.nativeSessionPeek.get(sessionId) ?? null) : null;
  }

  // ---- Boot ----

  async function bootstrap() {
    try {
      const meta = await window.SubstrateAPI.meta();
      if (meta && meta.roles) state.roles = { ...ROLES_FALLBACK, ...meta.roles };
      if (Array.isArray(meta?.columns)) state.columns = meta.columns;
    } catch (err) {
      console.warn('meta fetch failed', err);
    }
    try {
      const snap = await window.SubstrateAPI.snapshot();
      applySnapshot(snap);
    } catch (err) {
      console.error('snapshot fetch failed', err);
      state.ready = true;
      notify();
    }
    // Open WS for live updates.
    window.SubstrateAPI.createWS({
      url: window.SubstrateAPI.wsUrl('/ws'),
      onStatus: (s) => {
        state.connection = s;
        notify();
      },
      onMessage: (msg) => {
        if (!msg) return;
        switch (msg.type) {
          case 'snapshot':
            applySnapshot(msg.payload);
            break;
          case 'project-update':
            applyProjectUpdate(msg);
            break;
          case 'projects-list':
            applyProjectsList(msg);
            break;
          case 'native-sessions-update':
            applyNativeSessionsUpdate(msg);
            break;
          case 'chat-message':
            applyChatMessage(msg);
            break;
          case 'ticket-created':
            applyTicketCreated(msg);
            break;
          case 'ticket-updated':
            applyTicketUpdated(msg);
            // A terminal ticket transition can stamp an envelope completion
            // fact in the same tracker transaction. Reuse this existing WS
            // signal as a health invalidation rather than adding a timer.
            state.communicationHealthRev = (state.communicationHealthRev || 0) + 1;
            break;
          case 'ticket-deleted':
            applyTicketDeleted(msg);
            break;
          case 'ticket-comment':
            applyTicketComment(msg);
            break;
          case 'ticket-comment-updated':
            applyTicketCommentUpdated(msg);
            break;
          case 'dispatch-queue-updated':
            // TKT-0286: payload-free signal — bump a rev counter so queue-aware
            // surfaces refetch /api/dispatch-queue. No polling.
            state.dispatchQueueRev = (state.dispatchQueueRev || 0) + 1;
            notify();
            break;
          case 'communication-health-updated':
            state.communicationHealthRev = (state.communicationHealthRev || 0) + 1;
            notify();
            break;
          case 'roles-updated':
            if (msg.meta) state.roles = { ...ROLES_FALLBACK, ...msg.meta };
            state.rolesRev = (state.rolesRev || 0) + 1;
            notify();
            break;
          case 'pong':
            state.serverTime = msg.ts;
            break;
          default:
            // v3 agents-update / tickets-update / agent-detail / orchestrator-update
            // are intentionally ignored.
            break;
        }
      },
    });
  }

  // Per-session chat filter.
  function getChatForSession(sessionId) {
    if (!sessionId) return state.chat.slice();
    return state.chat.filter((m) => !m.session_id || m.session_id === sessionId);
  }

  function sessionRecency(s) {
    // updated_at is the server-side max of fact activity and registry recency
    // (GOL-109); fact_observed_at alone can lag real hook-driven activity.
    for (const raw of [s?.last_seen_at, s?.updated_at, s?.fact_observed_at, s?.started_at]) {
      const stamp = typeof raw === 'number' ? raw : Date.parse(raw);
      if (Number.isFinite(stamp)) return stamp;
    }
    return 0;
  }

  function sortSessionsByRecency(rows) {
    return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => sessionRecency(b) - sessionRecency(a));
  }

  window.Store = {
    subscribe,
    getState: () => state,
    getProject,
    getProjectByContractId,
    getProjects: () => state.projects,
    getTrackerTickets,
    getTicketComments,
    seedTicketComments,
    deleteTrackerTicket,
    upsertTrackerTicket,
    getRole,
    getRoles,
    loadNativeSessionPeek,
    refreshProjects,
    getNativeSessionPeek,
    getNativeSessionById: (sessionId) =>
      sessionId ? (state.nativeSessions.find((s) => s.session_id === sessionId) ?? null) : null,
    getChat: () => state.chat,
    getChatForSession,
    getSessionLastSeen: sessionRecency,
    sortSessionsByRecency,
    getNativeSessions: () => sortSessionsByRecency(state.nativeSessions),
    getChannels: () => state.channels,
    getRolesRev: () => state.rolesRev || 0,
    // The live channel for a given session_id, or null.
    getChannelForSession: (sessionId) =>
      sessionId ? (state.channels.find((c) => c.session_id === sessionId) ?? null) : null,
    getRecentMilestones: () => state.recentMilestones,
    // Native Golem sessions whose derived contract project_id maps to this
    // dashboard project.
    getProjectSessions: (project) => {
      if (!project) return [];
      const ids = new Set([project.project_id, project.id].filter(Boolean));
      return sortSessionsByRecency(state.nativeSessions.filter((s) =>
        s.alive === true && s.project_id && ids.has(s.project_id)));
    },
    // v4: alive native sessions belonging to a project.
    getProjectAliveSessions: (project) => {
      if (!project) return [];
      const ids = new Set([project.project_id, project.id].filter(Boolean));
      const pathMatches = (cwd) => {
        if (!cwd || !project.path) return false;
        return cwd === project.path || cwd.startsWith(project.path + '/');
      };
      return sortSessionsByRecency(state.nativeSessions.filter((s) => (
        s.alive === true && ((s.project_id && ids.has(s.project_id)) || (s.registered_project_id && ids.has(s.registered_project_id)) || pathMatches(s.cwd))
      )));
    },
    // v4: count of all alive native Golem sessions on the machine.
    getAliveSessionCount: () => state.nativeSessions.filter((s) => s.alive).length,
    getWorkingSessionCount: () => state.nativeSessions.filter((s) => s.alive && s.status === 'busy').length,
  };

  // Kick off as soon as DOM is ready (script in <body>, so it already is).
  bootstrap();
})();
