// Sidebar + Topbar shell — adapted to use window.Store instead of SubstrateData.

function Sidebar({ route, setRoute }) {
  useStore();
  const [pinnedIds, setPinnedIds] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem('golem.sidebar.pinnedProjects') || '[]'); } catch { return []; }
  });
  const projects = window.Store.getState().projects;
  const activeCount = window.Store.getNativeSessions().length;
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
  const pinned = projects.filter((p) => pinnedIds.includes(p.id));
  const recentCompact = [...buckets.active, ...buckets.recent].filter((p) => !pinnedIds.includes(p.id)).slice(0, 5);
  const visibleProjects = [...pinned, ...recentCompact];
  const projectCount = visibleProjects.length;
  const togglePin = (id) => {
    const next = pinnedIds.includes(id) ? pinnedIds.filter((x) => x !== id) : [...pinnedIds, id];
    setPinnedIds(next);
    localStorage.setItem('golem.sidebar.pinnedProjects', JSON.stringify(next));
  };

  // GOL-13: 3 core views — Workspace (/ + /projects + /project/:id),
  // Swarm Ops (/agents), Settings (/settings + /substrate). Tracker / Specs /
  // Logs boards and CEO chat were pruned.
  const items = [
    { id: 'dashboard', label: 'Workspace', icon: Icon.Projects, count: buckets.active.length, kinds: ['dashboard', 'projects', 'project'] },
    { id: 'agents', label: 'Swarm', icon: Icon.Agents, count: activeCount, kinds: ['agents'] },
    { id: 'substrate', label: 'Substrate', icon: Icon.Substrate || Icon.Projects, kinds: ['substrate'] },
    { id: 'settings', label: 'Settings', icon: Icon.Gear, kinds: ['settings'] },
  ];

  const isActive = (id) => {
    const entry = items.find((x) => x.id === id);
    if (!entry) return false;
    const kinds = entry.kinds || [entry.id];
    return kinds.includes(route.kind);
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
          const ageDays = p.last_activity_at ? Math.floor((Date.now() - p.last_activity_at) / DAY) : null;
          const freshness = buckets.archived.includes(p) ? 'archived'
            : buckets.stale.includes(p) ? 'stale'
            : live === 0 ? 'offline'
            : null;
          return (
            <div className="sidebar-project-row" key={p.id}>
            <a href={href} className={`sidebar-link ${active ? 'active' : ''}`}
              onClick={(e) => { e.preventDefault(); setRoute({ kind: 'project', id: p.id, tab: 'agents' }); }}>
              <span className="sidebar-link-icon" style={{ color: p.color }}>
                <span style={{
                  width: 8, height: 8, borderRadius: 2, background: p.color, display: 'inline-block',
                  boxShadow: live ? `0 0 6px ${p.color}` : 'none'
                }}/>
              </span>
              <span>{p.name}</span>
              {label === 'Pinned' && freshness && <span className={`sidebar-freshness ${freshness}`} title={ageDays == null ? 'No recorded activity' : `Last activity ${ageDays}d ago`}>{freshness}{ageDays != null ? ` · ${ageDays}d` : ''}</span>}
              <span className="sidebar-link-count">{live}</span>
            </a>
            <button className={`sidebar-pin ${pinnedIds.includes(p.id) ? 'active' : ''}`} onClick={() => togglePin(p.id)}
              aria-label={`${pinnedIds.includes(p.id) ? 'Unpin' : 'Pin'} ${p.name}`} title={`${pinnedIds.includes(p.id) ? 'Unpin' : 'Pin'} project`}>★</button>
            </div>
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
          {visibleProjects.length === 0 && (
            <div style={{ padding: '8px 8px 0', fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
              no projects discovered
            </div>
          )}
          {/* TKT-0107: bucketed groups by 7/30/90-day activeness. Each bucket
              renders as its own labeled section; live sessions bubble to the
              top of their bucket. */}
          {renderBucket('Pinned', pinned, 'bucket-pinned')}
          {renderBucket('Recent', recentCompact, 'bucket-recent')}
          <a href="/projects" className="sidebar-see-all" onClick={(e) => { e.preventDefault(); setRoute({ kind: 'projects' }); }}>
            See all projects <span className="tnum">{projects.length}</span>
          </a>
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
        <div className="sidebar-footer-status">
          <div className="sidebar-footer-dot"/>
          <div className="sidebar-footer-copy">
            <div>HARNESS · {window.Store.getState().connection === 'connected' ? 'ONLINE' : 'OFFLINE'}</div>
            <div className="sidebar-footer-version">v{window.__GOLEM_VERSION__}</div>
          </div>
        </div>
        <TweaksButton/>
      </div>
    </aside>
  );
}

function Topbar({ route, setRoute }) {
  useStore();
  const crumbs = [];
  crumbs.push({ label: 'Workspace', href: window.Router.buildHref({ kind: 'dashboard' }), onClick: () => setRoute({ kind: 'dashboard' }) });
  if (route.kind === 'dashboard') crumbs.push({ label: 'Dashboard', current: true });
  if (route.kind === 'projects') crumbs.push({ label: 'Projects', current: true });
  if (route.kind === 'agents') crumbs.push({ label: 'Swarm', current: true });
  if (route.kind === 'settings') crumbs.push({ label: 'Settings', current: true });
  if (route.kind === 'project') {
    crumbs.push({ label: 'Projects', href: window.Router.buildHref({ kind: 'projects' }), onClick: () => setRoute({ kind: 'projects' }) });
    const p = window.Store.getProject(route.id);
    crumbs.push({ label: p?.name || route.id, current: true });
  }

  // v4 (fix round 2, defect 3): count ALIVE native sessions, not stale v3
  // journal agents — these are what is actually running on the machine.
  const live = window.Store.getAliveSessionCount();
  const working = window.Store.getWorkingSessionCount();
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
        <span className="topbar-meta-item">
          <Icon.Activity/> {live} live <span className="topbar-meta-sep">|</span> {working} working
        </span>
        <ConnectionPill status={connection}/>
      </div>
    </header>
  );
}

window.Sidebar = Sidebar;
window.Topbar = Topbar;

// GOL-13: Project-scoped Ideas link. The count reflects the ideas for
// the current project when on a project page, otherwise the global queue
// (legacy). Lives in the sidebar's normal flow (no position:fixed) so it
// can't cover the footer.
function SidebarIdeasLink() {
  useStore();
  const route = window.Router ? window.Router.parseLocation() : { kind: 'dashboard' };
  const projectId = route.kind === 'project' ? route.id : null;
  const [count, setCount] = React.useState(0);
  const refresh = React.useCallback(() => {
    window.SubstrateAPI.listIdeas(projectId)
      .then((rows) => setCount(Array.isArray(rows) ? rows.length : 0))
      .catch(() => {});
  }, [projectId]);
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
