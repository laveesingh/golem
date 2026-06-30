// Create-ticket DRAWER (replaces the center-screen modal in create-ticket.jsx).
//
// URL-driven (TKT-0153): App passes `open` + `preselectProject` from the
// ?compose=1&project=<pid> overlay. Openers call Router.openComposer(pid); the
// two "+ New ticket" buttons in tracker-board.jsx and project-view.jsx do that
// directly. Close (Esc / backdrop / × / submit) → onClose → Router.closeOverlay
// → history.back, so Back closes the drawer.
//
// GitHub-issue-style drafts: every field is autosaved (debounced 300ms) to
// localStorage per project via window.CtDraft (ct-draft.js). Closing the drawer
// (Esc / backdrop / ×) or refreshing the tab flushes the draft and restores it
// on next open — work is never lost. Submit clears only that project's draft.
//
// Uses the same `.drawer` shell as ticket-drawer.jsx, with a distinct
// `.drawer-compose` class (NOT `.drawer-ticket` — td-annotate.jsx portals its
// annotation pill to `.drawer-ticket` and would collide). Width preset
// persisted under `ct:width`.

const CT_KINDS = ['work-item', 'decision', 'spec', 'question', 'fix'];
const CT_PRIORITIES = [
  { value: '', label: 'None' },
  { value: 'P0', label: 'P0' },
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
  { value: 'P3', label: 'P3' },
];

// TKT-0180: default genre template per ticket type. The template picker
// defaults to the type's scaffold but the user can override via the dropdown
// (e.g. pick prd/brainstorm for a work-item). 'question' has no default —
// the user picks a template explicitly if they want one.
//
// This map is the ONLY place the type→template default lives. The drawer's
// `setTemplateIdByType` effect consults it whenever the user changes type;
// if the user has manually picked a different template since the last
// type-change, that override sticks (see `templateOverride` below).
const TYPE_TEMPLATE = {
  'work-item': 'feature',
  'fix': 'bug',
  'spec': 'design-doc',
  'decision': 'decision',
};

// Drawer width presets (percentage of viewport). Persisted in localStorage so
// a refresh keeps the user's choice. Order is wide→narrow, matching the icon
// button group left-to-right. Mirrors ticket-drawer.jsx's TD_WIDTHS.
const CT_WIDTHS = [
  { v: '90', icon: () => <Icon.DrawerWide/>, label: 'Wide (90%)' },
  { v: '50', icon: () => <Icon.DrawerHalf/>, label: 'Half (50%)' },
  { v: '30', icon: () => <Icon.DrawerNarrow/>, label: 'Narrow (30%)' },
];
const CT_WIDTH_KEY = 'ct:width';
function ctLoadWidth() {
  try {
    const s = localStorage.getItem(CT_WIDTH_KEY);
    return CT_WIDTHS.some((w) => w.v === s) ? s : '90';
  } catch { return '90'; }
}

// Build the autosave snapshot from the current field states. Only completed
// uploads are persisted (in-flight ones have no URL yet; their markdown isn't
// in the body either, so dropping them on refresh is correct).
function snapshot(fields) {
  return {
    project_id: fields.projectId,
    kind: fields.kind,
    title: fields.title,
    body: fields.body,
    priority: fields.priority,
    stream_id: fields.streamId,
    assignee: fields.assignee,
    dispatch_session: fields.dispatchSession,
    uploads: (fields.uploads || [])
      .filter((u) => u.status === 'done' && u.url)
      .map((u) => ({ url: u.url, filename: u.name })),
  };
}

// Apply a loaded draft (or a blank default) to the field setters. `fallbackPid`
// is the opener's preselect — used when there's no draft so the project dropdown
// is still preselected (not blank).
function applyDraft(d, setProjectId, setters, fallbackPid, bodyTemplateIdRef) {
  setProjectId(d?.project_id || fallbackPid || '');
  setters.setKind(d?.kind || 'work-item');
  setters.setTitle(d?.title || '');
  setters.setBody(d?.body || '');
  setters.setPriority(d?.priority || '');
  setters.setStreamId(d?.stream_id || '');
  setters.setAssignee(d?.assignee || '');
  setters.setDispatchSession(d?.dispatch_session || '');
  setters.setUploads((d?.uploads || []).map((u, i) => ({
    id: `restored_${i}_${Math.random().toString(36).slice(2, 8)}`,
    name: u.filename || '',
    status: 'done',
    url: u.url,
  })));
  setters.setError(null);
  setters.setSubmitting(false);
  // TKT-0181: a restored draft's body is user-typed content (the body of
  // an unsaved draft). Mark it as user-edited so subsequent template
  // changes preserve it instead of overwriting. No-draft path leaves
  // the ref alone — the open will auto-fill the body via the type→template
  // effect and the ref will be set then.
  if (d && bodyTemplateIdRef) bodyTemplateIdRef.current = null;
}

function CreateTicketDrawer({ open, preselectProject, onClose }) {
  useStore();
  const projects = window.Store.getProjects();

  // `open` is URL-driven (?compose=1, owned by App). `projectId` is a composer
  // FIELD (the ticket's project), so it stays internal — seeded from the
  // preselect prop on open, then mutable via the dropdown.
  const [projectId, setProjectId] = React.useState('');
  const [kind, setKind] = React.useState('work-item');
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [priority, setPriority] = React.useState('');
  const [streamId, setStreamId] = React.useState('');
  const [assignee, setAssignee] = React.useState('');
  const [dispatchSession, setDispatchSession] = React.useState('');

  const [streams, setStreams] = React.useState([]);
  const [sessions, setSessions] = React.useState([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState(null);
  // True when the currently-shown fields came from a restored draft — drives
  // the "Restored unsaved draft · Discard" banner. Cleared on first edit or
  // submit.
  const [restored, setRestored] = React.useState(false);
  const [uploads, setUploads] = React.useState([]); // [{ id, name, status, url? }]
  // TKT-0180: genre templates fetched once per open; the body is pre-filled
  // with the type's default scaffold ONLY when the body is empty.
  const [templates, setTemplates] = React.useState([]);
  const [templateId, setTemplateId] = React.useState('');
  // TKT-0180: when the user manually picks a template from the dropdown, that
  // choice sticks across subsequent type changes. Reset to false every time
  // the type changes (so a fresh type-change gets the new default), and set
  // to true on explicit dropdown picks via `onTemplateChange`.
  const [templateOverride, setTemplateOverride] = React.useState(false);
  // TKT-0181: tracks which template's scaffold the body currently matches.
  // `null` means the body is either empty or has been user-edited (diverged
  // from any known template). The body-fill effect only swaps when this
  // ref is set to a known template id — so user-typed content is preserved
  // through type-changes and template re-picks.
  const bodyTemplateIdRef = React.useRef(null);
  const bodyRef = React.useRef(null);

  // Drawer width preset (persisted).
  const [widthPct, setWidthPct] = React.useState(ctLoadWidth);
  const setWidth = (v) => {
    setWidthPct(v);
    try { localStorage.setItem(CT_WIDTH_KEY, v); } catch {}
  };

  const setters = { setKind, setTitle, setBody, setPriority, setStreamId, setAssignee, setDispatchSession, setUploads, setError, setSubmitting };

  // ── Image paste/drop (ported verbatim from create-ticket.jsx) ──────────────
  const uploadOne = React.useCallback(async (file) => {
    const id = `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    setUploads((u) => [...u, { id, name: file.name, status: 'uploading' }]);
    try {
      const res = await window.SubstrateAPI.uploadAsset(file);
      setUploads((u) => u.map((x) => x.id === id ? { ...x, status: 'done', url: res.url } : x));
      return { id, md: `![](${res.url})`, url: res.url };
    } catch (err) {
      setUploads((u) => u.map((x) => x.id === id ? { ...x, status: 'error', error: String(err?.message || err) } : x));
      throw err;
    }
  }, []);

  const collectImages = (dt) => {
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
  };

  const onPaste = React.useCallback(async (e) => {
    const files = collectImages(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    const before = bodyRef.current?.selectionStart ?? body.length;
    const after = bodyRef.current?.selectionEnd ?? body.length;
    for (const f of files) {
      try {
        const { md } = await uploadOne(f);
        const insert = `${before === after ? '' : ''}\n${md}\n`;
        setBody((cur) => {
          const next = cur.slice(0, before) + insert + cur.slice(after);
          bodyTemplateIdRef.current = null; // pasted content = user-edited
          requestAnimationFrame(() => {
            if (bodyRef.current) {
              const pos = before + insert.length;
              bodyRef.current.setSelectionRange(pos, pos);
              bodyRef.current.focus();
            }
          });
          return next;
        });
        break;
      } catch (err) { /* error surfaced in uploads strip */ }
    }
  }, [body, uploadOne]);

  const onDrop = React.useCallback(async (e) => {
    const files = collectImages(e.dataTransfer);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) {
      try {
        const { md } = await uploadOne(f);
        setBody((cur) => { bodyTemplateIdRef.current = null; return cur + (cur.endsWith('\n') ? '' : '\n') + md + '\n'; });
      } catch (err) { /* surfaced in uploads strip */ }
    }
  }, [uploadOne]);

  // ── Open / project-restore ─────────────────────────────────────────────────
  // open is URL-driven (App passes it from ?compose=1). On open, migrate any
  // unscoped draft into the preselect project bucket, then load that project's
  // draft (or blank, with the project preselected). The draft is the source of
  // truth — closing no longer wipes state, and reopening re-syncs from the
  // flushed localStorage draft.
  const restore = React.useCallback((pid) => {
    let draft = null;
    if (pid) draft = window.CtDraft.migrateToProject(pid) || window.CtDraft.load(pid);
    else draft = window.CtDraft.load('');
    applyDraft(draft, setProjectId, setters, pid, bodyTemplateIdRef);
    setRestored(!!(draft && ((draft.title && draft.title.trim()) || (draft.body && draft.body.trim()))));
  }, []);

  // Restore on open. Uses a ref so a re-render with the same `open`/preselect
  // doesn't clobber in-progress edits.
  const openedFor = React.useRef(null);
  React.useEffect(() => {
    if (!open) { openedFor.current = null; return; }
    const key = `${preselectProject}`;
    if (openedFor.current === key) return;
    openedFor.current = key;
    restore(preselectProject);
  }, [open, preselectProject, restore]);

  // When the user changes project while the drawer is open, load that project's
  // own draft (after flushing the previous one). This is the per-project swap.
  const projectJustChanged = React.useRef(false);
  React.useEffect(() => {
    if (!open) return;
    if (projectJustChanged.current) {
      projectJustChanged.current = false;
      window.CtDraft.flush();
      restore(projectId);
    }
  }, [projectId, open, restore]);

  // Esc closes (→ App pops ?compose via onClose). Draft flush happens in the
  // close effect below when `open` flips false.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Flush the draft whenever the drawer closes (Esc / backdrop / × / Back / submit)
  // and on tab close / refresh — so in-progress work always lands in localStorage.
  React.useEffect(() => {
    if (!open) window.CtDraft.flush();
  }, [open]);
  React.useEffect(() => {
    const onUnload = () => window.CtDraft.flush();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  // Refetch streams + dispatchable sessions when the project changes (or open).
  React.useEffect(() => {
    if (!open || !projectId) { setStreams([]); setSessions([]); return; }
    let cancelled = false;
    window.SubstrateAPI.listStreams(projectId)
      .then((list) => { if (!cancelled) setStreams(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setStreams([]); });
    window.SubstrateAPI.listDispatchable(projectId)
      .then((list) => { if (!cancelled) setSessions(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setSessions([]); });
    return () => { cancelled = true; };
  }, [open, projectId]);

  // Drop stream/dispatch selections that no longer apply when lists change.
  React.useEffect(() => {
    if (streamId && !streams.some((s) => String(s.id) === String(streamId))) setStreamId('');
  }, [streams]); // eslint-disable-line
  React.useEffect(() => {
    if (dispatchSession && !sessions.some((s) => s.session_id === dispatchSession)) setDispatchSession('');
  }, [sessions]); // eslint-disable-line

  // ── Autosave (debounced) on any field change while open ───────────────────
  // The "Restored unsaved draft" banner is cleared only by explicit Discard or
  // Submit — NOT by the first keystroke (matches GitHub, which keeps the draft
  // indicator while you keep editing the restored draft).
  React.useEffect(() => {
    if (!open) return;
    window.CtDraft.scheduleSave(projectId, snapshot({ projectId, kind, title, body, priority, streamId, assignee, dispatchSession, uploads }));
  }, [open, projectId, kind, title, body, priority, streamId, assignee, dispatchSession, uploads]);

  // ── TKT-0174: genre templates ─────────────────────────────────────────────
  // Fetch the 6 scaffolds once per open; default-by-kind sets the dropdown,
  // and the body is pre-filled ONLY when empty (never clobbers a draft or
  // typed content).
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    window.SubstrateAPI.getTemplates()
      .then((list) => { if (!cancelled) setTemplates(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setTemplates([]); });
    return () => { cancelled = true; };
  }, [open]);

  // TKT-0180: when the type changes, the template picker snaps back to that
  // type's default UNLESS the user has manually overridden it since the last
  // type-change. A type-change always resets the override flag — even if the
  // new default happens to coincide with the user's prior pick — so a
  // deliberate type change is always a deliberate "re-default".
  React.useEffect(() => {
    if (!open) return;
    setTemplateOverride(false);
    setTemplateId(TYPE_TEMPLATE[kind] || '');
  }, [open, kind]);

  // When the template picker value changes (whether by type-change above or
  // by manual dropdown selection), fill the body IF it is empty OR if the
  // body still matches a known template's scaffold (i.e. the user has NOT
  // hand-edited it — they may have a scaffold from a prior template pick).
  // User-typed content diverges from every known template and is preserved.
  // The bodyTemplateIdRef tracks which scaffold the body currently matches
  // so re-selecting the same template is a no-op (no churn, no undo flash).
  React.useEffect(() => {
    if (!open || !templateId || !templates.length) return;
    const t = templates.find((x) => x.id === templateId);
    if (!t) return;
    setBody((cur) => {
      if (!cur.trim()) {
        // Empty body — always fill.
        bodyTemplateIdRef.current = t.id;
        return t.body;
      }
      if (bodyTemplateIdRef.current === t.id) {
        // Body already matches this template (user picked the same template
        // again, or type-change matched prior pick) — no-op.
        return cur;
      }
      // If we can prove the body came from any known template, swap.
      if (bodyTemplateIdRef.current) {
        bodyTemplateIdRef.current = t.id;
        return t.body;
      }
      // Body is non-empty and we don't know its source — assume user-edited
      // and preserve.
      return cur;
    });
  }, [open, templateId, templates]);

  // TKT-0181: manual dropdown pick. Sets templateOverride so a subsequent
  // type-change does NOT clobber the user's choice. A manual pick is
  // explicit user intent to use that template — but only swaps the body
  // if the body is still a clean template scaffold (per the rules above).
  // If the body has been user-edited, the manual pick still changes the
  // templateId dropdown but the body is left alone (the user can clear
  // the body manually to trigger a fresh fill).
  const onTemplateChange = (e) => {
    const id = e.target.value;
    setTemplateId(id);
    setTemplateOverride(true);
    if (!id) return;
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setBody((cur) => {
      if (!cur.trim()) {
        bodyTemplateIdRef.current = t.id;
        return t.body;
      }
      if (bodyTemplateIdRef.current === t.id) return cur;
      if (bodyTemplateIdRef.current) {
        bodyTemplateIdRef.current = t.id;
        return t.body;
      }
      return cur;
    });
  };

  if (!open) return null;

  const canDispatch = sessions.length > 0;
  const valid = !!projectId && !!title.trim();

  const buildBody = () => ({
    project_id: projectId,
    kind,
    title: title.trim(),
    body: body.trim() || undefined,
    priority: priority || undefined,
    stream_id: streamId || undefined,
    assignee: assignee || undefined,
    created_by: 'human',
  });

  const close = () => {
    if (submitting) return;
    onClose && onClose();
  };

const discard = () => {
    // Clear the in-progress content but keep the project context — discarding
    // a draft shouldn't also wipe the project dropdown the user just picked.
    window.CtDraft.discard(projectId);
    setKind('work-item'); setTitle(''); setBody(''); setPriority('');
    setStreamId(''); setAssignee(''); setDispatchSession('');
    setUploads([]); setError(null); setSubmitting(false); setRestored(false);
    setTemplateId(''); setTemplateOverride(false);
    bodyTemplateIdRef.current = null;
  };

  const onProjectChange = (e) => {
    const v = e.target.value;
    projectJustChanged.current = true;
    setProjectId(v);
  };

  const onSave = async () => {
    if (!valid || submitting) return;
    setSubmitting(true); setError(null);
    try {
      await window.SubstrateAPI.createTicket(buildBody());
      window.CtDraft.discard(projectId);
      onClose && onClose();
    } catch (err) {
      setError(err?.payload?.error || err?.message || 'Failed to create ticket');
      setSubmitting(false);
    }
  };

  const onSaveAndDispatch = async () => {
    if (!valid || submitting || !dispatchSession) return;
    setSubmitting(true); setError(null);
    try {
      const ticket = await window.SubstrateAPI.createTicket(buildBody());
      await window.SubstrateAPI.dispatchTicket(ticket.id, { session_id: dispatchSession });
      window.CtDraft.discard(projectId);
      onClose && onClose();
    } catch (err) {
      setError(err?.payload?.error || err?.message || 'Failed to create & dispatch ticket');
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={close}/>
      <aside className={`drawer ${open ? 'open' : ''} drawer-compose`} style={{ width: `${widthPct}vw` }}>
        {/* ── Header ── */}
        <div className="drawer-header ct-header">
          <div className="drawer-title-row">
            <h2 className="drawer-title">New ticket</h2>
            <div className="td-width-group" role="group" aria-label="Drawer width">
              {CT_WIDTHS.map((w) => (
                <button key={w.v}
                  className={`td-width-btn ${widthPct === w.v ? 'active' : ''}`}
                  onClick={() => setWidth(w.v)}
                  title={w.label}
                  aria-pressed={widthPct === w.v}>{w.icon()}</button>
              ))}
            </div>
            <button className="drawer-close" onClick={close} title="close"><Icon.Close/></button>
          </div>
        </div>

        {/* ── Scrollable fields ── */}
        <div className="ct-scroll">
          {restored && (
            <div className="ct-draft-banner">
              <span>Restored unsaved draft</span>
              <button className="ct-draft-discard" onClick={discard}>Discard</button>
            </div>
          )}

          <div className="ct-field">
            <label className="ct-label">Project</label>
            <select className="ct-input" value={projectId} onChange={onProjectChange} disabled={submitting}>
              <option value="">Select a project…</option>
              {projects.filter((p) => p.project_id).map((p) => (
                <option key={p.project_id} value={p.project_id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="ct-row">
            <div className="ct-field">
              <label className="ct-label">Type</label>
              <select className="ct-input" value={kind} onChange={(e) => setKind(e.target.value)} disabled={submitting}>
                {CT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            <div className="ct-field">
              <label className="ct-label">Priority</label>
              <select className="ct-input" value={priority} onChange={(e) => setPriority(e.target.value)} disabled={submitting}>
                {CT_PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
          </div>

          <div className="ct-field">
            <label className="ct-label">Title</label>
            <input className="ct-input" type="text" value={title} placeholder="Short summary"
              onChange={(e) => setTitle(e.target.value)} disabled={submitting} autoFocus/>
          </div>

          <div className="ct-field">
            <label className="ct-label">Template</label>
            <select className="ct-input" value={templateId} onChange={onTemplateChange}
              disabled={submitting || !templates.length}>
              <option value="">None</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          </div>

          <div className="ct-field ct-field--grow">
            <label className="ct-label">Body <span className="ct-label-hint">Markdown · paste or drop images</span></label>
            <textarea ref={bodyRef} className="orch-modal-textarea" rows={5} value={body}
              placeholder="Details, context, acceptance… (Markdown is rendered; empty body fills with the selected template; manually edited bodies are preserved through template changes)"
              onChange={(e) => { bodyTemplateIdRef.current = null; setBody(e.target.value); }}
              onPaste={onPaste}
              onDrop={onDrop}
              onDragOver={(e) => { if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
              disabled={submitting}/>
            {uploads.length > 0 && (
              <div className="ct-uploads">
                {uploads.map((u) => (
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

          <div className="ct-row">
            <div className="ct-field">
              <label className="ct-label">Stream</label>
              <select className="ct-input" value={streamId} onChange={(e) => setStreamId(e.target.value)} disabled={submitting || !projectId}>
                <option value="">None</option>
                {streams.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="ct-field">
              <label className="ct-label">Assignee</label>
              <select className="ct-input" value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={submitting || !projectId}>
                <option value="">Unassigned</option>
                <option value="human">Human</option>
                {sessions.map((s) => <option key={s.session_id} value={s.session_id}>{s.label}</option>)}
              </select>
            </div>
          </div>

          <div className="ct-dispatch">
            <label className="ct-label">Dispatch to session</label>
            <select className="ct-input" value={dispatchSession} onChange={(e) => setDispatchSession(e.target.value)}
              disabled={submitting || !canDispatch}>
              <option value="">{canDispatch ? 'Select a live session…' : 'No live session in this project'}</option>
              {sessions.map((s) => <option key={s.session_id} value={s.session_id}>{s.label}</option>)}
            </select>
            {!canDispatch && projectId && (
              <div className="ct-dispatch-hint">
                No live session in this project — start one with <span className="mono">cd &lt;project&gt; &amp;&amp; claude</span>.
              </div>
            )}
          </div>

          {error && <div className="ct-error">{error}</div>}
        </div>

        {/* ── Sticky actions ── */}
        <div className="ct-actions">
          <button className="orch-btn ghost" onClick={close} disabled={submitting}>Cancel</button>
          <button className="orch-btn" onClick={onSaveAndDispatch}
            disabled={submitting || !valid || !canDispatch || !dispatchSession}
            title={!canDispatch ? 'No live session in this project to dispatch to' : 'Create then dispatch to the selected session'}>
            Save &amp; Dispatch
          </button>
          <button className="orch-btn primary" onClick={onSave} disabled={submitting || !valid}>
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </aside>
    </>
  );
}

window.CreateTicketDrawer = CreateTicketDrawer;