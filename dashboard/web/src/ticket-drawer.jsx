// Ticket detail drawer — slides in from the right when a tracker card fires
// `open-ticket-drawer` {id}. Shows the full ticket with an html-report-style
// HTML body + inline annotations, inline field controls, dispatch, links.
//
// Live-by-store: the store's trackerTickets entry (kept fresh by `ticket-updated`
// WS deltas) is the source of truth for every field. Comments are seeded after
// getTicket() and appended by `ticket-comment` / `ticket-comment-updated`. The
// annotation UI renders them as anchored highlights + a right rail.

const TD_STATES = ['todo', 'in_progress', 'blocked', 'review', 'done', 'archived'];
const TD_KINDS = ['work-item', 'decision', 'spec', 'question', 'fix'];
const TD_PRIORITIES = [
  { value: '', label: 'None' },
  { value: 'P0', label: 'P0' },
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
  { value: 'P3', label: 'P3' },
];

// Drawer width presets (percentage of viewport width). Persisted in
// localStorage so a refresh keeps the user's choice. Order is wide→narrow,
// matching the icon button group left-to-right.
const TD_WIDTHS = [
  { v: '90', icon: () => <Icon.DrawerWide/>, label: 'Wide (90%)' },
  { v: '50', icon: () => <Icon.DrawerHalf/>, label: 'Half (50%)' },
  { v: '30', icon: () => <Icon.DrawerNarrow/>, label: 'Narrow (30%)' },
];
const TD_WIDTH_KEY = 'td:width';
function tdLoadWidth() {
  try {
    const s = localStorage.getItem(TD_WIDTH_KEY);
    return TD_WIDTHS.some((w) => w.v === s) ? s : '90';
  } catch { return '90'; }
}

// State → .pill modifier (the pill color set is keyed off the same --status-*
// vars the board columns use). todo/archived have no dedicated pill class.
const TD_STATE_PILL = {
  todo: 'idle',
  in_progress: 'running',
  blocked: 'blocked',
  review: 'review',
  done: 'done',
  archived: 'done',
};


function TicketDrawer({ open, ticketId, onClose, variant = 'overlay' }) {
  useStore();
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState(null);

  // Dispatchable sessions for the open ticket's project (for assignee + dispatch).
  const [dispatchable, setDispatchable] = React.useState([]);
  const [streams, setStreams] = React.useState([]);

  // Edit buffer for title/body. null when not editing.
  const [editBuf, setEditBuf] = React.useState(null);
  const [saving, setSaving] = React.useState(false);

  // Drawer width preset (persisted) + field-controls collapse (collapsed by
  // default; the body/state/assignee/priority fields are rarely changed and
  // take vertical space that info/report tickets need for prose).
  const [widthPct, setWidthPct] = React.useState(tdLoadWidth);
  const [fieldsExpanded, setFieldsExpanded] = React.useState(false);
  const setWidth = (v) => {
    setWidthPct(v);
    try { localStorage.setItem(TD_WIDTH_KEY, v); } catch {}
  };

  // Dispatch control state.
  const [dispatchSession, setDispatchSession] = React.useState('');
  const [dispatchNote, setDispatchNote] = React.useState(null); // soft inline note text
  const [dispatching, setDispatching] = React.useState(false);

  // WS6: question return state. `returnSession` is the live session the answered
  // question is handed back to (defaults to the asker `created_by` when live).
  const [returnSession, setReturnSession] = React.useState('');
  const [returnNote, setReturnNote] = React.useState(null);
  const [returning, setReturning] = React.useState(false);

  // The live ticket from the store (kept fresh by ticket-updated deltas).
  const ticket = ticketId ? (window.Store.getState().trackerTickets.get(ticketId) ?? null) : null;
  const flatComments = ticketId ? window.Store.getTicketComments(ticketId) : [];
  // Group flat top-level comments + replies by parent_id. The schema stores
  // replies as separate rows (parent_id set), but the annotation rail renders
  // them nested under their parent card — so assemble the tree here.
  const comments = React.useMemo(() => {
    const tops = [];
    const repliesByParent = new Map();
    for (const c of flatComments) {
      if (c.parent_id) {
        const arr = repliesByParent.get(c.parent_id) ?? [];
        arr.push({ author: c.author, text: c.body, ts: c.created_at, id: c.id });
        repliesByParent.set(c.parent_id, arr);
      } else {
        tops.push(c);
      }
    }
    return tops.map((t) => ({
      ...t,
      replies: (repliesByParent.get(t.id) ?? []).slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts))),
    }));
  }, [flatComments]);
  const projects = window.Store.getProjects();
  const project = ticket
    ? (window.Store.getProjectByContractId(ticket.project_id) ?? null)
    : null;

  // Open state is URL-driven (App passes open + ticketId from ?ticket=<id>).
  // When the drawer opens (or switches tickets), fetch full detail + seed
  // comments into the store so field controls have fresh values.
  React.useEffect(() => {
    if (!open || !ticketId) return;
    setEditBuf(null);
    setDispatchSession('');
    setDispatchNote(null);
    setReturnSession('');
    setReturnNote(null);
    setLoadError(null);
    setLoading(true);
    let cancelled = false;
    window.SubstrateAPI.getTicket(ticketId)
      .then((full) => {
        if (cancelled) return;
        if (full && full.id) {
          window.Store.upsertTrackerTicket(full);
          window.Store.seedTicketComments(full.id, full.comments || []);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err?.message || 'Failed to load ticket');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, ticketId]);

  // Esc closes (→ App pops the ?ticket overlay via onClose).
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Fetch dispatchable sessions + streams for the ticket's project.
  const projectId = ticket?.project_id || null;
  React.useEffect(() => {
    if (!open || !projectId) { setDispatchable([]); setStreams([]); return; }
    let cancelled = false;
    window.SubstrateAPI.listDispatchable(projectId)
      .then((list) => { if (!cancelled) setDispatchable(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setDispatchable([]); });
    window.SubstrateAPI.listStreams(projectId)
      .then((list) => { if (!cancelled) setStreams(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setStreams([]); });
    return () => { cancelled = true; };
  }, [open, projectId]);

  const labelBySession = React.useMemo(() => {
    const m = new Map();
    for (const s of dispatchable) if (s.session_id) m.set(s.session_id, s.label);
    return m;
  }, [dispatchable]);

  // WS6: this ticket is a question FOR the user (question-kind, assignee=human,
  // not done/archived) — drives the "Answer & return" affordance.
  const isQuestion = ticket
    ? (window.isQuestionForHuman
      ? window.isQuestionForHuman(ticket)
      : (ticket.kind === 'question' && ticket.assignee === 'human'
        && ticket.state !== 'done' && ticket.state !== 'archived'))
    : false;

  // Default the "Return to" select to the asker (created_by) when that session
  // is live in this project; else leave it empty so the user picks one.
  React.useEffect(() => {
    if (!isQuestion) return;
    const asker = ticket?.created_by || null;
    if (asker && asker !== 'human' && labelBySession.has(asker)) {
      setReturnSession((cur) => cur || asker);
    }
  }, [isQuestion, ticket?.created_by, labelBySession]);

  const resolveActor = React.useCallback((a) => {
    if (a === 'human') return 'You';
    if (!a) return 'Unassigned';
    return labelBySession.get(a) || `session ${String(a).slice(0, 8)}`;
  }, [labelBySession]);

  // Commit a single field immediately (actor: human).
  const commitField = React.useCallback((patch) => {
    if (!ticketId) return;
    window.SubstrateAPI.updateTicket(ticketId, { ...patch, actor: 'human' })
      .then((updated) => {
        if (updated && updated.id) window.Store.upsertTrackerTicket(updated);
      })
      .catch((err) => console.error('updateTicket failed', err));
  }, [ticketId]);

  const onSaveEdit = React.useCallback(() => {
    if (!ticketId || !editBuf) return;
    setSaving(true);
    window.SubstrateAPI.updateTicket(ticketId, {
      title: editBuf.title.trim(),
      body: editBuf.body,
      actor: 'human',
    })
      .then((updated) => {
        if (updated && updated.id) window.Store.upsertTrackerTicket(updated);
        setEditBuf(null);
        setSaving(false);
      })
      .catch((err) => { console.error('save ticket failed', err); setSaving(false); });
  }, [ticketId, editBuf]);

  const onDispatch = React.useCallback(() => {
    if (!ticketId || !dispatchSession || dispatching) return;
    setDispatching(true);
    setDispatchNote(null);
    window.SubstrateAPI.dispatchTicket(ticketId, { session_id: dispatchSession })
      .then((res) => {
        if (res?.ticket?.id) window.Store.upsertTrackerTicket(res.ticket);
        if (res && res.channel && res.channel.ok === false) {
          setDispatchNote("assigned — no live channel, it'll be picked up when that session is reachable");
        } else {
          setDispatchNote(null);
        }
        setDispatching(false);
      })
      .catch((err) => {
        console.error('dispatch failed', err);
        setDispatchNote(err?.payload?.error || err?.message || 'Dispatch failed');
        setDispatching(false);
      });
  }, [ticketId, dispatchSession, dispatching]);

  // Add a plain or inline-anchored comment. `input` can be a string (legacy)
  // or an object with { body, quote?, prefix?, suffix?, section?, section_id?, tag? }.
  const onAddComment = React.useCallback((input) => {
    if (!ticketId) return Promise.resolve();
    const payload = typeof input === 'string' ? { author: 'human', body: input } : { author: 'human', ...input };
    return window.SubstrateAPI.addComment(ticketId, payload);
  }, [ticketId]);

  const onUpdateComment = React.useCallback((commentId, patch) => {
    if (!ticketId) return Promise.resolve();
    return window.SubstrateAPI.updateComment(ticketId, commentId, patch);
  }, [ticketId]);

  const onReplyComment = React.useCallback((parentId, reply) => {
    if (!ticketId) return Promise.resolve();
    return window.SubstrateAPI.replyComment(ticketId, parentId, { author: 'human', body: reply.text });
  }, [ticketId]);

  // WS6: return an answered question to a live session. The dispatch is durable
  // (assignment lands on disk) even if the channel is offline — the note tells
  // the session to re-read the latest comment.
  const RETURN_NOTE = 'Your question was answered — re-read the latest comment.';
  const doReturn = React.useCallback(() => {
    if (!ticketId || !returnSession) return Promise.resolve();
    return window.SubstrateAPI.dispatchTicket(ticketId, { session_id: returnSession, note: RETURN_NOTE })
      .then((res) => {
        if (res?.ticket?.id) window.Store.upsertTrackerTicket(res.ticket);
        if (res && res.channel && res.channel.ok === false) {
          setReturnNote("returned — no live channel, the session will re-read on resume");
        } else {
          setReturnNote('returned — the session was pinged to re-read the answer');
        }
        return res;
      });
  }, [ticketId, returnSession]);

  const onReturn = React.useCallback(() => {
    if (!ticketId || !returnSession || returning) return;
    setReturning(true);
    setReturnNote(null);
    doReturn()
      .catch((err) => {
        console.error('return failed', err);
        setReturnNote(err?.payload?.error || err?.message || 'Return failed');
      })
      .finally(() => setReturning(false));
  }, [ticketId, returnSession, returning, doReturn]);

  // Answer & return — post the composer's comment, THEN dispatch back in one go.
  const onAnswerAndReturn = React.useCallback((body) => {
    if (!ticketId) return Promise.resolve();
    return window.SubstrateAPI.addComment(ticketId, { author: 'human', body })
      .then(() => {
        if (returnSession) return doReturn();
        return null;
      });
  }, [ticketId, returnSession, doReturn]);

  const close = () => onClose && onClose();

  const statePill = ticket ? (TD_STATE_PILL[ticket.state] || 'idle') : 'idle';

  // variant='page' renders the same ticket content in a standalone page layout
  // (no fixed drawer shell / backdrop / width presets) so /tickets/<id> can be
  // a dedicated screen. The annotation pill portals to containerSelector.
  const isPage = variant === 'page';
  const containerSelector = isPage ? '.ticket-page' : '.drawer-ticket';
  const projectHref = project
    ? window.Router.buildHref({ kind: 'project', id: project.id, tab: 'agents' })
    : null;
  const Shell = isPage ? 'div' : 'aside';
  const shellClass = isPage
    ? 'ticket-page'
    : `drawer ${open ? 'open' : ''} drawer-ticket`;
  const shellStyle = isPage ? undefined : { width: `${widthPct}vw` };

  return (
    <>
      {isPage ? null : (
        <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={close}/>
      )}
      <Shell className={shellClass} style={shellStyle}>
        {!open && !isPage ? null : loading && !ticket ? (
          <div className="td-loading">
            <div className="drawer-header">
              <div className="drawer-title-row">
                <h2 className="drawer-title">Ticket</h2>
                {isPage ? null : <button className="drawer-close" onClick={close}><Icon.Close/></button>}
              </div>
            </div>
            <div className="td-loading-body">loading ticket…</div>
          </div>
        ) : loadError && !ticket ? (
          <>
            <div className="drawer-header">
              <div className="drawer-title-row">
                <h2 className="drawer-title">Ticket</h2>
                {isPage ? null : <button className="drawer-close" onClick={close}><Icon.Close/></button>}
              </div>
            </div>
            <div className="td-loading-body td-error">{loadError}</div>
          </>
        ) : !ticket ? null : (
          <>
            {/* ── Header ── */}
            <div className="drawer-header td-header">
              <div className="drawer-title-row">
                {isPage && projectHref && (
                  <a className="td-back-link" href={projectHref}
                    onClick={(e) => { e.preventDefault(); window.Router.go({ kind: 'project', id: project.id, tab: 'agents' }); }}
                    title={`Back to ${project?.name}`}>
                    ← {project?.name}
                  </a>
                )}
                <span className="td-id mono">{ticket.id}</span>
                <span className="pill td-kind-pill">{ticket.kind}</span>
                {project && (
                  <span className="cc-chip td-project-chip" title={project.name}>
                    <span className="cc-chip-dot" style={{ background: project.color }}/>
                    <span className="cc-chip-text">{project.glyph ? `${project.glyph} ` : ''}{project.name}</span>
                  </span>
                )}
                <span className={`pill ${statePill}`}>{ticket.state}</span>
                {isQuestion && <span className="pill td-answer-badge">❓ needs answer</span>}
                {isPage ? null : (
                  <div className="td-width-group" role="group" aria-label="Drawer width">
                    {TD_WIDTHS.map((w) => (
                      <button
                        key={w.v}
                        className={`td-width-btn ${widthPct === w.v ? 'active' : ''}`}
                        onClick={() => setWidth(w.v)}
                        title={w.label}
                        aria-pressed={widthPct === w.v}
                      >{w.icon()}</button>
                    ))}
                  </div>
                )}
                {isPage ? null : (
                  <a className="td-open-page" href={window.Router.buildHref({ kind: 'ticket', id: ticket.id })}
                    target="_blank" rel="noopener" title="Open as standalone page (new tab)">↗</a>
                )}
                {isPage ? null : <button className="drawer-close" onClick={close}><Icon.Close/></button>}
              </div>
              <div className="drawer-meta td-meta">
                <div className="drawer-meta-item" title={ticket.created_at || ''}>
                  <span className="drawer-meta-key">created</span>
                  <span className="drawer-meta-val">{tdAgo(ticket.created_at)}</span>
                </div>
                <div className="drawer-meta-item" title={ticket.updated_at || ''}>
                  <span className="drawer-meta-key">updated</span>
                  <span className="drawer-meta-val">{tdAgo(ticket.updated_at)}</span>
                </div>
              </div>
            </div>

            <div className="td-scroll">
              {/* ── Title + body (with Edit toggle) ── */}
              {editBuf ? (
                <div className="td-edit">
                  <input
                    className="td-edit-title"
                    type="text"
                    value={editBuf.title}
                    onChange={(e) => setEditBuf({ ...editBuf, title: e.target.value })}
                    placeholder="Title"
                  />
                  <textarea
                    className="td-edit-body orch-modal-textarea"
                    rows={8}
                    value={editBuf.body}
                    onChange={(e) => setEditBuf({ ...editBuf, body: e.target.value })}
                    placeholder="Body (Markdown) — plain text auto-wraps into paragraphs"
                  />
                  <div className="td-edit-actions">
                    <button className="orch-btn ghost" onClick={() => setEditBuf(null)} disabled={saving}>Cancel</button>
                    <button className="orch-btn primary" onClick={onSaveEdit} disabled={saving || !editBuf.title.trim()}>
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="td-titlebody">
                  <div className="td-title-row">
                    <h2 className="td-title">{ticket.title}</h2>
                    <button
                      className="orch-btn small ghost td-edit-btn"
                      onClick={() => setEditBuf({ title: ticket.title || '', body: ticket.body || '' })}
                    >
                      Edit
                    </button>
                  </div>
                </div>
              )}

              {/* ── Markdown body + inline annotations ── */}
              <div className="td-body-area">
                {ticket.body ? (
                  <TdAnnotate
                    body={ticket.body}
                    comments={comments}
                    currentAuthor="you"
                    onCreate={onAddComment}
                    onUpdate={onUpdateComment}
                    onReply={onReplyComment}
                    containerSelector={containerSelector}
                  />
                ) : (
                  <div className="td-body-empty">No description.</div>
                )}
              </div>

              {/* ── Compact action tray (TKT-0101) ── */}
              {/* One row of pills + slim dispatch + collapsed links by default.
                  Pills are styled selects (TD-CHIP), commit on change via
                  commitField. Inline label prefixes use the actual field name
                  ("State", "Assignee", …) so the row is readable at 30% width
                  without tooltips; labels shrink to just the colored chip on
                  wider drawers via a media query in extra.css. */}
              <div className={`td-action-tray ${fieldsExpanded ? 'open' : ''}`}>
                <div className="td-tray-row">
                  <label className="td-tray-chip" data-key="state">
                    <span className="td-tray-key">State</span>
                    <select className="td-chip" value={ticket.state}
                      onChange={(e) => commitField({ state: e.target.value })}
                      aria-label="State">
                      {TD_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>

                  <label className="td-tray-chip" data-key="assignee">
                    <span className="td-tray-key">Assignee</span>
                    <select className="td-chip" value={ticket.assignee || ''}
                      onChange={(e) => commitField({ assignee: e.target.value || null })}
                      aria-label="Assignee">
                      <option value="">Unassigned</option>
                      <option value="human">Human (You)</option>
                      {dispatchable.map((s) => (
                        <option key={s.session_id} value={s.session_id}>{s.label}</option>
                      ))}
                      {/* Keep an offline assignee selectable if it isn't in the live list. */}
                      {ticket.assignee && ticket.assignee !== 'human'
                        && !labelBySession.has(ticket.assignee) && (
                        <option value={ticket.assignee}>
                          session {String(ticket.assignee).slice(0, 8)} (offline)
                        </option>
                      )}
                    </select>
                  </label>

                  <label className="td-tray-chip" data-key="priority">
                    <span className="td-tray-key">Priority</span>
                    <select className="td-chip" value={ticket.priority || ''}
                      onChange={(e) => commitField({ priority: e.target.value || null })}
                      aria-label="Priority">
                      {TD_PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </label>

                  <label className="td-tray-chip" data-key="kind">
                    <span className="td-tray-key">Kind</span>
                    <select className="td-chip" value={ticket.kind}
                      onChange={(e) => commitField({ kind: e.target.value })}
                      aria-label="Kind">
                      {TD_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </label>

                  <label className="td-tray-chip" data-key="stream">
                    <span className="td-tray-key">Stream</span>
                    <select className="td-chip" value={ticket.stream_id || ''}
                      onChange={(e) => commitField({ stream_id: e.target.value || null })}
                      aria-label="Stream">
                      <option value="">None</option>
                      {streams.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </label>

                  {/* Dispatch — folded into the same row as the field chips
                      (wraps to the next line on narrow widths), separated by a
                      left rule so it stands out without claiming its own row. */}
                  <div className="td-tray-dispatch">
                    <label className="td-tray-chip">
                      <span className="td-tray-key">Dispatch</span>
                      <select className="td-chip" value={dispatchSession}
                        onChange={(e) => setDispatchSession(e.target.value)}
                        disabled={dispatching || dispatchable.length === 0}
                        aria-label="Dispatch to session">
                        <option value="">
                          {dispatchable.length === 0 ? 'No session' : 'Session…'}
                        </option>
                        {dispatchable.map((s) => (
                          <option key={s.session_id} value={s.session_id}>{s.label}</option>
                        ))}
                      </select>
                    </label>
                    <button className="orch-btn small td-dispatch-go"
                      onClick={onDispatch}
                      disabled={dispatching || !dispatchSession || dispatchable.length === 0}
                      title={dispatchable.length === 0 ? 'No live session in this project — start one with `cd <project> && claude`' : 'Dispatch to the selected session'}>
                      {dispatching ? '…' : 'Dispatch'}
                    </button>
                  </div>

                  <button
                    className="td-tray-more"
                    onClick={() => setFieldsExpanded((e) => !e)}
                    aria-expanded={fieldsExpanded}
                    title={fieldsExpanded ? 'Hide fields detail' : 'More field controls'}
                  >
                    <Icon.ChevronRight/>
                  </button>
                </div>

                {fieldsExpanded && (
                  <div className="td-tray-extra">
                    <div className="td-tray-extra-row">
                      <span className="td-tray-extra-key">Dispatched to</span>
                      <span className="mono">{resolveActor(ticket.dispatched_to) || '—'}</span>
                      {ticket.dispatched_at && <span className="td-tray-extra-meta">· {tdAgo(ticket.dispatched_at)}</span>}
                    </div>
                    <div className="td-tray-extra-row">
                      <span className="td-tray-extra-key">Created by</span>
                      <span>{ticket.created_by && ticket.created_by !== 'human' ? ticket.created_by.slice(0, 8) : 'You'}</span>
                      <span className="td-tray-extra-meta">· {tdAgo(ticket.created_at)}</span>
                    </div>
                  </div>
                )}

                {dispatchNote && <div className="td-dispatch-note">{dispatchNote}</div>}
              </div>
            </div>

            {isQuestion ? (
              <QuestionReturn
                onComment={onAddComment}
                onReturn={onReturn}
                onAnswerAndReturn={onAnswerAndReturn}
                returnSession={returnSession}
                setReturnSession={setReturnSession}
                dispatchable={dispatchable}
                returning={returning}
                note={returnNote}
                ticket={ticket}
                labelBySession={labelBySession}
              />
            ) : null}
          </>
        )}
      </Shell>
    </>
  );
}

function tdAgo(iso) {
  if (!iso) return '';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return window.SubstrateFmt?.fmtTimeAgo?.(t) || '';
}

function TdField({ label, children }) {
  return (
    <label className="td-field">
      <span className="td-field-label">{label}</span>
      {children}
    </label>
  );
}

// WS6: the "Answer & return" affordance for a question-kind ticket. Combines the
// comment composer (the answer) with a "Return to ▾" live-session select and two
// actions: "Return" (re-dispatch to ping the asker) and "Answer & return" (post
// the comment THEN dispatch in one go). The answer always posts even with no
// live session — only the return ping is gated on a reachable session.
function QuestionReturn({
  onComment, onReturn, onAnswerAndReturn, returnSession, setReturnSession,
  dispatchable, returning, note, ticket, labelBySession,
}) {
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const taRef = React.useRef(null);

  const hasSessions = dispatchable.length > 0;
  const trimmed = text.trim();

  // The asker (created_by) may be offline — surface it as a disabled note rather
  // than hiding it, so the user understands why the default isn't pre-selected.
  const asker = ticket?.created_by && ticket.created_by !== 'human' ? ticket.created_by : null;
  const askerOffline = asker && !labelBySession.has(asker);

  const postComment = React.useCallback(async () => {
    if (busy || !trimmed) return;
    setBusy(true);
    try {
      await onComment(trimmed);
      setText('');
      taRef.current?.focus();
    } catch (err) {
      console.error('answer comment failed', err);
    } finally {
      setBusy(false);
    }
  }, [busy, trimmed, onComment]);

  const answerAndReturn = React.useCallback(async () => {
    if (busy || !trimmed || !returnSession) return;
    setBusy(true);
    try {
      await onAnswerAndReturn(trimmed);
      setText('');
    } catch (err) {
      console.error('answer & return failed', err);
    } finally {
      setBusy(false);
    }
  }, [busy, trimmed, returnSession, onAnswerAndReturn]);

  const onKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); postComment(); }
  };

  const disabled = busy || returning;

  return (
    <div className="td-question-return">
      <div className="td-qr-title">❓ Answer &amp; return</div>
      <textarea
        ref={taRef}
        className="ceo-composer-input td-qr-input"
        rows={2}
        placeholder="Write your answer…  (⌘/Ctrl + Enter posts the answer)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        disabled={disabled}
      />
      <div className="td-qr-return-row">
        <label className="td-qr-return-label">Return to</label>
        <select
          className="td-select td-qr-select"
          value={returnSession}
          onChange={(e) => setReturnSession(e.target.value)}
          disabled={disabled || !hasSessions}
          title={hasSessions ? 'Pick a live session to hand the answer back to' : 'No live session in this project'}
        >
          <option value="">
            {hasSessions ? 'Select a live session…' : 'No live session in this project'}
          </option>
          {dispatchable.map((s) => (
            <option key={s.session_id} value={s.session_id}>
              {s.label}{s.session_id === asker ? ' (asker)' : ''}
            </option>
          ))}
        </select>
      </div>
      {askerOffline && (
        <div className="td-qr-hint">
          The asking session <span className="mono">{String(asker).slice(0, 8)}</span> is offline — your answer still
          posts; pick another live session to ping, or it'll be re-read on resume.
        </div>
      )}
      {!hasSessions && (
        <div className="td-qr-hint">
          No live session in this project — your answer posts regardless; the asker re-reads it on resume.
        </div>
      )}
      {note && <div className="td-qr-note">{note}</div>}
      <div className="td-qr-actions">
        <button
          className="orch-btn"
          onClick={postComment}
          disabled={disabled || !trimmed}
          title="Post the answer as a comment without returning"
        >
          {busy ? 'Posting…' : 'Post answer'}
        </button>
        <button
          className="orch-btn ghost"
          onClick={onReturn}
          disabled={disabled || !returnSession}
          title={returnSession ? 'Re-dispatch this question to the selected session' : 'Pick a live session first'}
        >
          {returning ? 'Returning…' : 'Return'}
        </button>
        <button
          className="orch-btn primary"
          onClick={answerAndReturn}
          disabled={disabled || !trimmed || !returnSession}
          title={!returnSession ? 'Pick a live session to return to' : 'Post the answer then return to the selected session'}
        >
          Answer &amp; return
        </button>
      </div>
    </div>
  );
}

window.TicketDrawer = TicketDrawer;
