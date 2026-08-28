// TKT-0233: PopSelect — a dashboard-themed custom listbox that replaces native
// <select> on ticket surfaces. Native selects' option menus are OS-rendered
// (unstylable, ignore the dark theme); PopSelect portals a themed menu to
// document.body with keyboard + type-ahead support. No imports — uses globals
// (window.React, window.ReactDOM, window.Icon); top-level const is visible to
// later babel scripts (ticket-drawer.jsx, create-ticket-drawer.jsx). Never
// `import React` (two-React trap → "invalid hook call").

// State → dot color (mirrors the board pill palette). Consumers pass `dot`.
const PS_STATE_DOT = {
  todo: 'var(--text-3)',
  in_progress: 'var(--status-running)',
  blocked: 'var(--status-blocked)',
  review: 'var(--status-review)',
  done: 'var(--status-active)',
  archived: 'var(--status-active)',
};
window.PS_STATE_DOT = PS_STATE_DOT;

const PS_CHECK = (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5l3.5 3.5L13 5"/></svg>
);

function psLabel(opt) {
  if (!opt) return '';
  return opt.label != null ? String(opt.label) : (opt.value != null ? String(opt.value) : '');
}

const PopSelect = function PopSelect({ value, options, onChange, placeholder = '—', disabled = false, searchable, compact = false }) {
  const opts = Array.isArray(options) ? options : [];
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const activeRef = React.useRef(0); // TKT-0233: synchronous mirror of `active` so the document keydown listener (a stable closure) reads the current row without waiting for a re-render — fixes back-to-back ArrowDown+Enter selecting a stale row.
  const [filter, setFilter] = React.useState('');
  const [rect, setRect] = React.useState(null);
  const [up, setUp] = React.useState(false);
  const triggerRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const filterRef = React.useRef(null);
  const activeRowRef = React.useRef(null);
  const doSearch = searchable != null ? searchable : opts.length > 8;
  const strValue = value == null ? '' : String(value);
  const selected = opts.find((o) => String(o.value) === strValue) || null;

  const filtered = React.useMemo(() => {
    if (!doSearch || !filter) return opts;
    const f = filter.toLowerCase();
    return opts.filter((o) => psLabel(o).toLowerCase().includes(f));
  }, [opts, doSearch, filter]);

  const close = React.useCallback(() => { setOpen(false); setFilter(''); }, []);

  const choose = React.useCallback((v) => {
    if (onChange) onChange(v);
    close();
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, [onChange, close]);

  const openMenu = React.useCallback(() => {
    if (disabled || !opts.length) return;
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setRect({ left: r.left, top: r.top, bottom: r.bottom, width: r.width });
    const si = opts.findIndex((o) => String(o.value) === strValue);
    setActive(si >= 0 ? si : 0);
    activeRef.current = si >= 0 ? si : 0;
    setOpen(true);
  }, [disabled, opts, strValue]);

  // While open: click-outside + any scroll closes (capture-phase, so a scroll
  // inside the menu's own list still closes — simpler than repositioning). Esc
  // closes AND stopImmediatePropagation so the ticket drawer's window Esc
  // handler (which unmounts the drawer) never fires. ArrowUp/Down/Enter are
  // handled here too so they work regardless of where focus sits.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target) &&
          triggerRef.current && !triggerRef.current.contains(e.target)) close();
    };
    const onScroll = () => close();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); requestAnimationFrame(() => triggerRef.current?.focus()); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); const n = Math.min(activeRef.current + 1, filtered.length - 1); activeRef.current = n; setActive(n); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); const n = Math.max(activeRef.current - 1, 0); activeRef.current = n; setActive(n); return; }
      if (e.key === 'Enter') { e.preventDefault(); const o = filtered[activeRef.current]; if (o && !o.disabled) choose(o.value); return; }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, close, filtered, choose]);

  // Autofocus the filter input when the menu opens; keep the active row scrolled in.
  React.useEffect(() => { if (open && doSearch && filterRef.current) filterRef.current.focus(); }, [open, doSearch]);
  React.useEffect(() => { if (open && activeRowRef.current) activeRowRef.current.scrollIntoView({ block: 'nearest' }); }, [open, active]);

  // Open upward if there's more room above than below.
  React.useLayoutEffect(() => {
    if (!open || !rect) return;
    const mh = Math.min(320, filtered.length * 32 + (doSearch ? 40 : 0) + 16);
    const roomBelow = window.innerHeight - rect.bottom - 8;
    setUp(roomBelow < mh && rect.top > roomBelow);
  }, [open, rect, filtered.length, doSearch]);

  const onTriggerKey = (e) => {
    if (disabled || open) return; // TKT-0233: when open, the document keydown listener handles Arrow/Enter; re-opening here would reset the active row.
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); openMenu(); }
  };

  const menuStyle = rect ? {
    position: 'fixed',
    left: `${rect.left}px`,
    minWidth: `${rect.width}px`,
    zIndex: 90,
    ...(up ? { bottom: `${window.innerHeight - rect.top + 4}px` } : { top: `${rect.bottom + 4}px` }),
  } : { display: 'none' };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`ps-trigger${compact ? ' compact' : ''}${disabled ? ' disabled' : ''}`}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
      >
        {selected && selected.dot ? <span className="ps-dot" style={{ background: selected.dot }}/> : null}
        {selected && selected.badge ? <span className="ps-badge">{selected.badge}</span> : null}
        {selected && selected.icon ? <img className="ps-option-icon" src={selected.icon} alt=""/> : null}
        <span className="ps-label">{selected ? psLabel(selected) : placeholder}</span>
        <Icon.ChevronRight className="ps-chev"/>
      </button>
      {open && rect && ReactDOM.createPortal(
        <div ref={menuRef} className={`ps-menu${up ? ' up' : ''}`} style={menuStyle} role="listbox">
          {doSearch && (
            <input ref={filterRef} className="ps-filter" placeholder="Filter…" value={filter}
              onChange={(e) => setFilter(e.target.value)} aria-label="Filter options"/>
          )}
          <div className="ps-options">
            {filtered.length === 0 ? (
              <div className="ps-empty">No matches</div>
            ) : filtered.map((o, i) => (
              <button
                type="button"
                key={String(o.value) + ':' + i}
                ref={i === active ? activeRowRef : null}
                className={`ps-option${i === active ? ' active' : ''}${String(o.value) === strValue ? ' selected' : ''}`}
                onMouseEnter={() => { setActive(i); activeRef.current = i; }}
                onClick={() => { if (!o.disabled) choose(o.value); }}
                role="option"
                aria-selected={String(o.value) === strValue}
                disabled={o.disabled}
              >
                <span className="ps-check">{String(o.value) === strValue ? PS_CHECK : null}</span>
                {o.dot ? <span className="ps-dot" style={{ background: o.dot }}/> : null}
                {o.badge ? <span className="ps-badge">{o.badge}</span> : null}
                {o.icon ? <img className="ps-option-icon" src={o.icon} alt=""/> : null}
                <span className="ps-option-label">{psLabel(o)}</span>
                {o.hint ? <span className="ps-hint">{o.hint}</span> : null}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
window.PopSelect = PopSelect;

// GOL-287: shared assignee-option shaping for the create-ticket drawer and the
// ticket drawer's read/edit properties. Each live session row carries its
// model-provider mark (the same live registry the agent cards use), its held
// role, and its live status; the human row keeps the identity dot.
function assigneeProviderIcon(session) {
  if (!session) return null;
  const provider = window.ModelProviders?.resolveProvider?.(session.provider, session.model);
  return provider?.iconIdleSrc || provider?.iconSrc || null;
}

function buildAssigneeOptions({ sessions = [], liveStatus = null, offline = [] } = {}) {
  const options = [
    { value: '', label: 'Unassigned' },
    { value: 'human', label: 'Lavee', dot: '#f5a623' },
  ];
  for (const s of sessions) {
    if (!s?.session_id) continue;
    const status = (liveStatus instanceof Map ? liveStatus.get(s.session_id) : null) ?? s.status ?? null;
    const hint = [s.role, status && status !== 'unknown' ? status : null].filter(Boolean).join(' · ');
    options.push({
      value: s.session_id,
      label: s.label || s.name || `session ${String(s.session_id).slice(0, 8)}`,
      icon: assigneeProviderIcon(s),
      hint: hint || null,
    });
  }
  for (const extra of offline) {
    if (extra?.value != null) options.push(extra);
  }
  return options;
}
window.AssigneeOptions = { buildAssigneeOptions, assigneeProviderIcon };
