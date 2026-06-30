// Project view (v4) — the per-project command center.
//
// Top-to-bottom the page leads with v4 progress objects only:
//
//   1. HERO            — name / glyph / counts.
//   2. PLAN            — live checklist from PLAN.md (N/M + bar), or one quiet
//                        line when the project has no plan.
//   3. TICKETS         — per-project tracker.db kanban.
//   4. MILESTONES      — this project's milestone timeline, newest first.
//   5. SESSIONS        — native Claude Code sessions in this project.
//
// The v3 journal-synthesized agents panel, markdown tracker kanban, hook-event
// stream, and gate panels were removed in TKT-0009.

const { useState: usePVState } = React;

function ProjectView({ projectId, tab, setRoute }) {
  useStore();
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

  const milestones = project.milestones || [];
  const sessions = window.Store.getProjectSessions(project);
  const aliveSessions = window.Store.getProjectAliveSessions(project);
  const plan = project.plan;

  return (
    <div className="page project-command-center">
      <div className="project-hero">
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
          <h1 className="project-hero-name">{project.name}</h1>
          <div className="project-hero-meta">
            <span className="mono">{project.project_id || project.id}</span>
            <span className="sep">·</span>
            <span>{milestones.length} milestones</span>
            <span className="sep">·</span>
            <span style={{ color: 'var(--accent)' }}>{aliveSessions.length} live session{aliveSessions.length === 1 ? '' : 's'}</span>
            {project.auto && (<><span className="sep">·</span><span className="native-session-badge">auto</span></>)}
          </div>
        </div>
      </div>

      {/* ── 1. PLAN ── */}
      <ProjectPlanSection plan={plan} color={project.color}/>

      {/* ── 1b. PENDING GATES (TKT-0194) — human-in-the-loop approval / input
          gates. The anchor agent (or any v4 agent) writes a gate file to
          ~/.config/golem/gates/<project_id>/<gate_id>.md when a phase
          needs a human verdict; the dashboard exposes the awaiting ones
          here with Approve / Deny / Cancel buttons. The human can also edit
          the file's `status:` line directly — both paths converge. */}
      <ProjectGatesSection project={project}/>

      {/* ── 2. TICKETS ── */}
      <ProjectTrackerBoard contractId={project.project_id || project.id}/>

      {/* ── 3. MILESTONE TIMELINE ── */}
      <ProjectMilestoneTimeline milestones={milestones}/>

      {/* ── 4. SESSIONS IN THIS PROJECT ── */}
      <ProjectSessions sessions={sessions} setRoute={setRoute} projectId={project.project_id || project.id}/>
    </div>
  );
}

// ── Reusable collapsible section ──────────────────────────────────────────
function CollapsibleSection({ title, count, defaultOpen = false, children }) {
  const [open, setOpen] = usePVState(defaultOpen);
  return (
    <section className={`pv-collapse ${open ? 'open' : ''}`}>
      <button className="pv-collapse-head" onClick={() => setOpen((o) => !o)}>
        <span className="pv-collapse-caret">{open ? '▾' : '▸'}</span>
        <span className="pv-collapse-title">{title}</span>
        {count != null && <span className="pv-collapse-count tnum">{count}</span>}
      </button>
      {open && <div className="pv-collapse-body">{children}</div>}
    </section>
  );
}

// ── 1. PLAN ──
function ProjectPlanSection({ plan, color }) {
  if (!plan || !plan.total) {
    return (
      <div className="pv-section">
        <div className="pv-section-head"><span className="pv-section-title">Plan</span></div>
        <div className="pv-quiet-line">no <span className="mono">PLAN.md</span> — add one at the project root to track progress here.</div>
      </div>
    );
  }
  const pct = Math.round((plan.done / plan.total) * 100);
  const barColor = color || 'var(--accent)';
  return (
    <div className="pv-section pv-plan">
      <div className="pv-section-head">
        <span className="pv-section-title">{plan.title || 'Plan'}</span>
        <span className="pv-plan-stat">
          <span className="tnum">{plan.done}/{plan.total}</span>
          <span className="pv-plan-pct tnum" style={{ color: barColor }}>{pct}%</span>
        </span>
      </div>
      <div className="pv-plan-bar">
        <div className="pv-plan-fill" style={{ width: `${pct}%`, background: barColor }}/>
      </div>
      <ul className="pv-plan-items">
        {plan.items.map((it, i) => (
          <li key={i} className={`pv-plan-item ${it.done ? 'done' : ''}`}>
            <span className="pv-plan-box">{it.done ? '✓' : '○'}</span>
            <span className="pv-plan-text">{it.text || <span style={{ color: 'var(--text-4)' }}>(empty)</span>}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── 2. TICKETS ──
function ProjectTrackerBoard({ contractId }) {
  useStore();
  const [showArchived, setShowArchived] = usePVState(false);

  const [dispatchable, setDispatchable] = usePVState([]);
  React.useEffect(() => {
    if (!contractId) { setDispatchable([]); return; }
    let cancelled = false;
    window.SubstrateAPI.listDispatchable(contractId)
      .then((list) => { if (!cancelled) setDispatchable(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setDispatchable([]); });
    return () => { cancelled = true; };
  }, [contractId]);

  const labelBySession = React.useMemo(() => {
    const m = new Map();
    for (const s of dispatchable) if (s.session_id) m.set(s.session_id, s.label);
    return m;
  }, [dispatchable]);
  const resolveAssignee = React.useCallback((a) => {
    if (a === 'human') return 'You';
    if (!a) return 'Unassigned';
    return labelBySession.get(a) || `session ${String(a).slice(0, 8)}`;
  }, [labelBySession]);

  const tickets = window.Store.getTrackerTickets({ project_id: contractId, includeArchived: showArchived });
  const base = window.TRACKER_COLUMNS || [];
  const cols = showArchived && window.TRACKER_ARCHIVED_COL ? [...base, window.TRACKER_ARCHIVED_COL] : base;

  const onNew = () => {
    window.Router.openComposer(contractId);
  };

  const Columns = window.TicketColumns;

  return (
    <div className="pv-section pv-tracker">
      <div className="pv-section-head">
        <span className="pv-section-title">Tickets</span>
        <span className="pv-section-count tnum">{tickets.length}</span>
        <div className="pv-tracker-tools">
          <label className="tracker-toggle">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}/>
            Show archived
          </label>
          <button className="orch-btn primary" onClick={onNew}>+ New ticket</button>
        </div>
      </div>
      {tickets.length === 0 && !showArchived ? (
        <div className="pv-quiet-line">
          no tracker tickets yet — click <span className="mono">+ New ticket</span> to create one in this project.
        </div>
      ) : Columns ? (
        <Columns
          cols={cols}
          tickets={tickets}
          projectByContract={null}
          resolveAssignee={resolveAssignee}
        />
      ) : null}
    </div>
  );
}

// ── 3. MILESTONE TIMELINE ──
function ProjectMilestoneTimeline({ milestones }) {
  if (!milestones || milestones.length === 0) {
    return (
      <div className="pv-section">
        <div className="pv-section-head"><span className="pv-section-title">Milestones</span></div>
        <div className="pv-quiet-line">no milestones yet — sessions append them as work lands.</div>
      </div>
    );
  }
  const ordered = [...milestones].sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  return (
    <div className="pv-section pv-milestones">
      <div className="pv-section-head">
        <span className="pv-section-title">Milestones</span>
        <span className="pv-section-count tnum">{milestones.length}</span>
      </div>
      <ul className="pv-timeline">
        {ordered.map((m, i) => (
          <li key={`${m.t}-${i}`} className="pv-timeline-item">
            <span className="pv-timeline-rail"><span className="pv-timeline-dot"/></span>
            <div className="pv-timeline-body">
              <div className="pv-timeline-text">{m.text}</div>
              <div className="pv-timeline-ts mono" title={window.SubstrateFmt?.fmtClock?.(m.t) || ''}>
                {window.SubstrateFmt?.fmtTimeAgo?.(m.t) || ''}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── 4. SESSIONS ──
function ProjectSessions({ sessions, setRoute, projectId }) {
  return (
    <div className="pv-section">
      <div className="pv-section-head">
        <span className="pv-section-title">Sessions in this project</span>
        <span className="pv-section-count tnum">{sessions.length}</span>
      </div>
      {sessions.length === 0 ? (
        <div className="pv-quiet-line">
          no live <span className="mono">claude</span> session in this project. Run <span className="mono">cd</span> into it and start one — it appears here automatically.
        </div>
      ) : (
        <div className="cc-session-list">
          {sessions.map((s) => <SessionCard key={s.session_id || s.pid} session={s} setRoute={setRoute}/>)}
        </div>
      )}
    </div>
  );
}

// TKT-0194: pending human gates. The server returns the project's gate list
// on /api/projects (via the snapshot). Each gate carries frontmatter (kind,
// status, phase_just_completed, next_phase) + body. We render awaiting
// gates inline with Approve / Deny / Cancel buttons that POST to
// /api/projects/:id/gates/:gateId/:decision. After a verdict we refresh
// the projects list so the gate moves to the resolved list (or disappears
// if cancelled). For input gates, the body describes the missing secret.
function ProjectGatesSection({ project }) {
  const allGates = (project && Array.isArray(project.gates)) ? project.gates : [];
  const awaiting = allGates.filter((g) => g.status === 'awaiting');
  const resolved = allGates.filter((g) => g.status !== 'awaiting');
  const [busyGateId, setBusyGateId] = usePVState(null);
  const [error, setError] = usePVState(null);

  if (allGates.length === 0) {
    return (
      <div className="pv-section">
        <div className="pv-section-head">
          <span className="pv-section-title">Pending gates</span>
          <span className="pv-section-count tnum">0</span>
        </div>
        <div className="pv-quiet-line">
          no <span className="mono">~/.config/golem/gates/</span> files for this project. Agents write a gate here when a phase needs a human verdict (see <span className="mono">plugin/skills/gates/SKILL.md</span>).
        </div>
      </div>
    );
  }

  const onVerdict = async (gateId, decision) => {
    setBusyGateId(gateId);
    setError(null);
    try {
      await window.SubstrateAPI.gateVerdict(project.project_id || project.id, gateId, decision);
      await window.Store.refreshProjects();
    } catch (err) {
      console.error('gate verdict failed', err);
      setError(err?.message || String(err));
    } finally {
      setBusyGateId(null);
    }
  };

  return (
    <div className="pv-section">
      <div className="pv-section-head">
        <span className="pv-section-title">
          Pending gates
          {awaiting.length > 0 && (
            <span className="pv-section-title-badge pulse">{awaiting.length} awaiting</span>
          )}
        </span>
        <span className="pv-section-count tnum">{allGates.length}</span>
      </div>
      {error && <div className="pv-section-error">verdict failed: {error}</div>}
      {awaiting.length > 0 && (
        <div className="pv-gates-awaiting">
          {awaiting.map((g) => (
            <div key={g.gateId} className="pv-gate pv-gate-awaiting">
              <div className="pv-gate-head">
                <span className="pv-gate-kind">{g.kind || 'approval'}</span>
                <span className="pv-gate-id mono">{g.gateId}</span>
                {g.phaseJustCompleted && (
                  <span className="pv-gate-phase">after <span className="mono">{g.phaseJustCompleted}</span></span>
                )}
                {g.nextPhase && (
                  <span className="pv-gate-phase">→ <span className="mono">{g.nextPhase}</span></span>
                )}
                {g.createdAt && (
                  <span className="pv-gate-ts mono">{g.createdAt.slice(0, 10)}</span>
                )}
              </div>
              {g.body && <div className="pv-gate-body">{renderGateBody(g.body)}</div>}
              <div className="pv-gate-actions">
                <button
                  className="orch-btn primary"
                  disabled={busyGateId === g.gateId}
                  onClick={() => onVerdict(g.gateId, 'approved')}
                >
                  {busyGateId === g.gateId ? '…' : 'Approve'}
                </button>
                <button
                  className="orch-btn ghost"
                  disabled={busyGateId === g.gateId}
                  onClick={() => onVerdict(g.gateId, 'denied')}
                >
                  Deny
                </button>
                <button
                  className="orch-btn ghost"
                  disabled={busyGateId === g.gateId}
                  onClick={() => onVerdict(g.gateId, 'cancelled')}
                >
                  Cancel
                </button>
                {g.path && (
                  <span className="pv-gate-path mono" title={g.path}>{g.path.replace(/^.*\/gates\//, 'gates/')}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {resolved.length > 0 && (
        <details className="pv-gates-resolved">
          <summary>
            <span>Resolved ({resolved.length})</span>
          </summary>
          <ul className="pv-gates-resolved-list">
            {resolved.map((g) => (
              <li key={g.gateId}>
                <span className={`pv-gate-status pv-gate-status-${g.status}`}>{g.status}</span>
                <span className="mono">{g.gateId}</span>
                {g.frontmatter && g.frontmatter.acted_at && (
                  <span className="pv-gate-ts mono">{String(g.frontmatter.acted_at).slice(0, 16).replace('T', ' ')}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// Render the gate body as a short list (gate files use ## headings + bullets).
// Plain JSX construction — never mutate .props.children, just build a new tree.
function renderGateBody(body) {
  const lines = body.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }
    if (trimmed.startsWith('# ')) {
      out.push(<div key={out.length} className="pv-gate-body-h1">{trimmed.slice(2)}</div>);
      i++;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      out.push(<div key={out.length} className="pv-gate-body-h2">{trimmed.slice(3)}</div>);
      i++;
      continue;
    }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const items = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        if (!t || (!t.startsWith('- ') && !t.startsWith('* '))) break;
        items.push(<li key={items.length}>{t.slice(2)}</li>);
        i++;
      }
      out.push(<ul key={out.length} className="pv-gate-body-ul">{items}</ul>);
      continue;
    }
    // Paragraph: collect consecutive non-blank, non-heading, non-bullet lines.
    const paraLines = [];
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t || t.startsWith('# ') || t.startsWith('## ') || t.startsWith('- ') || t.startsWith('* ')) break;
      paraLines.push(t);
      i++;
    }
    if (paraLines.length) {
      out.push(<p key={out.length} className="pv-gate-body-p">{paraLines.join(' ')}</p>);
    }
  }
  return <div className="pv-gate-body-rendered">{out}</div>;
}

// v4: milestones are the primary progress signal.
function MilestoneStrip({ milestones }) {
  if (!milestones || milestones.length === 0) return null;
  const recent = milestones.slice(-8);
  return (
    <div className="milestone-strip">
      <div className="milestone-strip-head">
        <Icon.Activity size={13}/>
        <span>Milestones</span>
        <span className="milestone-strip-count">{milestones.length}</span>
      </div>
      <ul className="milestone-list">
        {recent.map((m, i) => (
          <li key={`${m.t}-${i}`} className="milestone-item">
            <span className="milestone-dot"/>
            <span className="milestone-text">{m.text}</span>
            <span className="milestone-ts mono">{window.SubstrateFmt?.fmtClock?.(m.t) || ''}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

window.ProjectView = ProjectView;
window.CollapsibleSection = CollapsibleSection;
window.MilestoneStrip = MilestoneStrip;
