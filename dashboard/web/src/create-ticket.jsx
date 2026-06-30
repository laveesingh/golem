// Create-ticket modal (WS5a). Mounted once at the app root; listens for the
// `open-create-ticket` CustomEvent (detail may carry a `project_id` to
// preselect). Reuses the .orch-modal* shell from extra.css.
//
// Save → createTicket({...created_by:'human'}); the `ticket-created` WS delta
// lands it on the board. Save & Dispatch additionally pushes the new ticket to
// a chosen live session via dispatchTicket — disabled when no session in the
// selected project is reachable (matches the "dispatch only to live sessions,
// never spawn" product decision).

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
const TYPE_TEMPLATE = {
  'work-item': 'feature',
  'fix': 'bug',
  'spec': 'design-doc',
  'decision': 'decision',
};

function CreateTicket() {
  useStore();
  const projects = window.Store.getProjects();

  const [open, setOpen] = React.useState(false);
  const [projectId, setProjectId] = React.useState('');
  const [kind, setKind] = React.useState('work-item');
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [priority, setPriority] = React.useState('');
  const [streamId, setStreamId] = React.useState('');
  const [assignee, setAssignee] = React.useState('');        // '' unassigned | 'human' | session_id
  const [dispatchSession, setDispatchSession] = React.useState(''); // session_id for Save & Dispatch

  const [streams, setStreams] = React.useState([]);
  const [sessions, setSessions] = React.useState([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState(null);
  // TKT-0106: image paste/drop. Tracks in-flight + completed uploads so we can
  // show previews above the textarea and clear them on submit/reset.
  const [uploads, setUploads] = React.useState([]); // [{ id, name, status, url? }]
  // TKT-0174: genre templates fetched once per open; the body is pre-filled
  // with the kind's default scaffold ONLY when the body is empty.
  const [templates, setTemplates] = React.useState([]);
  const [templateId, setTemplateId] = React.useState('');
  const bodyRef = React.useRef(null);

  // Upload a single File via SubstrateAPI.uploadAsset. Returns the markdown
  // image snippet on success, throws on failure.
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

  // Collect image Files from a ClipboardEvent or DragEvent. Skips non-image
  // files silently — paste/drop of text or non-images shouldn't be intercepted.
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
    if (files.length === 0) return; // let the default text paste through
    e.preventDefault();
    const before = bodyRef.current?.selectionStart ?? body.length;
    const after = bodyRef.current?.selectionEnd ?? body.length;
    for (const f of files) {
      try {
        const { md } = await uploadOne(f);
        const insert = `${before === after ? '' : ''}\n${md}\n`;
        setBody((cur) => {
          const next = cur.slice(0, before) + insert + cur.slice(after);
          // restore cursor after the inserted snippet on next tick
          requestAnimationFrame(() => {
            if (bodyRef.current) {
              const pos = before + insert.length;
              bodyRef.current.setSelectionRange(pos, pos);
              bodyRef.current.focus();
            }
          });
          return next;
        });
        break; // only insert first image per paste (cursor math gets fuzzy)
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
        setBody((cur) => cur + (cur.endsWith('\n') ? '' : '\n') + md + '\n');
      } catch (err) { /* surfaced in uploads strip */ }
    }
  }, [uploadOne]);

  const reset = React.useCallback(() => {
    setKind('work-item'); setTitle(''); setBody(''); setPriority('');
    setStreamId(''); setAssignee(''); setDispatchSession('');
    setError(null); setSubmitting(false); setUploads([]);
    setTemplateId('');
  }, []);

  // Open on event; preselect project if provided.
  React.useEffect(() => {
    const opener = (e) => {
      reset();
      const pre = e?.detail?.project_id;
      setProjectId(pre || '');
      setOpen(true);
    };
    window.addEventListener('open-create-ticket', opener);
    return () => window.removeEventListener('open-create-ticket', opener);
  }, [reset]);

  // Escape closes.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // TKT-0174: fetch the genre templates once per open.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    window.SubstrateAPI.getTemplates()
      .then((list) => { if (!cancelled) setTemplates(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setTemplates([]); });
    return () => { cancelled = true; };
  }, [open]);

  // TKT-0180: default-by-type — when the type changes (or on open), set the
  // dropdown to the type's default template, UNLESS the user has manually
  // overridden the template since the last type-change. A type-change resets
  // the override flag. 'question' has no default.
  const [templateOverride, setTemplateOverride] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    setTemplateOverride(false);
    setTemplateId(TYPE_TEMPLATE[kind] || '');
  }, [open, kind]);

  // TKT-0180: pre-fill the body from the selected template ONLY when the
  // body is empty (never clobbers typed content). Runs when the template
  // selection changes or templates arrive.
  React.useEffect(() => {
    if (!open || !templateId || !templates.length) return;
    const t = templates.find((x) => x.id === templateId);
    if (t) setBody((cur) => (cur.trim() ? cur : t.body));
  }, [open, templateId, templates]);

  const onTemplateChange = (e) => {
    const id = e.target.value;
    setTemplateId(id);
    setTemplateOverride(true);
    if (!id) return;
    const t = templates.find((x) => x.id === id);
    if (t) setBody((cur) => (cur.trim() ? cur : t.body));
  };

  // On project change (and on open), refetch streams + dispatchable sessions.
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

  // Reset stream/dispatch selections that no longer apply when the project's
  // lists change.
  React.useEffect(() => {
    if (streamId && !streams.some((s) => String(s.id) === String(streamId))) setStreamId('');
  }, [streams]); // eslint-disable-line
  React.useEffect(() => {
    if (dispatchSession && !sessions.some((s) => s.session_id === dispatchSession)) setDispatchSession('');
  }, [sessions]); // eslint-disable-line

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

  const close = () => { if (!submitting) setOpen(false); };

  const onSave = async () => {
    if (!valid || submitting) return;
    setSubmitting(true); setError(null);
    try {
      await window.SubstrateAPI.createTicket(buildBody());
      setOpen(false);
      reset();
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
      setOpen(false);
      reset();
    } catch (err) {
      setError(err?.payload?.error || err?.message || 'Failed to create & dispatch ticket');
      setSubmitting(false);
    }
  };

  return (
    <div className="orch-modal-backdrop" onClick={close}>
      <div className="orch-modal ct-modal" onClick={(e) => e.stopPropagation()}>
        <div className="orch-modal-header">
          <span className="orch-modal-title">New ticket</span>
          <button className="orch-modal-close" onClick={close} title="close">×</button>
        </div>

        <div className="ct-field">
          <label className="ct-label">Project</label>
          <select className="ct-input" value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={submitting}>
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

        <div className="ct-field">
          <label className="ct-label">Body <span className="ct-label-hint">Markdown · paste or drop images</span></label>
          <textarea ref={bodyRef} className="orch-modal-textarea" rows={5} value={body} placeholder="Details, context, acceptance… (Markdown is rendered; empty body fills with the selected template)"
            onChange={(e) => setBody(e.target.value)}
            onPaste={onPaste}
            onDrop={onDrop}
            onDragOver={(e) => { if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
            disabled={submitting}/>
          {/* TKT-0106: upload previews. Show while in-flight + after success so
              the user can confirm what they attached before clicking Save. */}
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

        <div className="orch-modal-actions">
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
      </div>
    </div>
  );
}

window.CreateTicket = CreateTicket;
