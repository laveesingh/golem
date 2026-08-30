// PeekModal — live ANSI terminal scrollback + mid-turn steer (GOL-15)
// Renders GET /api/native-sessions/:sessionId/terminal with ANSI colors, polls live, supports auto-scroll lock and steer/halt/kill.

function ansiToHtml(text) {
  if (!text) return '';
  // Minimal ANSI → HTML: handles reset 0, bold 1, colors 30-37, 90-97, bg 40-47, 100-107
  const esc = '\x1b';
  const colorMap = {
    '30': 'var(--text-3)', '31': 'var(--status-blocked)', '32': 'var(--status-active)', '33': 'var(--status-review)',
    '34': '#60a5fa', '35': '#c084fc', '36': '#22d3ee', '37': 'var(--text-1)',
    '90': 'var(--text-3)', '91': '#fca5a5', '92': '#86efac', '93': '#fde68a', '94': '#93c5fd', '95': '#d8b4fe', '96': '#67e8f9', '97': '#f8fafc',
  };
  const bgMap = {
    '40': 'transparent', '41': 'rgba(248,113,113,.15)', '42': 'rgba(74,222,128,.12)', '43': 'rgba(251,191,36,.12)',
    '44': 'rgba(96,165,250,.12)', '45': 'rgba(192,132,252,.12)', '46': 'rgba(34,211,238,.12)', '47': 'rgba(255,255,255,.06)',
  };
  let html = '';
  let openSpans = 0;
  const push = (code) => {
    if (code === '0') {
      while (openSpans-- > 0) html += '</span>';
      openSpans = 0;
    } else if (code === '1') {
      html += '<span style="font-weight:700">'; openSpans++;
    } else if (colorMap[code]) {
      html += `<span style="color:${colorMap[code]}">`; openSpans++;
    } else if (bgMap[code]) {
      html += `<span style="background:${bgMap[code]}">`; openSpans++;
    }
  };
  // Split on ESC[ ... m
  const parts = String(text).split(/\x1b\[([^m]*?)m/);
  // parts: text, codes, text, codes, ...
  html += escHtml(parts[0] || '');
  for (let i = 1; i < parts.length; i += 2) {
    const codes = (parts[i] || '').split(';').filter(Boolean);
    for (const c of codes) push(c);
    html += escHtml(parts[i+1] || '');
  }
  while (openSpans-- > 0) html += '</span>';
  // Preserve line breaks
  return html;
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function PeekModal({ open, sessionId, onClose }) {
  const [output, setOutput] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [autoScroll, setAutoScroll] = React.useState(true);
  const [steerText, setSteerText] = React.useState('');
  const [steerBusy, setSteerBusy] = React.useState(false);
  const [actionMsg, setActionMsg] = React.useState(null);
  const scrollRef = React.useRef(null);
  const isAtBottom = () => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  const onScroll = () => {
    setAutoScroll(isAtBottom());
  };
  const fetchTerminal = React.useCallback(async () => {
    if (!open || !sessionId) return;
    setLoading(true);
    try {
      const res = await window.SubstrateAPI.getTerminal(sessionId, 600);
      setOutput(res.output || '');
      setError(null);
      if (autoScroll) setTimeout(()=> { const el=scrollRef.current; if(el) el.scrollTop = el.scrollHeight; }, 30);
    } catch (err) {
      setError(err?.payload?.error || err?.message || String(err));
    } finally { setLoading(false); }
  }, [open, sessionId, autoScroll]);

  React.useEffect(() => {
    if (!open || !sessionId) return;
    fetchTerminal();
    const id = setInterval(fetchTerminal, 2000);
    return () => clearInterval(id);
  }, [open, sessionId, fetchTerminal]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !sessionId) return null;

  const doSteer = async (mode) => {
    const text = steerText.trim();
    if (mode === 'steer' && !text) return;
    setSteerBusy(true);
    setActionMsg(null);
    try {
      const fnMap = {
        steer: () => window.SubstrateAPI.sendSteer(sessionId, text),
        interrupt: () => window.SubstrateAPI.sendInterrupt(sessionId, text || 'interrupt'),
        halt: () => window.SubstrateAPI.sendHalt(sessionId, text || 'halt'),
        kill: () => window.SubstrateAPI.killSession(sessionId),
      };
      const res = await (fnMap[mode] ? fnMap[mode]() : window.SubstrateAPI.sendSteer(sessionId, text));
      setActionMsg(`${mode} ✓ ${res?.envelope_id ? String(res.envelope_id).slice(0,8) : res?.killed || ''}`);
      if (mode === 'steer') setSteerText('');
      setTimeout(()=> setActionMsg(null), 2500);
      fetchTerminal();
    } catch (err) {
      setActionMsg(`${mode} failed: ${err?.payload?.error || err?.message || String(err)}`);
    } finally { setSteerBusy(false); }
  };

  const copyOutput = async () => {
    try { await navigator.clipboard.writeText(output); setActionMsg('copied ✓'); setTimeout(()=>setActionMsg(null),1200); } catch {}
  };

  const html = React.useMemo(()=> ansiToHtml(output), [output]);

  return (
    <>
      <div className="peek-backdrop open" onClick={onClose} />
      <div className="peek-modal open" role="dialog" aria-modal="true" aria-label={`Terminal ${sessionId}`}>
        <div className="peek-modal-head">
          <span className="peek-modal-title mono">🖥️ {sessionId.slice(0,12)} — live terminal</span>
          <span className={`peek-status ${loading?'busy':''}`}>{loading?'live…':'live'}</span>
          <div className="peek-modal-actions">
            <button className="orch-btn ghost small" onClick={fetchTerminal} disabled={loading}>Refresh</button>
            <button className="orch-btn ghost small" onClick={copyOutput}>Copy</button>
            <button className="orch-btn ghost small" onClick={()=> window.open(`about:blank`,'_blank')}>Pop-out</button>
            <button className="drawer-close" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="peek-terminal" ref={scrollRef} onScroll={onScroll}>
          {error ? <div className="peek-error">{error}</div> : <pre className="peek-pre" dangerouslySetInnerHTML={{ __html: html || '<span style="color:var(--text-3)">(no output yet)</span>' }} />}
        </div>
        <div className="peek-steer">
          <input
            className="peek-steer-input"
            placeholder="Mid-turn steer message… (Enter to send steer)"
            value={steerText}
            onChange={(e)=> setSteerText(e.target.value)}
            onKeyDown={(e)=> { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); doSteer('steer'); } }}
            disabled={steerBusy}
          />
          <div className="peek-steer-actions">
            <button className="orch-btn primary small" onClick={()=>doSteer('steer')} disabled={steerBusy || !steerText.trim()}>💬 Steer</button>
            <button className="orch-btn ghost small" onClick={()=>doSteer('interrupt')} disabled={steerBusy}>Pause</button>
            <button className="orch-btn ghost small" onClick={()=> { if(confirm('Halt this worker?')) doSteer('halt'); }} disabled={steerBusy}>Halt</button>
            <button className="orch-btn small" onClick={()=> { if(confirm('Kill this worker? This terminates the tmux session.')) doSteer('kill'); }} disabled={steerBusy} style={{ color:'var(--status-blocked)', borderColor:'rgba(248,113,113,.35)'}}>Kill</button>
            <label className="peek-autoscroll"><input type="checkbox" checked={autoScroll} onChange={(e)=> setAutoScroll(e.target.checked)} /> auto-scroll</label>
          </div>
          {actionMsg && <div className="peek-action-msg">{actionMsg}</div>}
        </div>
      </div>
    </>
  );
}
window.PeekModal = PeekModal;
