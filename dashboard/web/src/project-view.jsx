// Project view (v4) — unified 3-pane Spec Cockpit & Project Tracker Board (GOL-14, GOL-23, GOL-24, GOL-32-36).
// Spec Navigator (L) | Document + Tasks + Spacious Reviews (C) | Swarm Fleet (R).
// Fully interactive: text selection annotations, embedded comment threads below spec with 1-click dispatch/resolve,
// newest-first folded comments, clean delete for specs/tasks, worker termination, and Kanban Tracker Board view.

const { useState: usePVState, useEffect, useMemo, useRef } = window.React;

const PV_LAYOUT_KEY = 'golem.pv.layout.v1';
const EmptyCard = window.EmptyCard || (({label, hint}) => window.React.createElement('div', {className:'empty-card'}, window.React.createElement('div', null, label), hint && window.React.createElement('div', {className:'empty-card-hint'}, hint)));

// ── Spec stage groupings for left navigator
const SPEC_STAGES = [
  { id: 'drafting', label: 'Drafting', icon: '📝', states: ['todo'], color: 'var(--status-open)' },
  { id: 'brainstorm', label: 'Brainstorm & Lock', icon: '🔒', states: ['in_progress'], color: 'var(--status-running)' },
  { id: 'building', label: 'In Build / Verifying', icon: '⚡', states: ['blocked', 'review'], color: 'var(--status-review)' },
  { id: 'closed', label: 'Closed', icon: '✅', states: ['done', 'archived'], color: 'var(--status-done)' },
];

function specStageFor(state) {
  for (const g of SPEC_STAGES) if (g.states.includes(state)) return g;
  return SPEC_STAGES[0];
}

function useActiveSpecId(projectId, specs) {
  const key = `golem.cockpit.activeSpec.${projectId}`;
  const [active, setActive] = window.React.useState(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved && specs.some(s => s.id === saved || s.display_id === saved)) return saved;
    } catch {}
    return specs[0]?.id || null;
  });
  window.React.useEffect(() => {
    if (!specs.length) { setActive(null); return; }
    if (active && specs.some(s => s.id === active || s.display_id === active)) return;
    const sorted = [...specs].sort((a,b) => (Date.parse(b.updated_at||b.created_at||'')||0) - (Date.parse(a.updated_at||a.created_at||'')||0));
    const next = sorted[0]?.id || specs[0].id;
    setActive(next);
    try { localStorage.setItem(key, next); } catch {}
  }, [specs, active, key]);
  const set = (id) => {
    setActive(id);
    try { localStorage.setItem(key, id); } catch {}
  };
  return [active, set];
}

// ── Helpers
function fmtAgo(iso) { return window.SubstrateFmt?.fmtTimeAgo?.(iso) || ''; }
function fmtClock(iso) { return window.SubstrateFmt?.fmtClock?.(iso) || iso || ''; }
function renderMd(text) {
  if (!text) return '';
  return window.SubstrateFmt?.renderMarkdown ? window.SubstrateFmt.renderMarkdown(text) : String(text);
}
function authorMeta(author, labelHint) {
  if (author === 'human' || author === 'you' || author === 'human:dashboard') return { label: 'Lavee', color: '#f5a623' };
  if (labelHint) return { label: labelHint, color: '#9aa4bb' };
  const s = window.Store?.getNativeSessionById?.(author);
  if (s?.label || s?.name) return { label: s.label || s.name, color: '#9aa4bb' };
  return { label: author || 'Agent', color: '#9aa4bb' };
}
function nextStateFor(state) {
  const order = { todo: 'in_progress', in_progress: 'review', review: 'done', done: 'todo', blocked: 'in_progress', archived: 'todo' };
  return order[state] || 'todo';
}
function roleGlyph(role) {
  const r = String(role||'').toLowerCase();
  if (r==='designer') return 'DS';
  if (r==='builder') return 'BU';
  if (r==='explorer') return 'EX';
  if (r==='lead') return 'LE';
  if (r==='reviewer') return 'RE';
  return r.slice(0,2).toUpperCase() || 'AG';
}
function statePillClass(state) {
  const map = { todo: 'idle', in_progress: 'running', blocked: 'blocked', review: 'review', done: 'done', archived: 'done' };
  return map[state] || 'idle';
}

// ── Isolated Live Elapsed Timer (prevents re-rendering parent worker cards)
function LiveElapsedTimer({ iso }) {
  const [elapsed, setElapsed] = window.React.useState(() => {
    if (!iso) return 0;
    return Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  });
  window.React.useEffect(() => {
    if (!iso) return;
    const interval = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000)));
    }, 1000);
    return () => clearInterval(interval);
  }, [iso]);

  if (!iso) return null;
  const str = window.SubstrateFmt?.fmtRuntime ? window.SubstrateFmt.fmtRuntime(elapsed) : `${elapsed}s`;
  return <span className="cockpit-swarm-timer tnum">{str}</span>;
}

// ── ProjectView — Cockpit or Tracker Board
function ProjectView({ projectId, tab, setRoute }) {
  (window.useStore ? window.useStore() : null);
  const project = window.Store.getProject(projectId);
  if (!project) {
    return (
      <div className="page">
        <EmptyCard label="unknown project"
          hint={<>Project <span className="mono">{projectId}</span> wasn't found under <span className="mono">GOLEM_PROJECTS_ROOT</span>.</>}
        />
      </div>
    );
  }
  const cid = project.project_id || project.id;
  const milestones = project.milestones || [];
  const [directiveOpen, setDirectiveOpen] = window.React.useState(false);
  const [peekSessionId, setPeekSessionId] = window.React.useState(null);
  const [spawnOpen, setSpawnOpen] = window.React.useState(false);
  const [activeView, setActiveView] = window.React.useState('cockpit'); // 'cockpit' | 'tracker'

  // Resizable Panes State (persisted in localStorage)
  const [leftWidth, setLeftWidth] = window.React.useState(() => {
    try {
      const v = parseInt(localStorage.getItem('golem.cockpit.leftWidth'), 10);
      if (v >= 180 && v <= 550) return v;
    } catch {}
    return 280;
  });
  const [rightWidth, setRightWidth] = window.React.useState(() => {
    try {
      const v = parseInt(localStorage.getItem('golem.cockpit.rightWidth'), 10);
      if (v >= 240 && v <= 650) return v;
    } catch {}
    return 320;
  });

  const startResizeLeft = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = leftWidth;
    document.body.style.userSelect = 'none';
    const onMove = (moveEv) => {
      const newW = Math.max(180, Math.min(550, startW + (moveEv.clientX - startX)));
      setLeftWidth(newW);
      try { localStorage.setItem('golem.cockpit.leftWidth', String(newW)); } catch {}
    };
    const onUp = () => {
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startResizeRight = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rightWidth;
    document.body.style.userSelect = 'none';
    const onMove = (moveEv) => {
      const newW = Math.max(240, Math.min(650, startW - (moveEv.clientX - startX)));
      setRightWidth(newW);
      try { localStorage.setItem('golem.cockpit.rightWidth', String(newW)); } catch {}
    };
    const onUp = () => {
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  window.React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setDirectiveOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const aliveSessions = window.Store.getProjectAliveSessions(project);
  const allProjectTickets = window.Store.getTrackerTickets({ project_id: cid, includeArchived: true });
  const canonicalTotal = allProjectTickets.filter(t => t.kind !== 'spec' && t.state !== 'archived').length;
  const canonicalDone = allProjectTickets.filter(t => t.kind !== 'spec' && t.state === 'done').length;
  const canonicalPct = canonicalTotal ? Math.round((canonicalDone / canonicalTotal) * 100) : 0;

  const allSpecs = allProjectTickets.filter(t => t.kind === 'spec');
  const specsSorted = window.React.useMemo(() => {
    return [...allSpecs].sort((a,b) => (Date.parse(b.updated_at||b.created_at||'')||0) - (Date.parse(a.updated_at||a.created_at||'')||0));
  }, [allSpecs]);
  const [activeSpecId, setActiveSpecId] = useActiveSpecId(cid, specsSorted);
  const activeSpec = window.React.useMemo(() => {
    if (!activeSpecId) return null;
    return specsSorted.find(s => s.id === activeSpecId || s.display_id === activeSpecId) || specsSorted[0] || null;
  }, [activeSpecId, specsSorted]);

  // Lifecycle-Aware Next Action CTA
  const nextAction = window.React.useMemo(() => {
    if (!activeSpec) {
      if (allSpecs.length === 0) {
        return {
          icon: '🚀',
          title: 'Start First Flight',
          desc: 'Create your first living spec to begin agentic development',
          cta: 'Create First Spec',
          run: () => window.Router?.openComposer?.(cid, { kind: 'spec' }),
        };
      }
      return {
        icon: '📋',
        title: 'Select a Spec',
        desc: 'Choose an active spec from the left tree to review or dispatch',
        cta: 'View First Spec',
        run: () => allSpecs[0] && setActiveSpecId(allSpecs[0].display_id || allSpecs[0].id),
      };
    }
    const specTickets = allProjectTickets.filter(t => t.parent_id === activeSpec.id);
    const specComments = window.Store.getTicketComments(activeSpec.id) || [];
    const openComments = specComments.filter(c => c.status === 'open' && c.dispatch_state !== 'addressed');
    const todoTasks = specTickets.filter(t => t.state === 'todo');
    const inProgTasks = specTickets.filter(t => t.state === 'in_progress');
    const reviewTasks = specTickets.filter(t => t.state === 'review');
    const doneTasksCount = specTickets.filter(t => t.state === 'done').length;

    if (activeSpec.state === 'todo') {
      return {
        icon: '⚡',
        title: 'Draft & Decompose',
        desc: 'Define acceptance criteria and break down into executable tasks',
        cta: '⚡ Decompose Tasks',
        run: () => window.Router?.openComposer?.(cid, { kind: 'task', parent: activeSpec.id }),
      };
    }
    if (openComments.length > 0) {
      return {
        icon: '💬',
        title: `Resolve Feedback (${openComments.length} Open)`,
        desc: `${openComments.length} comment${openComments.length === 1 ? '' : 's'} awaiting resolution or dispatch`,
        cta: 'Review Comments ➔',
        run: () => {
          const el = document.querySelector('.cockpit-center-comments');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        },
      };
    }
    if (todoTasks.length > 0 && inProgTasks.length === 0) {
      return {
        icon: '🐝',
        title: `Launch Swarm (${todoTasks.length} Tasks Ready)`,
        desc: `Dispatch queued subtasks to available workers in isolated worktrees`,
        cta: 'Talk to Lead ⌘K',
        run: () => setDirectiveOpen(true),
      };
    }
    if (reviewTasks.length > 0) {
      return {
        icon: '🔍',
        title: `Verify Work (${reviewTasks.length} in Review)`,
        desc: `${reviewTasks.length} task${reviewTasks.length === 1 ? '' : 's'} ready for evidence check and verification`,
        cta: 'Review Tasks ➔',
        run: () => {
          const el = document.querySelector('.task-subtable');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        },
      };
    }
    if (activeSpec.state !== 'done' && activeSpec.state !== 'archived') {
      if (specTickets.length > 0 && doneTasksCount === specTickets.length) {
        return {
          icon: '✓',
          title: 'All Tasks Shipped',
          desc: 'All subtasks complete — verify evidence and land spec',
          cta: 'Verify & Land Spec',
          run: () => {
            window.SubstrateAPI?.updateTicket(activeSpec.display_id || activeSpec.id, { state: 'done', actor: 'human:dashboard' })
              .then(u => { if (u && u.id) window.Store.upsertTrackerTicket(u); });
          },
        };
      }
    }
    return {
      icon: '✅',
      title: 'Spec Complete',
      desc: 'All work items verified and landed on branch',
      cta: '+ New Spec',
      run: () => window.Router?.openComposer?.(cid, { kind: 'spec' }),
    };
  }, [activeSpec?.id, activeSpec?.state, allProjectTickets.length, allSpecs.length, cid]);

  return (
    <div className="page project-cockpit-page">
      {/* Hero Bar with View Switcher */}
      <div className="project-hero cockpit-hero">
        <div
          className="project-hero-glyph"
          style={{
            background: `color-mix(in oklab, ${project.color} 18%, var(--bg-2))`,
            color: project.color,
            border: `1px solid color-mix(in oklab, ${project.color} 30%, transparent)`,
          }}
        >
          {project.glyph}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <h1 className="project-hero-name" style={{ margin: 0 }}>{project.name}</h1>
            {/* View Switcher: Spec Cockpit vs Tracker Board */}
            <div className="cockpit-top-view-switcher">
              <button
                className={`view-switch-btn ${activeView === 'cockpit' ? 'active' : ''}`}
                onClick={() => setActiveView('cockpit')}
                title="Unified Spec-First Cockpit"
              >
                📋 Spec Cockpit
              </button>
              <button
                className={`view-switch-btn ${activeView === 'tracker' ? 'active' : ''}`}
                onClick={() => setActiveView('tracker')}
                title="Classic High-Level Kanban Tracker"
              >
                📊 Tracker Board
              </button>
            </div>
          </div>
          <div className="project-hero-meta" style={{ marginTop: 4 }}>
            <span className="mono">{project.project_id || project.id}</span>
            <span className="sep">·</span>
            <span>{milestones.length} milestones</span>
            <span className="sep">·</span>
            <span style={{ color: 'var(--status-active)' }}>{aliveSessions.length} live worker{aliveSessions.length === 1 ? '' : 's'}</span>
            <span className="sep">·</span>
            <span className="mono" title="Canonical tracker truth">{canonicalDone}/{canonicalTotal} tasks</span>
            <span className="mono" style={{color: project.color}}>{canonicalPct}%</span>
          </div>
        </div>
        <div className="cockpit-hero-actions">
          <button className="orch-btn ghost small" onClick={()=> setDirectiveOpen(true)} title="Talk to Lead (Cmd+K)">💬 Talk to Lead <span className="mono" style={{opacity:.6, marginLeft:6}}>⌘K</span></button>
          <button className="orch-btn small" onClick={()=> setSpawnOpen(true)} title="Add worker">+ Add Worker</button>
        </div>
      </div>

      {activeView === 'cockpit' ? (
        <>
          {/* Next Action Banner */}
          {nextAction && (
            <div className="cockpit-next-action-bar">
              <div className="cockpit-next-action-left">
                <span className="cockpit-next-action-icon">{nextAction.icon}</span>
                <div className="cockpit-next-action-text">
                  <span className="cockpit-next-action-title">Next: {nextAction.title}</span>
                  <span className="cockpit-next-action-desc">{nextAction.desc}</span>
                </div>
              </div>
              {nextAction.cta && nextAction.run && (
                <button className="orch-btn primary small cockpit-next-action-btn" onClick={nextAction.run}>
                  {nextAction.cta}
                </button>
              )}
            </div>
          )}

          <div
            className="cockpit-grid"
            style={{
              gridTemplateColumns: `${leftWidth}px 4px minmax(0, 1fr) 4px ${rightWidth}px`
            }}
          >
            <CockpitLeft
              project={project}
              cid={cid}
              allTickets={allProjectTickets}
              specs={specsSorted}
              activeSpec={activeSpec}
              setActiveSpecId={setActiveSpecId}
            />
            <div
              className="cockpit-resizer left-resizer"
              onMouseDown={startResizeLeft}
              title="Drag to resize left navigation pane"
            />
            <CockpitCenter
              project={project}
              cid={cid}
              activeSpec={activeSpec}
              setRoute={setRoute}
            />
            <div
              className="cockpit-resizer right-resizer"
              onMouseDown={startResizeRight}
              title="Drag to resize swarm fleet pane"
            />
            <CockpitRight
              project={project}
              cid={cid}
              activeSpec={activeSpec}
              setRoute={setRoute}
              onPeek={setPeekSessionId}
              onSpawn={()=> setSpawnOpen(true)}
            />
          </div>
        </>
      ) : (
        /* High-Level Project Kanban Tracker Board */
        <ProjectTrackerBoardView
          project={project}
          cid={cid}
          tickets={allProjectTickets}
          onOpenTicket={(id) => window.Router.openTicket(id)}
        />
      )}

      {directiveOpen && window.DirectiveModal && window.React.createElement(window.DirectiveModal, {
        open: directiveOpen,
        onClose: ()=> setDirectiveOpen(false),
        projectId: cid,
        defaultSpecId: activeSpec?.display_id || activeSpec?.id || null
      })}
      {peekSessionId && window.PeekModal && window.React.createElement(window.PeekModal, {
        open: !!peekSessionId,
        sessionId: peekSessionId,
        onClose: ()=> setPeekSessionId(null)
      })}
      {spawnOpen && window.WorkerSpawnModal && window.React.createElement(window.WorkerSpawnModal, {
        open: spawnOpen,
        onClose: ()=> setSpawnOpen(false),
        defaultProjectId: cid
      })}
    </div>
  );
}

// ── LEFT: Spec Lifecycle Navigator (Clean Fold, Ticket Explorer & Delete)
function CockpitLeft({ project, cid, allTickets, specs, activeSpec, setActiveSpecId }) {
  const [viewMode, setViewMode] = window.React.useState('specs');
  const [ticketKindFilter, setTicketKindFilter] = window.React.useState('all');
  const [query, setQuery] = window.React.useState('');
  const [ideasCount, setIdeasCount] = window.React.useState(0);
  const qLower = query.trim().toLowerCase();

  window.React.useEffect(() => {
    let cancelled = false;
    const fetch = () => window.SubstrateAPI.listIdeas(cid).then(rows => {
      if (!cancelled) setIdeasCount(Array.isArray(rows) ? rows.length : 0);
    }).catch(()=>{});
    fetch();
    const onChange = () => fetch();
    window.addEventListener('ideas:changed', onChange);
    return () => { cancelled = true; window.removeEventListener('ideas:changed', onChange); };
  }, [cid]);

  const filteredSpecs = window.React.useMemo(() => {
    if (!qLower) return specs;
    return specs.filter(s =>
      (s.title||'').toLowerCase().includes(qLower) ||
      (s.display_id||'').toLowerCase().includes(qLower) ||
      (s.id||'').toLowerCase().includes(qLower)
    );
  }, [specs, qLower]);

  const groupedSpecs = window.React.useMemo(() => {
    const map = new Map(SPEC_STAGES.map(g => [g.id, []]));
    for (const s of filteredSpecs) {
      const g = specStageFor(s.state);
      map.get(g.id).push(s);
    }
    return map;
  }, [filteredSpecs]);

  const specMeta = window.React.useMemo(() => {
    const m = new Map();
    const allChildren = allTickets.filter(t => t.parent_id);
    for (const s of specs) {
      const children = allChildren.filter(c => c.parent_id === s.id);
      const total = children.length;
      const done = children.filter(c => c.state === 'done' || c.state === 'archived').length;
      const comments = window.Store.getTicketComments(s.id) || [];
      const openUndispatched = comments.filter(c => c.status === 'open' && c.dispatch_state === 'undispatched').length;
      const openTotal = comments.filter(c => c.status === 'open').length;
      m.set(s.id, { total, done, openUndispatched, openTotal, children });
    }
    return m;
  }, [specs, allTickets, window.Store.getState().ticketComments]);

  const filteredTickets = window.React.useMemo(() => {
    let rows = allTickets.filter(t => t.state !== 'archived');
    if (ticketKindFilter !== 'all') rows = rows.filter(t => t.kind === ticketKindFilter);
    if (qLower) {
      rows = rows.filter(t =>
        (t.title||'').toLowerCase().includes(qLower) ||
        (t.display_id||'').toLowerCase().includes(qLower) ||
        (t.id||'').toLowerCase().includes(qLower)
      );
    }
    return rows;
  }, [allTickets, ticketKindFilter, qLower]);

  const handleDeleteSpec = (e, specItem) => {
    e.stopPropagation();
    if (!confirm(`Delete spec ${specItem.display_id || specItem.id} ("${specItem.title}") and all its subtasks?`)) return;
    window.SubstrateAPI.deleteTicket(specItem.id || specItem.display_id).then(() => {
      window.Store.deleteTrackerTicket(specItem.id);
      if (specItem.display_id) window.Store.deleteTrackerTicket(specItem.display_id);
    }).catch(err => alert('Failed to delete spec: ' + (err.message || err)));
  };

  return (
    <div className="cockpit-left">
      <div className="cockpit-left-head">
        <button
          className="orch-btn primary cockpit-ideas-btn"
          onClick={() => window.Router.openIdeas()}
          title="Open project ideas"
        >
          <span>💡 Ideas</span>
          {ideasCount > 0 && <span className="cockpit-ideas-count">{ideasCount}</span>}
        </button>
        <button
          className="orch-btn ghost cockpit-new-spec"
          onClick={() => window.Router.openComposer(cid, { kind: viewMode === 'tickets' ? 'task' : 'spec' })}
          title={viewMode === 'tickets' ? 'New ticket' : 'New living spec'}
        >
          {viewMode === 'tickets' ? '+ Ticket' : '+ Spec'}
        </button>
      </div>

      <div className="cockpit-nav-tabs">
        <button
          className={`cockpit-nav-tab ${viewMode === 'specs' ? 'active' : ''}`}
          onClick={() => setViewMode('specs')}
        >
          <span>📋 Specs</span>
          <span className="cockpit-nav-tab-count tnum">{specs.length}</span>
        </button>
        <button
          className={`cockpit-nav-tab ${viewMode === 'tickets' ? 'active' : ''}`}
          onClick={() => setViewMode('tickets')}
        >
          <span>🎫 All Tickets</span>
          <span className="cockpit-nav-tab-count tnum">{allTickets.filter(t => t.state !== 'archived').length}</span>
        </button>
      </div>

      <div className="cockpit-search-wrap">
        <input
          className="cockpit-search"
          placeholder={viewMode === 'specs' ? 'Filter specs…' : 'Filter tickets…'}
          value={query}
          onChange={(e)=> setQuery(e.target.value)}
          aria-label="Filter"
        />
      </div>

      {viewMode === 'specs' ? (
        <div className="cockpit-tree">
          {SPEC_STAGES.map(group => {
            const list = groupedSpecs.get(group.id) || [];
            return (
              <div key={group.id} className="cockpit-stage-group">
                <div className="cockpit-stage-head">
                  <span className="cockpit-stage-label">
                    <span className="cockpit-stage-icon">{group.icon}</span> {group.label}
                  </span>
                  <span className="cockpit-stage-count tnum">{list.length}</span>
                </div>
                {list.length === 0 ? (
                  <div className="cockpit-stage-empty">—</div>
                ) : list.map(s => {
                  const meta = specMeta.get(s.id) || { total:0, done:0, openUndispatched:0, openTotal:0 };
                  const active = activeSpec && (activeSpec.id === s.id || activeSpec.display_id === s.display_id);
                  return (
                    <div
                      key={s.id}
                      className={`cockpit-spec-item ${active ? 'active' : ''}`}
                      onClick={()=> setActiveSpecId(s.id)}
                      title={`${s.display_id||s.id}: ${s.title}`}
                    >
                      <span className="cockpit-spec-indicator" style={{ background: group.color }}/>
                      <span className="cockpit-spec-main">
                        <span className="cockpit-spec-id mono">{s.display_id || s.id}</span>
                        <span className="cockpit-spec-title">{s.title}</span>
                      </span>
                      <span className="cockpit-spec-badges">
                        {meta.total > 0 && (
                          <span className="cockpit-pill cockpit-task-pill" title={`${meta.done}/${meta.total} tasks done`}>
                            {meta.done}/{meta.total}
                          </span>
                        )}
                        {meta.openUndispatched > 0 && (
                          <span className="cockpit-pill cockpit-comment-pill" title={`${meta.openUndispatched} undispatched feedback`}>
                            {meta.openUndispatched}💬
                          </span>
                        )}
                        {meta.openUndispatched === 0 && meta.openTotal > 0 && (
                          <span className="cockpit-pill cockpit-comment-pill quiet" title={`${meta.openTotal} open comments`}>
                            {meta.openTotal}💬
                          </span>
                        )}
                        <button
                          className="cockpit-delete-btn"
                          onClick={(e) => handleDeleteSpec(e, s)}
                          title="Delete spec"
                        >
                          ✕
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {specs.length === 0 ? (
            window.EmptyStateOnboardingCTA ? window.React.createElement(window.EmptyStateOnboardingCTA, { kind: 'specs', setRoute: () => window.Router && window.Router.go({ kind: 'onboarding' }) }) : <div className="cockpit-empty">No specs yet — create one with + Spec.</div>
          ) : filteredSpecs.length === 0 ? (
            <div className="cockpit-empty">No specs match filter.</div>
          ) : null}
        </div>
      ) : (
        <div className="cockpit-tickets-explorer">
          <div className="cockpit-kind-pills">
            {['all', 'task', 'doc', 'spec'].map(k => (
              <button
                key={k}
                className={`cockpit-filter-btn ${ticketKindFilter === k ? 'active' : ''}`}
                onClick={() => setTicketKindFilter(k)}
              >
                {k.toUpperCase()} ({allTickets.filter(t => (k === 'all' || t.kind === k) && t.state !== 'archived').length})
              </button>
            ))}
          </div>
          <div className="cockpit-tickets-list">
            {filteredTickets.map(t => {
              const isSpec = t.kind === 'spec';
              const active = isSpec && activeSpec && (activeSpec.id === t.id || activeSpec.display_id === t.display_id);
              return (
                <div
                  key={t.id}
                  className={`cockpit-ticket-row ${active ? 'active' : ''}`}
                  onClick={() => {
                    if (isSpec) setActiveSpecId(t.id);
                    else if (t.parent_id && specs.some(s => s.id === t.parent_id)) {
                      setActiveSpecId(t.parent_id);
                      window.Router.openTicket(t.id);
                    } else {
                      window.Router.openTicket(t.id);
                    }
                  }}
                >
                  <div className="cockpit-ticket-row-top">
                    <span className="cockpit-ticket-kind-tag mono">{t.kind}</span>
                    <span className="cockpit-ticket-id mono">{t.display_id || t.id}</span>
                    <span className={`pill ${statePillClass(t.state)}`} style={{fontSize: 10, marginLeft: 'auto'}}>
                      {t.state}
                    </span>
                    <button
                      className="cockpit-delete-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete ticket ${t.display_id || t.id}?`)) {
                          window.SubstrateAPI.deleteTicket(t.id).then(() => window.Store.deleteTrackerTicket(t.id));
                        }
                      }}
                      title="Delete ticket"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="cockpit-ticket-title" title={t.title}>{t.title}</div>
                </div>
              );
            })}
            {filteredTickets.length === 0 && <div className="cockpit-empty">No tickets match filter.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── CENTER: Spec Document + Inline Text Selection Annotate + Subtasks + Spacious Reviews Stream Below
function CockpitCenter({ project, cid, activeSpec, setRoute }) {
  (window.useStore ? window.useStore() : null);
  const spec = activeSpec ? (window.Store.getState().trackerTickets.get(activeSpec.id) || activeSpec) : null;
  const [dispatchable, setDispatchable] = window.React.useState([]);
  const bodyRef = window.React.useRef(null);

  // Text selection & inline annotation state
  const [selectionPillPos, setSelectionPillPos] = window.React.useState(null);
  const [anchoredModalData, setAnchoredModalData] = window.React.useState(null);
  const [anchoredBody, setAnchoredBody] = window.React.useState('');
  const [anchoredTag, setAnchoredTag] = window.React.useState('comment');
  const [anchoredDispatchTarget, setAnchoredDispatchTarget] = window.React.useState('');
  const [isSavingAnchor, setIsSavingAnchor] = window.React.useState(false);

  // Reviews section state (below document)
  const [commentFilter, setCommentFilter] = window.React.useState('open');
  const [newCommentText, setNewCommentText] = window.React.useState('');
  const [newCommentTag, setNewCommentTag] = window.React.useState('comment');
  const [newCommentDispatchTarget, setNewCommentDispatchTarget] = window.React.useState('');
  const [replyingToId, setReplyingToId] = window.React.useState(null);
  const [replyText, setReplyText] = window.React.useState('');
  const [postingComment, setPostingComment] = window.React.useState(false);
  const [showOlderComments, setShowOlderComments] = window.React.useState(false);

  window.React.useEffect(() => {
    if (!cid) return;
    let cancelled = false;
    window.SubstrateAPI.listDispatchable(cid).then(list => {
      if (!cancelled) {
        const rows = Array.isArray(list) ? list : [];
        setDispatchable(rows);
        if (rows.length && !anchoredDispatchTarget) setAnchoredDispatchTarget(rows[0].session_id);
        if (rows.length && !newCommentDispatchTarget) setNewCommentDispatchTarget(rows[0].session_id);
      }
    }).catch(()=>{});
    return () => { cancelled = true; };
  }, [cid]);

  // Ensure active spec details are loaded
  window.React.useEffect(() => {
    if (!activeSpec) return;
    const id = activeSpec.display_id || activeSpec.id;
    window.SubstrateAPI.getTicket(id).then(full => {
      if (full && full.id) {
        window.Store.upsertTrackerTicket(full);
        window.Store.seedTicketComments(full.id, full.comments||[]);
      }
    }).catch(()=>{});
  }, [activeSpec?.id, activeSpec?.display_id]);

  // Mermaid rendering
  window.React.useEffect(() => {
    if (!activeSpec || !bodyRef.current) return;
    const nodes = bodyRef.current.querySelectorAll('.mermaid');
    if (nodes.length && window.runMermaid) window.runMermaid(nodes);
  }, [activeSpec?.body, activeSpec?.id]);

  // Handle text selection in document body for inline annotation pill
  window.React.useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;

    const onMouseUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setSelectionPillPos(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const text = sel.toString().trim();
      if (!text || text.length < 2) {
        setSelectionPillPos(null);
        return;
      }
      if (!root.contains(range.commonAncestorContainer)) {
        setSelectionPillPos(null);
        return;
      }

      const rootText = root.innerText || root.textContent || '';
      const quote = text;
      let at = rootText.indexOf(quote);
      const prefix = at > 0 ? rootText.slice(Math.max(0, at - 40), at) : '';
      const suffix = at >= 0 ? rootText.slice(at + quote.length, at + quote.length + 40) : '';

      let node = range.startContainer;
      if (node.nodeType === 3) node = node.parentNode;
      let section = 'General';
      let sectionId = '';
      let curr = node;
      while (curr && curr !== root) {
        let prev = curr.previousElementSibling;
        while (prev) {
          if (/^H[1-6]$/i.test(prev.tagName)) {
            section = prev.textContent.trim();
            sectionId = prev.id || section.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            break;
          }
          prev = prev.previousElementSibling;
        }
        if (sectionId) break;
        curr = curr.parentElement;
      }

      const rect = range.getBoundingClientRect();
      const containerRect = root.getBoundingClientRect();
      setSelectionPillPos({
        top: rect.top - containerRect.top + root.scrollTop,
        left: rect.left - containerRect.left + (rect.width / 2),
        quote,
        prefix,
        suffix,
        section,
        sectionId,
      });
    };

    const onMouseDown = (e) => {
      if (e.target.closest('.cockpit-selection-pill') || e.target.closest('.cockpit-anchored-modal')) return;
      setSelectionPillPos(null);
    };

    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [activeSpec?.id]);

  // Highlight quoted text ranges for anchored comments
  window.React.useEffect(() => {
    if (!activeSpec || !spec || !bodyRef.current) return;
    const root = bodyRef.current;
    root.querySelectorAll('mark.cockpit-anno').forEach(m => {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    });
    const comments = window.Store.getTicketComments(spec.id) || [];
    const quotes = comments.filter(c => c.quote && c.status !== 'deleted').slice(0, 30);
    if (!quotes.length) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentNode;
        if (p && p.closest && p.closest('mark.cockpit-anno')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);
    const fullText = textNodes.map(t => t.nodeValue).join('');
    let pos = 0;
    const idx = textNodes.map(t => {
      const start = pos;
      pos += t.nodeValue.length;
      return { node: t, start, end: pos };
    });
    for (const c of quotes) {
      const q = String(c.quote).trim();
      if (!q) continue;
      let at = fullText.indexOf(q);
      if (at < 0) at = fullText.toLowerCase().indexOf(q.toLowerCase());
      if (at < 0) continue;
      const start = at, end = at + q.length;
      for (let i = idx.length - 1; i >= 0; i--) {
        const seg = idx[i];
        if (seg.end <= start || seg.start >= end) continue;
        let node = seg.node;
        const ls = Math.max(0, start - seg.start);
        const le = Math.min(node.nodeValue.length, end - seg.start);
        if (le < node.nodeValue.length) node.splitText(le);
        if (ls > 0) node = node.splitText(ls);
        const mark = document.createElement('mark');
        mark.className = 'cockpit-anno';
        mark.dataset.commentId = c.id;
        mark.title = 'Comment: ' + (c.body||'').slice(0,80);
        mark.style.background = 'color-mix(in oklab, var(--status-review) 24%, transparent)';
        mark.style.borderBottom = '2px solid var(--status-review)';
        mark.style.cursor = 'pointer';
        node.parentNode.insertBefore(mark, node);
        mark.appendChild(node);
        mark.addEventListener('click', () => {
          const card = document.querySelector(`.cockpit-comment-card[data-comment-id="${c.id}"]`);
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.style.outline = '2px solid var(--accent)';
            setTimeout(()=> card.style.outline='', 1400);
          }
        });
      }
    }
  }, [activeSpec?.id, spec?.id, spec?.body, (window.Store.getTicketComments(spec?.id)||[]).length]);

  if (!activeSpec || !spec) {
    const hasAnySpecs = window.Store.getTrackerTickets({ project_id: cid, kind: 'spec' }).length > 0;
    if (!hasAnySpecs) {
      return (
        <div className="cockpit-center">
          {window.EmptyStateOnboardingCTA ? window.React.createElement(window.EmptyStateOnboardingCTA, { kind: 'specs' }) : <EmptyCard label="no specs yet" hint={<>Create your first living spec to populate the cockpit center.</>} />}
        </div>
      );
    }
    return (
      <div className="cockpit-center">
        <EmptyCard label="no spec selected" hint={<>Select a spec from the left navigator or create a new one with <span className="mono">+ Spec</span>.</>} />
      </div>
    );
  }

  const allTickets = window.Store.getTrackerTickets({ project_id: cid, includeArchived: true });
  const children = allTickets.filter(t => t.parent_id === spec.id);
  const allComments = window.Store.getTicketComments(spec.id) || [];
  const openUndispatched = allComments.filter(c => c.status==='open' && c.dispatch_state==='undispatched');

  // Filter & sort newest first
  const filteredComments = allComments
    .filter(c => {
      if (commentFilter === 'all') return true;
      if (commentFilter === 'decision') return c.tag === 'decision' || c.tag === 'decision_ask' || /decision|choice|locked/i.test(c.body||'');
      if (commentFilter === 'resolved') return c.status === 'resolved' || c.dispatch_state === 'addressed';
      return c.status === 'open' && c.dispatch_state !== 'addressed';
    })
    .sort((a,b) => (Date.parse(b.created_at || '') || 0) - (Date.parse(a.created_at || '') || 0));

  // Collapsing / Folding logic: show top 4 by default unless expanded
  const visibleComments = showOlderComments ? filteredComments : filteredComments.slice(0, 4);
  const hiddenCount = filteredComments.length - visibleComments.length;

  const decisionSummary = allComments.filter(c => (c.tag === 'decision' || c.tag === 'decision_ask' || /decision|locked/i.test(c.body||''))).slice(0, 4);

  const stateOrder = { todo:'Draft', in_progress:'Refining', blocked:'Blocked', review:'Review', done:'Locked', archived:'Locked' };
  const html = renderMd(spec.body || '');
  const lifecycle = (() => {
    const s = spec.state;
    if (s === 'todo') return { active: 1, done: [] };
    if (s === 'in_progress') return { active: 2, done: [1] };
    if (s === 'blocked' || s === 'review') return { active: 3, done: [1,2] };
    if (s === 'done' || s === 'archived') return { active: 4, done: [1,2,3] };
    return { active: 1, done: [] };
  })();
  const pillClass = (n) => lifecycle.done.includes(n) ? 'done' : lifecycle.active===n ? 'active' : '';
  const labelBySession = new Map(dispatchable.map(s => [s.session_id, s.label]));

  const handleTaskState = (task) => {
    const next = nextStateFor(task.state);
    window.SubstrateAPI.updateTicket(task.display_id || task.id, { state: next, actor: 'human:dashboard' })
      .then(updated => { if (updated && updated.id) window.Store.upsertTrackerTicket(updated); })
      .catch(err => console.error('task state update failed', err));
  };

  const handleDeleteTask = (task) => {
    if (!confirm(`Delete task ${task.display_id || task.id} ("${task.title}")?`)) return;
    window.SubstrateAPI.deleteTicket(task.id).then(() => {
      window.Store.deleteTrackerTicket(task.id);
    }).catch(err => alert('Failed to delete task: ' + (err.message || err)));
  };

  const dispatchAllOpen = () => {
    if (openUndispatched.length===0) return;
    const target = spec.assignee && dispatchable.some(s=>s.session_id===spec.assignee) ? spec.assignee : (dispatchable[0]?.session_id || '');
    if (!target) { alert('No live session to dispatch to. Start a worker via Swarm pane or /agents.'); return; }
    window.SubstrateAPI.batchDispatchComments(spec.display_id||spec.id, { session_id: target })
      .then(res => {
        if (res?.ticket?.id) window.Store.upsertTrackerTicket(res.ticket);
        if (res?.ticket?.comments) window.Store.seedTicketComments(res.ticket.id, res.ticket.comments);
      }).catch(err=> console.error(err));
  };

  const decompose = () => {
    window.Router.openComposer(cid, { kind: 'task', parent: spec.display_id || spec.id });
  };

  const verifyAndLand = () => {
    if (!confirm(`Mark spec ${spec.display_id||spec.id} as done (Locked)?`)) return;
    window.SubstrateAPI.updateTicket(spec.display_id||spec.id, { state: 'done', actor: 'human:dashboard' })
      .then(updated => { if (updated?.id) window.Store.upsertTrackerTicket(updated); })
      .catch(err=> console.error(err));
  };

  // Submit Anchored Comment from Inline Selection Popover
  const handleSaveAnchoredComment = (dispatch = false) => {
    const text = anchoredBody.trim();
    if (!text || !anchoredModalData) return;
    setIsSavingAnchor(true);
    const tag = anchoredTag !== 'comment' ? anchoredTag : undefined;
    window.SubstrateAPI.addComment(spec.display_id || spec.id, {
      author: 'human',
      author_label: 'Lavee',
      body: text,
      tag: tag,
      quote: anchoredModalData.quote,
      prefix: anchoredModalData.prefix,
      suffix: anchoredModalData.suffix,
      section: anchoredModalData.section,
      section_id: anchoredModalData.sectionId,
    }).then(created => {
      if (dispatch && created && created.id) {
        const target = anchoredDispatchTarget || dispatchable[0]?.session_id;
        if (target) window.SubstrateAPI.dispatchComment(created.id, { session_id: target }).catch(()=>{});
      }
      setAnchoredModalData(null);
      setAnchoredBody('');
      setIsSavingAnchor(false);
      setSelectionPillPos(null);
      window.getSelection()?.removeAllRanges();
    }).catch(err => {
      console.error(err);
      setIsSavingAnchor(false);
    });
  };

  // Submit Top-Level Comment in Center Pane
  const handlePostGeneralComment = (dispatch = false) => {
    const text = newCommentText.trim();
    if (!text || !spec) return;
    setPostingComment(true);
    const tag = newCommentTag !== 'comment' ? newCommentTag : undefined;
    window.SubstrateAPI.addComment(spec.display_id || spec.id, {
      author: 'human',
      author_label: 'Lavee',
      body: text,
      tag: tag,
    }).then(created => {
      if (dispatch && created && created.id) {
        const target = newCommentDispatchTarget || dispatchable[0]?.session_id;
        if (target) window.SubstrateAPI.dispatchComment(created.id, { session_id: target }).catch(()=>{});
      }
      setNewCommentText('');
      setPostingComment(false);
    }).catch(err => {
      console.error(err);
      setPostingComment(false);
    });
  };

  const handleReplySubmit = (commentId) => {
    const text = replyText.trim();
    if (!text || !spec) return;
    window.SubstrateAPI.replyComment(spec.display_id || spec.id, commentId, {
      author: 'human',
      author_label: 'Lavee',
      body: text
    }).then(() => {
      setReplyText('');
      setReplyingToId(null);
    }).catch(err => console.error(err));
  };

  const handleToggleResolve = (comment) => {
    if (!spec) return;
    const isResolved = comment.status === 'resolved' || comment.dispatch_state === 'addressed';
    const newStatus = isResolved ? 'open' : 'resolved';
    window.SubstrateAPI.updateComment(spec.display_id || spec.id, comment.id, {
      status: newStatus
    }).then(res => {
      if (res?.ticket?.id) window.Store.upsertTrackerTicket(res.ticket);
    }).catch(err => console.error(err));
  };

  const handleDispatchSingleComment = (comment, targetSessionId = null) => {
    if (!spec) return;
    const target = targetSessionId || (spec.assignee && dispatchable.some(s => s.session_id === spec.assignee)
      ? spec.assignee
      : (dispatchable[0]?.session_id || ''));
    if (!target) { alert('No live worker session to dispatch to.'); return; }
    window.SubstrateAPI.dispatchComment(comment.id, { session_id: target }).then(res => {
      if (res?.ticket?.id) window.Store.upsertTrackerTicket(res.ticket);
      if (res?.ticket?.comments) window.Store.seedTicketComments(res.ticket.id, res.ticket.comments);
    }).catch(err => console.error(err));
  };

  return (
    <div className="cockpit-center" style={{ position: 'relative' }}>
      {/* Document Lifecycle & Header */}
      <div className="doc-header">
        <div className="doc-lifecycle-bar">
          <span className={`step-pill ${pillClass(1)}`}>1. Draft {lifecycle.done.includes(1) ? '✓' : ''}</span>
          <span className="step-arrow">➔</span>
          <span className={`step-pill ${pillClass(2)}`}>2. Lock {lifecycle.done.includes(2) ? '✓' : ''}</span>
          <span className="step-arrow">➔</span>
          <span className={`step-pill ${pillClass(3)}`}>3. In Build {lifecycle.active===3 ? `(${children.filter(c=>c.state==='done').length}/${children.length})` : lifecycle.done.includes(3) ? '✓' : ''}</span>
          <span className="step-arrow">➔</span>
          <span className={`step-pill ${pillClass(4)}`}>4. Complete {lifecycle.done.includes(4) || lifecycle.active===4 ? '✓' : ''}</span>
        </div>
        <div className="cockpit-doc-head">
          <div className="cockpit-doc-id mono">{spec.display_id || spec.id}</div>
          <span className={`pill ${statePillClass(spec.state)}`}>{stateOrder[spec.state]||spec.state}</span>
          <span className="cockpit-doc-title">{spec.title}</span>
        </div>
        <div className="cockpit-doc-meta">
          <span className="mono">{spec.kind}</span>
          <span>·</span>
          <span>updated {fmtAgo(spec.updated_at)}</span>
          {spec.assignee && <><span>·</span><span>assignee {labelBySession.get(spec.assignee)||spec.assignee_label||spec.assignee.slice(0,8)}</span></>}
        </div>
      </div>

      {/* Spec Markdown Body */}
      <div
        className="cockpit-doc-body td-body"
        ref={bodyRef}
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {/* Floating Selection Trigger Pill */}
      {selectionPillPos && !anchoredModalData && (
        <button
          className="cockpit-selection-pill"
          style={{ top: `${selectionPillPos.top}px`, left: `${selectionPillPos.left}px` }}
          onClick={() => setAnchoredModalData(selectionPillPos)}
        >
          <span>💬 Add Comment on Selection</span>
        </button>
      )}

      {/* Inline Anchored Comment Popover Modal */}
      {anchoredModalData && (
        <div className="peek-backdrop" onClick={() => setAnchoredModalData(null)}>
          <div className="cockpit-anchored-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cockpit-anchored-modal-head">
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  Section: {anchoredModalData.section}
                </span>
                <div className="cockpit-anchored-quote-preview">
                  “{anchoredModalData.quote.length > 120 ? anchoredModalData.quote.slice(0, 120) + '…' : anchoredModalData.quote}”
                </div>
              </div>
              <button className="orch-btn ghost small" onClick={() => setAnchoredModalData(null)}>✕</button>
            </div>
            <div className="cockpit-anchored-modal-body">
              <textarea
                className="cockpit-composer-input"
                placeholder="Write your review comment, question, or decision on this section…"
                rows={3}
                value={anchoredBody}
                onChange={(e) => setAnchoredBody(e.target.value)}
                autoFocus
              />
              <div className="cockpit-composer-bar">
                <div className="cockpit-tag-pills">
                  {['comment', 'decision', 'blocker', 'question'].map(t => (
                    <button
                      key={t}
                      type="button"
                      className={`cockpit-tag-btn ${anchoredTag === t ? 'active' : ''}`}
                      onClick={() => setAnchoredTag(t)}
                    >
                      {t === 'decision' ? '🔒 Decision' : t === 'blocker' ? '⚠️ Blocker' : t === 'question' ? '❓ Question' : '💬 Note'}
                    </button>
                  ))}
                </div>
                {dispatchable.length > 0 && (
                  <select
                    className="cockpit-worker-select"
                    value={anchoredDispatchTarget}
                    onChange={(e) => setAnchoredDispatchTarget(e.target.value)}
                    title="Target worker for dispatch"
                  >
                    {dispatchable.map(w => (
                      <option key={w.session_id} value={w.session_id}>
                        {w.label || w.session_id.slice(0, 8)} ({w.role || 'worker'})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
            <div className="cockpit-anchored-modal-actions">
              <button
                className="orch-btn ghost small"
                onClick={() => setAnchoredModalData(null)}
              >
                Cancel
              </button>
              <button
                className="orch-btn primary small"
                disabled={!anchoredBody.trim() || isSavingAnchor}
                onClick={() => handleSaveAnchoredComment(false)}
              >
                Post Comment
              </button>
              {dispatchable.length > 0 && (
                <button
                  className="orch-btn primary small"
                  disabled={!anchoredBody.trim() || isSavingAnchor}
                  onClick={() => handleSaveAnchoredComment(true)}
                  title="Post and immediately dispatch to worker"
                >
                  ⚡ Post & Dispatch
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Subtasks Section */}
      <div className="cockpit-subtasks task-subtable">
        <div className="cockpit-subtasks-head">
          <span className="cockpit-subtasks-title">Sub-tasks</span>
          <span className="cockpit-subtasks-count tnum">{children.length}</span>
          <button className="orch-btn ghost small" onClick={decompose}>+ Task</button>
        </div>
        {children.length===0 ? (
          <div className="cockpit-quiet">No sub-tasks yet. Decompose this spec to create work items.</div>
        ) : (
          <div className="cockpit-task-table">
            {children.map(t => {
              const statusCls = t.state==='done' ? 'status-done' : t.state==='in_progress' ? 'status-inprogress' : 'status-todo';
              const branch = t.branch || (t.worktree ? t.worktree.split('/').pop() : null) || null;
              const assigneeLabel = t.assignee_label || labelBySession.get(t.assignee) || (t.assignee? t.assignee.slice(0,8): null);
              const avatarGlyph = t.assignee ? (assigneeLabel||'?').slice(0,2).toUpperCase() : '—';
              const doneAt = t.done_at || t.state_changed_at || null;
              const actorLabel = t.state==='done' ? (t.assignee_label || labelBySession.get(t.assignee) || (t.assignee?String(t.assignee).slice(0,8):'')) : null;
              return (
                <div key={t.id} className="task-row">
                  <div className="task-row-left">
                    <button className={`task-status-pill ${statusCls}`} onClick={()=>{
                      handleTaskState(t);
                      setTimeout(()=> {
                        try {
                          const specTicket = window.Store.getState().trackerTickets.get(spec.id);
                          if (!specTicket) return;
                          let body = specTicket.body || '';
                          const id = t.display_id || t.id;
                          const title = t.title || '';
                          const lines = body.split('\n');
                          let changed = false;
                          for (let i=0;i<lines.length;i++) {
                            const line = lines[i];
                            if (line.includes(id) || (title && line.includes(title.slice(0,20)))) {
                              if (t.state !== 'done' && line.match(/- \[ \]/)) { lines[i] = line.replace('- [ ]', '- [x]'); changed = true; break; }
                              if (t.state === 'done' && line.match(/- \[x\]/i)) { lines[i] = line.replace(/- \[x\]/i, '- [ ]'); changed = true; break; }
                            }
                          }
                          if (changed) {
                            const newBody = lines.join('\n');
                            window.SubstrateAPI.updateTicket(spec.display_id||spec.id, { body: newBody, actor: 'human:dashboard' }).then(u=> u&&u.id&&window.Store.upsertTrackerTicket(u));
                          }
                        } catch {}
                      }, 300);
                    }} title="Click to cycle state">{t.state==='in_progress' ? 'In Progress' : t.state==='review' ? 'Review' : t.state==='done' ? 'Done' : t.state==='blocked' ? 'Blocked' : 'Todo'}</button>
                    <a className="mono cockpit-task-id" href={window.Router.buildHref({kind:'ticket', id:t.id})} onClick={(e)=>{e.preventDefault(); window.Router.openTicket(t.id);}} style={{fontWeight:500}}>{t.display_id||t.id}</a>
                    <span className="cockpit-task-title" title={t.title} style={{fontWeight:500}}>{t.title}</span>
                  </div>
                  <div className="task-row-right" style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                    {assigneeLabel && <span className="worker-avatar" style={{width:22,height:22,fontSize:9}}>{avatarGlyph}</span>}
                    <span className="mono" style={{fontSize:11,color:'var(--text-3)'}}>{assigneeLabel || 'Unassigned'}</span>
                    {branch && <span className="branch-chip">{branch}</span>}
                    <span className={`pill ${statePillClass(t.state)}`} style={{fontSize:10}}>{t.state}</span>
                    {t.state==='done' && doneAt && <span className="mono" style={{fontSize:10,color:'var(--text-3)'}} title={doneAt}>{window.SubstrateFmt?.fmtTimeAgo?.(doneAt)||''} ✓</span>}
                    {t.state==='done' && actorLabel && <span className="mono" style={{fontSize:10,background:'var(--bg-3)',border:'1px solid var(--border-1)',padding:'1px 5px',borderRadius:4}}>{actorLabel}</span>}
                    <button
                      className="cockpit-delete-btn"
                      onClick={() => handleDeleteTask(t)}
                      title="Delete task"
                      style={{marginLeft: 4}}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Action Bar */}
      <div className="cockpit-actions">
        <button className="orch-btn cockpit-action" onClick={decompose} title="Lead: Decompose spec into tasks">⚡ Decompose into Tasks</button>
        <button className="orch-btn cockpit-action primary" onClick={dispatchAllOpen} disabled={openUndispatched.length===0} title="Dispatch all undispatched comments on this spec">
          💬 Dispatch Open Comments {openUndispatched.length>0 ? `(${openUndispatched.length})` : ''}
        </button>
        <button className="orch-btn cockpit-action" onClick={verifyAndLand} title="Verify & land spec (mark done)">✓ Verify & Land Spec</button>
      </div>

      {/* Spacious Reviews & Comments Stream (Directly Below Document) */}
      <div className="cockpit-center-comments">
        <div className="cockpit-center-comments-head">
          <div className="cockpit-center-comments-title">
            <span>💬 Reviews & Feedback</span>
            <span className="cockpit-right-count tnum">{allComments.length}</span>
          </div>
          <div className="cockpit-comment-filter">
            <button className={`cockpit-filter-btn ${commentFilter==='open'?'active':''}`} onClick={()=>setCommentFilter('open')} title="Open feedback (excludes resolved)">
              Open ({allComments.filter(c => c.status === 'open' && c.dispatch_state !== 'addressed').length})
            </button>
            <button className={`cockpit-filter-btn ${commentFilter==='decision'?'active':''}`} onClick={()=>setCommentFilter('decision')} title="Decisions">
              Decisions
            </button>
            <button className={`cockpit-filter-btn ${commentFilter==='resolved'?'active':''}`} onClick={()=>setCommentFilter('resolved')} title="Resolved feedback">
              Resolved ({allComments.filter(c => c.status === 'resolved' || c.dispatch_state === 'addressed').length})
            </button>
            <button className={`cockpit-filter-btn ${commentFilter==='all'?'active':''}`} onClick={()=>setCommentFilter('all')} title="All comments">
              All
            </button>
          </div>
        </div>

        {/* Decision Summary Box */}
        {decisionSummary.length > 0 && (
          <div className="cockpit-decision-summary">
            <div className="cockpit-decision-summary-head">
              <span>🔒 Locked Architectural Decisions</span>
            </div>
            {decisionSummary.map(d => (
              <div key={d.id} className="cockpit-decision-item">
                <span>• {(d.body||'').slice(0, 100)}{(d.body||'').length > 100 ? '…' : ''}</span>
              </div>
            ))}
          </div>
        )}

        {/* Embedded Top-Level Comment Composer */}
        <div className="cockpit-comment-composer">
          <textarea
            className="cockpit-composer-input"
            placeholder="Write review feedback, architectural decision, or question on this spec…"
            rows={3}
            value={newCommentText}
            onChange={(e)=> setNewCommentText(e.target.value)}
          />
          <div className="cockpit-composer-bar">
            <div className="cockpit-tag-pills">
              {['comment', 'decision', 'blocker', 'question'].map(t => (
                <button
                  key={t}
                  type="button"
                  className={`cockpit-tag-btn ${newCommentTag === t ? 'active' : ''}`}
                  onClick={() => setNewCommentTag(t)}
                >
                  {t === 'decision' ? '🔒 Decision' : t === 'blocker' ? '⚠️ Blocker' : t === 'question' ? '❓ Question' : '💬 Note'}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {dispatchable.length > 0 && (
                <select
                  className="cockpit-worker-select"
                  value={newCommentDispatchTarget}
                  onChange={(e) => setNewCommentDispatchTarget(e.target.value)}
                  title="Dispatch target"
                >
                  {dispatchable.map(w => (
                    <option key={w.session_id} value={w.session_id}>
                      {w.label || w.session_id.slice(0, 8)} ({w.role || 'worker'})
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="orch-btn ghost small"
                disabled={!newCommentText.trim() || postingComment}
                onClick={() => handlePostGeneralComment(false)}
              >
                Post Note
              </button>
              <button
                type="button"
                className="orch-btn primary small cockpit-post-btn"
                disabled={!newCommentText.trim() || postingComment}
                onClick={() => handlePostGeneralComment(true)}
              >
                ⚡ Post & Dispatch
              </button>
            </div>
          </div>
        </div>

        {/* Comment Stream Cards (Newest First & Folded) */}
        {filteredComments.length === 0 ? (
          <div className="cockpit-quiet">No comments in this filter. Select text in the document above to add an anchored note.</div>
        ) : (
          <div className="cockpit-comment-cards-grid">
            {visibleComments.map(c => {
              const isResolved = c.status==='resolved' || c.dispatch_state==='addressed';
              const isReplying = replyingToId === c.id;
              const tag = c.tag || (/decision|locked/i.test(c.body||'') ? 'decision' : null);
              return (
                <div
                  key={c.id}
                  className={`cockpit-comment-card ${isResolved ? 'resolved' : ''} ${tag ? `tag-${tag}` : ''}`}
                  data-comment-id={c.id}
                >
                  <div className="cockpit-comment-head">
                    <span className="cockpit-comment-author">{authorMeta(c.author, c.author_label).label}</span>
                    {c.section && <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>§ {c.section}</span>}
                    {tag && (
                      <span className={`cockpit-tag-badge tag-${tag} mono`}>
                        {tag === 'decision' ? '🔒 Decision' : tag === 'blocker' ? '⚠️ Blocker' : tag}
                      </span>
                    )}
                    <span className="cockpit-comment-time mono">{fmtAgo(c.created_at||c.updated_at)}</span>
                  </div>

                  {c.quote && (
                    <div
                      className="cockpit-comment-quote clickable"
                      title="Click to jump to section in document"
                      onClick={() => {
                        const mark = bodyRef.current?.querySelector(`mark.cockpit-anno[data-comment-id="${c.id}"]`);
                        if (mark) {
                          mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          mark.style.outline = '2px solid var(--accent)';
                          setTimeout(() => mark.style.outline = '', 1400);
                        }
                      }}
                    >
                      <span className="cockpit-quote-icon">“</span>
                      <span>{c.quote}</span>
                    </div>
                  )}

                  <div className="cockpit-comment-body td-body" dangerouslySetInnerHTML={{ __html: renderMd(c.body||'') }} />

                  <div className="cockpit-comment-actions">
                    <button
                      className="orch-btn ghost small"
                      onClick={() => setReplyingToId(isReplying ? null : c.id)}
                      title="Reply to thread"
                    >
                      💬 Reply
                    </button>
                    <button
                      className="orch-btn ghost small"
                      onClick={() => handleDispatchSingleComment(c)}
                      title="Dispatch feedback to live worker"
                    >
                      ⚡ Dispatch
                    </button>
                    <button
                      className="orch-btn ghost small"
                      onClick={() => handleToggleResolve(c)}
                      title={isResolved ? 'Reopen comment' : 'Mark resolved'}
                    >
                      {isResolved ? '↺ Reopen' : '✓ Resolve'}
                    </button>

                    <span className="cockpit-comment-state mono" style={{marginLeft:'auto'}}>
                      {isResolved ? (
                        <span style={{color:'var(--status-active)'}}>Resolved ✓</span>
                      ) : c.dispatch_state === 'dispatched' ? (
                        <span style={{color:'var(--status-running)'}}>Sent to agent</span>
                      ) : (
                        <span>Open</span>
                      )}
                    </span>
                  </div>

                  {/* Inline Reply Composer */}
                  {isReplying && (
                    <div className="cockpit-reply-box">
                      <input
                        className="cockpit-reply-input"
                        placeholder="Write a reply…"
                        value={replyText}
                        onChange={(e)=> setReplyText(e.target.value)}
                        onKeyDown={(e)=> { if (e.key === 'Enter') handleReplySubmit(c.id); }}
                        autoFocus
                      />
                      <button
                        className="orch-btn primary small"
                        onClick={()=> handleReplySubmit(c.id)}
                        disabled={!replyText.trim()}
                      >
                        Reply
                      </button>
                      <button
                        className="orch-btn ghost small"
                        onClick={()=> setReplyingToId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  )}

                  {/* Threaded Replies List */}
                  {c.replies && c.replies.length > 0 && (
                    <div className="cockpit-replies">
                      {c.replies.map(r => (
                        <div key={r.id} className="cockpit-reply">
                          <span className="cockpit-reply-author">{authorMeta(r.author, r.author_label).label}:</span>
                          <span className="cockpit-reply-body" dangerouslySetInnerHTML={{__html: renderMd(r.body)}} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Expander / Collapse Toggle for Older Comments */}
            {filteredComments.length > 4 && (
              <button
                className="orch-btn ghost small cockpit-fold-toggle"
                onClick={() => setShowOlderComments(prev => !prev)}
              >
                {showOlderComments ? '▴ Collapse older comments' : `▾ Show ${hiddenCount} older comment${hiddenCount === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── RIGHT: Swarm Fleet & Live Zero-Terminal Operations (with Orb Animations & Kill Action)
function CockpitRight({ project, cid, activeSpec, onPeek, onSpawn }) {
  (window.useStore ? window.useStore() : null);
  const [steerSessionId, setSteerSessionId] = window.React.useState(null);
  const [steerInput, setSteerInput] = window.React.useState('');
  const [rawWorkers, setRawWorkers] = window.React.useState([]);
  // Model switch state — per-worker selection + in-flight flag.
  const [profiles, setProfiles] = window.React.useState([]);
  const [modelPick, setModelPick] = window.React.useState({}); // name -> profile
  const [switchingName, setSwitchingName] = window.React.useState(null);
  const [switchMsg, setSwitchMsg] = window.React.useState(null); // { name, tone, text }

  const alive = window.Store.getProjectAliveSessions(project);

  window.React.useEffect(() => {
    if (!cid) return;
    let cancelled = false;
    const fetchProfiles = () => window.SubstrateAPI.modelProfiles().then((store) => {
      if (!cancelled && Array.isArray(store?.profiles)) setProfiles(store.profiles);
    }).catch(()=>{});
    const fetchW = () => {
      window.SubstrateAPI.listWorkers(cid).then(list => {
        if (!cancelled && Array.isArray(list)) setRawWorkers(list);
      }).catch(()=>{});
      fetchProfiles();
    };
    fetchW();
    const timer = setInterval(fetchW, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [cid, alive.length]);

  // Model profiles for the per-worker switcher (also refreshed on the WS-signal
  // DOM event when Settings saves a profile).
  window.React.useEffect(() => {
    let cancelled = false;
    const handler = () => window.SubstrateAPI.modelProfiles().then((store) => {
      if (!cancelled && Array.isArray(store?.profiles)) setProfiles(store.profiles);
    }).catch(()=>{});
    window.addEventListener('model-profiles-updated', handler);
    return () => { cancelled = true; window.removeEventListener('model-profiles-updated', handler); };
  }, []);

  // Include failed/unregistered workers that still exist in workers.json
  const failedWorkers = window.React.useMemo(() => {
    const aliveNames = new Set(alive.map(s => s.name).filter(Boolean));
    const aliveIds = new Set(alive.map(s => s.session_id).filter(Boolean));
    return rawWorkers.filter(w => {
      if (w.state !== 'failed' && w.state !== 'spawning') return false;
      if (w.name && aliveNames.has(w.name)) return false;
      if (w.session_id && aliveIds.has(w.session_id)) return false;
      return true;
    });
  }, [rawWorkers, alive]);

  const handlePeek = (session) => {
    const id = session.session_id || session.name;
    if (id && onPeek) { onPeek(id); return; }
    if (session.session_id) window.Router.openNativeSession(session.session_id);
  };

  const handleSendSteer = (sessionId) => {
    const text = steerInput.trim();
    if (!text) return;
    window.SubstrateAPI.sendSteer(sessionId, text).then(() => {
      setSteerInput('');
      setSteerSessionId(null);
    }).catch(err => console.error(err));
  };

  const handleKillWorker = (session) => {
    const name = session.name || session.session_id?.slice(0,8) || 'worker';
    if (!confirm(`End background worker ${name}?`)) return;
    window.SubstrateAPI.killSession(session.session_id || session.name).then(() => {
      setRawWorkers(prev => prev.filter(w => w.name !== session.name && w.session_id !== session.session_id));
    }).catch(err => console.error(err));
  };

  const handleSwitchModel = (session) => {
    const name = session.name || session.worker_name;
    const profile = modelPick[name];
    if (!name || !profile) return;
    const harness = session.harness || 'pi';
    const note = harness === 'pi'
      ? 'Pi workers resume their conversation on the new model.'
      : 'Hermes workers restart fresh on the new model.';
    if (!confirm(`Switch ${name} to profile “${profile}” and restart it?\n\n${note}`)) return;
    setSwitchingName(name);
    setSwitchMsg(null);
    window.SubstrateAPI.switchWorkerModel(name, { profile, project: cid }).then((res) => {
      setSwitchMsg({ name, tone: 'ok', text: `Switched to ${profile} ✓` });
      setModelPick((prev) => ({ ...prev, [name]: '' }));
      setTimeout(() => setSwitchMsg((m) => (m?.name === name ? null : m)), 4000);
    }).catch((err) => {
      setSwitchMsg({ name, tone: 'err', text: String(err?.message || err).slice(0, 160) });
    }).finally(() => setSwitchingName(null));
  };

  return (
    <div className="cockpit-right">
      <div className="cockpit-right-section">
        <div className="cockpit-right-head">
          <span className="cockpit-right-title">Live Swarm Fleet</span>
          <span className="cockpit-right-count tnum">{alive.length + failedWorkers.length}</span>
          <button className="orch-btn ghost small" onClick={()=> onSpawn && onSpawn()} title="Add worker" style={{marginLeft:'auto'}}>+ Add Worker</button>
        </div>
        {alive.length === 0 && failedWorkers.length === 0 ? (
          <div className="cockpit-quiet">No live workers in this project.</div>
        ) : (
          <div className="cockpit-swarm-list">
            {/* Live Active Workers */}
            {alive.map(s => {
              const isBusy = s.status==='busy';
              const isSteeringThis = steerSessionId === (s.session_id || s.name);
              const family = s.provider || s.model || '';
              return (
                <div key={s.session_id || s.name || s.pid} className={`cockpit-swarm-card ${isBusy?'busy':''}`}>
                  <div className="cockpit-swarm-top">
                    <div className="worker-identity">
                      <div className={`worker-avatar-orb ${isBusy ? 'busy' : s.status==='waiting' ? 'waiting' : 'idle'}`}>
                        <div className="worker-avatar">{roleGlyph(s.role)}</div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        <span className="cockpit-swarm-name">{s.name || s.session_id.slice(0,8)}</span>
                        <span className="mono" style={{ fontSize: 10, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
                          {window.ModelFamilyIcon && <window.ModelFamilyIcon family={family} size={12} />}
                          <span>{s.model || 'model'}</span>
                        </span>
                      </div>
                    </div>
                    <span className={`cockpit-swarm-dot pulse-dot ${isBusy?'running': s.status==='waiting'?'waiting':'idle'}`} style={{marginLeft:'auto'}} />
                    {isBusy && <LiveElapsedTimer iso={s.updated_at} />}
                  </div>

                  <div className="cockpit-swarm-meta">
                    <span className="cockpit-swarm-role worker-role">{s.role || 'worker'}</span>
                    {isBusy && <span className="mono" style={{fontSize:10, color:'var(--status-running)'}}>active turn</span>}
                    <button
                      className="cockpit-kill-btn mono"
                      onClick={() => handleKillWorker(s)}
                      title="Kill / terminate background worker process"
                    >
                      ✕ End
                    </button>
                  </div>

                  {s.current_in_progress_ticket && (
                    <div className="cockpit-swarm-task mono" title={s.current_in_progress_ticket.title}>
                      {s.current_in_progress_ticket.display_id||s.current_in_progress_ticket.id}: {s.current_in_progress_ticket.title.slice(0,40)}
                    </div>
                  )}

                  <div className="cockpit-swarm-actions">
                    <button className="orch-btn ghost small" onClick={()=>handlePeek(s)} title="View streaming terminal output">👁️ Live Output</button>
                    <button
                      className={`orch-btn ghost small ${isSteeringThis ? 'active' : ''}`}
                      onClick={()=> setSteerSessionId(isSteeringThis ? null : (s.session_id || s.name))}
                      title="Send guidance to agent mid-turn"
                    >
                      💬 Guidance
                    </button>
                  </div>

                  {/* Inline Guidance Form */}
                  {isSteeringThis && (
                    <div className="cockpit-steer-box">
                      <textarea
                        className="cockpit-steer-textarea"
                        placeholder={`Message ${s.name || 'agent'}…`}
                        rows={2}
                        value={steerInput}
                        onChange={(e)=> setSteerInput(e.target.value)}
                        onKeyDown={(e)=> { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSendSteer(s.session_id || s.name); }}
                      />
                      <div className="cockpit-steer-actions">
                        <button className="orch-btn ghost small" onClick={()=> setSteerInput('Continue with current approach.')}>Continue</button>
                        <button className="orch-btn ghost small" onClick={()=> setSteerInput('Please wrap up and run tests.')}>Wrap Up</button>
                        <button className="orch-btn primary small" onClick={()=> handleSendSteer(s.session_id || s.name)}>Send</button>
                      </div>
                    </div>
                  )}

                  {/* Progressive disclosure for technical metadata + model switcher */}
                  <details className="worker-details">
                    <summary className="worker-details-summary">▸ Technical Details & Model</summary>
                    <div className="worker-details-grid mono">
                      <div><span>Harness:</span> <b>{s.harness || 'pi'}</b></div>
                      <div><span>Provider:</span> <b>{s.provider || '—'}</b></div>
                      <div><span>PID:</span> <b>{s.pid != null ? s.pid : '—'}</b></div>
                      <div><span>Session ID:</span> <b>{s.session_id?.slice(0,10)}…</b></div>
                    </div>
                    {(() => {
                      const harness = s.harness || 'pi';
                      const name = s.name || s.worker_name;
                      if (!['pi', 'hermes'].includes(harness)) {
                        return (
                          <div className="cockpit-model-switch mono" title={`Model switching is available for golem-managed pi/hermes workers; this session runs ${harness}`}>
                            <span className="cockpit-model-switch-hint">Model switch unavailable ({harness})</span>
                          </div>
                        );
                      }
                      const matching = profiles.filter((p) => (p.harness || 'pi') === harness);
                      const current = modelPick[name] || '';
                      const msg = switchMsg?.name === name ? switchMsg : null;
                      return (
                        <div className="cockpit-model-switch">
                          <div className="cockpit-model-switch-row">
                            <select
                              className="cockpit-model-switch-select mono"
                              value={current}
                              disabled={switchingName === name || matching.length === 0}
                              onChange={(e) => setModelPick((prev) => ({ ...prev, [name]: e.target.value }))}
                              aria-label={`Switch model for ${name}`}
                            >
                              <option value="">Switch model… ({matching.length} profiles)</option>
                              {matching.map((p) => (
                                <option key={p.name} value={p.name}>{p.name} · {p.model}</option>
                              ))}
                            </select>
                            <button
                              className="orch-btn small cockpit-model-switch-btn"
                              disabled={!current || switchingName === name}
                              onClick={() => handleSwitchModel(s)}
                              title={harness === 'pi' ? 'Restart worker on the selected profile (conversation resumes)' : 'Restart worker on the selected profile (fresh session)'}
                            >
                              {switchingName === name ? 'Switching…' : 'Switch'}
                            </button>
                          </div>
                          {msg && (
                            <div className={`cockpit-model-switch-msg ${msg.tone} mono`}>{msg.text}</div>
                          )}
                          {matching.length === 0 && (
                            <div className="cockpit-model-switch-hint mono">No {harness} profiles yet — create one in Settings.</div>
                          )}
                        </div>
                      );
                    })()}
                  </details>
                </div>
              );
            })}

            {/* Failed or Unregistered Spawning Workers (surfaced with 1-click End/Dismiss) */}
            {failedWorkers.map(w => {
              return (
                <div key={w.worker_id || w.name} className="cockpit-swarm-card failed" style={{ borderColor: 'rgba(248,113,113,0.35)', background: 'rgba(248,113,113,0.04)' }}>
                  <div className="cockpit-swarm-top">
                    <div className="worker-identity">
                      <div className="worker-avatar" style={{ background: 'rgba(248,113,113,0.2)', color: 'var(--status-blocked)' }}>
                        {roleGlyph(w.role)}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        <span className="cockpit-swarm-name">{w.name}</span>
                        <span className="mono" style={{ fontSize: 10, color: 'var(--status-blocked)' }}>
                          ⚠️ {w.state === 'spawning' ? 'starting…' : 'connection failed'}
                        </span>
                      </div>
                    </div>
                    <button
                      className="cockpit-kill-btn mono"
                      style={{ marginLeft: 'auto' }}
                      onClick={() => handleKillWorker(w)}
                      title="Dismiss failed worker and free worker name"
                    >
                      ✕ Dismiss
                    </button>
                  </div>

                  {w.error && (
                    <div className="mono" style={{ fontSize: 10.5, color: 'var(--status-blocked)', background: 'rgba(0,0,0,0.2)', padding: '4px 8px', borderRadius: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {w.error.slice(0, 140)}
                    </div>
                  )}

                  <div className="cockpit-swarm-actions">
                    <button className="orch-btn ghost small" onClick={() => handlePeek(w)} title="Inspect terminal output">
                      👁️ Inspect Log
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── PROJECT TRACKER BOARD VIEW (Classic 4-Column Kanban)
function ProjectTrackerBoardView({ project, cid, tickets, onOpenTicket }) {
  const [kindFilter, setKindFilter] = window.React.useState('all');
  const [search, setSearch] = window.React.useState('');

  const COLUMNS = [
    { id: 'todo', label: 'Todo', color: 'var(--status-open)' },
    { id: 'in_progress', label: 'In Progress', color: 'var(--status-running)' },
    { id: 'review', label: 'Review', color: 'var(--status-review)' },
    { id: 'done', label: 'Done', color: 'var(--status-done)' },
  ];

  const filtered = window.React.useMemo(() => {
    let rows = tickets.filter(t => t.state !== 'archived');
    if (kindFilter !== 'all') rows = rows.filter(t => t.kind === kindFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(t => (t.title||'').toLowerCase().includes(q) || (t.display_id||'').toLowerCase().includes(q));
    }
    return rows;
  }, [tickets, kindFilter, search]);

  const byState = window.React.useMemo(() => {
    const map = { todo: [], in_progress: [], review: [], done: [] };
    for (const t of filtered) {
      const st = t.state || 'todo';
      if (map[st]) map[st].push(t);
      else map.todo.push(t);
    }
    return map;
  }, [filtered]);

  const handleCycleState = (e, t) => {
    e.stopPropagation();
    const next = nextStateFor(t.state);
    window.SubstrateAPI.updateTicket(t.id || t.display_id, { state: next, actor: 'human:dashboard' })
      .then(u => { if (u?.id) window.Store.upsertTrackerTicket(u); });
  };

  return (
    <div className="project-tracker-board-view">
      <div className="tracker-board-toolbar">
        <div className="cockpit-kind-pills">
          {['all', 'spec', 'task', 'doc'].map(k => (
            <button
              key={k}
              className={`cockpit-filter-btn ${kindFilter === k ? 'active' : ''}`}
              onClick={() => setKindFilter(k)}
            >
              {k.toUpperCase()} ({tickets.filter(t => (k==='all'||t.kind===k) && t.state!=='archived').length})
            </button>
          ))}
        </div>
        <input
          className="cockpit-search"
          placeholder="Filter cards…"
          style={{ maxWidth: 240, marginLeft: 'auto' }}
          value={search}
          onChange={(e)=> setSearch(e.target.value)}
        />
        <button
          className="orch-btn primary small"
          onClick={() => window.Router.openComposer(cid, { kind: kindFilter === 'spec' ? 'spec' : 'task' })}
        >
          + New Card
        </button>
      </div>

      <div className="tracker-board-columns">
        {COLUMNS.map(col => {
          const list = byState[col.id] || [];
          return (
            <div key={col.id} className="tracker-column">
              <div className="tracker-column-head">
                <span className="tracker-column-indicator" style={{ background: col.color }} />
                <span className="tracker-column-title">{col.label}</span>
                <span className="tracker-column-count tnum">{list.length}</span>
              </div>
              <div className="tracker-column-cards">
                {list.map(t => {
                  return (
                    <div
                      key={t.id}
                      className="tracker-card"
                      onClick={() => onOpenTicket && onOpenTicket(t.id)}
                    >
                      <div className="tracker-card-top">
                        <span className="cockpit-ticket-kind-tag mono">{t.kind}</span>
                        <span className="mono tracker-card-id">{t.display_id || t.id}</span>
                        <button
                          className="tracker-card-cycle-btn"
                          onClick={(e) => handleCycleState(e, t)}
                          title={`Move to ${nextStateFor(t.state)}`}
                        >
                          ➔
                        </button>
                      </div>
                      <div className="tracker-card-title">{t.title}</div>
                      {t.assignee && (
                        <div className="tracker-card-meta mono">
                          <span>{t.assignee_label || t.assignee.slice(0,8)}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
                {list.length === 0 && <div className="tracker-column-empty">Empty</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Keep legacy helpers for compatibility
function ProjectPlanSection() { return null; }
function ProjectTrackerBoard() { return null; }
function ProjectSpecsBoard() { return null; }
function ProjectMilestoneTimeline() { return null; }
function ProjectSessions() { return null; }
function MilestoneStrip() { return null; }

if (typeof PVSection === 'undefined') { window.PVSection = ({children}) => window.React.createElement('div', null, children); } else window.PVSection = PVSection;
if (typeof MilestoneStrip === 'undefined') { window.MilestoneStrip = () => null; } else window.MilestoneStrip = MilestoneStrip;
window.ProjectView = ProjectView;
