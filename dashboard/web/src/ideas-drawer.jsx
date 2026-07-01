// TKT-0206: IdeasStack — a global parking lot of raw thoughts the user
// drops via a bottom-left anchor button. The drawer mirrors the
// existing drawer pattern (URL overlay ?ideas=1, backdrop + slide-in
// aside, Esc to close, Back button to close) so it works on every
// dashboard page including the standalone /tickets/<id> view.
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

function IdeasDrawer({ open, onClose }) {
  const [ideas, setIdeas] = React.useState([]);
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [popping, setPopping] = React.useState(null);
  const taRef = React.useRef(null);
  const listRef = React.useRef(null);

  // Load on open + when other components tell us the list changed
  // (the Store fires 'ideas:changed' after create/pop).
  React.useEffect(() => {
    if (!open) return;
    window.SubstrateAPI.listIdeas()
      .then((rows) => setIdeas(Array.isArray(rows) ? rows : []))
      .catch((err) => setError(err?.message || 'Failed to load ideas'));
  }, [open]);

  // Re-fetch on 'ideas:changed' events (fired by the Store after our
  // own create / pop). Cheap (just a directory read) and keeps the list
  // in sync without manual refresh.
  React.useEffect(() => {
    if (!open) return;
    const onChange = () => {
      window.SubstrateAPI.listIdeas()
        .then((rows) => setIdeas(Array.isArray(rows) ? rows : []))
        .catch(() => {});
    };
    window.addEventListener('ideas:changed', onChange);
    return () => window.removeEventListener('ideas:changed', onChange);
  }, [open]);

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
      await window.SubstrateAPI.createIdea(trimmed);
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
    if (busy || popping) return;
    setPopping(id);
    try {
      await window.SubstrateAPI.popIdea(id);
      window.dispatchEvent(new CustomEvent('ideas:changed'));
    } catch (err) {
      setError(err?.payload?.error || err?.message || 'Failed to pop idea');
    } finally {
      setPopping(null);
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
            Drop a thought, pop one to take it forward. Oldest first.
          </div>
        </div>
        <div className="ideas-composer">
          <textarea
            ref={taRef}
            className="ideas-input"
            rows={3}
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
                      onClick={() => pop(idea.id)}
                      disabled={busy || popping === idea.id}
                      title="Take this idea forward (removes it from the queue)"
                    >
                      {popping === idea.id ? '…' : 'Pop'}
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
