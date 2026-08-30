// DirectiveModal — Project Global Directive Space (GOL-15)
// Floating modal accessible via Cmd+K or "+ Send Directive" in project header.
// Recipient: lead (ephemeral) or active worker; Context: None (freeform), Spec, Ticket;
// Dispatch via POST /api/brief or ticket_dispatch, surfaces live stream via peek after dispatch.

function DirectiveModal({ open, onClose, projectId, defaultSpecId = null }) {
  const [recipient, setRecipient] = React.useState('lead');
  const [context, setContext] = React.useState('none'); // none | spec | ticket
  const [specId, setSpecId] = React.useState(defaultSpecId || '');
  const [ticketId, setTicketId] = React.useState('');
  const [ephemeral, setEphemeral] = React.useState(true);
  const [worktree, setWorktree] = React.useState(false);
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState(null);
  const [error, setError] = React.useState(null);

  const alive = window.Store ? window.Store.getProjectAliveSessions(window.Store.getProject(projectId)) : [];
  // Also include broader dispatchable for recipient list
  const [dispatchable, setDispatchable] = React.useState([]);
  React.useEffect(() => {
    if (!open || !projectId) return;
    window.SubstrateAPI.listDispatchable(projectId).then(list => setDispatchable(Array.isArray(list)?list:[])).catch(()=>setDispatchable([]));
  }, [open, projectId]);
  const specs = window.Store ? window.Store.getTrackerTickets({ project_id: projectId, kind: 'spec', includeArchived: true }) : [];
  const tickets = window.Store ? window.Store.getTrackerTickets({ project_id: projectId, includeArchived: true }).filter(t=>t.kind!=='spec').slice(0,80) : [];

  React.useEffect(() => {
    if (open) {
      setResult(null); setError(null);
      if (defaultSpecId) { setContext('spec'); setSpecId(defaultSpecId); }
    }
  }, [open, defaultSpecId]);

  // Cmd+K global handler when modal closed — allow parent to trigger open via prop, but also handle here for convenience
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleDispatch = async () => {
    const trimmed = text.trim();
    if (!trimmed) { setError('Directive text is required'); return; }
    setBusy(true); setError(null); setResult(null);
    try {
      let res;
      const targetSession = recipient === 'lead' ? null : recipient;
      if (context === 'none') {
        // Freeform — ephemeral lead turn via brief (no ticket). Must have a live target; no orphaned ticket is created.
        let target = targetSession;
        if (!target) {
          // Lead ephemeral: prefer a live lead-role session, else first dispatchable, else first alive worker
          const leadAlive = (alive || []).find(s => s.role === 'lead' && s.session_id);
          const leadDispatchable = (dispatchable || []).find(s => (s.label||'').toLowerCase().includes('lead'));
          target = (leadAlive && leadAlive.session_id) || (leadDispatchable && leadDispatchable.session_id) || (dispatchable[0] && dispatchable[0].session_id) || (alive[0] && alive[0].session_id) || null;
        }
        if (!target) { setError('No live worker to receive freeform directive — spawn a worker first or pick a recipient'); setBusy(false); return; }
        res = await window.SubstrateAPI.pushBrief(trimmed, target);
        setResult({ kind: 'brief', res });
      } else if (context === 'spec') {
        if (!specId) { setError('Pick a spec to attach'); setBusy(false); return; }
        const id = specId;
        // Dispatch spec to target (ephemeral turn, worktree optional)
        const payload = { session_id: targetSession || (dispatchable[0]?.session_id || ''), note: trimmed, mode: ephemeral ? 'now' : 'when_idle', workspace: worktree ? 'worktree' : undefined };
        if (!payload.session_id) { setError('Pick a recipient worker for spec dispatch'); setBusy(false); return; }
        res = await window.SubstrateAPI.dispatchTicket(id, payload);
        setResult({ kind: 'spec', res });
      } else if (context === 'ticket') {
        if (!ticketId) { setError('Pick a ticket to attach'); setBusy(false); return; }
        const id = ticketId;
        const payload = { session_id: targetSession || (dispatchable[0]?.session_id || ''), note: trimmed, mode: ephemeral ? 'now' : 'when_idle', workspace: worktree ? 'worktree' : undefined };
        if (!payload.session_id) { setError('Pick a recipient'); setBusy(false); return; }
        res = await window.SubstrateAPI.dispatchTicket(id, payload);
        setResult({ kind: 'ticket', res });
      }
      // Surface live stream: if dispatch succeeded, optionally open peek for the target session
      // (caller can decide); we just show result and keep modal open for copy
    } catch (err) {
      setError(err?.payload?.error || err?.message || String(err));
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="drawer-backdrop open" onClick={onClose} />
      <div className="directive-modal" role="dialog" aria-modal="true" aria-label="Send Directive">
        <div className="directive-modal-head">
          <h2>Send Directive — {projectId || 'project'}</h2>
          <span className="mono directive-kbd">Cmd+K</span>
          <button className="drawer-close" onClick={onClose}>×</button>
        </div>
        <div className="directive-modal-body">
          <label className="directive-field">
            <span>Recipient</span>
            <select value={recipient} onChange={(e)=> setRecipient(e.target.value)}>
              <option value="lead">Lead — ephemeral turn</option>
              {dispatchable.map(s => <option key={s.session_id} value={s.session_id}>{s.label || s.session_id.slice(0,8)} · {s.status||'idle'}</option>)}
              {alive.filter(s=>!dispatchable.some(d=>d.session_id===s.session_id)).map(s => <option key={s.session_id} value={s.session_id}>{s.name||s.session_id.slice(0,8)} · {s.status||'idle'} (alive)</option>)}
            </select>
          </label>
          <div className="directive-field">
            <span>Context</span>
            <div className="directive-context-tabs">
              <button className={`directive-tab ${context==='none'?'active':''}`} onClick={()=>setContext('none')}>None — freeform</button>
              <button className={`directive-tab ${context==='spec'?'active':''}`} onClick={()=>setContext('spec')}>Attach Spec</button>
              <button className={`directive-tab ${context==='ticket'?'active':''}`} onClick={()=>setContext('ticket')}>Attach Ticket</button>
            </div>
            {context==='spec' && (
              <select value={specId} onChange={(e)=>setSpecId(e.target.value)}>
                <option value="">— pick spec —</option>
                {specs.map(s=> <option key={s.id} value={s.display_id||s.id}>{s.display_id||s.id} — {s.title.slice(0,60)}</option>)}
              </select>
            )}
            {context==='ticket' && (
              <select value={ticketId} onChange={(e)=>setTicketId(e.target.value)}>
                <option value="">— pick ticket —</option>
                {tickets.map(t=> <option key={t.id} value={t.display_id||t.id}>{t.display_id||t.id} — {t.title.slice(0,60)}</option>)}
              </select>
            )}
          </div>
          <label className="directive-field">
            <span>Directive</span>
            <textarea rows={5} placeholder="What should the agent do? Be specific — this becomes the brief." value={text} onChange={(e)=>setText(e.target.value)} />
          </label>
          <div className="directive-options">
            <label className="directive-check"><input type="checkbox" checked={ephemeral} onChange={(e)=>setEphemeral(e.target.checked)} /> Ephemeral turn (no persistent session bloat)</label>
            <label className="directive-check"><input type="checkbox" checked={worktree} onChange={(e)=>setWorktree(e.target.checked)} /> Worktree isolation</label>
          </div>
          {error && <div className="directive-error">{error}</div>}
          {result && <div className="directive-result">Dispatched ✓ — {result.kind} {result.res?.envelope_id ? `envelope ${String(result.res.envelope_id).slice(0,8)}` : ''} {result.res?.queued ? '(queued until idle)' : ''}</div>}
        </div>
        <div className="directive-modal-actions">
          <button className="orch-btn ghost" onClick={onClose}>Close</button>
          <button className="orch-btn primary" onClick={handleDispatch} disabled={busy || !text.trim()}>{busy ? 'Dispatching…' : 'Dispatch'}</button>
        </div>
      </div>
    </>
  );
}
window.DirectiveModal = DirectiveModal;
