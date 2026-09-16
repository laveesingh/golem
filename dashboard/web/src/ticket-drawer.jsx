// Ticket detail drawer — slides in from the right when a tracker card fires
// `open-ticket-drawer` {id}. Shows the full ticket with an html-report-style
// HTML body + inline annotations, inline field controls, dispatch, links.
//
// Live-by-store: the store's trackerTickets entry (kept fresh by `ticket-updated`
// WS deltas) is the source of truth for every field. Comments are seeded after
// getTicket() and appended by `ticket-comment` / `ticket-comment-updated`. The
// annotation UI renders them as anchored highlights + a right rail.

const TD_STATES = ['todo', 'in_progress', 'blocked', 'review', 'done', 'archived'];
const TD_KINDS = ['spec', 'task', 'doc'];
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
// TKT-0285: the 30% (Narrow) preset is gone — a sidebar is impossible at that
// width. Two presets now: 90 (Wide) + 50 (Half). tdLoadWidth coerces a stored
// '30' to '50' one-time so nobody lands on a broken width.
const TD_WIDTHS = [
  { v: '90', icon: () => <Icon.DrawerWide/>, label: 'Wide (90%)' },
  { v: '50', icon: () => <Icon.DrawerHalf/>, label: 'Half (50%)' },
];
const TD_WIDTH_KEY = 'td:width';
function tdLoadWidth() {
  try {
    let s = localStorage.getItem(TD_WIDTH_KEY);
    // TKT-0285: the 30% preset is gone — coerce a stored '30' to '50' and
    // persist it back so the migration is one-time (not a broken blank width).
    if (s === '30') { s = '50'; try { localStorage.setItem(TD_WIDTH_KEY, s); } catch {} }
    return TD_WIDTHS.some((w) => w.v === s) ? s : '90';
  } catch { return '90'; }
}

function collectImages(dt) {
  if (!dt) return [];
  const out = [];
  if (dt.items) {
    for (const it of dt.items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && /^image\//.test(f.type)) out.push(f);
      }
    }
  }
  if (dt.files) {
    for (const f of dt.files) {
      if (f && /^image\//.test(f.type) && !out.includes(f)) out.push(f);
    }
  }
  return out;
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


function TicketDrawer({ open, ticketId, onClose, variant = 'overlay', reader = false }) {
  useStore();
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState(null);

  // Dispatchable sessions for the open ticket's project (for assignee + dispatch).
  const [dispatchable, setDispatchable] = React.useState([]);
  const [dispatchableLoaded, setDispatchableLoaded] = React.useState(false);

  // Edit buffer for title/body. null when not editing.
  const [editBuf, setEditBuf] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  // TKT-0233: inline title edit (click the h2 to edit; Enter/blur commits, Esc reverts).
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState('');
  const titleInputRef = React.useRef(null);
  const tdScrollRef = React.useRef(null);
  const editTextareaRef = React.useRef(null);
  const editActionsRef = React.useRef(null);
  const specPreviewRef = React.useRef(null);

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
  // TKT-0245: 'now' | 'when_idle' — default follows the selected target's live
  // status (idle→Now, busy/waiting→When idle); the user can override via the
  // segmented toggle. `cancelling` gates the Cancel button on a pending row.
  const [dispatchMode, setDispatchMode] = React.useState('now');
  const [workspaceMode, setWorkspaceMode] = React.useState(false); // worktree toggle
  const [cancelling, setCancelling] = React.useState(false);

  const [revival, setRevival] = React.useState(null);
  const [revivalSession, setRevivalSession] = React.useState('');
  const [revivalNote, setRevivalNote] = React.useState(null);
  const [revivalBusy, setRevivalBusy] = React.useState(false);
  const [commentDispatchSession, setCommentDispatchSession] = React.useState('');
  const [commentDispatching, setCommentDispatching] = React.useState(false);
  const [commentDispatchNote, setCommentDispatchNote] = React.useState(null);

  // The live ticket from the store (kept fresh by ticket-updated deltas).
  // Routes are human-facing and commonly carry a display id such as GOL-12,
  // while the store is canonically keyed by the underlying tracker id
  // (TKT-0013). Resolve that display-id route after getTicket seeds the store;
  // otherwise a valid standalone spec page stays blank and its child-work
  // composer can never be reached.
  const trackerTickets = window.Store.getState().trackerTickets;
  const ticket = ticketId
    ? (trackerTickets.get(ticketId)
      ?? [...trackerTickets.values()].find((candidate) => candidate.display_id === ticketId)
      ?? null)
    : null;
  const flatComments = ticket
    ? window.Store.getTicketComments(ticket.id)
    : (ticketId ? window.Store.getTicketComments(ticketId) : []);
  // Group flat comment rows into top-level threads without changing storage.
  // Reply-to-reply rows resolve to the same root so the rail can enforce one
  // visible reply layer while retaining each row's own id and lifecycle.
  const comments = React.useMemo(() => {
    const byId = new Map(flatComments.map((comment) => [comment.id, comment]));
    const tops = [];
    const repliesByRoot = new Map();
    const sortByCreated = (a, b) => {
      const left = String(a.created_at || a.ts || '');
      const right = String(b.created_at || b.ts || '');
      return left.localeCompare(right);
    };
    const isDraft = (comment) => comment.dispatch_state === 'undispatched'
      || (!comment.dispatch_state && (comment.author === 'human' || comment.author === 'you'));
    const sortForRail = (a, b) => (Number(isDraft(a)) - Number(isDraft(b))) || sortByCreated(a, b);

    const rootFor = (comment) => {
      let current = comment;
      const seen = new Set();
      while (current?.parent_id && byId.has(current.parent_id) && !seen.has(current.id)) {
        seen.add(current.id);
        current = byId.get(current.parent_id);
      }
      return current && !current.parent_id ? current : null;
    };

    for (const comment of flatComments) {
      if (comment.parent_id && comment.status === 'deleted') continue;
      if (!comment.parent_id) {
        tops.push(comment);
        continue;
      }
      const root = rootFor(comment);
      if (!root) {
        // Preserve a reply whose parent was deleted or is not in the payload;
        // it remains visible as an orphan top-level message.
        tops.push({ ...comment, parent_id: null });
        continue;
      }
      const replies = repliesByRoot.get(root.id) ?? [];
      replies.push(comment);
      repliesByRoot.set(root.id, replies);
    }

    return tops.sort(sortForRail).map((top) => ({
      ...top,
      replies: (repliesByRoot.get(top.id) ?? []).slice().sort(sortByCreated),
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
    setRevival(null);
    setRevivalSession('');
    setRevivalNote(null);
    setCommentDispatchSession('');
    setCommentDispatchNote(null);
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

  // Fetch dispatchable sessions for the ticket's project.
  const projectId = ticket?.project_id || null;
  React.useEffect(() => {
    if (!open || !projectId) { setDispatchable([]); setDispatchableLoaded(false); return; }
    let cancelled = false;
    setDispatchableLoaded(false);
    window.SubstrateAPI.listDispatchable(projectId)
      .then((list) => { if (!cancelled) { setDispatchable(Array.isArray(list) ? list : []); setDispatchableLoaded(true); } })
      .catch(() => { if (!cancelled) setDispatchable([]); });
    return () => { cancelled = true; };
  }, [open, projectId]);

  const labelBySession = React.useMemo(() => {
    const m = new Map();
    for (const s of dispatchable) if (s.session_id) m.set(s.session_id, s.label);
    return m;
  }, [dispatchable]);

  // GOL-101: only offer a live session as the implicit target. A spec assigned
  // to a session that has since died used to enable the dispatch button with no
  // picker at all, so the brief went to a dead channel and the failure was
  // invisible. An assignee that is not currently dispatchable falls through to
  // the picker instead.
  // Until the dispatchable list has actually loaded, "not in the list" means
  // unknown, not dead — treating it as dead flashes the picker and a misleading
  // "no live session" hint on every open, and sticks that way if the fetch errors.
  const assigneeIsLive = React.useMemo(() => {
    const assignee = ticket?.assignee;
    if (!assignee || assignee === 'human') return false;
    if (!dispatchableLoaded) return true;
    return dispatchable.some((s) => s.session_id === assignee);
  }, [ticket?.assignee, dispatchable, dispatchableLoaded]);
  // GOL-353: a live assignee is the ONLY implicit comment recipient. When the
  // assignee is offline, human, or unset, no fallback target is selected —
  // the human reassigns the ticket or picks an explicit live recipient in the
  // draft-queue picker (never an arbitrary first live session).
  const defaultCommentDispatchSession = assigneeIsLive ? ticket.assignee : '';
  const selectedCommentDispatchSession = commentDispatchSession || defaultCommentDispatchSession;
  // Offline/human/unassigned assignee, named for the recovery message: never
  // hide the routing problem behind a generic Dispatch button.
  const offlineAssigneeLabel = assigneeIsLive
    ? null
    : (!ticket?.assignee ? 'no assignee' : (ticket.assignee === 'human' ? 'you (human)' : `@${ticket.assignee} (offline)`));
  const undispatchedComments = React.useMemo(
    // Only open comments are dispatchable — resolved conversations and
    // soft-deleted (status='deleted') comments must not keep the bulk
    // button alive. Mirrors the server's listUndispatchedForTicket filter.
    () => flatComments.filter((c) => c.dispatch_state === 'undispatched' && c.status === 'open'),
    [flatComments]
  );
  const undispatchedCount = undispatchedComments.length;
  // The live assignee is the only comment-dispatch target now that the bulk
  // panel moved to the comments drawer header (which shows only when the
  // assignee is live). Label it for the header button.
  const dispatchTargetLabel = selectedCommentDispatchSession
    ? (labelBySession.get(selectedCommentDispatchSession) || null)
    : null;

  React.useEffect(() => {
    if (defaultCommentDispatchSession) setCommentDispatchSession('');
  }, [defaultCommentDispatchSession]);

  // TKT-0245: decorate dispatch picker options with live status dots + hints.
  // Join the dispatchable list with the store's nativeSessions (updated every
  // 3s via WS) by session_id so the dots re-render live; pending_count comes
  // from the dispatchable REST response.
  const nativeSessionsNow = window.Store.getState().nativeSessions;
  const dispatchOptions = React.useMemo(() => {
    const liveStatus = new Map();
    for (const s of nativeSessionsNow) {
      if (s.session_id) liveStatus.set(s.session_id, s.status ?? null);
    }
    return dispatchable.map((s) => {
      const status = liveStatus.get(s.session_id) ?? s.status ?? null;
      const deliveryReady = s.delivery_ready ?? s.reachable !== false;
      const deliveryReason = s.delivery_reason ?? null;
      // A healthy managed Codex target may be busy/waiting with its direct
      // typed delivery gate closed. Keep its live status visible and make the
      // safe when-idle queue explicit; only actual channel loss is unreachable.
      if (!deliveryReady && (deliveryReason === 'busy' || deliveryReason === 'waiting')) {
        const hintStatus = deliveryReason === 'busy' ? 'working' : 'waiting';
        const dot = deliveryReason === 'busy' ? 'var(--status-running)' : 'var(--status-review)';
        let hint = `${hintStatus} · will queue`;
        if (s.pending_count > 0) hint += ` · ${s.pending_count} queued`;
        return { value: s.session_id, label: s.label, dot, hint };
      }
      if (!deliveryReady) {
        let hint = 'unreachable · will queue';
        if (s.pending_count > 0) hint += ` · ${s.pending_count} queued`;
        // TKT-0369 consult cns-9082c5 V1: --text-2 (not --text-3) so the dot
        // doesn't blend with the hint text (also --text-3) — the dot is the only
        // color carrier for status, so it needs to pop while staying "neutral".
        return { value: s.session_id, label: s.label, dot: 'var(--text-2)', hint };
      }
      const dot = status === 'idle' ? 'var(--status-active)'
        : status === 'busy' ? 'var(--status-running)'
        : status === 'waiting' ? 'var(--status-review)'
        : 'var(--text-3)';
      let hint = status === 'idle' ? 'idle'
        : status === 'busy' ? 'working'
        : status === 'waiting' ? 'waiting'
        : '—';
      if (s.pending_count > 0) hint += ` · ${s.pending_count} queued`;
      return { value: s.session_id, label: s.label, dot, hint };
    });
  }, [dispatchable, nativeSessionsNow]);

  // TKT-0245: pending dispatch (embedded in ticket detail by the server). When
  // set, the dispatch row is replaced by a status line + Cancel button. The
  // store refreshes the ticket on every ticket-updated WS, so this is live.
  const pendingDispatch = ticket?.pending_dispatch ?? null;
  const pendingTargetOffline = (() => {
    if (!pendingDispatch) return false;
    const s = window.Store.getNativeSessionById?.(pendingDispatch.session_id);
    return !s || !s.alive;
  })();
  // A live target without a healthy integration is held pending until that
  // integration returns. Busy/waiting delivery holds are normal queue state.
  const pendingTargetUnreachable = (() => {
    if (!pendingDispatch || pendingTargetOffline) return false;
    const d = dispatchable.find((s) => s.session_id === pendingDispatch.session_id);
    return !!d && (d.channel_present === false
      || (d.channel_present === true && ['unreachable', 'unverified', 'unhealthy'].includes(d.endpoint_health))
      || (d.channel_present == null && d.reachable === false));
  })();
  const pendingLabel = pendingDispatch
    ? (labelBySession.get(pendingDispatch.session_id)
      || window.Store.getNativeSessionById?.(pendingDispatch.session_id)?.name
      || `session ${String(pendingDispatch.session_id).slice(0, 8)}`)
    : null;

  React.useEffect(() => {
    if (!ticketId || ticket?.kind !== 'spec' || !pendingDispatch) { setRevival(null); return; }
    let cancelled = false;
    window.SubstrateAPI.revivalInfo(ticketId)
      .then((info) => { if (!cancelled) setRevival(info?.eligible ? info : null); })
      .catch(() => { if (!cancelled) setRevival(null); });
    return () => { cancelled = true; };
  }, [ticketId, ticket?.kind, pendingDispatch?.id]);

  const resolveActor = React.useCallback((a, persistedLabel) => {
    if (a === 'human' || a === 'you' || a === 'human:dashboard') return 'Lavee';
    if (!a) return 'Unassigned';
    // TKT-0266: prefer the durable persisted label (from session_labels) so
    // the meta strip still shows the friendly name after the session goes
    // offline. Falls back to the live resolver, then the uuid stub.
    return persistedLabel || labelBySession.get(a) || window.Store?.getNativeSessionById?.(a)?.name || window.Store?.getNativeSessionById?.(a)?.label || `session ${String(a).slice(0, 8)}`;
  }, [labelBySession]);

  const [fieldToast, setFieldToast] = React.useState(null);
  // Commit a single field immediately (actor: human).
  const commitField = React.useCallback((patch) => {
    if (!ticketId) return;
    window.SubstrateAPI.updateTicket(ticketId, { ...patch, actor: 'human' })
      .then((updated) => {
        if (updated && updated.id) window.Store.upsertTrackerTicket(updated);
      })
      .catch((err) => {
        console.error('updateTicket failed', err);
        setFieldToast({ msg: `Update failed: ${err?.payload?.error || err?.message || err}`, id: Math.random() });
        setTimeout(() => setFieldToast(null), 4000);
      });
  }, [ticketId]);

  // TKT-0233: body-only edit. editBuf is now { body } (title is edited inline).
  const [editBodyUploads, setEditBodyUploads] = React.useState([]);
  const uploadEditBodyOne = React.useCallback(async (file) => {
    const id = `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    setEditBodyUploads((u) => [...u, { id, name: file.name || 'image.png', status: 'uploading' }]);
    try {
      const res = await window.SubstrateAPI.uploadAsset(file);
      setEditBodyUploads((u) => u.map((x) => x.id === id ? { ...x, status: 'done', url: res.url } : x));
      return { id, md: `![](${res.url})`, url: res.url, name: file.name || 'image.png' };
    } catch (err) {
      setEditBodyUploads((u) => u.map((x) => x.id === id ? { ...x, status: 'error', error: String(err?.message || err) } : x));
      throw err;
    }
  }, []);

  const onEditBodyPaste = React.useCallback(async (e) => {
    const files = collectImages(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    const textarea = editTextareaRef.current;
    const cur = editBuf?.body ?? '';
    const before = textarea?.selectionStart ?? cur.length;
    const after = textarea?.selectionEnd ?? cur.length;
    const format = ticket?.body_format || 'markdown';
    for (const f of files) {
      try {
        const { md, url, name } = await uploadEditBodyOne(f);
        // GOL-326: Markdown bodies take Markdown image syntax; HTML bodies
        // take a safe <figure><img> so the block pipeline normalizes it.
        const insert = window.SubstrateFmt.imageMarkupFor(format, url, name);
        const next = cur.slice(0, before) + insert + cur.slice(after);
        setEditBuf({ ...editBuf, body: next });
        requestAnimationFrame(() => {
          if (textarea) {
            const pos = before + insert.length;
            textarea.setSelectionRange(pos, pos);
            textarea.focus();
          }
        });
        break;
      } catch (err) { /* error surfaced in uploads strip */ }
    }
  }, [editBuf, uploadEditBodyOne, ticket]);

  const onEditBodyDrop = React.useCallback(async (e) => {
    const files = collectImages(e.dataTransfer);
    if (files.length === 0) return;
    e.preventDefault();
    const format = ticket?.body_format || 'markdown';
    for (const f of files) {
      try {
        const { url, name } = await uploadEditBodyOne(f);
        const insert = window.SubstrateFmt.imageMarkupFor(format, url, name);
        setEditBuf((buf) => buf ? { ...buf, body: (buf.body || '') + (buf.body?.endsWith('\n') ? '' : '\n') + insert } : buf);
      } catch (err) { /* surfaced in uploads strip */ }
    }
  }, [uploadEditBodyOne, ticket]);

  const isEditBodyUploading = editBodyUploads.some((u) => u.status === 'uploading');

  // GOL-326: the full-source editor labels the stored format and sends the
  // optimistic revision for HTML bodies. A 409 keeps the draft intact and
  // surfaces the current revision so the human can retry deliberately —
  // never an automatic overwrite. The returned current revision is held
  // LOCALLY (editExpectedRevision) and used for the retry: the draft and the
  // stale store ticket never need a refresh for the human to recover (GOL-350).
  const [editError, setEditError] = React.useState(null);
  const [editExpectedRevision, setEditExpectedRevision] = React.useState(null);

  const onSaveEdit = React.useCallback(() => {
    if (!ticketId || !editBuf || isEditBodyUploading) return;
    setSaving(true);
    setEditError(null);
    const html = (ticket?.body_format ?? 'markdown') === 'html';
    const expected = html ? (editExpectedRevision ?? ticket.body_revision) : null;
    const patch = { body: editBuf.body, actor: 'human', ...(expected != null ? { expected_revision: expected } : {}) };
    window.SubstrateAPI.updateTicket(ticketId, patch)
      .then((updated) => {
        if (updated && updated.id) window.Store.upsertTrackerTicket(updated);
        setEditExpectedRevision(null);
        setEditBuf(null);
        setEditBodyUploads([]);
        setSaving(false);
      })
      .catch((err) => {
        console.error('save ticket failed', err);
        setSaving(false);
        if (err?.payload?.code === 'revision_conflict') {
          // Draft preserved: keep editBuf exactly as the human left it, and
          // carry the server's current revision for the explicit retry.
          setEditExpectedRevision(err.payload.current_revision ?? null);
          setEditError(`Revision conflict — the document moved to revision ${err.payload.current_revision}. Your draft is preserved; review and save again.`);
        } else {
          setEditError(err?.payload?.error || err?.message || 'Save failed');
        }
      });
  }, [ticketId, editBuf, isEditBodyUploading, ticket, editExpectedRevision]);

  // ── GOL-326: block-scoped raw HTML editor ─────────────────────────────────
  // Entered from the comment composer's attachment pill (Edit block). Loads
  // one block, previews it sanitized, and saves through the same
  // POST /block-patches endpoint the CLI uses. A 409 keeps the draft and
  // adopts the returned current revision for an explicit re-save.
  const [blockEdit, setBlockEdit] = React.useState(null); // { blockId, html, revision, busy, error }
  const blockPreviewRef = React.useRef(null);
  const openBlockEditor = React.useCallback(async (blockId) => {
    setBlockEdit({ blockId, html: '', revision: null, busy: true, error: null });
    try {
      const block = await window.SubstrateAPI.getTicketBlock(ticketId, blockId);
      setBlockEdit({ blockId, html: block.html || '', revision: block.body_revision, busy: false, error: null });
    } catch (err) {
      setBlockEdit(null);
      setFieldToast({ msg: `Cannot load block: ${err?.payload?.error || err?.message || err}`, id: Math.random() });
      setTimeout(() => setFieldToast(null), 4000);
    }
  }, [ticketId]);
  const onBlockEditSave = React.useCallback(() => {
    if (!blockEdit || blockEdit.busy) return;
    setBlockEdit((cur) => ({ ...cur, busy: true, error: null }));
    window.SubstrateAPI.patchTicketBlocks(ticketId, {
      expected_revision: blockEdit.revision,
      operations: [{ op: 'replace', block_id: blockEdit.blockId, html: blockEdit.html }],
      actor: 'human',
    })
      .then((result) => {
        setBlockEdit(null);
        if (result?.ticket_id) {
          // The WS delta will refresh the store; also pull the outline-bearing
          // update so the persisted ids render immediately.
          window.SubstrateAPI.getTicket(ticketId).then((t) => { if (t && t.id) window.Store.upsertTrackerTicket(t); }).catch(() => {});
        }
      })
      .catch((err) => {
        if (err?.payload?.code === 'revision_conflict') {
          // Draft preserved; adopt the returned current revision for an
          // explicit retry. Never an automatic overwrite.
          setBlockEdit((cur) => ({ ...cur, busy: false,
            revision: err.payload.current_revision ?? cur.revision,
            error: `Revision conflict — document is now at revision ${err.payload.current_revision}. Your draft is preserved; save again to apply it to the current revision.` }));
        } else {
          setBlockEdit((cur) => ({ ...cur, busy: false, error: err?.payload?.error || err?.message || 'Save failed' }));
        }
      });
  }, [ticketId, blockEdit]);

  // Editing has a fixed bottom action bar outside .td-scroll. Measure only the
  // direct layout landmarks (not every nested field) so the editor follows the
  // actual viewport. Specs reserve a compact Work Items preview below the editor.
  React.useLayoutEffect(() => {
    if (!editBuf) return undefined;
    const textarea = editTextareaRef.current;
    const scroller = tdScrollRef.current;
    if (!textarea || !scroller) return undefined;

    const updateHeight = () => {
      const textareaTop = textarea.getBoundingClientRect().top;
      const scrollerBottom = scroller.getBoundingClientRect().bottom;
      const actionTop = editActionsRef.current?.getBoundingClientRect().top;
      const visibleBottom = Math.min(scrollerBottom, actionTop ?? scrollerBottom);
      const bodyArea = textarea.closest('.td-body-area');
      const bodyStyle = bodyArea ? window.getComputedStyle(bodyArea) : null;
      const bodyBorders = bodyStyle
        ? (parseFloat(bodyStyle.borderTopWidth) || 0) + (parseFloat(bodyStyle.borderBottomWidth) || 0)
        : 0;
      const previewHeader = specPreviewRef.current?.querySelector('.td-children-header');
      const previewHeight = ticket?.kind === 'spec'
        ? Math.max(64, Math.ceil(previewHeader?.getBoundingClientRect().height || 0) + 36)
        : 0;
      const height = Math.max(120, Math.floor(visibleBottom - textareaTop - bodyBorders - previewHeight));
      if (textarea.style.height !== `${height}px`) textarea.style.height = `${height}px`;
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    [scroller, editActionsRef.current, specPreviewRef.current]
      .filter(Boolean)
      .forEach((node) => observer.observe(node));
    window.addEventListener('resize', updateHeight);
    window.visualViewport?.addEventListener('resize', updateHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateHeight);
      window.visualViewport?.removeEventListener('resize', updateHeight);
    };
  }, [!!editBuf, widthPct, variant, ticket?.kind]);

  // TKT-0233: inline title edit — click the h2 to edit, Enter/blur commits, Esc reverts.
  const startTitleEdit = React.useCallback(() => {
    setTitleDraft(ticket?.title || '');
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.focus(), 0);
  }, [ticket]);
  const commitTitle = React.useCallback(() => {
    const t = (titleDraft || '').trim();
    setEditingTitle(false);
    if (t && ticket && t !== ticket.title) commitField({ title: t });
  }, [titleDraft, ticket, commitField]);

  const onDispatch = React.useCallback(() => {
    if (!ticketId || !dispatchSession || dispatching) return;
    setDispatching(true);
    setDispatchNote(null);
    window.SubstrateAPI.dispatchTicket(ticketId, { session_id: dispatchSession, mode: dispatchMode, workspace: workspaceMode ? 'worktree' : undefined })
      .then((res) => {
        if (res?.ticket?.id) window.Store.upsertTrackerTicket(res.ticket);
        // Re-fetch dispatchable so pending_count hints refresh in the picker.
        if (projectId) {
          window.SubstrateAPI.listDispatchable(projectId)
            .then((list) => setDispatchable(Array.isArray(list) ? list : []))
            .catch(() => {});
        }
        if (res?.queued) {
          setDispatchNote(null); // the pending row renders in place of the dispatch row
        } else if (res && res.channel && res.channel.ok === false) {
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
  }, [ticketId, dispatchSession, dispatching, dispatchMode, projectId]);

  // TKT-0245: cancel a queued dispatch. The server broadcasts a ticket-updated
  // (pending_dispatch gone) so the store refreshes the ticket and the drawer
  // re-renders back to the dispatch row.
  const onCancelDispatch = React.useCallback(() => {
    const pending = ticket?.pending_dispatch;
    if (!pending || cancelling) return;
    setCancelling(true);
    window.SubstrateAPI.cancelDispatchQueue(pending.id)
      .then(() => {
        if (projectId) {
          window.SubstrateAPI.listDispatchable(projectId)
            .then((list) => setDispatchable(Array.isArray(list) ? list : []))
            .catch(() => {});
        }
        setCancelling(false);
      })
      .catch((err) => {
        console.error('cancel dispatch failed', err);
        setCancelling(false);
      });
  }, [ticket, cancelling, projectId]);

  const onCopyRevive = React.useCallback(() => {
    if (!revival?.revive_command) return;
    navigator.clipboard?.writeText(revival.revive_command).then(
      () => setRevivalNote('revive command copied'),
      () => setRevivalNote(revival.revive_command),
    );
  }, [revival]);

  const onRevivalRedispatch = React.useCallback(() => {
    if (!ticketId || !revivalSession || revivalBusy) return;
    setRevivalBusy(true);
    setRevivalNote(null);
    window.SubstrateAPI.redispatchRevival(ticketId, {
      session_id: revivalSession,
      note: 'Revival re-dispatch from dead-session warning.',
    })
      .then((res) => {
        if (res?.ticket?.id) window.Store.upsertTrackerTicket(res.ticket);
        setRevival(null);
        setRevivalNote(res?.channel?.ok === false ? 'reassigned; channel push failed' : 're-dispatched');
      })
      .catch((err) => setRevivalNote(err?.payload?.error || err?.message || 'Re-dispatch failed'))
      .finally(() => setRevivalBusy(false));
  }, [ticketId, revivalSession, revivalBusy]);

  // Add a plain or inline-anchored comment. `input` can be a string (legacy)
  // or an object with { body, quote?, prefix?, suffix?, section?, section_id?, tag? }.
  const onAddComment = React.useCallback((input) => {
    if (!ticketId) return Promise.resolve();
    const payload = typeof input === 'string' ? { author: 'human', body: input } : { author: 'human', ...input };
    return window.SubstrateAPI.addComment(ticketId, payload);
  }, [ticketId]);

  // GOL-101: this used to be fire-and-forget from the composer — the promise was
  // never awaited and never caught, so a failed dispatch (or a throw on a
  // missing target) closed the composer, left the optimistic comment in the
  // rail, and looked exactly like success. Failures now land in the same note
  // the batch button writes to, and the caller gets a rejected promise.
  const onAddCommentAndDispatch = React.useCallback(async (input) => {
    if (!ticketId) return null;
    const target = selectedCommentDispatchSession;
    setCommentDispatchNote(null);
    if (!target) {
      setCommentDispatchNote('Pick a session before dispatching comments');
      throw new Error('Pick a session before dispatching comments');
    }
    let comment;
    try {
      comment = await onAddComment(input);
    } catch (err) {
      setCommentDispatchNote(err?.payload?.error || err?.message || 'Saving the comment failed');
      throw err;
    }
    if (!comment?.id) {
      setCommentDispatchNote('Comment saved but not dispatched — the server returned no comment id');
      return comment;
    }
    try {
      const res = await window.SubstrateAPI.dispatchComment(comment.id, { session_id: target });
      if (res?.ticket?.id) window.Store.upsertTrackerTicket(res.ticket);
      if (res?.ticket?.comments) window.Store.seedTicketComments(res.ticket.id, res.ticket.comments);
      setCommentDispatchNote(`dispatched to ${labelBySession.get(target) || target}`);
      return res;
    } catch (err) {
      // The comment itself is saved; only delivery failed, and the server has
      // rolled the dispatch back so it is still queued as undispatched. Flag
      // that so the rail keeps the card it optimistically rendered.
      if (err && typeof err === 'object') err.golemCommentSaved = true;
      setCommentDispatchNote(err?.payload?.error || err?.message || 'Dispatch failed — the comment is still undispatched');
      throw err;
    }
  }, [ticketId, onAddComment, selectedCommentDispatchSession, labelBySession]);

  const onBatchDispatchComments = React.useCallback(async () => {
    if (!ticketId || commentDispatching) return;
    const target = selectedCommentDispatchSession;
    if (!target) { setCommentDispatchNote('Pick a session before batch-dispatching comments'); return; }
    setCommentDispatching(true);
    setCommentDispatchNote(null);
    try {
      const res = await window.SubstrateAPI.batchDispatchComments(ticketId, { session_id: target });
      if (res?.ticket?.id) window.Store.upsertTrackerTicket(res.ticket);
      if (res?.ticket?.comments) window.Store.seedTicketComments(res.ticket.id, res.ticket.comments);
      const n = Array.isArray(res?.dispatches) ? res.dispatches.length : 0;
      // GOL-101: `dispatches` only counts what was enqueued. Delivery is what
      // the human cares about, and the old note claimed success even when the
      // channel push had failed.
      setCommentDispatchNote(n
        ? `batch dispatched ${n} comment${n === 1 ? '' : 's'} to ${labelBySession.get(target) || target}`
        : 'no undispatched comments');
    } catch (err) {
      console.error('batch comment dispatch failed', err);
      setCommentDispatchNote(err?.payload?.error || err?.message || 'Batch dispatch failed');
    } finally {
      setCommentDispatching(false);
    }
  }, [ticketId, commentDispatching, selectedCommentDispatchSession, labelBySession]);

  // Dispatch a single existing comment (per-comment Dispatch button on the
  // comment card, both in the read view and the edit composer). The comment
  // stays undispatched on failure so it can be retried.
  const onDispatchComment = React.useCallback(async (commentId) => {
    if (!ticketId || !commentId) return;
    const target = selectedCommentDispatchSession;
    setCommentDispatchNote(null);
    if (!target) {
      setCommentDispatchNote('Pick a session before dispatching comments');
      return;
    }
    try {
      const res = await window.SubstrateAPI.dispatchComment(commentId, { session_id: target });
      if (res?.ticket?.id) window.Store.upsertTrackerTicket(res.ticket);
      if (res?.ticket?.comments) window.Store.seedTicketComments(res.ticket.id, res.ticket.comments);
      setCommentDispatchNote(`dispatched to ${labelBySession.get(target) || target}`);
    } catch (err) {
      setCommentDispatchNote(err?.payload?.error || err?.message || 'Dispatch failed — the comment is still undispatched');
    }
  }, [ticketId, selectedCommentDispatchSession, labelBySession]);

  const onUpdateComment = React.useCallback((commentId, patch) => {
    if (!ticketId) return Promise.resolve();
    return window.SubstrateAPI.updateComment(ticketId, commentId, patch);
  }, [ticketId]);

  const onReplyComment = React.useCallback((parentId, reply) => {
    if (!ticketId) return Promise.resolve();
    return window.SubstrateAPI.replyComment(ticketId, parentId, { author: 'human', body: reply.text });
  }, [ticketId]);

  const onReplyCommentAndDispatch = React.useCallback(async (parentId, reply) => {
    if (!ticketId) return null;
    const target = selectedCommentDispatchSession;
    setCommentDispatchNote(null);
    if (!target) {
      setCommentDispatchNote('Pick a session before dispatching comments');
      throw new Error('Pick a session before dispatching comments');
    }
    let comment;
    try {
      comment = await onReplyComment(parentId, reply);
    } catch (err) {
      setCommentDispatchNote(err?.payload?.error || err?.message || 'Saving the reply failed');
      throw err;
    }
    if (!comment?.id) {
      setCommentDispatchNote('Reply saved but not dispatched — the server returned no comment id');
      return comment;
    }
    try {
      const res = await window.SubstrateAPI.dispatchComment(comment.id, { session_id: target });
      if (res?.ticket?.id) window.Store.upsertTrackerTicket(res.ticket);
      if (res?.ticket?.comments) window.Store.seedTicketComments(res.ticket.id, res.ticket.comments);
      setCommentDispatchNote(`dispatched to ${labelBySession.get(target) || target}`);
      return res;
    } catch (err) {
      if (err && typeof err === 'object') err.golemCommentSaved = true;
      setCommentDispatchNote(err?.payload?.error || err?.message || 'Reply dispatch failed — the reply is still undispatched');
      throw err;
    }
  }, [ticketId, onReplyComment, selectedCommentDispatchSession, labelBySession]);

  // GOL-150: state is the only lifecycle, so the history strip reads
  // state_change events alone (older rows may still carry phase_change).
  const stateEvents = React.useMemo(() => {
    const rows = Array.isArray(ticket?.events) ? ticket.events : [];
    return rows.filter((e) => e.type === 'state_change').slice(-8).reverse();
  }, [ticket?.events]);

  const close = () => onClose && onClose();

  const statePill = ticket ? (TD_STATE_PILL[ticket.state] || 'idle') : 'idle';
  // Snapshot rows are body-less (server slims /api/snapshot); keep the loading
  // shell until getTicket hydrates the open ticket so the reader never flashes
  // "No description." between route open and fetch. A failed fetch releases
  // the guard so the error state stays reachable.
  const needsDetail = !!ticket && ticket.body === undefined && !loadError;
  // TKT-0266: rotating gear next to the state pill when the ticket is being
  // actively worked (in_progress + busy live assignee). Same rule as the board
  // card; re-renders on store updates so it tracks the 3s session refresh.
  const activelyWorked = ticket ? (window.isActivelyWorked ? window.isActivelyWorked(ticket) : false) : false;

  // variant='page' renders the same ticket content in a standalone page layout
  // (no fixed drawer shell / backdrop / width presets) so /tickets/<id> can be
  // a dedicated screen. The annotation pill portals to containerSelector.
  const isPage = variant === 'page';
  const containerSelector = isPage ? '.ticket-page' : '.drawer-ticket';
  const projectHref = project
    ? window.Router.buildHref({ kind: 'project', id: project.id, tab: 'agents' })
    : null;
  const Shell = isPage ? 'div' : DrawerPanel;
  const shellClass = isPage
    ? `ticket-page${reader ? ' td-reader' : ''}${editBuf ? ' td-editing' : ''}`
    : `drawer-ticket${editBuf ? ' td-editing' : ''}`;
  const shellStyle = isPage ? undefined : { width: `${widthPct}vw` };

  return (
    <>
      {isPage ? null : (
        <DrawerBackdrop open={open} onClose={close}/>
      )}
      <Shell className={shellClass} style={shellStyle} {...(isPage ? {} : { open, onClose: close, label: ticket ? `Ticket ${ticket.display_id || ticket.id}` : 'Ticket details' })}>
        {!open && !isPage ? null : (loading && !ticket) || needsDetail ? (
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
                <span className="td-id mono">{ticket.display_id || ticket.id}</span>
                <span className="pill td-kind-pill" data-kind={ticket.kind}>{ticket.kind}</span>
                {project && (
                  <span className="cc-chip td-project-chip" title={project.name}>
                    <span className="cc-chip-dot" style={{ background: project.color }}/>
                    <span className="cc-chip-text">{project.glyph ? `${project.glyph} ` : ''}{project.name}</span>
                  </span>
                )}
                <span className={`pill ${statePill}`}>{ticket.state}</span>
                {activelyWorked && <Icon.Gear size={12} className="gear gear-working" title="assignee is actively working"/>}
                {undispatchedCount > 0 && (
                  <span className="pill td-comment-dispatch-badge" title="Human comments that have not been dispatched to a session">
                    undispatched: {undispatchedCount}
                  </span>
                )}
                {isPage ? null : (
                  <button
                    className={`td-width-btn ${widthPct === '90' ? 'active' : ''}`}
                    onClick={() => setWidth(widthPct === '90' ? '50' : '90')}
                    title="Toggle drawer width (90% ⇄ 50%)"
                    aria-pressed={widthPct === '90'}
                  >{widthPct === '90' ? <Icon.DrawerWide/> : <Icon.DrawerHalf/>}</button>
                )}
                {reader ? null : (
                  <a className="td-open-page td-reader-open"
                    href={window.Router.buildHref({ kind: 'ticket', id: ticket.id, reader: true })}
                    {...(isPage ? {} : { target: '_blank', rel: 'noopener' })}
                    title="Reader view — the document alone (new tab)"><Icon.External/></a>
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

            <div className="td-scroll" ref={tdScrollRef}>
              {/* TKT-0285: fields sidebar — the .td-props panel (TKT-0233) moves
                  into a sticky left .td-side; the title + body + (0284) Work-items
                  panel live in .td-main, which re-centers within the remaining
                  horizontal space (gutters both sides). The annotation rail
                  (comments on the right) is untouched. align-items: flex-start is
                  REQUIRED on .td-layout or the sticky sidebar never engages. */}
              <div className="td-layout">
              <aside className="td-side">
              {/* ── Properties panel (TKT-0233 → TKT-0285 moved into the sidebar) —
                   PopSelect controls; 0245's dispatch block + 0266's meta move with it. ── */}
              <div className="td-props">
                {fieldToast && <div className="orch-toast err cc-toast" key={fieldToast.id} style={{ margin: '0 0 8px 0' }}>{fieldToast.msg}</div>}
                {/* TKT-0339: Project — a read-only top-level field (color dot +
                    name, links to the project view). Set at creation; not PATCHable
                    (project_id isn't in updateTicket's whitelist + cross-project
                    moves have unhandled ripple effects). Renders for ALL tickets. */}
                <div className="td-prop td-prop-project" title="Set at creation">
                  <span className="td-prop-label">Project</span>
                  {project ? (
                    <a className="cc-chip td-project-chip td-project-chip-link"
                      href={window.Router.buildHref({ kind: 'project', id: project.id, tab: 'agents' })}
                      onClick={(e) => { e.preventDefault(); window.Router.go({ kind: 'project', id: project.id, tab: 'agents' }); }}
                      title={project.name}>
                      <span className="cc-chip-dot" style={{ background: project.color }}/>
                      <span className="cc-chip-text">{project.glyph ? `${project.glyph} ` : ''}{project.name}</span>
                    </a>
                  ) : (
                    <span className="td-prop-value-muted">—</span>
                  )}
                </div>
                <div className="td-prop">
                  <span className="td-prop-label">State</span>
                  <PopSelect
                    value={ticket.state}
                    compact
                    options={TD_STATES.map((s) => ({ value: s, label: s, dot: PS_STATE_DOT[s] }))}
                    onChange={(v) => commitField({ state: v })}
                  />
                </div>
                <div className="td-prop">
                  <span className="td-prop-label">Assignee</span>
                  {/* GOL-287: assignee rows now carry the session's model mark,
                      held role, and live status via the shared option builder. */}
                  <PopSelect
                    value={ticket.assignee || ''}
                    placeholder="Unassigned"
                    searchable
                    compact
                    options={window.AssigneeOptions.buildAssigneeOptions({
                      sessions: dispatchable,
                      liveStatus: new Map(nativeSessionsNow.filter((s) => s.session_id).map((s) => [s.session_id, s.status ?? null])),
                      offline: (ticket.assignee && ticket.assignee !== 'human' && !labelBySession.has(ticket.assignee))
                        ? [{ value: ticket.assignee, label: ticket.assignee_label || `session ${String(ticket.assignee).slice(0, 8)}`, hint: 'offline' }]
                        : [],
                    })}
                    onChange={(v) => commitField({ assignee: v || null })}
                  />
                </div>
                <div className="td-prop">
                  <span className="td-prop-label">Priority</span>
                  <PopSelect
                    value={ticket.priority || ''}
                    placeholder="None"
                    compact
                    options={TD_PRIORITIES.map((p) => ({ value: p.value, label: p.label || 'None', badge: p.value || undefined }))}
                    onChange={(v) => commitField({ priority: v || null })}
                  />
                </div>
                <div className="td-prop">
                  <span className="td-prop-label">Type</span>
                  <PopSelect
                    value={ticket.kind}
                    compact
                    options={TD_KINDS.map((k) => ({ value: k, label: k }))}
                    onChange={(v) => commitField({ kind: v })}
                  />
                </div>
                {/* Dispatch — an action, not a property; full-width, separated.
                    TKT-0245: when a dispatch is queued (ticket.pending_dispatch
                    set), the row becomes a status line + Cancel; otherwise the
                    PopSelect (with live status dots) + Now/When-idle mode toggle
                    + Dispatch/Queue button. Disabled/empty-picker behavior from
                    TKT-0233 is preserved verbatim. */}
                {pendingDispatch ? (
                  <>
                    <div className="td-prop-dispatch td-dispatch-pending">
                      <span className="td-prop-label">Dispatch</span>
                      <span className="td-dispatch-pending-line">
                        <span className="td-dispatch-pending-icon">⏳</span>
                        Queued for {pendingLabel} · {tdAgo(pendingDispatch.created_at)} · waiting for idle
                        {pendingTargetOffline && <span className="td-dispatch-pending-offline"> · session offline</span>}
                        {pendingTargetUnreachable && <span className="td-dispatch-pending-offline"> · delivery integration down (reconnect the target harness integration)</span>}
                      </span>
                      <button className="orch-btn small ghost td-dispatch-cancel"
                        onClick={onCancelDispatch}
                        disabled={cancelling}
                        title="Cancel this queued dispatch">
                        {cancelling ? '…' : 'Cancel'}
                      </button>
                    </div>
                    {revival && (
                      <div className="td-prop-dispatch td-dispatch-pending" style={{ borderColor: 'color-mix(in oklab, var(--warning) 45%, var(--line))', background: 'color-mix(in oklab, var(--warning) 8%, transparent)' }}>
                        <span className="td-prop-label">Revival</span>
                        <div style={{ display: 'grid', gap: 8, minWidth: 0, flex: 1 }}>
                          <div className="td-dispatch-pending-line">Assigned session is offline or unreachable; revive it or re-dispatch full spec context.</div>
                          <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{revival.revive_command}</pre>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <button className="orch-btn small ghost" onClick={onCopyRevive}>Copy command</button>
                            <select className="td-select" value={revivalSession} onChange={(e) => setRevivalSession(e.target.value)} disabled={revivalBusy || dispatchable.length === 0}>
                              <option value="">Re-dispatch to…</option>
                              {dispatchable.filter((s) => s.session_id !== pendingDispatch.session_id).map((s) => <option key={s.session_id} value={s.session_id}>{s.label}</option>)}
                            </select>
                            <button className="orch-btn small" disabled={revivalBusy || !revivalSession} onClick={onRevivalRedispatch}>{revivalBusy ? 'Sending…' : 'Re-dispatch'}</button>
                          </div>
                          {revivalNote && <div className="td-dispatch-note">{revivalNote}</div>}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="td-prop-dispatch">
                    <span className="td-prop-label">Dispatch to</span>
                    <PopSelect
                      value={dispatchSession}
                      placeholder={dispatchable.length === 0 ? 'No session' : 'Session…'}
                      compact
                      disabled={dispatching || dispatchable.length === 0}
                      options={dispatchOptions}
                      onChange={(v) => {
                        setDispatchSession(v);
                        // Default the mode from the selected target's live
                        // status: idle → Now, busy/waiting → When idle (the
                        // user can override via the toggle below). TKT-0369: an
                        // Any target without immediate delivery defaults to
                        // When-idle even when its live status is idle.
                        const sel = dispatchable.find((s) => s.session_id === v);
                        const liveSt = nativeSessionsNow.find((s) => s.session_id === v)?.status ?? null;
                        const st = sel ? (liveSt ?? sel.status ?? null) : null;
                        setDispatchMode(sel && (sel.delivery_ready === false || (sel.delivery_ready == null && sel.reachable === false)) ? 'when_idle' : (st === 'idle' ? 'now' : 'when_idle'));
                      }}
                    />
                    <div className="td-dispatch-actions">
                      <div className="td-dispatch-mode" role="group" aria-label="Dispatch mode">
                        <button type="button" className={`td-dispatch-mode-btn${dispatchMode === 'now' ? ' active' : ''}`}
                          onClick={() => setDispatchMode('now')} aria-pressed={dispatchMode === 'now'} title="Push the brief immediately">Now</button>
                        <button type="button" className={`td-dispatch-mode-btn${dispatchMode === 'when_idle' ? ' active' : ''}`}
                          onClick={() => setDispatchMode('when_idle')} aria-pressed={dispatchMode === 'when_idle'} title="Queue the brief until the target session is idle">When idle</button>
                      </div>
                      {project?.worktrees === true && (
                        <label className="td-dispatch-workspace" title="Dispatch with a git worktree — builder gets branch + dir + setup instructions">
                          <input type="checkbox" checked={workspaceMode} onChange={(e) => setWorkspaceMode(e.target.checked)} />
                          <span>Worktree</span>
                        </label>
                      )}
                      <button className="orch-btn small td-dispatch-go"
                        onClick={onDispatch}
                        disabled={dispatching || !dispatchSession || dispatchable.length === 0}
                        title={dispatchable.length === 0 ? 'No live Golem session in this project — start a supported harness session' : (dispatchMode === 'when_idle' ? 'Queue the dispatch until the target session is idle' : 'Dispatch to the selected session')}>
                        {dispatching ? '…' : (dispatchMode === 'when_idle' ? 'Queue' : 'Dispatch')}
                      </button>
                    </div>
                  </div>
                )}

                {/* Meta strip — collapsed by default */}
                <div className="td-meta-strip">
                  <button className="td-meta-toggle" onClick={() => setFieldsExpanded((e) => !e)} aria-expanded={fieldsExpanded} title={fieldsExpanded ? 'Hide metadata' : 'Show metadata'}>
                    <Icon.ChevronRight/>
                    <span>{fieldsExpanded ? 'Less' : 'More'}</span>
                  </button>
                  {fieldsExpanded && (
                    <div className="td-meta-list">
                      <div className="td-meta-row">
                        <span className="td-meta-key">Canonical id</span>
                        <span className="mono">{ticket.id}</span>
                      </div>
                      <div className="td-meta-row">
                        <span className="td-meta-key">Dispatched to</span>
                        <span className="mono">{resolveActor(ticket.dispatched_to, ticket.dispatched_to_label) || '—'}</span>
                        {ticket.dispatched_at && <span className="td-meta-value">· {tdAgo(ticket.dispatched_at)}</span>}
                      </div>
                      <div className="td-meta-row">
                        <span className="td-meta-key">Created by</span>
                        <span>{ticket.created_by && ticket.created_by !== 'human' && ticket.created_by !== 'you' ? (ticket.created_by_label || (ticket.created_by.length > 12 ? `session ${ticket.created_by.slice(0, 8)}` : ticket.created_by)) : 'Lavee'}</span>
                        <span className="td-meta-value">· {tdAgo(ticket.created_at)}</span>
                      </div>
                      <div className="td-meta-row">
                        <span className="td-meta-key">Updated</span>
                        <span className="td-meta-value">{tdAgo(ticket.updated_at)}</span>
                      </div>
                      {stateEvents.length > 0 && (
                        <div className="td-meta-row td-state-history">
                          <span className="td-meta-key">State history</span>
                          <span className="td-meta-value">
                            {stateEvents.map((e) => {
                              const data = typeof e.data === 'string' ? (() => { try { return JSON.parse(e.data); } catch { return {}; } })() : (e.data || {});
                              return `${data.from || '?'}→${data.to || '?'} (${e.actor_label || e.actor || 'system'})`;
                            }).join(' · ')}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {dispatchNote && !pendingDispatch && <div className="td-dispatch-note">{dispatchNote}</div>}
              </div>
              </aside>

              {/* TKT-0285: main column — title + body + (0284) Work-items panel.
                  The title + .td-md re-center within .td-main (gutters both sides);
                  the annotation-rail reserve now lives on .td-main. */}
              <div className="td-main">
              {/* ── Title — document heading, click to inline-edit (TKT-0233) ── */}
              <div className="td-titlebody">
                <div className="td-title-row">
                  {editingTitle ? (
                    <input
                      ref={titleInputRef}
                      className="td-title-input"
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitTitle(); }
                        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditingTitle(false); }
                      }}
                      onBlur={commitTitle}
                      placeholder="Title"
                    />
                  ) : reader ? (
                    <h2 className="td-title" onClick={startTitleEdit} title="Click to edit title — click ID to copy">
                      <span
                        className="td-title-prefix"
                        title={`Copy ${ticket.display_id || ticket.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          const did = ticket.display_id || ticket.id;
                          navigator.clipboard?.writeText(did).then(() => {
                            setFieldToast({ msg: `Copied ${did}`, id: Math.random() });
                            setTimeout(() => setFieldToast(null), 1500);
                          }).catch(() => {});
                        }}
                      >{ticket.display_id || ticket.id} — </span>{ticket.title}
                    </h2>
                  ) : (
                    <h2 className="td-title" onClick={startTitleEdit} title="Click to edit">{ticket.title}</h2>
                  )}
                  <button
                    className="orch-btn small ghost td-edit-btn"
                    onClick={() => { setEditExpectedRevision(null); setEditError(null); setEditBuf({ body: ticket.body || '' }); }}
                    title="Edit body"
                  >
                    Edit
                  </button>
                </div>
                {reader && (() => {
                  const assigneeId = ticket.assignee;
                  const isUnassigned = !assigneeId;
                  const isHuman = assigneeId === 'human' || assigneeId === 'you' || assigneeId === 'human:dashboard';
                  const label = isUnassigned ? 'Unassigned' : resolveActor(assigneeId, ticket.assignee_label);
                  const initials = isHuman ? 'L' : (label.split(/[\s:_-]+/).filter(Boolean).slice(0,2).map(p=>p[0]).join('').toUpperCase() || 'A');
                  // GOL-287 feedback: the byline wears the assignee's
                  // model-provider mark (same resolution as the comment
                  // avatars); initials only when no session/icon resolves.
                  const assigneeSession = !isHuman && !isUnassigned ? window.Store?.getNativeSessionById?.(assigneeId) : null;
                  const assigneeIcon = assigneeSession ? window.AssigneeOptions?.assigneeProviderIcon?.(assigneeSession) : null;
                  return (
                    <div className="td-reader-byline">
                      {assigneeIcon
                        ? <span className="by-avatar by-avatar-icon"><img src={assigneeIcon} alt=""/></span>
                        : <span className={`by-avatar ${isHuman ? 'human' : ''}`} aria-hidden="true">{initials}</span>}
                      {/* GOL-316 D1: the byline assignee is a working PopSelect
                          reusing the drawer's options builder + commitField —
                          edit where you read. Same component and commit path
                          as the drawer, no second options fetch (options load
                          in the reader too, app.jsx open={true}). */}
                      <span>Assigned to</span>
                      <PopSelect
                        value={ticket.assignee || ''}
                        placeholder="Unassigned"
                        searchable
                        compact
                        options={window.AssigneeOptions.buildAssigneeOptions({
                          sessions: dispatchable,
                          liveStatus: new Map(nativeSessionsNow.filter((s) => s.session_id).map((s) => [s.session_id, s.status ?? null])),
                          offline: (ticket.assignee && ticket.assignee !== 'human' && !labelBySession.has(ticket.assignee))
                            ? [{ value: ticket.assignee, label: ticket.assignee_label || `session ${String(ticket.assignee).slice(0, 8)}`, hint: 'offline' }]
                            : [],
                        })}
                        onChange={(v) => commitField({ assignee: v || null })}
                      />
                      <span className="byline-dot" aria-hidden="true" />
                      <span className={`pill ${statePill}`}>{ticket.state}</span>
                      <span className="pill td-kind-pill" data-kind={ticket.kind}>{ticket.kind}</span>
                      <span>· Updated {tdAgo(ticket.updated_at)}</span>
                    </div>
                  );
                })()}
              </div>

              {/* ── GOL-326: block-scoped raw HTML editor (attachment pill entry) ── */}
              {blockEdit && (
                <div className="td-block-editor" data-testid="block-editor">
                  {/* GOL-355: dedicated header layout — flex with the close control
                      pushed right; the editor no longer reuses .drawer-close
                      positioning semantics (which collided with the title). */}
                  <div className="td-block-editor-head">
                    <span className="td-block-editor-title">Edit block <code>{blockEdit.blockId}</code></span>
                    {blockEdit.revision != null && <span className="td-block-editor-rev">document revision {blockEdit.revision}</span>}
                    <button className="td-block-editor-close" aria-label="Close block editor"
                      title="Close block editor" onClick={() => setBlockEdit(null)}>×</button>
                  </div>
                  {blockEdit.error && <div className="ct-error" role="alert">{blockEdit.error}</div>}
                  <textarea
                    className="td-edit-body orch-modal-textarea"
                    rows={6}
                    value={blockEdit.html}
                    onChange={(e) => setBlockEdit((cur) => ({ ...cur, html: e.target.value }))}
                    placeholder="<section>…raw HTML for this block…</section>"
                    disabled={blockEdit.busy}
                  />
                  <div className="td-block-editor-preview" ref={blockPreviewRef}
                    dangerouslySetInnerHTML={{ __html: window.SubstrateFmt.renderBody(blockEdit.html, 'html') }} />
                  <div className="row">
                    <button className="orch-btn ghost" onClick={() => setBlockEdit(null)} disabled={blockEdit.busy}>Cancel</button>
                    <button className="orch-btn primary" onClick={onBlockEditSave} disabled={blockEdit.busy}>
                      {blockEdit.busy ? 'Saving…' : 'Save block'}
                    </button>
                  </div>
                </div>
              )}

              {/* ── Body — read (TdAnnotate) or edit (TKT-0233: body-only) ── */}
              <div className="td-body-area">
                {editBuf ? (
                  <div className="td-edit">
                    <textarea
                      ref={editTextareaRef}
                      className="td-edit-body orch-modal-textarea"
                      rows={8}
                      value={editBuf.body}
                      onChange={(e) => setEditBuf({ ...editBuf, body: e.target.value })}
                      onPaste={onEditBodyPaste}
                      onDrop={onEditBodyDrop}
                      onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); }}
                      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditBuf(null); setEditBodyUploads([]); } }}
                      placeholder={(ticket?.body_format === 'html' ? "Body (HTML) — full source; saves through the revision gate (paste/drop images)" : "Body (Markdown) — plain text auto-wraps into paragraphs (paste/drop images)")}
                    />
                    {editError && <div className="ct-error" role="alert">{editError}</div>}
                    {editBodyUploads.length > 0 && (
                      <div className="ct-uploads">
                        {editBodyUploads.map((u) => (
                          <div key={u.id} className={`ct-upload ct-upload-${u.status}`}>
                            {u.status === 'uploading' && <span className="ct-upload-spinner" />}
                            {u.status === 'done' && u.url && <img src={u.url} alt={u.name} className="ct-upload-thumb" />}
                            {u.status === 'error' && <span className="ct-upload-err">×</span>}
                            <span className="ct-upload-name">{u.name}</span>
                            {u.status === 'error' && <span className="ct-upload-err-msg">{u.error}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : ticket.body ? (
                  <TdAnnotate
                    body={ticket.body}
                    bodyFormat={ticket.body_format || 'markdown'}
                    onEditBlock={openBlockEditor}
                    comments={comments}
                    currentAuthor="you"
                    onCreate={onAddComment}
                    onCreateAndDispatch={onAddCommentAndDispatch}
                    onUpdate={onUpdateComment}
                    onReply={onReplyComment}
                    onReplyAndDispatch={onReplyCommentAndDispatch}
                    onDispatchComment={onDispatchComment}
                    canDispatchComments={!!selectedCommentDispatchSession}
                    undispatchedCount={undispatchedCount}
                    dispatchTargetLabel={dispatchTargetLabel}
                    onBatchDispatch={onBatchDispatchComments}
                    commentDispatching={commentDispatching}
                    commentDispatchNote={commentDispatchNote}
                    dispatchTargets={dispatchable.map((s) => ({ session_id: s.session_id, label: s.label }))}
                    selectedDispatchTarget={selectedCommentDispatchSession}
                    onSelectDispatchTarget={(v) => setCommentDispatchSession(v)}
                    offlineAssigneeLabel={offlineAssigneeLabel}
                    containerSelector={containerSelector}
                    documentKey={ticket.id}
                    documentTitle={ticket.title}
                  />
                ) : (
                  <div className="td-body-empty">No description.</div>
                )}
              </div>

              {/* TKT-0284: spec → children panel. Specs surface their children
                  (work items with parent_id = this spec) as a clickable list
                  under the body, aligned to the 1200px column. Children are
                  read LIVE from the store so a newly-created work item appears
                  instantly (its creation broadcasts ticket-created, not a
                  parent refresh). Non-spec tickets skip the panel v1. */}
              {ticket.kind === 'spec' && (
                <div className="td-spec-children-preview" ref={specPreviewRef}>
                  <SpecChildrenPanel
                    specId={ticket.id}
                    projectContractId={ticket.project_id}
                    seedChildren={ticket.children || []}
                    resolveAssignee={resolveActor}
                    reader={reader}
                  />
                </div>
              )}
              </div>{/* /.td-main */}
              </div>{/* /.td-layout */}
            </div>

            {editBuf ? (
              <div className="td-edit-actions" ref={editActionsRef}>
                <button className="orch-btn ghost" onClick={() => setEditBuf(null)} disabled={saving}>Cancel</button>
                <button className="orch-btn primary" onClick={onSaveEdit} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
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

// TKT-0284: spec → children panel. Renders the spec's children (tasks and
// supporting docs with parent_id = this spec) as a clickable list, aligned to
// the 1200px document column like .td-props. Children are read LIVE from the
// store on every render (useStore re-renders on store changes, so a newly
// created task appears instantly — its creation broadcasts ticket-created, not
// a parent ticket-updated, so the server's ticket.children would go stale
// without a re-fetch). "+ Task" opens the composer with Kind=task + Parent=this
// spec (Router.openComposer presets).
// GOL-151: the list is flat and creation-ordered. Dependency waves are gone —
// sequencing lives in the spec body as prose, not in ticket metadata.
function SpecChildrenPanel({ specId, projectContractId, seedChildren = [], resolveAssignee, reader = false }) {
  useStore();
  // No memo: the store Map mutates in place on upsert (applyTicketCreated /
  // applyTicketUpdated do .set on the same Map ref), so a useMemo keyed on the
  // Map would not recompute. Recompute on every render instead — cheap at v1
  // spec volume, and useStore guarantees a re-render on every store change.
  const all = window.Store.getState().trackerTickets;
  const byId = new Map();
  for (const t of seedChildren) {
    if (t?.id) byId.set(t.id, t);
  }
  for (const t of all.values()) {
    if (t.parent_id === specId) byId.set(t.id, { ...(byId.get(t.id) || {}), ...t });
  }
  const children = [...byId.values()];
  children.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const onNewTask = () => {
    window.Router.openComposer(projectContractId, { kind: 'task', parent: specId });
  };
  return (
    <div className="td-children">
      <div className="td-children-header">
        <span className="td-children-title">Children</span>
        <span className="td-children-count tnum">{children.length}</span>
        <button className="orch-btn small ghost td-children-add" onClick={onNewTask}
          title="Create a task under this spec">+ Task</button>
      </div>
      {children.length === 0 ? (
        <div className="td-children-empty">No children yet — they'll emerge as sections lock in.</div>
      ) : (
        <div className="td-children-list">
          {children.map((c) => (
            <a key={c.id}
              className="td-child-row"
              href={window.Router.buildHref({ kind: 'ticket', id: c.id, reader })}
              onClick={(e) => {
                e.preventDefault();
                // Reader view stays in reader view; everywhere else keeps the
                // drawer-overlay behaviour.
                if (reader) window.Router.go({ kind: 'ticket', id: c.id, reader: true });
                else window.Router.openTicket(c.id);
              }}
              title={c.title}
            >
              <span className="td-child-id mono">{c.display_id || c.id}</span>
              <span className="pill td-kind-pill" data-kind={c.kind}>{c.kind}</span>
              <span className="td-child-title">{c.title}</span>
              <span className={`pill ${TD_STATE_PILL[c.state] || 'idle'}`}>{c.state}</span>
              <span className="td-child-assignee">{resolveAssignee(c.assignee, c.assignee_label)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// TKT-0233: the unused TdField component was removed (fields now use .td-prop).

window.TicketDrawer = TicketDrawer;
