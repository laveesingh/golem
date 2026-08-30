// Browser-side REST + WebSocket client for the dashboard backend.
// Plain JS so it loads before babel-transformed JSX components.

(function () {
  const base = ''; // same-origin

  async function getJSON(path) {
    const r = await fetch(base + path, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} ${path}`);
    return r.json();
  }

  async function postJSON(path, body) {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body == null ? '{}' : JSON.stringify(body),
    });
    let json = null;
    try { json = await r.json(); } catch { /* response may be plain text */ }
    if (!r.ok) {
      const err = new Error(`${r.status} ${r.statusText} ${path}`);
      err.payload = json;
      throw err;
    }
    return json;
  }

  async function patchJSON(path, body) {
    const r = await fetch(base + path, {
      method: 'PATCH',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body == null ? '{}' : JSON.stringify(body),
    });
    let json = null;
    try { json = await r.json(); } catch { /* response may be plain text */ }
    if (!r.ok) {
      const err = new Error(`${r.status} ${r.statusText} ${path}`);
      err.payload = json;
      throw err;
    }
    return json;
  }

  async function putJSON(path, body) {
    const r = await fetch(base + path, {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body == null ? '{}' : JSON.stringify(body),
    });
    let json = null;
    try { json = await r.json(); } catch { /* response may be plain text */ }
    if (!r.ok) {
      const err = new Error(`${r.status} ${r.statusText} ${path}`);
      err.payload = json;
      throw err;
    }
    return json;
  }

  async function delJSON(path, body) {
    const r = await fetch(base + path, {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await r.json(); } catch { /* response may be plain text */ }
    if (!r.ok) {
      const err = new Error(`${r.status} ${r.statusText} ${path}`);
      err.payload = json;
      throw err;
    }
    return json;
  }

  // Build an encoded query string from a params object, skipping null/undefined.
  function qs(params) {
    const parts = [];
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v == null || v === '') continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
    return parts.length ? `?${parts.join('&')}` : '';
  }

  function wsUrl(path) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}${path}`;
  }

  // Listener-friendly WS wrapper with auto-reconnect.
  function createWS({ url, onMessage, onStatus }) {
    let socket = null;
    let alive = true;
    let backoff = 600;
    let pingTimer = null;

    function setStatus(s) {
      try {
        onStatus && onStatus(s);
      } catch {
        /* ignore */
      }
    }

    function connect() {
      if (!alive) return;
      setStatus('connecting');
      try {
        socket = new WebSocket(url);
      } catch (err) {
        setStatus('disconnected');
        scheduleReconnect();
        return;
      }
      socket.onopen = () => {
        backoff = 600;
        setStatus('connected');
        // Keep-alive pings every 25s.
        pingTimer = setInterval(() => {
          if (socket && socket.readyState === WebSocket.OPEN) {
            try {
              socket.send(JSON.stringify({ type: 'ping' }));
            } catch {
              /* ignore */
            }
          }
        }, 25_000);
      };
      socket.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        try {
          onMessage && onMessage(msg);
        } catch (err) {
          console.error('ws onMessage error', err);
        }
      };
      socket.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = null;
        setStatus('disconnected');
        scheduleReconnect();
      };
      socket.onerror = () => {
        // close handler will run; nothing to do here.
      };
    }

    function scheduleReconnect() {
      if (!alive) return;
      const delay = Math.min(backoff, 8000);
      setTimeout(connect, delay);
      backoff = Math.min(backoff * 1.6, 8000);
    }

    function send(obj) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify(obj));
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }

    function close() {
      alive = false;
      if (pingTimer) clearInterval(pingTimer);
      if (socket) socket.close();
    }

    connect();
    return { send, close };
  }

  window.SubstrateAPI = {
    getJSON,
    postJSON,
    patchJSON,
    delJSON,
    wsUrl,
    createWS,
    snapshot: () => getJSON('/api/snapshot'),
    meta: () => getJSON('/api/meta'),
    communicationHealth: (params) => getJSON(`/api/communication-health${qs(params)}`),
    listMessageEnvelopes: (params) => getJSON(`/api/message-envelopes${qs(params)}`),
    getMessageEnvelope: (id) => getJSON(`/api/message-envelopes/${encodeURIComponent(id)}`),
    projects: () => getJSON('/api/projects'),
    workspaces: () => getJSON('/api/workspaces'),
    // v4 (fix round 2): peek payload for one native session — recent central-
    // journal events + milestones + best-effort transcript path.
    nativeSessionPeek: (sessionId) =>
      getJSON(`/api/native-sessions/${encodeURIComponent(sessionId)}/peek`),
    // v4: brief / interrupt / halt delivered over per-session channels.
    pushBrief: (text, sessionId) =>
      postJSON('/api/brief', { brief: text, session_id: sessionId ?? null }),
    pushInterrupt: (text, sessionId) =>
      postJSON('/api/interrupt', { text, session_id: sessionId ?? null }),
    pushHalt: (reason, sessionId) =>
      postJSON('/api/halt', { reason: reason ?? '', session_id: sessionId ?? null }),
    channels: () => getJSON('/api/channels'),
    channelHealth: (sessionId) =>
      getJSON(`/api/channel/health${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`),
    setSessionRole: (sessionId, role) =>
      postJSON(`/api/sessions/${encodeURIComponent(sessionId)}/role`, { role }),
    listRoles: () => getJSON('/api/roles'),
    modelProfiles: () => getJSON('/api/model-profiles'),
    createModelProfile: (profile) => postJSON('/api/model-profiles', profile),
    saveModelProfile: (name, patch) => patchJSON(`/api/model-profiles/${encodeURIComponent(name)}`, patch),
    deleteModelProfile: (name) => delJSON(`/api/model-profiles/${encodeURIComponent(name)}`),
    modelCatalog: (refresh = false) => getJSON(`/api/model-catalog${refresh ? '?refresh=1' : ''}`),
    refreshModelCatalog: () => postJSON('/api/model-catalog/refresh', {}),
    saveRoleDefaultProfile: (name, profile) => patchJSON(`/api/roles/${encodeURIComponent(name)}`, { default_profile: profile || null }),
    createRole: (role) => postJSON('/api/roles', role),
    saveRole: (name, patch) =>
      fetch(`/api/roles/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(typeof patch === 'string' ? { body: patch } : patch),
      }).then(async (r) => {
        const json = await r.json().catch(() => null);
        if (!r.ok) {
          const err = new Error(`${r.status} ${r.statusText} /api/roles/${name}`);
          err.payload = json;
          throw err;
        }
        return json;
      }),
    deleteRole: (name, force = false) =>
      fetch(`/api/roles/${encodeURIComponent(name)}${force ? '?force=true' : ''}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      }).then(async (r) => {
        const json = await r.json().catch(() => null);
        if (!r.ok) {
          const err = new Error(`${r.status} ${r.statusText} /api/roles/${name}`);
          err.payload = json;
          throw err;
        }
        return json;
      }),
    pushRole: (name) => postJSON(`/api/roles/${encodeURIComponent(name)}/push`, {}),

    // GOL-4: background agent terminal peek & interaction
    sessionTerminal: (sessionId, lines) =>
      getJSON(`/api/native-sessions/${encodeURIComponent(sessionId)}/terminal${lines ? `?lines=${lines}` : ''}`),
    sendSessionMessage: (sessionId, text) =>
      postJSON(`/api/native-sessions/${encodeURIComponent(sessionId)}/message`, { text }),
    interruptSession: (sessionId) =>
      postJSON(`/api/native-sessions/${encodeURIComponent(sessionId)}/interrupt`, {}),

    // ---- Cross-project tracker (tracker.db) ----
    // These are SEPARATE from the legacy markdown `tickets(projectId)` above.
    // Tickets are filtered/posted by the CONTRACT `project_id` (`<slug>-<6hex>`).
    listTickets: (params) => getJSON(`/api/tickets${qs(params)}`),
    listReviewTickets: () => getJSON('/api/tickets?state=review'),
    // TKT-0284: content search across ticket title + body (specs page search
    // mode). Server returns { id, title, kind, state, updated_at, snippet,
    // title_match, match_start, match_len }[] — snippet carries the first body
    // match ±80 chars with offsets so the client can <mark> it. q <2 chars → 400.
    searchTickets: (params) => getJSON(`/api/tickets/search${qs(params)}`),
    createTicket: (body) => postJSON('/api/tickets', body),
    getTicket: (id) => getJSON(`/api/tickets/${encodeURIComponent(id)}`),
    updateTicket: (id, patch) => patchJSON(`/api/tickets/${encodeURIComponent(id)}`, patch),
    deleteTicket: (id, actor = 'human') => delJSON(`/api/tickets/${encodeURIComponent(id)}`, { actor }),
    addComment: (id, body) => postJSON(`/api/tickets/${encodeURIComponent(id)}/comments`, body),
    dispatchComment: (commentId, body) => postJSON(`/api/comments/${encodeURIComponent(commentId)}/dispatch`, body),
    batchDispatchComments: (id, body) => postJSON(`/api/tickets/${encodeURIComponent(id)}/comments/batch-dispatch`, body),
    updateComment: (id, commentId, patch) =>
      patchJSON(`/api/tickets/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, patch),
    replyComment: (id, commentId, body) =>
      postJSON(`/api/tickets/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/reply`, body),
    dispatchTicket: (id, { session_id, note, mode, workspace }) =>
      postJSON(`/api/tickets/${encodeURIComponent(id)}/dispatch`, { session_id, note, mode, workspace }),
    revivalInfo: (id, params) => getJSON(`/api/tickets/${encodeURIComponent(id)}/revival${qs(params)}`),
    redispatchRevival: (id, body) => postJSON(`/api/tickets/${encodeURIComponent(id)}/revival/redispatch`, body),
    dismissUnackedDispatch: (id, deliveryEventId) =>
      postJSON(`/api/tickets/${encodeURIComponent(id)}/unacked/${encodeURIComponent(deliveryEventId)}/dismiss`, { actor: 'human:dashboard' }),
    listDispatchable: (projectId) =>
      getJSON(`/api/sessions/dispatchable${qs({ project: projectId })}`),
    // TKT-0245: cancel a queued dispatch (DELETE /api/dispatch-queue/:qid).
    cancelDispatchQueue: (qid) =>
      delJSON(`/api/dispatch-queue/${encodeURIComponent(qid)}`),
    // Genre template scaffolds (spec/feature)
    // served as Markdown bodies from plugin/skills/tracker/templates/. Used by
    // the create-ticket composer's template picker to pre-fill an empty body.
    getTemplates: () => getJSON('/api/templates'),
    // TKT-0206 / GOL-13: project-scoped ideas stack. When projectId is
    // supplied the queue is filtered to that project's ideas; without it
    // the legacy global view (all ideas) is returned.
    listIdeas: (projectId) => getJSON(`/api/ideas${qs(projectId ? { project: projectId } : {})}`),
    createIdea: (body, projectId) => postJSON('/api/ideas', projectId ? { body, project_id: projectId } : { body }),
    promoteIdea: (id, body) => postJSON(`/api/ideas/${encodeURIComponent(id)}/promote`, body || {}),
    popIdea: (id) => postJSON(`/api/ideas/${encodeURIComponent(id)}/pop`, {}),
    substrateStatus: (project) => getJSON(`/api/substrate/status${qs({ project })}`),
    substrateConfig: () => getJSON('/api/substrate/config'),
    updateSubstrateConfig: (body) => {
      return fetch('/api/substrate/config', {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }).then(async (r) => {
        const json = await r.json().catch(() => null);
        if (!r.ok) {
          const err = new Error(`${r.status} ${r.statusText} /api/substrate/config`);
          err.payload = json;
          throw err;
        }
        return json;
      });
    },
    syncSubstrate: (body) => postJSON('/api/substrate/sync', body),
    // GOL-2: Substrate Layer (Skills, Instructions, Roles)
    listSubstrateSkills: () => getJSON('/api/substrate/skills'),
    getSubstrateSkill: (slug) => getJSON(`/api/substrate/skills/${encodeURIComponent(slug)}`),
    createSubstrateSkill: (body) => postJSON('/api/substrate/skills', body),
    updateSubstrateSkill: (slug, body) => putJSON(`/api/substrate/skills/${encodeURIComponent(slug)}`, body),
    deleteSubstrateSkill: (slug) => delJSON(`/api/substrate/skills/${encodeURIComponent(slug)}`),
    getSubstrateInstructions: () => getJSON('/api/substrate/instructions'),
    updateSubstrateInstructions: (body) => putJSON('/api/substrate/instructions', body),
    listSubstrateRoles: () => getJSON('/api/substrate/roles'),
    updateSubstrateRole: (role, body) => putJSON(`/api/substrate/roles/${encodeURIComponent(role)}`, body),
    // Ticket links (WS5b). `from` is the ticket id the link hangs off of.
    addLink: (id, { to_ticket, type }) =>
      postJSON(`/api/tickets/${encodeURIComponent(id)}/links`, { to_ticket, type }),
    removeLink: (id, { to_ticket, type }) =>
      delJSON(`/api/tickets/${encodeURIComponent(id)}/links`, { to_ticket, type }),
    // GOL-15: zero-terminal swarm controls — terminal ANSI, steer, spawn
    getTerminal: (sessionId, lines) => getJSON(`/api/native-sessions/${encodeURIComponent(sessionId)}/terminal${qs(lines ? { lines } : {})}`),
    sendSteer: (sessionId, text) => postJSON(`/api/native-sessions/${encodeURIComponent(sessionId)}/message`, { text, mode: 'steer' }),
    sendInterrupt: (sessionId, text) => postJSON(`/api/native-sessions/${encodeURIComponent(sessionId)}/message`, { text, mode: 'interrupt' }),
    sendHalt: (sessionId, text) => postJSON(`/api/native-sessions/${encodeURIComponent(sessionId)}/message`, { text, mode: 'halt' }),
    killSession: (sessionId) => postJSON(`/api/native-sessions/${encodeURIComponent(sessionId)}/message`, { mode: 'kill' }),
    listWorkers: (projectId) => getJSON(`/api/workers${qs(projectId ? { project: projectId } : {})}`),
    spawnWorker: (body) => postJSON('/api/workers/spawn', body),
    diagnostics: () => getJSON('/api/diagnostics'),
    scaffoldProject: (name) => postJSON('/api/projects/scaffold', { name }),
    importProject: (path) => postJSON('/api/projects/import', { path }),

    // TKT-0106: image asset upload. Posts the file as base64 alongside
    // filename + mime. Server validates, stores content-addressed under
    // ~/.config/golem/ticket-assets/<hash>.<ext>, returns {url, ...}.
    uploadAsset: async (file) => {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
      return postJSON('/api/ticket-assets', { filename: file.name, mime: file.type, base64: b64 });
    },
  };
})();
