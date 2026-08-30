// Onboarding — First Flight wizard (GOL-16)
// Route: /onboarding  + empty-state CTA when no projects / no specs
// 3-step stepper: 1) Environment Readiness (DiagnosticCard), 2) Workspace setup (import vs scaffold), 3) First spec creation (prompt → spec → dispatch)

function OnboardingPage({ setRoute }) {
  const [step, setStep] = React.useState(1);
  const projects = window.Store ? window.Store.getState().projects : [];
  const hasProjects = projects.length > 0;

  // Step 1 readiness is separate card; allow continue even if amber/red but warn
  const nextStep = () => setStep((s) => Math.min(3, s + 1));
  const prevStep = () => setStep((s) => Math.max(1, s - 1));

  return (
    <div className="page onboarding-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">First Flight — Onboarding</h1>
          <div className="page-subtitle">From green field to living spec in three steps. Zero ambiguity, zero terminal.</div>
        </div>
      </div>

      <div className="onboarding-stepper">
        <div className={`onboarding-step ${step >= 1 ? 'active' : ''} ${step > 1 ? 'done' : ''}`}>
          <span className="onboarding-step-num">1</span>
          <span className="onboarding-step-label">Readiness</span>
        </div>
        <span className="onboarding-step-sep">→</span>
        <div className={`onboarding-step ${step >= 2 ? 'active' : ''} ${step > 2 ? 'done' : ''}`}>
          <span className="onboarding-step-num">2</span>
          <span className="onboarding-step-label">Workspace</span>
        </div>
        <span className="onboarding-step-sep">→</span>
        <div className={`onboarding-step ${step >= 3 ? 'active' : ''}`}>
          <span className="onboarding-step-num">3</span>
          <span className="onboarding-step-label">First Spec</span>
        </div>
      </div>

      <div className="onboarding-content">
        {step === 1 && <OnboardingStepReadiness onNext={nextStep} />}
        {step === 2 && <OnboardingStepWorkspace onNext={nextStep} onBack={prevStep} setRoute={setRoute} hasProjects={hasProjects} />}
        {step === 3 && <OnboardingStepFirstSpec onBack={prevStep} setRoute={setRoute} />}
      </div>
    </div>
  );
}

function OnboardingStepReadiness({ onNext }) {
  return (
    <div className="onboarding-step-panel">
      <h2>Step 1 — Environment Readiness</h2>
      <p className="onboarding-step-desc">Automated doctor checks for Pi, Claude Code, Codex, and model API keys. Green = ready, amber = warning, red = action required.</p>
      <DiagnosticCard />
      <div className="onboarding-step-actions">
        <button className="orch-btn primary" onClick={onNext}>Continue to Workspace →</button>
        <span className="onboarding-step-hint">You can continue even if some checks are amber — remediation hints are on the card.</span>
      </div>
    </div>
  );
}

function OnboardingStepWorkspace({ onNext, onBack, setRoute, hasProjects }) {
  const [busy, setBusy] = React.useState(null); // 'import' | 'scaffold' | null
  const [error, setError] = React.useState(null);
  const [result, setResult] = React.useState(null);

  const handleImport = async () => {
    const path = prompt('Path to existing Git repo to import (absolute path, e.g. /Users/you/code/my-app):');
    if (!path || !path.trim()) return;
    setBusy('import');
    setError(null);
    setResult(null);
    try {
      const res = await window.SubstrateAPI.postJSON('/api/projects/import', { path: path.trim() });
      setResult(res);
      // Refresh projects list via store (snapshot will update via WS, but we can also fetch)
      if (window.Store && window.Store.refreshProjects) await window.Store.refreshProjects();
      // Alternatively, force reload snapshot
      setTimeout(() => { setResult(null); onNext && onNext(); }, 800);
    } catch (e) {
      setError(e.payload?.error || e.message || String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleScaffold = async () => {
    const name = prompt('Name for new project directory (e.g. my-first-golem-app):');
    if (!name || !name.trim()) return;
    setBusy('scaffold');
    setError(null);
    setResult(null);
    try {
      const res = await window.SubstrateAPI.postJSON('/api/projects/scaffold', { name: name.trim() });
      setResult(res);
      if (window.Store && window.Store.refreshProjects) await window.Store.refreshProjects();
      setTimeout(() => { setResult(null); onNext && onNext(); }, 800);
    } catch (e) {
      setError(e.payload?.error || e.message || String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="onboarding-step-panel">
      <h2>Step 2 — Workspace Setup</h2>
      <p className="onboarding-step-desc">Create a new directory or import an existing Git repository. Both scaffold <span className="mono">AGENTS.md</span> and initialize tracker state.</p>
      <div className="onboarding-workspace-grid">
        <div className="onboarding-workspace-card">
          <h3>Import Git Repo</h3>
          <p>Bring an existing repository under Golem’s project root. We’ll add <span className="mono">AGENTS.md</span> if missing and register it.</p>
          <button className="orch-btn primary" onClick={handleImport} disabled={!!busy}>{busy === 'import' ? 'Importing…' : 'Import Git Repo'}</button>
        </div>
        <div className="onboarding-workspace-card">
          <h3>Scaffold New Directory</h3>
          <p>Create a fresh project directory pre-seeded with <span className="mono">AGENTS.md</span>, <span className="mono">docs/</span>, and tracker linkage.</p>
          <button className="orch-btn" onClick={handleScaffold} disabled={!!busy}>{busy === 'scaffold' ? 'Scaffolding…' : 'Scaffold New'}</button>
        </div>
      </div>
      {error && <div className="onboarding-error">{error}</div>}
      {result && <div className="onboarding-result">✓ {result.project_id || result.id || result.name} ready — AGENTS.md scaffolded</div>}
      {hasProjects && <div className="onboarding-hint">You already have {hasProjects ? 'projects' : 'no projects'} — you can skip or add another.</div>}
      <div className="onboarding-step-actions">
        <button className="orch-btn ghost" onClick={onBack}>← Back</button>
        <button className="orch-btn primary" onClick={onNext}>Continue to First Spec →</button>
        <button className="orch-btn ghost" onClick={() => setRoute && setRoute({ kind: 'projects' })}>View Projects</button>
      </div>
    </div>
  );
}

function OnboardingStepFirstSpec({ onBack, setRoute }) {
  const [title, setTitle] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [profile, setProfile] = React.useState('');
  const [profiles, setProfiles] = React.useState([]);
  const [projects, setProjects] = React.useState([]);
  const [projectId, setProjectId] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [result, setResult] = React.useState(null);

  React.useEffect(() => {
    window.SubstrateAPI.modelProfiles().then(res => setProfiles(Array.isArray(res?.profiles) ? res.profiles : [])).catch(()=>{});
    window.SubstrateAPI.projects().then(list => {
      const arr = Array.isArray(list) ? list : [];
      setProjects(arr);
      if (arr.length && !projectId) setProjectId(arr[0].project_id || arr[0].id);
    }).catch(()=>{});
  }, []);

  const handleCreate = async () => {
    const t = title.trim();
    const p = prompt.trim();
    if (!t) { setError('Spec title is required'); return; }
    if (!p) { setError('Prompt is required — describe what to build'); return; }
    if (!projectId) { setError('Pick a project'); return; }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // Create spec ticket with prompt as body preamble
      const body = `# Spec: ${t}\n\n## 1. Intent\n\n${p}\n\n## 2. Current behavior\n\n_TODO: grounded research_\n\n## 3. Design\n\n_TODO_\n`;
      const ticket = await window.SubstrateAPI.createTicket({ project_id: projectId, kind: 'spec', title: t, body, state: 'todo' });
      // Optionally dispatch to lead/worker if profile selected and worker exists
      let dispatchRes = null;
      if (profile) {
        // Try to find a dispatchable worker for this project with that profile or any
        try {
          const dispatchable = await window.SubstrateAPI.listDispatchable(projectId);
          const target = (Array.isArray(dispatchable) && dispatchable[0]?.session_id) ? dispatchable[0].session_id : null;
          if (target) {
            dispatchRes = await window.SubstrateAPI.dispatchTicket(ticket.display_id || ticket.id, { session_id: target, note: `First Flight spec: ${t}`, mode: 'now' });
          }
        } catch {}
      }
      setResult({ ticket, dispatchRes });
    } catch (e) {
      setError(e.payload?.error || e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding-step-panel">
      <h2>Step 3 — First Flight Spec</h2>
      <p className="onboarding-step-desc">Prompt-to-spec drafting. We’ll create a living spec document, assign a worker profile, and dispatch with one click.</p>
      <div className="onboarding-spec-form">
        <label className="onboarding-field">
          <span>Project</span>
          <select value={projectId} onChange={(e)=> setProjectId(e.target.value)}>
            {projects.map(p=> <option key={p.project_id||p.id} value={p.project_id||p.id}>{p.name} ({p.project_id||p.id})</option>)}
            {projects.length===0 && <option value="">— no projects yet — scaffold one in Step 2 —</option>}
          </select>
        </label>
        <label className="onboarding-field">
          <span>Spec Title</span>
          <input placeholder="e.g. User authentication with magic links" value={title} onChange={(e)=> setTitle(e.target.value)} />
        </label>
        <label className="onboarding-field">
          <span>Prompt — what to build</span>
          <textarea rows={5} placeholder="Describe the feature, constraints, and acceptance criteria..." value={prompt} onChange={(e)=> setPrompt(e.target.value)} />
        </label>
        <label className="onboarding-field">
          <span>Worker Profile (optional)</span>
          <select value={profile} onChange={(e)=> setProfile(e.target.value)}>
            <option value="">— auto / lead —</option>
            {profiles.map(p=> <option key={p.name} value={p.name}>{p.name} — {p.provider}/{p.model}</option>)}
          </select>
        </label>
        {error && <div className="onboarding-error">{error}</div>}
        {result && (
          <div className="onboarding-result">
            ✓ Created {result.ticket.display_id || result.ticket.id} — <a href={window.Router.buildHref({ kind: 'ticket', id: result.ticket.display_id || result.ticket.id })} onClick={(e)=> { e.preventDefault(); window.Router.openTicket(result.ticket.display_id || result.ticket.id); }}>{result.ticket.title}</a>
            {result.dispatchRes ? ` · dispatched to ${result.dispatchRes.ticket?.assignee || 'worker'}` : ' · not yet dispatched (pick a worker and retry)'}
          </div>
        )}
      </div>
      <div className="onboarding-step-actions">
        <button className="orch-btn ghost" onClick={onBack}>← Back</button>
        <button className="orch-btn primary" onClick={handleCreate} disabled={busy || !title.trim() || !prompt.trim() || !projectId}>{busy ? 'Creating…' : 'Create & Dispatch Spec →'}</button>
        {result && <button className="orch-btn ghost" onClick={()=> setRoute && setRoute({ kind: 'project', id: projectId })}>Open Project Workspace →</button>}
      </div>
    </div>
  );
}

// Empty-state CTA cards reused in dashboard and project-view when no data
function EmptyStateOnboardingCTA({ kind = 'projects', setRoute }) {
  if (kind === 'projects') {
    return (
      <div className="empty-card onboarding-cta">
        <div>no projects yet — start your First Flight</div>
        <div className="empty-card-hint">Launch the 3-step wizard to check environment, set up a workspace, and create your first living spec.</div>
        <button className="orch-btn primary" onClick={()=> setRoute && setRoute({ kind: 'onboarding' })}>Start First Flight →</button>
      </div>
    );
  }
  if (kind === 'specs') {
    return (
      <div className="empty-card onboarding-cta">
        <div>no specs in this project</div>
        <div className="empty-card-hint">Create your first living spec — it will become the cockpit’s center stage.</div>
        <button className="orch-btn primary" onClick={()=> window.Router.openComposer(null, { kind: 'spec' })}>+ New Spec</button>
      </div>
    );
  }
  return null;
}

window.OnboardingPage = OnboardingPage;
window.EmptyStateOnboardingCTA = EmptyStateOnboardingCTA;
