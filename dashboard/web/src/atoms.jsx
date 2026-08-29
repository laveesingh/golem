// Shared atoms — adapted from the design's atoms.jsx to use window.Store
// (real role map) instead of the static SubstrateData.ROLES.

function Avatar({ role, size = 32, pulse = false }) {
  const r = window.Store.getRole(role);
  if (!role) {
    return (
      <div className="agent-avatar anon" style={{ width: size, height: size }}>
        {r.glyph}
        {pulse && <span className="agent-avatar-pulse" style={{ color: r.color }}/>}
      </div>
    );
  }
  return (
    <div
      className="agent-avatar"
      style={{
        width: size, height: size,
        background: `color-mix(in oklab, ${r.color} 18%, var(--bg-2))`,
        color: r.color,
        border: `1px solid color-mix(in oklab, ${r.color} 35%, transparent)`,
      }}
    >
      {r.glyph}
      {pulse && <span className="agent-avatar-pulse" style={{ color: r.color }}/>}
    </div>
  );
}

function RoleSelect({ value, disabled, onChange, id }) {
  const roles = window.Store.getRoles ? window.Store.getRoles() : [];
  const current = value || '';
  const missingRole = current && !roles.some((role) => role.name === current);
  return (
    <select className="agent-card-role-select" id={id} value={current} onChange={(e) => onChange(e.target.value || null)} disabled={disabled}>
      <option value="">clear</option>
      {missingRole && <option value={current}>{current} (legacy)</option>}
      {roles.map((role) => <option key={role.name} value={role.name}>{role.name}</option>)}
    </select>
  );
}

function ProjectGlyph({ project, size = 32 }) {
  return (
    <div
      className="project-card-glyph"
      style={{
        width: size, height: size,
        background: `color-mix(in oklab, ${project.color} 18%, var(--bg-2))`,
        color: project.color,
        border: `1px solid color-mix(in oklab, ${project.color} 30%, transparent)`,
      }}
    >
      {project.glyph}
    </div>
  );
}

function Carousel({ children, trackRef }) {
  const internalRef = React.useRef(null);
  const ref = trackRef ?? internalRef;
  return (
    <div className="carousel">
      <div className="carousel-track" ref={ref}>{children}</div>
    </div>
  );
}

function CarouselControls({ trackRef }) {
  return (
    <div className="row-controls">
      <button className="icon-btn" onClick={() => trackRef.current?.scrollBy({ left: -360, behavior: 'smooth' })}>
        <Icon.ChevronLeft/>
      </button>
      <button className="icon-btn" onClick={() => trackRef.current?.scrollBy({ left: 360, behavior: 'smooth' })}>
        <Icon.ChevronRight/>
      </button>
    </div>
  );
}

function ConnectionPill({ status }) {
  const cls = status === 'connected' ? 'connected' : status === 'disconnected' ? 'disconnected' : '';
  const label = status === 'connected' ? 'Live'
    : status === 'connecting' ? 'Connecting'
    : status === 'disconnected' ? 'Offline'
    : status;
  return (
    <span className={`conn-pill ${cls}`}>
      <span className="dot"/>{label}
    </span>
  );
}

function DrawerBackdrop({ open, onClose, className = '' }) {
  if (!open) return null;
  return <div className={`drawer-backdrop open${className ? ` ${className}` : ''}`} onClick={onClose} aria-hidden="true"/>;
}

// One modal authority for every right drawer. Entries are ordered by mount,
// so only the top owns keyboard handling while background inertness derives
// from stack depth rather than any individual drawer's cleanup timing.
const DRAWER_STACK = [];
function syncDrawerBackground() {
  const inert = DRAWER_STACK.length > 0;
  document.querySelectorAll('.app > .sidebar, .app > .main').forEach((node) => {
    node.inert = inert;
    if (inert) node.setAttribute('aria-hidden', 'true');
    else node.removeAttribute('aria-hidden');
  });
  const top = drawerTop();
  DRAWER_STACK.forEach((entry) => {
    const panel = entry.ref.current;
    if (!panel) return;
    const isTop = entry === top;
    panel.inert = !isTop;
    panel.setAttribute('aria-hidden', isTop ? 'false' : 'true');
    if (isTop) panel.setAttribute('aria-modal', 'true');
    else panel.removeAttribute('aria-modal');
    panel.dataset.modalTop = isTop ? 'true' : 'false';
  });
}
function drawerTop() { return DRAWER_STACK[DRAWER_STACK.length - 1] || null; }

function DrawerPanel({ open, onClose, label = 'Details', className = '', children, ...props }) {
  const ref = React.useRef(null);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  React.useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const focusKey = previous?.getAttribute?.('data-focus-key');
    const entry = { ref, previous, focusKey };
    DRAWER_STACK.push(entry);
    syncDrawerBackground();
    ref.current?.focus();
    const onKey = (event) => {
      if (drawerTop() !== entry) return;
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current?.(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...(ref.current?.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])]
        .filter((node) => !node.hidden && node.getAttribute('aria-hidden') !== 'true');
      if (!focusable.length) { event.preventDefault(); ref.current?.focus(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const index = DRAWER_STACK.indexOf(entry);
      if (index >= 0) DRAWER_STACK.splice(index, 1);
      syncDrawerBackground();
      const target = previous?.isConnected ? previous : (focusKey ? document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`) : null);
      if (index >= DRAWER_STACK.length) (target || drawerTop()?.ref?.current)?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <aside ref={ref} className={`drawer open${className ? ` ${className}` : ''}`}
      role="dialog" aria-label={label} tabIndex={-1} {...props}>
      {children}
    </aside>
  );
}
window.DrawerBackdrop = DrawerBackdrop;
window.DrawerPanel = DrawerPanel;

// v4: PLAN.md progress — a compact "N/M" bar that expands to the flat
// checkbox-item list on click. Renders nothing when the project has no plan.
// `color` themes the fill bar to match the project.
function PlanProgress({ plan, color, defaultOpen = false }) {
  const [open, setOpen] = React.useState(defaultOpen);
  if (!plan || !plan.total) return null;
  const pct = plan.total ? Math.round((plan.done / plan.total) * 100) : 0;
  const barColor = color || 'var(--accent)';
  return (
    <div className="plan-progress" onClick={(e) => e.stopPropagation()}>
      <button
        className="plan-progress-head"
        onClick={() => setOpen((o) => !o)}
        title={plan.title || 'PLAN.md'}
      >
        <span className="plan-progress-caret">{open ? '▾' : '▸'}</span>
        <span className="plan-progress-label">PLAN</span>
        <div className="plan-progress-bar">
          <div className="plan-progress-fill" style={{ width: `${pct}%`, background: barColor }}/>
        </div>
        <span className="plan-progress-count tnum">{plan.done}/{plan.total}</span>
      </button>
      {open && (
        <ul className="plan-items">
          {plan.items.map((it, i) => (
            <li key={i} className={`plan-item ${it.done ? 'done' : ''}`}>
              <span className="plan-item-box">{it.done ? '✓' : '○'}</span>
              <span className="plan-item-text">{it.text || <span style={{ color: 'var(--text-4)' }}>(empty)</span>}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function sessionStatusKind(s) {
  if (s?.alive === false || ['dead', 'ended', 'stopped'].includes(s?.status)) return 'dead';
  if (s.status === 'busy') return 'busy';
  if (s.status === 'waiting') return 'waiting';
  if (s.status === 'idle') return 'idle';
  if (['error', 'failed', 'system error'].includes(s.status)) return 'error';
  if (['initializing', 'starting'].includes(s.status)) return 'initializing';
  if (s.status === 'stopping') return 'stopping';
  if (s.status === 'offline') return 'unavailable';
  return 'unknown';
}

function HarnessIcon({ harness, working = false }) {
  const h = harness || 'claudecode';
  const icon = window.ModelProviders?.harnessForId?.(h);
  const iconSrc = icon && (working ? (icon.iconActiveSrc || icon.iconSrc) : (icon.iconIdleSrc || icon.iconSrc));
  return (
    <span className={`agent-harness-icon ${icon ? `harness-${icon.id}` : 'harness-unknown'} ${working ? 'is-working' : 'is-idle'}`} role="img" title={`Harness: ${icon?.label || h}`} aria-label={`Harness: ${icon?.label || h}`}>
      {iconSrc ? <img src={iconSrc} alt=""/> : (
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M8 12h8M12 8v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
      )}
    </span>
  );
}

// Provider/model resolution shared by the chip and the portrait orb.
function resolveProviderView(providerId, model) {
  const provider = window.ModelProviders?.resolveProvider?.(providerId, model)
    || window.ModelProviders?.fallback || { id: 'fallback', label: 'Unknown' };
  return {
    provider,
    providerLabel: provider.id === 'fallback' ? 'Unknown provider' : provider.label,
    modelLabel: typeof model === 'string' && model.trim() ? model.trim() : 'model unavailable',
  };
}

// The chip pairs the provider mark with the model name. Its icon stays at rest
// (idle) always — the animated model mark lives in the portrait orb.
function ModelPill({ model, provider: providerId }) {
  const { provider, providerLabel, modelLabel } = resolveProviderView(providerId, model);
  const iconSrc = provider.iconIdleSrc || provider.iconSrc;
  return (
    <span className="agent-model-pill" title={`${providerLabel}: ${modelLabel}`}>
      <span className={`agent-model-icon provider-${provider.id || 'fallback'}`} aria-hidden="true">
        {iconSrc ? <img src={iconSrc} alt=""/> : (
          <svg viewBox="0 0 24 24"><path d="M12 3.5 20 8v8l-8 4.5L4 16V8l8-4.5Z" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M8.5 12h7M12 8.5v7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
        )}
      </span>
      <span>{modelLabel}</span>
    </span>
  );
}

// The primary portrait orb: the provider/model mark, animated while the agent works.
function ProviderOrbIcon({ model, provider: providerId, working = false }) {
  const { provider, providerLabel, modelLabel } = resolveProviderView(providerId, model);
  const iconSrc = working ? (provider.iconActiveSrc || provider.iconSrc) : (provider.iconIdleSrc || provider.iconSrc);
  return (
    <span className={`agent-model-icon provider-${provider.id || 'fallback'} ${working ? 'is-working' : 'is-idle'}`} role="img" title={`Model: ${providerLabel} — ${modelLabel}`} aria-label={`Model: ${providerLabel} — ${modelLabel}`}>
      {iconSrc ? <img src={iconSrc} alt=""/> : (
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 20 8v8l-8 4.5L4 16V8l8-4.5Z" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M8.5 12h7M12 8.5v7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
      )}
    </span>
  );
}

function stateLabel(statusKind) {
  return {
    busy: 'Active work',
    waiting: 'Waiting',
    idle: 'Idle',
    error: 'Error',
    initializing: 'Initializing',
    stopping: 'Stopping',
    unavailable: 'Unavailable',
    unknown: 'Unknown state',
    dead: 'Offline',
  }[statusKind] || 'Unknown state';
}

function waitingBayMessage(waitingFor) {
  const value = typeof waitingFor === 'string' ? waitingFor.trim() : '';
  if (!value) return '';
  if (value.toLowerCase() === 'approval') return 'await approval';
  if (value.toLowerCase() === 'user input') return 'await input';
  return value;
}

function timestampMs(value) {
  const stamp = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(stamp) ? stamp : null;
}

function AgentCard({ session, name, queueCount = 0, setRoute, showControls = false, compact = false }) {
  const s = session || {};
  const [roleToast, setRoleToast] = React.useState(null);
  const project = window.Store.getProjectByContractId(s.project_id);
  const channel = window.Store.getChannelForSession(s.session_id);
  const hasChannel = !!channel;
  const statusKind = sessionStatusKind(s);
  const title = name || s.name || (s.session_id ? s.session_id.slice(0, 8) : (s.pid != null ? `pid ${s.pid}` : 'unnamed session'));
  const currentTicket = s.current_in_progress_ticket?.id ? s.current_in_progress_ticket : null;
  const pendingSource = s.pending_count != null ? Number(s.pending_count) : Number(queueCount);
  const pendingCount = Number.isInteger(pendingSource) && pendingSource > 0 ? pendingSource : 0;
  const unackedWarnings = s.active_unacked_dispatches || [];
  const fallbackProject = project || { glyph: '?', color: 'var(--text-3)' };
  const lastSeen = window.Store.getSessionLastSeen?.(s);
  const startedAt = timestampMs(s.started_at);
  const lifetime = startedAt == null
    ? 'age unknown'
    : `${window.SubstrateFmt?.fmtRuntime?.(Math.max(0, (Date.now() - startedAt) / 1000)) || 'age unknown'} old`;
  const freshness = Number.isFinite(lastSeen) && lastSeen > 0 && window.SubstrateFmt?.fmtTimeAgo?.(lastSeen)
    ? `seen ${window.SubstrateFmt.fmtTimeAgo(lastSeen)}`
    : 'seen unknown';
  const bayMessage = statusKind === 'waiting' ? waitingBayMessage(s.waiting_for) : '';
  const communication = s.reachable === true ? 'live' : s.reachable === false ? 'offline' : 'unknown';
  const communicationLabel = communication === 'live' ? 'Channel live'
    : communication === 'offline' ? 'Channel offline'
    : 'Channel unknown';
  const ticketLabel = currentTicket?.display_id || currentTicket?.id;
  const roleControlId = `agent-role-${String(s.session_id || s.pid || title).replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  const openPeek = () => {
    if (s.session_id) window.openNativeSessionDrawer(s.session_id);
  };
  const openProject = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (project && setRoute) setRoute({ kind: 'project', id: project.id, tab: 'agents' });
  };
  const containRoleControl = (e) => e.stopPropagation();
  const flashRoleError = (err) => {
    const msg = err?.payload?.error || err?.message || 'Role assignment failed';
    console.error('set role failed', err);
    setRoleToast({ msg: `Role assignment failed: ${msg}`, id: Math.random() });
    setTimeout(() => setRoleToast(null), 3000);
  };
  const assignRole = async (role) => {
    try {
      const result = await window.SubstrateAPI.setSessionRole(s.session_id, role);
      if (result?.activation?.ok === false) {
        const detail = result.activation.error || `status ${result.activation.status ?? 'unknown'}`;
        console.warn('role saved but activation was not delivered', result.activation);
        setRoleToast({ msg: `Role saved; activation not delivered: ${detail}`, id: Math.random() });
        setTimeout(() => setRoleToast(null), 5000);
      }
    } catch (error) {
      flashRoleError(error);
    }
  };

  return (
    <article className={`agent-card native-session-card state-${statusKind} ${compact ? 'compact' : ''}`}>
      <button
        type="button"
        className="agent-card-surface"
        data-focus-key={s.session_id ? `agent:${s.session_id}` : undefined}
        onClick={openPeek}
        disabled={!s.session_id}
        aria-label={s.session_id ? `Open agent ${title} details` : 'Agent details unavailable'}
      ><span className="agent-card-sr-only">Open agent {title} details</span></button>

      <div className="agent-card-passport">
        <div className="agent-card-portrait">
          <div className="agent-card-orbs">
            <div className="agent-card-orb agent-card-orb--model">
              <ProviderOrbIcon model={s.model} provider={s.provider} working={statusKind === 'busy'}/>
            </div>
            <div className="agent-card-harness-mark">
              <HarnessIcon harness={s.harness} working={statusKind === 'busy'}/>
            </div>
          </div>
          <span className="agent-card-sr-only">{stateLabel(statusKind)}</span>
          <div className="agent-card-transient-bay" aria-live="polite" aria-atomic="true" title={bayMessage || undefined}>
            {bayMessage && <span>{bayMessage}</span>}
          </div>
        </div>

        <div className="agent-card-main">
          <div className="agent-card-identity">
            <button
              type="button"
              className="agent-card-project-action"
              onClick={openProject}
              disabled={!project || !setRoute}
              title={project ? `Open ${project.name} agents` : 'Unregistered project; project navigation is unavailable'}
              aria-label={project ? `Open ${project.name} agents` : 'Unregistered project; project navigation is unavailable'}
            ><ProjectGlyph project={fallbackProject} size={compact ? 28 : 32}/></button>
            <div className="native-session-name agent-card-name" title={title}>{title}</div>
            <ModelPill model={s.model} provider={s.provider}/>
            <div className="agent-card-time mono" title={`${lifetime}; ${freshness}`} aria-label={`${lifetime}, ${freshness}`}>
              <Icon.Clock size={13}/>
              <span>{lifetime}</span><span aria-hidden="true">/</span><span>{freshness}</span>
            </div>
          </div>

          <div className="agent-card-operations">
            <div className="agent-card-field agent-card-role-field">
              <label className="agent-card-field-label agent-card-role-label" htmlFor={roleControlId}>Role</label>
              <div className="agent-card-role-control" onPointerDown={containRoleControl} onClick={containRoleControl}>
                <span className="agent-card-role-emblem" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 1.75 13 3.75v3.75c0 3.05-2.03 5.5-5 6.75-2.97-1.25-5-3.7-5-6.75V3.75L8 1.75Z"/>
                    <path d="m5.75 7.8 1.5 1.5 3-3"/>
                  </svg>
                </span>
                <span className="agent-card-role-value" aria-hidden="true">{s.role || 'clear'}</span>
                <RoleSelect id={roleControlId} value={s.role || ''} onChange={assignRole} disabled={!s.session_id}/>
              </div>
              {roleToast && <div className="orch-toast err cc-toast" key={roleToast.id}>{roleToast.msg}</div>}
            </div>
            <div className={`agent-card-field agent-card-communication communication-${communication}`}>
              <span className="agent-card-field-label">Communication</span>
              <span className="agent-card-field-value"><span className="agent-card-communication-icon" aria-hidden="true">{communication === 'live' ? '↗' : communication === 'offline' ? '×' : '?'}</span>{communicationLabel}</span>
            </div>
            <div className="agent-card-field agent-card-dispatch-field">
              <span className="agent-card-field-label">Current work</span>
              {currentTicket ? (
                <a
                  className="agent-card-ticket mono"
                  href={window.Router.buildHref({ kind: 'ticket', id: currentTicket.id })}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.Router.openTicket(currentTicket.id); }}
                  title={currentTicket.title || ticketLabel}
                  aria-label={`Open ticket ${ticketLabel}${currentTicket.title ? `: ${currentTicket.title}` : ''}`}
                >{ticketLabel}</a>
              ) : <span className="agent-card-field-value is-empty">No current work</span>}
            </div>
            <div className="agent-card-field">
              <span className="agent-card-field-label">Dispatches</span>
              <span className={`agent-card-field-value ${pendingCount ? '' : 'is-empty'}`} title={pendingCount ? `${pendingCount} queued dispatch${pendingCount === 1 ? '' : 'es'}` : undefined}>{pendingCount ? `${pendingCount} queued` : 'Queue clear'}</span>
            </div>
            <div className="agent-card-field agent-card-peek-field">
              <span className="agent-card-field-label">Console</span>
              <button
                type="button"
                className="orch-btn small ghost agent-card-peek-btn"
                onClick={(e) => { e.stopPropagation(); openPeek(); }}
                title={`Open live terminal & steer console for ${title}`}
              >
                ›_ Peek
              </button>
            </div>
          </div>
        </div>
      </div>

      {unackedWarnings.length > 0 && (
        <div className="agent-card-attention-footer">
          {unackedWarnings.map((warning) => window.UnackedDispatchBadge ? <window.UnackedDispatchBadge key={warning.envelope_id || warning.delivery_event_id || warning.warning_event_id} warning={warning}/> : null)}
        </div>
      )}

      {showControls && (hasChannel ? (
        <div className="agent-card-controls-footer"><SessionControls session={s} channel={channel}/></div>
      ) : (
        s.alive && (
          <div className="agent-card-controls-footer"><div className="cc-session-nochannel" title="No golem channel registered for this session — briefs and interrupts are unavailable.">
            <span className="cc-nochannel-dot"/>{window.Store.getChannels().length > 0 ? 'no channel (pre-v4 session) — restart to enable controls' : 'no channel — controls unavailable'}
          </div></div>
        )
      ))}
    </article>
  );
}

function SessionControls({ session: s, channel }) {
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [toast, setToast] = React.useState(null);
  const sid = s.session_id;

  const flash = (msg, kind = 'ok') => {
    setToast({ msg, kind, id: Math.random() });
    setTimeout(() => setToast(null), 2600);
  };
  const run = React.useCallback(async (fn, label) => {
    setBusy(true);
    try {
      await fn();
      flash(`${label} sent`, 'ok');
      return true;
    } catch (err) {
      console.error(`${label} failed`, err);
      flash(`${label} failed`, 'err');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  const sendBrief = React.useCallback(async () => {
    const t = text.trim();
    if (!t || busy) return;
    const ok = await run(() => window.SubstrateAPI.pushBrief(t, sid), 'Brief');
    if (ok) setText('');
  }, [text, busy, sid, run]);

  return (
    <div className="cc-session-controls" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="cc-composer">
        <input
          className="cc-composer-input"
          placeholder="Send a brief to this session..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendBrief(); } }}
          disabled={busy}
        />
        <button className="orch-btn primary small" disabled={busy || !text.trim()} onClick={sendBrief}>Send</button>
      </div>
      <div className="cc-session-buttons">
        <button className="orch-btn small" disabled={busy} onClick={() => run(() => window.SubstrateAPI.pushInterrupt(text.trim() || 'interrupt from dashboard', sid), 'Interrupt')}>Interrupt</button>
        <button className="orch-btn small ghost" disabled={busy} onClick={() => { if (confirm(`Halt session ${(sid || '').slice(0, 8)} — gracefully yield after current dispatch?`)) run(() => window.SubstrateAPI.pushHalt('Halt requested from dashboard', sid), 'Halt'); }}>Halt</button>
        <span className="cc-channel-tag mono" title={`channel ${channel.url || `${channel.host}:${channel.port}`}`}>:{channel.port}</span>
      </div>
      {toast && <div className={`orch-toast ${toast.kind} cc-toast`} key={toast.id}>{toast.msg}</div>}
    </div>
  );
}

// Hook for components to subscribe to store changes and re-render.
function useStore() {
  const [, force] = React.useReducer((n) => n + 1, 0);
  React.useEffect(() => {
    return window.Store.subscribe(() => force());
  }, []);
  return window.Store;
}

window.Avatar = Avatar;
window.ProjectGlyph = ProjectGlyph;
window.Carousel = Carousel;
window.CarouselControls = CarouselControls;
window.ConnectionPill = ConnectionPill;
window.PlanProgress = PlanProgress;
window.AgentCard = AgentCard;
window.SessionControls = SessionControls;
window.useStore = useStore;
