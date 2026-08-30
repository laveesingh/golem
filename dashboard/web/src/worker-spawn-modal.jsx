// WorkerSpawnModal — 1-click worker spawn from UI (GOL-15)
// Picks Role, Name, Profile, Project and calls POST /api/workers/spawn

function WorkerSpawnModal({ open, onClose, defaultProjectId = null }) {
  const [roles, setRoles] = React.useState([]);
  const [profiles, setProfiles] = React.useState([]);
  const [projects, setProjects] = React.useState([]);
  const [role, setRole] = React.useState('builder');
  const [name, setName] = React.useState('');
  const [profile, setProfile] = React.useState('');
  const [project, setProject] = React.useState(defaultProjectId || '');
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    if (!open) return;
    setResult(null); setError(null);
    if (defaultProjectId) setProject(defaultProjectId);
    window.SubstrateAPI.listRoles().then(list => setRoles(Array.isArray(list)?list:[])).catch(()=>{});
    window.SubstrateAPI.modelProfiles().then(res => setProfiles(Array.isArray(res?.profiles)?res.profiles:[])).catch(()=>{});
    window.SubstrateAPI.projects().then(list => setProjects(Array.isArray(list)?list:[])).catch(()=>{});
  }, [open, defaultProjectId]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key==='Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSpawn = async () => {
    if (!role) { setError('Role is required'); return; }
    setBusy(true); setError(null); setResult(null);
    try {
      const body = { role };
      if (name.trim()) body.name = name.trim();
      if (project) body.project = project;
      if (profile) body.profile = profile;
      const worker = await window.SubstrateAPI.spawnWorker(body);
      setResult(worker);
    } catch (err) {
      setError(err?.payload?.error || err?.message || String(err));
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="drawer-backdrop open" onClick={onClose} />
      <div className="worker-spawn-modal open" role="dialog" aria-modal="true" aria-label="Spawn worker">
        <div className="worker-spawn-head">
          <h2>Spawn Worker</h2>
          <button className="drawer-close" onClick={onClose}>×</button>
        </div>
        <div className="worker-spawn-body">
          <label className="worker-spawn-field">
            <span>Role *</span>
            <select value={role} onChange={(e)=>setRole(e.target.value)}>
              {roles.length===0 && <option value="builder">builder</option>}
              {roles.map(r=> <option key={r.name} value={r.name}>{r.name}</option>)}
              {roles.length>0 && !roles.some(r=>r.name===role) && <option value={role}>{role}</option>}
            </select>
          </label>
          <label className="worker-spawn-field">
            <span>Name (auto if empty)</span>
            <input placeholder="my-worker-1" value={name} onChange={(e)=>setName(e.target.value)} />
          </label>
          <label className="worker-spawn-field">
            <span>Model Profile</span>
            <select value={profile} onChange={(e)=>setProfile(e.target.value)}>
              <option value="">— default for role —</option>
              {profiles.map(p=> <option key={p.name} value={p.name}>{p.name} — {p.provider}/{p.model}</option>)}
            </select>
          </label>
          <label className="worker-spawn-field">
            <span>Project</span>
            <select value={project} onChange={(e)=>setProject(e.target.value)}>
              <option value="">— current / auto —</option>
              {projects.map(p=> <option key={p.project_id||p.id} value={p.project_id||p.id}>{p.name} ({p.project_id||p.id})</option>)}
            </select>
          </label>
          {error && <div className="worker-spawn-error">{error}</div>}
          {result && <div className="worker-spawn-result">Spawned ✓ {result.name} — {result.state} {result.session_id ? `· ${String(result.session_id).slice(0,8)}` : ''}</div>}
        </div>
        <div className="worker-spawn-actions">
          <button className="orch-btn ghost" onClick={onClose}>Close</button>
          <button className="orch-btn primary" onClick={handleSpawn} disabled={busy || !role}>{busy ? 'Spawning…' : 'Spawn'}</button>
        </div>
      </div>
    </>
  );
}
window.WorkerSpawnModal = WorkerSpawnModal;
