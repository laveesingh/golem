// Native session drawer (v4 & GOL-4) — slides in from the right when a native session
// card is clicked. Body = live terminal peek & steer console + metadata & recent activity.

// Thin wrapper kept for existing call sites (dashboard.jsx, other-pages.jsx).
// Now routes through the URL overlay (?ns=<sid>) so Back closes the drawer.
function openNativeSessionDrawer(sessionId, tab = null) {
  window.Router.openNativeSession(sessionId ?? null);
}

function NsdTerminalView({ sessionId, session, alive, events = [], peek = null }) {
  const [lines, setLines] = React.useState(100);
  const [autoRefresh, setAutoRefresh] = React.useState(true);
  const [terminal, setTerminal] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [copiedAttach, setCopiedAttach] = React.useState(false);
  const [copiedOutput, setCopiedOutput] = React.useState(false);
  const [error, setError] = React.useState(null);
  const terminalBodyRef = React.useRef(null);
  const userScrolledUp = React.useRef(false);

  const fetchTerminal = React.useCallback(async (showLoading = false) => {
    if (!sessionId) return;
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const res = await window.SubstrateAPI.sessionTerminal(sessionId, lines);
      setTerminal(res);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [sessionId, lines]);

  React.useEffect(() => {
    fetchTerminal(true);
  }, [fetchTerminal]);

  React.useEffect(() => {
    if (!autoRefresh || !alive) return undefined;
    const interval = setInterval(() => {
      fetchTerminal(false);
    }, 2000);
    return () => clearInterval(interval);
  }, [autoRefresh, alive, fetchTerminal]);

  // Auto-scroll to bottom if user has not scrolled up
  React.useEffect(() => {
    const el = terminalBodyRef.current;
    if (!el || userScrolledUp.current) return;
    el.scrollTop = el.scrollHeight;
  }, [terminal?.text]);

  const handleScroll = (e) => {
    const el = e.currentTarget;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    userScrolledUp.current = !isAtBottom;
  };

  const copyAttach = () => {
    const hint = terminal?.attach_hint || `golem attach ${session?.name || sessionId}`;
    navigator.clipboard?.writeText(hint).then(() => {
      setCopiedAttach(true);
      setTimeout(() => setCopiedAttach(false), 2000);
    });
  };

  const copyOutput = () => {
    if (!terminal?.text) return;
    navigator.clipboard?.writeText(terminal.text).then(() => {
      setCopiedOutput(true);
      setTimeout(() => setCopiedOutput(false), 2000);
    });
  };

  const lineOptions = [50, 100, 250, 500];
  const renderedAnsi = React.useMemo(() => {
    if (!terminal?.text) return '';
    return window.SubstrateFmt?.renderAnsi
      ? window.SubstrateFmt.renderAnsi(terminal.text)
      : terminal.text;
  }, [terminal?.text]);

  return (
    <div className="nsd-terminal-section">
      <div className="nsd-terminal-toolbar">
        <div className="nsd-terminal-tools-left">
          <label className="nsd-auto-toggle" title="Poll terminal output every 2s while live">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            <span className={`nsd-auto-dot ${autoRefresh && alive ? 'is-active' : ''}`}/>
            <span>Live auto-refresh</span>
          </label>
          <button
            type="button"
            className="orch-btn small ghost"
            onClick={() => fetchTerminal(true)}
            disabled={loading}
            title="Refresh terminal output now"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <div className="nsd-terminal-tools-right">
          <div className="nsd-line-pills" role="group" aria-label="Lines to display">
            {lineOptions.map((n) => (
              <button
                key={n}
                type="button"
                className={`nsd-line-pill ${lines === n ? 'active' : ''}`}
                onClick={() => setLines(n)}
              >
                {n}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="orch-btn small ghost nsd-copy-btn"
            onClick={copyAttach}
            title={terminal?.attach_hint || 'Copy attach command'}
          >
            {copiedAttach ? 'Copied Cmd ✓' : 'Attach Cmd'}
          </button>

          <button
            type="button"
            className="orch-btn small ghost nsd-copy-btn"
            onClick={copyOutput}
            disabled={!terminal?.text}
            title="Copy scrollback output to clipboard"
          >
            {copiedOutput ? 'Copied Log ✓' : 'Copy Log'}
          </button>
        </div>
      </div>

      <div className="nsd-terminal-viewport" ref={terminalBodyRef} onScroll={handleScroll}>
        {loading && !terminal ? (
          <div className="nsd-terminal-empty">Connecting to agent terminal…</div>
        ) : error ? (
          <div className="nsd-terminal-empty is-error">{error}</div>
        ) : !terminal?.ok || !terminal?.text ? (
          <div className="nsd-terminal-foreground-feed">
            <div className="nsd-foreground-badge">
              <span className="nsd-fg-icon">⚡</span>
              <span>Foreground terminal session ({session?.harness || 'native'}) · Live activity stream</span>
            </div>
            {events.length === 0 ? (
              <div className="nsd-terminal-empty">
                {peek?.note || 'No recorded activity yet for this session.'}
              </div>
            ) : (
              <div className="nsd-terminal-events">
                {events.map((e, i) => (
                  <div key={`${e.t}-${i}`} className="nsd-terminal-event-row mono">
                    <span className="nsd-event-time">{window.SubstrateFmt?.fmtTimeAgo?.(e.t) || ''}</span>
                    <span className={`nsd-event-type type-${e.event}`}>{e.event}</span>
                    <span className="nsd-event-summary" title={e.summary}>{e.summary}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <pre
            className="nsd-terminal-text mono"
            dangerouslySetInnerHTML={{ __html: renderedAnsi }}
          />
        )}
      </div>
    </div>
  );
}

function NsdSteerComposer({ sessionId, session, alive, onSent }) {
  const [text, setText] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [interrupting, setInterrupting] = React.useState(false);
  const [feedback, setFeedback] = React.useState(null);

  const isBusy = session?.status === 'busy' || session?.delivery_state === 'accepted';

  const send = async (customText = null) => {
    const payload = (customText != null ? customText : text).trim();
    if (!payload || !sessionId || sending) return;
    setSending(true);
    setFeedback(null);
    try {
      const res = await window.SubstrateAPI.sendSessionMessage(sessionId, payload);
      setText('');
      const isSteer = res?.steered || isBusy;
      setFeedback({
        type: 'success',
        msg: isSteer ? 'Steer guidance delivered to active turn ✓' : 'Message dispatched to session ✓',
      });
      onSent?.();
      setTimeout(() => setFeedback(null), 4000);
    } catch (err) {
      setFeedback({
        type: 'error',
        msg: String(err?.payload?.error || err?.message || err),
      });
    } finally {
      setSending(false);
    }
  };

  const handleInterrupt = async () => {
    if (!sessionId || interrupting) return;
    setInterrupting(true);
    setFeedback(null);
    try {
      await window.SubstrateAPI.interruptSession(sessionId);
      setFeedback({
        type: 'success',
        msg: 'Interrupt signal sent to agent ✓',
      });
      setTimeout(() => setFeedback(null), 4000);
    } catch (err) {
      setFeedback({
        type: 'error',
        msg: String(err?.payload?.error || err?.message || err),
      });
    } finally {
      setInterrupting(false);
    }
  };

  const chips = [
    { label: '⚡ Status update', text: 'Please provide a concise status update on your current progress and next action.' },
    { label: '📌 Wrap up task', text: 'Please wrap up the current task, run any necessary tests/checks, and report your findings.' },
  ];

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="nsd-steer-dock">
      <div className="nsd-steer-chips">
        <span className="nsd-steer-chips-label">Quick prompts:</span>
        {chips.map((c) => (
          <button
            key={c.label}
            type="button"
            className="nsd-chip-btn"
            onClick={() => setText(c.text)}
            disabled={!alive || sending}
          >
            {c.label}
          </button>
        ))}
        {isBusy && (
          <button
            type="button"
            className="nsd-chip-btn is-interrupt"
            onClick={handleInterrupt}
            disabled={!alive || interrupting}
            title="Send interrupt signal to current turn"
          >
            {interrupting ? 'Interrupting…' : '✋ Interrupt turn'}
          </button>
        )}
      </div>

      <div className="nsd-steer-input-row">
        <textarea
          className="nsd-steer-input mono"
          placeholder={alive ? (isBusy ? 'Type mid-turn steer guidance… (Enter to send)' : 'Send message / brief to agent… (Enter to send)') : 'Session is offline'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!alive || sending}
          rows={2}
        />
        <button
          type="button"
          className="orch-btn nsd-send-btn"
          onClick={() => send()}
          disabled={!alive || !text.trim() || sending}
        >
          {sending ? 'Sending…' : isBusy ? '↗ Steer' : '↗ Send'}
        </button>
      </div>

      {feedback && (
        <div className={`nsd-steer-feedback ${feedback.type}`}>
          {feedback.msg}
        </div>
      )}
    </div>
  );
}

function NativeSessionDrawer({ open, sessionId, onClose }) {
  useStore();
  const [activeTab, setActiveTab] = React.useState('console');

  // open + sessionId are URL-driven (?ns=<sid>, owned by App). On open, fetch
  // the session's recent activity + milestones.
  React.useEffect(() => {
    if (open && sessionId) window.Store.loadNativeSessionPeek(sessionId);
  }, [open, sessionId]);

  React.useEffect(() => {
    if (!open || !sessionId) return;
    const id = setInterval(() => {
      const s = window.Store.getNativeSessionById(sessionId);
      if (s && s.alive) window.Store.loadNativeSessionPeek(sessionId);
    }, 5000);
    return () => clearInterval(id);
  }, [open, sessionId]);

  // TKT-0286: this session's pending dispatch queue (FIFO). Refetch on open +
  // on the dispatch-queue-updated WS signal (rev). Cancel relies on the same
  // signal for refresh — no polling.
  const dispatchQueueRev = window.Store.getState().dispatchQueueRev || 0;
  const [queue, setQueue] = React.useState([]);
  React.useEffect(() => {
    if (!open || !sessionId) { setQueue([]); return; }
    let cancelled = false;
    window.SubstrateAPI.getJSON(`/api/dispatch-queue?session=${encodeURIComponent(sessionId)}`)
      .then((rows) => { if (!cancelled) setQueue(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setQueue([]); });
    return () => { cancelled = true; };
  }, [open, sessionId, dispatchQueueRev]);

  const session = sessionId ? window.Store.getNativeSessionById(sessionId) : null;
  const peek = sessionId ? window.Store.getNativeSessionPeek(sessionId) : null;
  const s = session || peek?.session || null;

  if (!sessionId) {
    return (
      <>
        <DrawerBackdrop open={open} onClose={onClose}/>
        <DrawerPanel open={open} onClose={onClose} label="Agent details"/>
      </>
    );
  }

  const alive = s?.alive;
  const statusKind = !s ? 'idle'
    : !alive ? 'dead'
    : s.status === 'busy' ? 'busy'
    : s.status === 'waiting' ? 'waiting'
    : 'idle';
  const dotClass = statusKind === 'busy' ? 'live'
    : statusKind === 'waiting' ? 'waiting'
    : statusKind === 'idle' ? 'idle'
    : 'offline';
  const statusLabel = statusKind === 'busy' ? 'Working'
    : statusKind === 'waiting' ? 'Waiting'
    : statusKind === 'idle' ? 'Idle'
    : 'Dead';

  const title = s?.name
    || (s?.cwd ? s.cwd.split('/').filter(Boolean).pop() : null)
    || (sessionId ? sessionId.slice(0, 8) : 'session');

  const project = s ? window.Store.getProjectByContractId(s.project_id) : null;
  const registered = (s && (s.registered || !!project));

  const events = peek?.events ?? [];
  const milestones = peek?.milestones ?? [];
  const loaded = !!peek;
  const currentTicket = s?.current_in_progress_ticket ?? null;
  const pendingCount = Number(s?.pending_count || queue.length || 0);
  const channelUnavailable = s?.channel_present === false
    || (s?.channel_present === true && ['unreachable', 'unverified', 'unhealthy'].includes(s?.endpoint_health))
    || (s?.channel_present == null && s?.reachable === false);
  const endpointLabel = s?.endpoint_health
    ?? (s?.reachable === true ? 'healthy' : s?.reachable === false ? 'unreachable' : 'unknown');
  const deliveryLabel = s?.delivery_ready === true
    ? 'ready'
    : s?.delivery_reason
      ? `not ready · ${s.delivery_reason}`
      : s?.reachable === false ? 'not ready' : 'unknown';

  const metaRows = [
    ['name', s?.name || '—', false],
    ['harness', s?.harness || 'claudecode', true],
    ['cwd', s?.cwd || '—', true],
    ['pid', s?.pid != null ? String(s.pid) : '—', true],
    ['session_id', sessionId, true],
    ['continuation', s?.continuation_key || '—', true],
    ['provider', s?.provider || '—', true],
    ['model', s?.model || '—', true],
    ['project', s?.project_id || '—', true],
    ['started', s?.started_at ? window.SubstrateFmt.fmtTimeAgo(s.started_at) : '—', false],
    ['last seen', s?.last_seen_at || s?.updated_at ? window.SubstrateFmt.fmtTimeAgo(s.last_seen_at || s.updated_at) : 'unknown', false],
    ['process', s?.alive ? 'alive' : 'not alive', false],
    ['endpoint', endpointLabel, false],
    ['delivery', deliveryLabel, false],
    ['delivery mode', s?.delivery_mode || '—', true],
    ['turn state', s?.delivery_state || '—', true],
    ['compatibility', s?.compatibility ? `${s.compatibility.status} · Pi ${s.compatibility.pi_version || '?'} · Node ${s.compatibility.node_requirement}` : '—', false],
    ['extension', s?.extension_version || '—', true],
    ['trust', s?.trust || '—', true],
    ['transcript', peek?.transcript_path || (loaded ? 'not found' : '…'), true],
  ];

  return (
    <>
      <DrawerBackdrop open={open} onClose={onClose}/>
      <DrawerPanel open={open} onClose={onClose} label={`Agent details: ${title}`}>
        <div className="drawer-header nsd-header">
          <div className="drawer-title-row">
            <span className={`orch-dot ${dotClass}`} style={{ flexShrink: 0 }}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 className="drawer-title" title={s?.cwd || ''}>{title}</h2>
              <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className={`nsd-status status-${statusKind}`}>{statusLabel}</span>
                {s?.role && <span className="native-session-role-chip">{s.role}</span>}
                {pendingCount > 0 && <span className="native-session-queue-chip" title={`${pendingCount} queued dispatch${pendingCount === 1 ? '' : 'es'}`}>⏳ {pendingCount}</span>}
                {project
                  ? <><span>·</span><span style={{ color: project.color }}>{project.name}</span></>
                  : registered
                    ? <><span>·</span><span>{s?.project_id || ''}</span></>
                    : <><span>·</span><span style={{ color: 'var(--status-blocked)' }}>unregistered</span></>}
                {s?.alive && channelUnavailable && <><span>·</span><span className="nsd-nochannel">no channel</span></>}
              </div>
            </div>
            <button className="drawer-close" onClick={onClose}><Icon.Close/></button>
          </div>

          <div className="nsd-tab-bar">
            <button
              type="button"
              className={`nsd-tab-btn ${activeTab === 'console' ? 'active' : ''}`}
              onClick={() => setActiveTab('console')}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 6 7 9 4 12"/>
                <line x1="9" y1="12" x2="13" y2="12"/>
              </svg>
              <span>Live Console & Steer</span>
            </button>
            <button
              type="button"
              className={`nsd-tab-btn ${activeTab === 'activity' ? 'active' : ''}`}
              onClick={() => setActiveTab('activity')}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="4" x2="13" y2="4"/>
                <line x1="3" y1="8" x2="13" y2="8"/>
                <line x1="3" y1="12" x2="9" y2="12"/>
              </svg>
              <span>Activity & Events</span>
            </button>
          </div>
        </div>

        <div className={`drawer-body nsd-body ${activeTab === 'console' ? 'is-console-tab' : ''}`}>
          {activeTab === 'console' ? (
            <div className="nsd-console-wrap">
              <NsdTerminalView
                sessionId={sessionId}
                session={s}
                alive={alive}
                events={events}
                peek={peek}
              />
              <NsdSteerComposer
                sessionId={sessionId}
                session={s}
                alive={alive}
                onSent={() => window.Store.loadNativeSessionPeek(sessionId)}
              />
            </div>
          ) : (
            <div className="nsd-activity-wrap">
              <div className="nsd-meta-grid">
                {metaRows.map(([k, v, mono]) => (
                  <React.Fragment key={k}>
                    <div className="nsd-meta-key">{k}</div>
                    <div className={`nsd-meta-val ${mono ? 'mono' : ''}`} title={String(v)}>{v}</div>
                  </React.Fragment>
                ))}
              </div>

              {currentTicket && (
                <a
                  className="nsd-current-ticket mono"
                  href={window.Router.buildHref({ kind: 'ticket', id: currentTicket.id })}
                  onClick={(e) => { e.preventDefault(); window.Router.openTicket(currentTicket.id); }}
                  title={currentTicket.title}
                >
                  current: {currentTicket.display_id || currentTicket.id} · {currentTicket.title}
                </a>
              )}

              <div className="nsd-section-head">
                Recent activity
                <span className="nsd-section-count tnum">{events.length}</span>
              </div>
              {!loaded ? (
                <div className="empty">loading…</div>
              ) : events.length === 0 ? (
                <div className="empty">
                  {peek?.note || 'no central-journal activity for this session'}
                </div>
              ) : (
                <div className="nsd-events">
                  {events.map((e, i) => (
                    <div key={`${e.t}-${i}`} className="nsd-event">
                      <span className="nsd-event-time mono">{window.SubstrateFmt.fmtTimeAgo(e.t)}</span>
                      <span className={`nsd-event-type type-${e.event}`}>{e.event}</span>
                      <span className="nsd-event-summary" title={e.summary}>{e.summary}</span>
                    </div>
                  ))}
                </div>
              )}

              {milestones.length > 0 && (
                <>
                  <div className="nsd-section-head">
                    Milestones
                    <span className="nsd-section-count tnum">{milestones.length}</span>
                  </div>
                  <ul className="nsd-milestones">
                    {milestones.map((m, i) => (
                      <li key={`${m.t}-${i}`} className="nsd-milestone">
                        <span className="nsd-milestone-dot"/>
                        <span className="nsd-milestone-text">{m.text}</span>
                        <span className="nsd-milestone-ts mono">{window.SubstrateFmt.fmtTimeAgo(m.t)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {queue.length > 0 && (
                <>
                  <div className="nsd-section-head">
                    Dispatch queue
                    <span className="nsd-section-count tnum">{queue.length}</span>
                  </div>
                  <div className="nsd-queue">
                    {queue.map((r, i) => (
                      <NsdQueueRow key={r.id} row={r} position={i + 1}/>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </DrawerPanel>
    </>
  );
}

// TKT-0286: one row of the session's dispatch queue inside the peek drawer.
// Position (FIFO), ticket id + title (link), note (one-line truncated),
// queued-ago, Cancel. Cancel relies on the dispatch-queue-updated WS signal
// for refresh.
function NsdQueueRow({ row, position }) {
  const [err, setErr] = React.useState(null);
  const cancel = () => {
    setErr(null);
    window.SubstrateAPI.delJSON(`/api/dispatch-queue/${encodeURIComponent(row.id)}`)
      .catch((e) => setErr(String(e?.message || e)));
  };
  const t = Date.parse(row.created_at);
  const ago = Number.isFinite(t) ? (window.SubstrateFmt?.fmtTimeAgo?.(t) || '') : '';
  const note = row.note ? (row.note.length > 60 ? row.note.slice(0, 60) + '…' : row.note) : null;
  return (
    <div className="nsd-queue-row">
      <span className="nsd-queue-pos tnum">{position}</span>
      <a className="nsd-queue-ticket"
        href={window.Router.buildHref({ kind: 'ticket', id: row.ticket_id })}
        onClick={(e) => { e.preventDefault(); window.Router.openTicket(row.ticket_id); }}
        title={row.ticket_title || row.ticket_id}
      >
        <span className="mono">{row.ticket_id}</span>
        {row.ticket_title ? <span className="nsd-queue-title">{row.ticket_title}</span> : null}
      </a>
      {note && <span className="nsd-queue-note" title={row.note}>{note}</span>}
      <span className="nsd-queue-ago" title={row.created_at}>{ago}</span>
      <button className="orch-btn small ghost nsd-queue-cancel" onClick={cancel} title="Cancel this queued dispatch">Cancel</button>
      {err && <div className="nsd-queue-rowerr">{err}</div>}
    </div>
  );
}

window.NativeSessionDrawer = NativeSessionDrawer;
window.openNativeSessionDrawer = openNativeSessionDrawer;
