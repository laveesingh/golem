// Sidebar + Topbar shell — adapted to use window.Store instead of SubstrateData.

function Sidebar({ route, setRoute }) {
  useStore();
  const [includeStale, setIncludeStale] = React.useState(false);
  const projects = window.Store.getState().projects;
  const activeCount = window.Store.getAliveSessionCount();
  // TKT-0107: bucket by last_activity_at instead of the binary stale flag.
  // Thresholds: ≤7d = Active, ≤30d = Recent, ≤90d = Stale, >90d = Archived (only
  // shown when "Include stale" is on).
  const now = Date.now();
  const DAY = 86400_000;
  const buckets = React.useMemo(() => {
    const active = [], recent = [], stale = [], archived = [];
    for (const p of projects) {
      const la = p.last_activity_at || p.last_seen_at || 0;
      const age = la > 0 ? (now - la) / DAY : Infinity;
      if (age <= 7) active.push(p);
      else if (age <= 30) recent.push(p);
      else if (age <= 90) stale.push(p);
      else archived.push(p);
    }
    // Within each bucket, sort by live-session-count desc, then by
    // last_activity_at desc.
    const sortFn = (a, b) => {
      const la = window.Store.getProjectAliveSessions(a).length;
      const lb = window.Store.getProjectAliveSessions(b).length;
      if (la !== lb) return lb - la;
      return (b.last_activity_at || 0) - (a.last_activity_at || 0);
    };
    active.sort(sortFn); recent.sort(sortFn); stale.sort(sortFn); archived.sort(sortFn);
    return { active, recent, stale, archived };
  }, [projects, now]);
  const visibleProjects = includeStale
    ? [...buckets.active, ...buckets.recent, ...buckets.stale, ...buckets.archived]
    : [...buckets.active, ...buckets.recent, ...buckets.stale];
  const projectCount = visibleProjects.length;

  const items = [
    { id: 'dashboard', label: 'Dashboard', icon: Icon.Dashboard },
    { id: 'tracker', label: 'Tracker', icon: Icon.Tracker },
    { id: 'projects', label: 'Projects', icon: Icon.Projects, count: buckets.active.length },
    { id: 'agents', label: 'Agents', icon: Icon.Agents, count: activeCount },
    { id: 'logs', label: 'Journals & Logs', icon: Icon.Logs },
  ];

  const isActive = (id) => {
    if (route.kind === 'project') return id === 'projects';
    return route.kind === id;
  };

  // Render one bucket as a labeled section.
  const renderBucket = (label, list, klass) => {
    if (list.length === 0) return null;
    return (
      <div className={`sidebar-bucket ${klass}`}>
        <div className="sidebar-bucket-label">{label} <span className="tnum">{list.length}</span></div>
        {list.map(p => {
          const active = route.kind === 'project' && route.id === p.id;
          const live = window.Store.getProjectAliveSessions(p).length;
          const href = window.Router.buildHref({ kind: 'project', id: p.id, tab: 'agents' });
          return (
            <a
              key={p.id}
              href={href}
              className={`sidebar-link ${active ? 'active' : ''}`}
              onClick={(e) => { e.preventDefault(); setRoute({ kind: 'project', id: p.id, tab: 'agents' }); }}
            >
              <span className="sidebar-link-icon" style={{ color: p.color }}>
                <span style={{
                  width: 8, height: 8, borderRadius: 2, background: p.color, display: 'inline-block',
                  boxShadow: live ? `0 0 6px ${p.color}` : 'none'
                }}/>
              </span>
              <span>{p.name}</span>
              <span className="sidebar-link-count">{live}</span>
            </a>
          );
        })}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-mark">G</div>
        <div>
          <div className="sidebar-brand-text">Golem</div>
          <div className="sidebar-brand-sub">golem · command center</div>
        </div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-label">Workspace</div>
        <nav className="sidebar-nav">
          {items.map(item => {
            const I = item.icon;
            const href = window.Router.buildHref({ kind: item.id });
            return (
              <a
                key={item.id}
                href={href}
                className={`sidebar-link ${isActive(item.id) ? 'active' : ''}`}
                onClick={(e) => { e.preventDefault(); setRoute({ kind: item.id }); }}
              >
                <span className="sidebar-link-icon"><I /></span>
                <span>{item.label}</span>
                {item.count != null && <span className="sidebar-link-count">{item.count}</span>}
              </a>
            );
          })}
        </nav>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-label">Projects</div>
        <nav className="sidebar-nav">
          <label className="sidebar-stale-toggle">
            <input
              type="checkbox"
              checked={includeStale}
              onChange={(e) => setIncludeStale(e.target.checked)}
            />
            Include stale
          </label>
          {visibleProjects.length === 0 && (
            <div style={{ padding: '8px 8px 0', fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
              no projects discovered
            </div>
          )}
          {/* TKT-0107: bucketed groups by 7/30/90-day activeness. Each bucket
              renders as its own labeled section; live sessions bubble to the
              top of their bucket. */}
          {renderBucket('Active', buckets.active, 'bucket-active')}
          {renderBucket('Recent', buckets.recent, 'bucket-recent')}
          {renderBucket('Stale', buckets.stale, 'bucket-stale')}
          {includeStale && renderBucket('Archived', buckets.archived, 'bucket-archived')}
        </nav>
      </div>

      {/* TKT-0206: Ideas link in the menu bar (second-last fixed section,
          before the HARNESS footer). Floating-anchor style was rejected
          because the button covered the sidebar's footer. Now it lives
          IN the sidebar flow — the user clicks the menu bar item, the
          Ideas drawer slides in (same ?ideas=1 overlay as before). The
          count badge mirrors the queue size and updates on ideas:changed. */}
      <SidebarIdeasLink/>

      <div className="sidebar-footer">
        <div className="sidebar-footer-dot"/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div>HARNESS · {window.Store.getState().connection === 'connected' ? 'ONLINE' : 'OFFLINE'}</div>
          <div style={{ color: 'var(--text-3)', marginTop: 2 }}>v0.1.0</div>
        </div>
        <TweaksButton/>
      </div>
    </aside>
  );
}

function Topbar({ route, setRoute }) {
  useStore();
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

  const crumbs = [];
  crumbs.push({ label: 'Workspace', href: window.Router.buildHref({ kind: 'dashboard' }), onClick: () => setRoute({ kind: 'dashboard' }) });
  if (route.kind === 'dashboard') crumbs.push({ label: 'Dashboard', current: true });
  if (route.kind === 'tracker') crumbs.push({ label: 'Tracker', current: true });
  if (route.kind === 'projects') crumbs.push({ label: 'Projects', current: true });
  if (route.kind === 'agents') crumbs.push({ label: 'Agents', current: true });
  if (route.kind === 'logs') crumbs.push({ label: 'Journals & Logs', current: true });
  if (route.kind === 'project') {
    crumbs.push({ label: 'Projects', href: window.Router.buildHref({ kind: 'projects' }), onClick: () => setRoute({ kind: 'projects' }) });
    const p = window.Store.getProject(route.id);
    crumbs.push({ label: p?.name || route.id, current: true });
  }

  // v4 (fix round 2, defect 3): count ALIVE native sessions, not stale v3
  // journal agents — these are what is actually running on the machine.
  const live = window.Store.getAliveSessionCount();
  const connection = window.Store.getState().connection;

  return (
    <header className="topbar">
      <div className="crumb">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="crumb-sep">/</span>}
            {c.current
              ? <span className="crumb-current">{c.label}</span>
              : <a href={c.href} className="crumb-link" onClick={(e) => { e.preventDefault(); c.onClick && c.onClick(); }}>{c.label}</a>}
          </React.Fragment>
        ))}
      </div>
      <div className="topbar-spacer"/>
      <div className="topbar-meta">
        <ConnectionPill status={connection}/>
        <span className="topbar-meta-item">
          <Icon.Activity/> {live} session{live === 1 ? '' : 's'} live
        </span>
        <span className="topbar-meta-item">
          <Icon.Clock/> {window.SubstrateFmt.fmtClock(now)}
        </span>
      </div>
    </header>
  );
}

window.Sidebar = Sidebar;
window.Topbar = Topbar;

// TKT-0206: Ideas link in the sidebar menu bar. Click → Router.openIdeas()
// (opens the existing IdeasDrawer via the ?ideas=1 overlay). The count
// badge mirrors the queue size and refreshes on the shared 'ideas:changed'
// event so post/pop from anywhere in the app stay in sync.
//
// Lives in the sidebar's normal flow (no position:fixed, no z-index),
// so it can't cover the sidebar footer (HARNESS · ONLINE, TweaksButton)
// or any other sidebar content — which is the regression that killed
// the floating-anchor version.
function SidebarIdeasLink() {
  const [count, setCount] = React.useState(0);
  const refresh = React.useCallback(() => {
    window.SubstrateAPI.listIdeas()
      .then((rows) => setCount(Array.isArray(rows) ? rows.length : 0))
      .catch(() => {});
  }, []);
  React.useEffect(() => {
    refresh();
    window.addEventListener('ideas:changed', refresh);
    return () => window.removeEventListener('ideas:changed', refresh);
  }, [refresh]);
  return (
    <div className="sidebar-section sidebar-section-ideas">
      <nav className="sidebar-nav">
        <a
          href="#"
          className="sidebar-link sidebar-link-ideas"
          onClick={(e) => { e.preventDefault(); window.Router.openIdeas(); }}
          title="Open the ideas stack"
        >
          <span className="sidebar-link-icon"><Icon.Lightbulb/></span>
          <span>Ideas</span>
          {count > 0 && <span className="sidebar-link-count">{count}</span>}
        </a>
      </nav>
    </div>
  );
}

window.SidebarIdeasLink = SidebarIdeasLink;
