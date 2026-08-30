// Command-center home (v4). Three zones:
//   1. SESSIONS RAIL  — every native Golem session: status, what it's
//      stuck on, and per-session controls (brief composer + interrupt/halt
//      when a live channel exists for that session).
//   2. WORK ZONE      — project cards reworked around PLAN.md progress and the
//      latest milestone.
//   3. CONTROL & FEED — cross-project milestone feed (the primary progress signal).
//
// The home renders entirely from the snapshot (native_sessions, channels,
// projects[].plan/.milestones, recent_milestones) — NO
// per-project fetches.

const { useState: useDState, useCallback: useDCallback } = React;

function Dashboard({ setRoute }) {
  useStore();
  const state = window.Store.getState();
  const sessions = window.Store.getNativeSessions();
  const projects = state.projects;
  const milestones = window.Store.getRecentMilestones();

  const aliveCount = sessions.filter((s) => s.alive).length;
  const busyCount = sessions.filter((s) => s.alive && s.status === 'busy').length;
  const waitingCount = sessions.filter((s) => s.alive && s.status === 'waiting').length;

  return (
    <div className="page command-center">
      <div className="page-header">
        <div>
          <h1 className="page-title">Command Center</h1>
          <div className="page-subtitle">
            What is running right now, what it is stuck on, and where every project stands.
          </div>
        </div>
        <div className="cc-headline-stats">
          <CCStat value={aliveCount} label="sessions live" tone="active"/>
          <CCStat value={busyCount} label="working" tone="running"/>
          <CCStat value={waitingCount} label="waiting" tone="review"/>
        </div>
      </div>

      <div className="cc-grid">
        {/* ── Zone 1: Sessions rail ── */}
        <section className="cc-zone cc-sessions">
          <div className="cc-zone-head">
            <span className="cc-zone-title">Sessions</span>
            <span className="cc-zone-count">{sessions.length}</span>
          </div>
          {sessions.length === 0 ? (
            <EmptyCard
              label="no Golem sessions running"
              hint={<>This rail lists live sessions from supported Golem harnesses. Start a supported harness in a project to bring it online.</>}
            />
          ) : (
            <div className="cc-session-list">
              {sessions.map((s) => (
                <AgentCard key={s.session_id || s.pid} session={s} setRoute={setRoute} showControls/>
              ))}
            </div>
          )}
        </section>

        {/* ── Zone 2: Work zone ── */}
        <section className="cc-zone cc-work">
          <div className="cc-zone-head">
            <span className="cc-zone-title">Projects</span>
            <span className="cc-zone-count">{projects.length}</span>
          </div>
          {projects.length === 0 ? (
            window.EmptyStateOnboardingCTA ? React.createElement(window.EmptyStateOnboardingCTA, { kind: 'projects', setRoute }) : <EmptyCard label="no projects discovered" hint={<>Projects appear as sessions register them, or bootstrap one under <span className="mono">golem-projects/</span>.</>} />
          ) : (
            <div className="cc-project-list">
              {projects.map((p) => (
                <WorkCard key={p.id} project={p} setRoute={setRoute}/>
              ))}
            </div>
          )}
        </section>

        {/* ── Zone 3: Milestone feed ── */}
        <section className="cc-zone cc-control">
          <MilestoneFeed milestones={milestones} setRoute={setRoute}/>
        </section>
      </div>
    </div>
  );
}

function CCStat({ value, label, tone }) {
  return (
    <div className={`cc-stat tone-${tone || 'muted'}`}>
      <div className="cc-stat-value tnum">{value}</div>
      <div className="cc-stat-label">{label}</div>
    </div>
  );
}

// A small clickable chip linking to a project page (or a quiet "unregistered"
// badge style when the session's project isn't tracked by the dashboard).
//
// `registered` is the server's authoritative flag (native-sessions.js matches
// the session cwd/root against the registry). It can be TRUE even when no local
// project record resolves here — the dashboard `id` (registry id) and the
// derived contract `project_id` differ for most registered projects. So the
// "unregistered" badge keys off `registered`, NOT merely off a missing project
// record: only a genuinely unregistered cwd gets the badge.
function ProjectChip({ project, projectId, registered, setRoute }) {
  if (project) {
    return (
      <button
        className="cc-chip"
        style={{ '--chip-color': project.color }}
        onClick={(e) => { e.stopPropagation(); setRoute && setRoute({ kind: 'project', id: project.id, tab: 'agents' }); }}
        title={`open ${project.name}`}
      >
        <span className="cc-chip-dot" style={{ background: project.color }}/>
        <span className="cc-chip-text">{project.name}</span>
      </button>
    );
  }
  // Registered but no resolvable project record (id/contract-id mismatch, or a
  // project the dashboard summary hasn't surfaced): show the derived id as a
  // quiet chip WITHOUT the unregistered tag.
  if (registered) {
    return (
      <span className="cc-chip" title={projectId ? `registered project — ${projectId}` : 'registered project'}>
        <span className="cc-chip-dot"/>
        <span className="cc-chip-text mono">{projectId ? projectId : '—'}</span>
      </span>
    );
  }
  return (
    <span className="cc-chip cc-chip-unregistered" title={projectId ? `derived project_id: ${projectId} — not registered with the dashboard` : 'no project'}>
      <span className="cc-chip-dot"/>
      <span className="cc-chip-text mono">{projectId ? projectId : '—'}</span>
      <span className="cc-chip-tag">unregistered</span>
    </span>
  );
}

// ── Zone 2: a project card built around PLAN progress + latest milestone ──
function WorkCard({ project: p, setRoute }) {
  // v5b: home progress now comes from the cross-project tracker (tracker.db),
  // not PLAN.md. done = state 'done'; total = non-archived tickets for this
  // project's CONTRACT project_id. Falls back gracefully (no bar) when the
  // project has zero tracker tickets.
  const contractId = p.project_id || p.id;
  const trackerTickets = window.Store.getTrackerTickets({ project_id: contractId });
  const trackerTotal = trackerTickets.length;
  const trackerDone = trackerTickets.filter((t) => t.state === 'done').length;
  const hasTracker = trackerTotal > 0;

  const milestones = p.milestones || [];
  const latest = milestones.length ? milestones[milestones.length - 1] : null;
  const hasActivity = hasTracker || milestones.length > 0;
  const live = window.Store.getProjectAliveSessions(p).length;
  const pct = hasTracker ? Math.round((trackerDone / trackerTotal) * 100) : 0;

  // Compact render for projects with no plan + no activity.
  if (!hasActivity) {
    return (
      <button
        className="cc-work-card compact"
        style={{ '--card-color': p.color }}
        onClick={() => setRoute({ kind: 'project', id: p.id })}
      >
        <ProjectGlyph project={p} size={26}/>
        <span className="cc-work-name">{p.name}</span>
        {p.auto && <span className="cc-work-tag">auto</span>}
        {live > 0 && <span className="cc-work-live"><span className="orch-dot live"/>{live}</span>}
      </button>
    );
  }

  return (
    <div
      className="cc-work-card"
      style={{ '--card-color': p.color }}
      onClick={() => setRoute({ kind: 'project', id: p.id })}
    >
      <div className="cc-work-top">
        <ProjectGlyph project={p} size={30}/>
        <div className="cc-work-titlewrap">
          <div className="cc-work-name">{p.name}</div>
          <div className="cc-work-id mono">{p.id}</div>
        </div>
        <div className="cc-work-badges">
          {live > 0 && <span className="cc-work-live"><span className="orch-dot live"/>{live}</span>}
        </div>
      </div>

      {hasTracker && (
        <div className="cc-plan">
          <div className="cc-plan-bar">
            <div className="cc-plan-fill" style={{ width: `${pct}%`, background: p.color }}/>
          </div>
          <span className="cc-plan-count tnum">{trackerDone}/{trackerTotal}</span>
          <span className="cc-plan-pct tnum" style={{ color: p.color }}>{pct}%</span>
        </div>
      )}

      {latest ? (
        <div className="cc-work-milestone" title={latest.text}>
          <span className="cc-work-milestone-dot"/>
          <span className="cc-work-milestone-text">{latest.text}</span>
          <span className="cc-work-milestone-ts mono">{window.SubstrateFmt.fmtTimeAgo(latest.t)}</span>
        </div>
      ) : (
        <div className="cc-work-milestone muted">no milestones yet</div>
      )}
    </div>
  );
}

// ── Zone 3: cross-project milestone feed (primary progress signal) ──
function MilestoneFeed({ milestones, setRoute }) {
  return (
    <div className="cc-panel">
      <div className="cc-zone-head">
        <span className="cc-zone-title">Milestone Feed</span>
        <span className="cc-zone-count">{milestones.length}</span>
      </div>
      {milestones.length === 0 ? (
        <div className="cc-panel-empty">
          No milestones yet. Sessions append them as work lands — they are the primary progress signal.
        </div>
      ) : (
        <ul className="cc-feed">
          {milestones.map((m, i) => {
            const project = window.Store.getProjectByContractId(m.project);
            return (
              <li key={`${m.t}-${i}`} className="cc-feed-item">
                <span className="cc-feed-dot" style={{ background: m.project_color || 'var(--accent)' }}/>
                <div className="cc-feed-body">
                  <div className="cc-feed-text">{m.text}</div>
                  <div className="cc-feed-meta">
                    <ProjectChip project={project} projectId={m.project} registered setRoute={setRoute}/>
                    <span className="cc-feed-ts mono">{window.SubstrateFmt.fmtTimeAgo(m.t)}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function EmptyCard({ label, hint }) {
  return (
    <div className="empty-card">
      <div>{label}</div>
      <div className="empty-card-hint">{hint}</div>
    </div>
  );
}

window.Dashboard = Dashboard;
window.EmptyCard = EmptyCard;
window.WorkCard = WorkCard;
window.MilestoneFeed = MilestoneFeed;
window.ProjectChip = ProjectChip;
