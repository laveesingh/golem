// TKT-0206 / GOL-13: IdeasStack — now PROJECT-SCOPED. When a projectId
// is supplied the drawer shows and creates ideas only for that project;
// without it the drawer falls back to the legacy global queue. Mirrors
// the existing drawer pattern (URL overlay ?ideas=1, backdrop + slide-in
// aside, Esc to close, Back to close) so it works on every dashboard page
// including the standalone /tickets/<id> view.
//
// "Pop" semantics: clicking an idea removes it from the queue — the
// user is taking the idea forward (typically into a tracker ticket).
// There's no "pushed back" / archive flow; the idea is a parking lot,
// once you've parked, you've parked. The server deletes the .md on pop.
//
// The list is FIFO (oldest first) so the user sees what they've been
// sitting on longest. The composer is "always one ready" so the user
// can paste a bunch of ideas quickly — Enter posts, Shift+Enter
// newline (standard textarea behavior).

function IdeasDrawer({ open, onClose, projectId = null }) {
  const [ideas, setIdeas] = React.useState([]);
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [popping, setPopping] = React.useState(null);
  const [promoting, setPromoting] = React.useState(null);
  const taRef = React.useRef(null);
  const listRef = React.useRef(null);

  // Load on open + when other components tell us the list changed
  // (the Store fires 'ideas:changed' after create/pop). Project-scoped
  // when projectId is present.
  React.useEffect(() => {
    if (!open) return;
    window.SubstrateAPI.listIdeas(projectId)
      .then((rows) => setIdeas(Array.isArray(rows) ? rows : []))
      .catch((err) => setError(err?.message || 'Failed to load ideas'));
  }, [open, projectId]);

  // Re-fetch on 'ideas:changed' events (fired by the Store after our
  // own create / pop). Cheap (just a directory read) and keeps the list
  // in sync without manual refresh.
  React.useEffect(() => {
    if (!open) return;
    const onChange = () => {
      window.SubstrateAPI.listIdeas(projectId)
        .then((rows) => setIdeas(Array.isArray(rows) ? rows : []))
        .catch(() => {});
    };
    window.addEventListener('ideas:changed', onChange);
    return () => window.removeEventListener('ideas:changed', onChange);
  }, [open, projectId]);

  // Esc to close.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Auto-focus the composer when the drawer opens.
  React.useEffect(() => {
    if (open) setTimeout(() => taRef.current?.focus(), 100);
  }, [open]);

  const post = async () => {
    const trimmed = text.trim();
    if (busy || !trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await window.SubstrateAPI.createIdea(trimmed, projectId);
      setText('');
      taRef.current?.focus();
      window.dispatchEvent(new CustomEvent('ideas:changed'));
    } catch (err) {
      setError(err?.payload?.error || err?.message || 'Failed to save idea');
    } finally {
      setBusy(false);
    }
  };

  const pop = async (id) => {
    if (busy || popping || promoting) return;
    setPopping(id);
    try {
      await window.SubstrateAPI.popIdea(id);
      window.dispatchEvent(new CustomEvent('ideas:changed'));
    } catch (err) {
      setError(err?.payload?.error || err?.message || 'Failed to discard idea');
    } finally {
      setPopping(null);
    }
  };

  const promote = async (id) => {
    if (busy || popping || promoting) return;
    setPromoting(id);
    setError(null);
    try {
      const payload = projectId ? { project_id: projectId } : {};
      const result = await window.SubstrateAPI.promoteIdea(id, payload);
      window.dispatchEvent(new CustomEvent('ideas:changed'));
      const ticketId = result?.ticket?.display_id || result?.ticket?.id;
      if (ticketId) window.Router.openTicket(ticketId);
    } catch (err) {
      setError(err?.payload?.error || err?.message || 'Failed to promote idea');
    } finally {
      setPromoting(null);
    }
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post(); }
  };

  if (!open) return null;

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose}/>
      <aside className={`drawer ${open ? 'open' : ''} ideas-drawer`}>
        <div className="drawer-header ideas-drawer-header">
          <div className="drawer-title-row">
            <h2 className="drawer-title">Ideas</h2>
            <span className="ideas-count mono">{ideas.length}</span>
            <button className="drawer-close" onClick={onClose} title="Close (Esc)"><Icon.Close/></button>
          </div>
          <div className="ideas-help">
            {projectId ? `Project ideas — scoped to this workspace. Oldest first.` : `Drop a thought, promote one to a spec, or discard it. Oldest first.`}
          </div>
        </div>
        <div className="ideas-composer">
          <textarea
            ref={taRef}
            className="ideas-input"
            rows={5}
            placeholder="What's on your mind? (Enter posts · Shift+Enter newline)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            disabled={busy}
          />
          <div className="ideas-composer-actions">
            {error && <div className="ideas-error">{error}</div>}
            <button
              className="orch-btn primary"
              onClick={post}
              disabled={busy || !text.trim()}
            >
              {busy ? 'Posting…' : 'Post idea'}
            </button>
          </div>
        </div>
        <div className="ideas-list" ref={listRef}>
          {ideas.length === 0 ? (
            <div className="ideas-empty">
              No ideas yet. Drop a thought above to start the queue.
            </div>
          ) : (
            <ul className="ideas-ul">
              {ideas.map((idea) => (
                <li key={idea.id} className="idea-card" data-id={idea.id}>
                  <div className="idea-body">{idea.body}</div>
                  <div className="idea-meta">
                    <span className="idea-ts mono">
                      {idea.createdAt ? idea.createdAt.slice(0, 16).replace('T', ' ') : ''}
                    </span>
                    <button
                      className="orch-btn primary small"
                      onClick={() => promote(idea.id)}
                      disabled={busy || popping === idea.id || promoting === idea.id}
                      title="Create a spec ticket from this idea"
                    >
                      {promoting === idea.id ? '...' : 'Promote to spec'}
                    </button>
                    <button
                      className="orch-btn ghost small"
                      onClick={() => pop(idea.id)}
                      disabled={busy || popping === idea.id || promoting === idea.id}
                      title="Discard this idea without creating a spec"
                    >
                      {popping === idea.id ? '...' : 'Discard'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}

window.IdeasDrawer = IdeasDrawer;
