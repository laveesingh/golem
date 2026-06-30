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

    // ---- Cross-project tracker (tracker.db) ----
    // These are SEPARATE from the legacy markdown `tickets(projectId)` above.
    // Tickets are filtered/posted by the CONTRACT `project_id` (`<slug>-<6hex>`).
    listTickets: (params) => getJSON(`/api/tickets${qs(params)}`),
    createTicket: (body) => postJSON('/api/tickets', body),
    getTicket: (id) => getJSON(`/api/tickets/${encodeURIComponent(id)}`),
    updateTicket: (id, patch) => patchJSON(`/api/tickets/${encodeURIComponent(id)}`, patch),
    addComment: (id, body) => postJSON(`/api/tickets/${encodeURIComponent(id)}/comments`, body),
    updateComment: (id, commentId, patch) =>
      patchJSON(`/api/tickets/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, patch),
    replyComment: (id, commentId, body) =>
      postJSON(`/api/tickets/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/reply`, body),
    dispatchTicket: (id, { session_id, note }) =>
      postJSON(`/api/tickets/${encodeURIComponent(id)}/dispatch`, { session_id, note }),
    listDispatchable: (projectId) =>
      getJSON(`/api/sessions/dispatchable${qs({ project: projectId })}`),
    listStreams: (projectId) => getJSON(`/api/streams${qs({ project: projectId })}`),
    createStream: (body) => postJSON('/api/streams', body),
    updateStream: (id, patch) => patchJSON(`/api/streams/${encodeURIComponent(id)}`, patch),
    // Genre template scaffolds (feature/bug/design-doc/prd/brainstorm/decision)
    // served as Markdown bodies from plugin/skills/tracker/templates/. Used by
    // the create-ticket composer's template picker to pre-fill an empty body.
    getTemplates: () => getJSON('/api/templates'),
    // Ticket links (WS5b). `from` is the ticket id the link hangs off of.
    addLink: (id, { to_ticket, type }) =>
      postJSON(`/api/tickets/${encodeURIComponent(id)}/links`, { to_ticket, type }),
    removeLink: (id, { to_ticket, type }) =>
      delJSON(`/api/tickets/${encodeURIComponent(id)}/links`, { to_ticket, type }),
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
