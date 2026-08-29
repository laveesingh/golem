// Substrate management surface (GOL-2) — browse, inspect, edit, create,
// and synchronize canonical skills, global instructions, roles, and harness renders across
// both built-in substrate sources, user global pools, and project-scoped pools.

function SubstratePage({ route, setRoute }) {
  const [activeTab, setActiveTab] = React.useState(route?.tab || 'skills');
  const [syncing, setSyncing] = React.useState(false);
  const [syncResult, setSyncResult] = React.useState(null);
  const [toast, setToast] = React.useState(null);

  React.useEffect(() => {
    if (route?.tab && route.tab !== activeTab) {
      setActiveTab(route.tab);
    }
  }, [route?.tab]);

  const switchTab = (tab) => {
    setActiveTab(tab);
    if (setRoute) setRoute({ kind: 'substrate', tab, slug: route?.slug || null });
  };

  const flashToast = (msg, type = 'success') => {
    setToast({ msg, type, id: Math.random() });
    setTimeout(() => setToast(null), 4000);
  };

  const handleGlobalSync = async (force = false) => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await window.SubstrateAPI.syncSubstrate({ force });
      setSyncResult(res);
      const okCount = (res.results || []).filter((r) => r.status === 'ok').length;
      flashToast(`Substrate sync complete: ${okCount} harness target${okCount === 1 ? '' : 's'} updated.`, 'success');
    } catch (err) {
      const msg = String(err?.payload?.error || err?.message || err);
      flashToast(`Sync failed: ${msg}`, 'error');
      setSyncResult(err?.payload || { status: 'error', error: msg });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="page substrate-page">
      <div className="page-header substrate-page-header">
        <div>
          <div className="substrate-header-title-row">
            <h1 className="page-title">Substrate & Skills Layer</h1>
            <span className="substrate-badge mono">canonical & user pools</span>
          </div>
          <div className="page-subtitle">
            Author and inspect canonical substrate skills, user global skills, project skills, instructions, and roles.
          </div>
        </div>

        <div className="substrate-header-actions">
          <button
            type="button"
            className="orch-btn primary substrate-sync-btn"
            onClick={() => handleGlobalSync(false)}
            disabled={syncing}
          >
            {syncing ? 'Syncing…' : '⚡ Sync All Harnesses'}
          </button>
        </div>
      </div>

      {toast && (
        <div className={`substrate-toast ${toast.type}`} key={toast.id}>
          {toast.msg}
        </div>
      )}

      <div className="substrate-tabs-bar">
        <button
          type="button"
          className={`substrate-tab-btn ${activeTab === 'skills' ? 'active' : ''}`}
          onClick={() => switchTab('skills')}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="2" width="12" height="12" rx="2"/>
            <path d="M5.5 8l2 2 3.5-4"/>
          </svg>
          <span>Skills Catalog</span>
        </button>

        <button
          type="button"
          className={`substrate-tab-btn ${activeTab === 'instructions' ? 'active' : ''}`}
          onClick={() => switchTab('instructions')}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.5 1.5H10L12.5 4V14a.5.5 0 0 1-.5.5H3.5a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z"/>
            <path d="M10 1.5V4h2.5"/>
            <path d="M5 7h5"/>
            <path d="M5 9.5h5"/>
            <path d="M5 12h3"/>
          </svg>
          <span>Instructions (AGENTS.md)</span>
        </button>

        <button
          type="button"
          className={`substrate-tab-btn ${activeTab === 'roles' ? 'active' : ''}`}
          onClick={() => switchTab('roles')}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="5.5" cy="6" r="2"/>
            <circle cx="11" cy="6" r="1.6"/>
            <path d="M2 13C2 11 3.5 9.5 5.5 9.5C7.5 9.5 9 11 9 13"/>
            <path d="M9.5 13C9.5 11.5 10.5 10 12 10C13.4 10 14 11 14 12"/>
          </svg>
          <span>Roles Registry</span>
        </button>

        <button
          type="button"
          className={`substrate-tab-btn ${activeTab === 'sync' ? 'active' : ''}`}
          onClick={() => switchTab('sync')}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="8 1.5 14 4.5 8 7.5 2 4.5 8 1.5"/>
            <polyline points="2 8 8 11 14 8"/>
            <polyline points="2 11.5 8 14.5 14 11.5"/>
          </svg>
          <span>Harness Sync & Matrix</span>
        </button>
      </div>

      <div className="substrate-content">
        {activeTab === 'skills' && (
          <SubstrateSkillsView
            initialSlug={route?.slug}
            onSync={() => handleGlobalSync(false)}
            onToast={flashToast}
          />
        )}
        {activeTab === 'instructions' && (
          <SubstrateInstructionsView
            onSync={() => handleGlobalSync(false)}
            onToast={flashToast}
          />
        )}
        {activeTab === 'roles' && (
          <SubstrateRolesView
            onSync={() => handleGlobalSync(false)}
            onToast={flashToast}
          />
        )}
        {activeTab === 'sync' && (
          <SubstrateSyncView
            onSync={handleGlobalSync}
            syncing={syncing}
            syncResult={syncResult}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Multi-Pool Skills Catalog & Editor Tab
// ---------------------------------------------------------------------------

function SubstrateSkillsView({ initialSlug, onSync, onToast }) {
  const [skills, setSkills] = React.useState([]);
  const [selectedSlug, setSelectedSlug] = React.useState(initialSlug || null);
  const [selectedScope, setSelectedScope] = React.useState(null);
  const [poolFilter, setPoolFilter] = React.useState('all'); // 'all' | 'builtin' | 'user' | 'project'
  const [loadingList, setLoadingList] = React.useState(true);
  const [search, setSearch] = React.useState('');
  const [showCreateModal, setShowCreateModal] = React.useState(false);

  const loadSkills = React.useCallback(async () => {
    try {
      const list = await window.SubstrateAPI.listSubstrateSkills();
      setSkills(Array.isArray(list) ? list : []);
      if (!selectedSlug && list.length > 0) {
        setSelectedSlug(list[0].slug);
        setSelectedScope(list[0].scope);
      }
    } catch (err) {
      onToast(`Failed to load skills: ${err.message}`, 'error');
    } finally {
      setLoadingList(false);
    }
  }, [selectedSlug, onToast]);

  React.useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const poolCounts = React.useMemo(() => {
    const counts = { all: skills.length, builtin: 0, user: 0, project: 0 };
    for (const s of skills) {
      if (s.scope in counts) counts[s.scope] += 1;
    }
    return counts;
  }, [skills]);

  const filtered = React.useMemo(() => {
    let list = skills;
    if (poolFilter !== 'all') {
      list = list.filter((s) => s.scope === poolFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((s) => (
        s.slug.toLowerCase().includes(q)
        || s.name.toLowerCase().includes(q)
        || (s.description || '').toLowerCase().includes(q)
      ));
    }
    return list;
  }, [skills, poolFilter, search]);

  const handleCreated = (newSkill) => {
    setShowCreateModal(false);
    setSkills((prev) => [...prev.filter((s) => s.slug !== newSkill.slug || s.scope !== newSkill.scope), newSkill].sort((a, b) => a.slug.localeCompare(b.slug)));
    setSelectedSlug(newSkill.slug);
    setSelectedScope(newSkill.scope);
    onToast(`Skill "${newSkill.slug}" (${newSkill.scope}) created successfully!`, 'success');
  };

  const handleDeleted = (slug, scope) => {
    setSkills((prev) => prev.filter((s) => !(s.slug === slug && s.scope === scope)));
    const remaining = skills.filter((s) => !(s.slug === slug && s.scope === scope));
    setSelectedSlug(remaining[0]?.slug || null);
    setSelectedScope(remaining[0]?.scope || null);
    onToast(`Skill "${slug}" removed from ${scope} pool.`, 'success');
  };

  return (
    <div className="substrate-skills-container">
      {/* Left Sidebar List */}
      <div className="substrate-skills-sidebar">
        <div className="substrate-skills-sidebar-head">
          <div className="substrate-skills-count">
            <strong>Skills</strong> <span className="mono tnum">({filtered.length})</span>
          </div>
          <button
            type="button"
            className="orch-btn small primary"
            onClick={() => setShowCreateModal(true)}
          >
            + New Skill
          </button>
        </div>

        {/* Pool Selector Tabs */}
        <div className="substrate-pool-pills" role="group" aria-label="Skill scope">
          <button
            type="button"
            className={`substrate-pool-pill ${poolFilter === 'all' ? 'active' : ''}`}
            onClick={() => setPoolFilter('all')}
          >
            All ({poolCounts.all})
          </button>
          <button
            type="button"
            className={`substrate-pool-pill ${poolFilter === 'builtin' ? 'active' : ''}`}
            onClick={() => setPoolFilter('builtin')}
          >
            Substrate ({poolCounts.builtin})
          </button>
          <button
            type="button"
            className={`substrate-pool-pill ${poolFilter === 'user' ? 'active' : ''}`}
            onClick={() => setPoolFilter('user')}
          >
            User Global ({poolCounts.user})
          </button>
          {poolCounts.project > 0 && (
            <button
              type="button"
              className={`substrate-pool-pill ${poolFilter === 'project' ? 'active' : ''}`}
              onClick={() => setPoolFilter('project')}
            >
              Project ({poolCounts.project})
            </button>
          )}
        </div>

        <div className="substrate-search-box">
          <input
            type="text"
            className="substrate-search-input mono"
            placeholder="Search skills across pools…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="substrate-skills-list">
          {loadingList ? (
            <div className="substrate-empty-hint">Loading skills…</div>
          ) : filtered.length === 0 ? (
            <div className="substrate-empty-hint">No matching skills found in this pool.</div>
          ) : (
            filtered.map((s) => (
              <button
                key={`${s.scope}-${s.slug}`}
                type="button"
                className={`substrate-skill-item ${selectedSlug === s.slug && selectedScope === s.scope ? 'active' : ''}`}
                onClick={() => { setSelectedSlug(s.slug); setSelectedScope(s.scope); }}
              >
                <div className="substrate-skill-item-header">
                  <div className="substrate-skill-item-name mono">{s.slug}</div>
                  <span className={`substrate-scope-badge ${s.scope}`}>
                    {s.scope === 'builtin' ? 'Substrate' : s.scope === 'user' ? 'User Global' : `Project: ${s.project_name || 'repo'}`}
                  </span>
                </div>
                <div className="substrate-skill-item-desc">{s.description || 'No description provided.'}</div>
                <div className="substrate-skill-item-meta">
                  <span>{s.word_count || 0} words</span>
                  <span>·</span>
                  <span>{window.SubstrateFmt?.fmtTimeAgo?.(s.updated_at) || ''}</span>
                  {s.has_templates && <span className="substrate-pill">templates</span>}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right Detail / Editor View */}
      <div className="substrate-skills-main">
        {selectedSlug ? (
          <SkillDetailEditor
            key={`${selectedScope}-${selectedSlug}`}
            slug={selectedSlug}
            scope={selectedScope}
            onSaved={(updated) => {
              setSkills((prev) => prev.map((s) => s.slug === updated.slug && s.scope === updated.scope ? { ...s, ...updated } : s));
              onToast(`Skill "${updated.slug}" saved.`, 'success');
            }}
            onDeleted={handleDeleted}
            onSync={onSync}
            onToast={onToast}
          />
        ) : (
          <div className="substrate-empty-card">
            <div>Select a skill on the left to inspect or edit.</div>
          </div>
        )}
      </div>

      {showCreateModal && (
        <CreateSkillModal
          onClose={() => setShowCreateModal(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}

function SkillDetailEditor({ slug, scope, onSaved, onDeleted, onSync, onToast }) {
  const [skill, setSkill] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [viewMode, setViewMode] = React.useState('preview');
  const [rawText, setRawText] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const loadSkill = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await window.SubstrateAPI.getSubstrateSkill(slug);
      setSkill(data);
      setRawText(data.raw || '');
    } catch (err) {
      onToast(`Error loading skill: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [slug, onToast]);

  React.useEffect(() => {
    loadSkill();
  }, [loadSkill]);

  const handleSave = async (andSync = false) => {
    setSaving(true);
    try {
      const res = await window.SubstrateAPI.updateSubstrateSkill(slug, {
        raw: rawText,
        scope: skill?.scope || scope,
        project_id: skill?.project_id || null,
      });
      setSkill(res);
      onSaved(res);
      if (andSync) {
        await onSync();
      }
    } catch (err) {
      onToast(`Failed to save: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Are you sure you want to delete skill "${slug}" from ${skill?.scope || scope} pool?`)) return;
    setDeleting(true);
    try {
      await window.SubstrateAPI.deleteSubstrateSkill(slug);
      onDeleted(slug, skill?.scope || scope);
    } catch (err) {
      onToast(`Failed to delete: ${err.message}`, 'error');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return <div className="substrate-empty-card"><div>Loading skill content…</div></div>;
  }

  const renderedHtml = window.SubstrateFmt?.renderMarkdown
    ? window.SubstrateFmt.renderMarkdown(skill?.body || skill?.raw || '')
    : (skill?.body || skill?.raw || '');

  return (
    <div className="substrate-skill-editor-card">
      <div className="substrate-editor-head">
        <div className="substrate-editor-identity">
          <div className="substrate-editor-title-row">
            <h2 className="substrate-editor-title mono">{skill?.slug}</h2>
            <span className={`substrate-scope-badge ${skill?.scope}`}>
              {skill?.scope === 'builtin' ? 'Substrate Built-in' : skill?.scope === 'user' ? 'User Global (~/.agents/skills)' : `Project: ${skill?.project_name}`}
            </span>
          </div>
          <div className="substrate-editor-path mono">{skill?.dir_path}/SKILL.md</div>
        </div>

        <div className="substrate-editor-actions">
          <div className="substrate-view-toggles" role="group" aria-label="View mode">
            <button
              type="button"
              className={`substrate-mode-btn ${viewMode === 'preview' ? 'active' : ''}`}
              onClick={() => setViewMode('preview')}
            >
              Preview
            </button>
            <button
              type="button"
              className={`substrate-mode-btn ${viewMode === 'edit' ? 'active' : ''}`}
              onClick={() => setViewMode('edit')}
            >
              Edit Markdown
            </button>
          </div>

          {viewMode === 'edit' && (
            <>
              <button
                type="button"
                className="orch-btn ghost"
                onClick={() => setRawText(skill?.raw || '')}
                disabled={saving || rawText === skill?.raw}
              >
                Discard
              </button>
              <button
                type="button"
                className="orch-btn"
                onClick={() => handleSave(false)}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              {skill?.scope === 'builtin' && (
                <button
                  type="button"
                  className="orch-btn primary"
                  onClick={() => handleSave(true)}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : 'Save & Sync'}
                </button>
              )}
            </>
          )}

          <button
            type="button"
            className="orch-btn danger ghost"
            onClick={handleDelete}
            disabled={deleting}
            title="Delete this skill"
          >
            Delete
          </button>
        </div>
      </div>

      <div className="substrate-desc-banner">
        <div className="substrate-desc-label">Description:</div>
        <div className="substrate-desc-text">{skill?.description || 'No description in frontmatter.'}</div>
      </div>

      {viewMode === 'preview' ? (
        <div className="substrate-preview-wrap">
          <div
            className="td-md substrate-rendered-doc"
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        </div>
      ) : (
        <div className="substrate-raw-edit-wrap">
          <textarea
            className="substrate-markdown-textarea mono"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder="Skill markdown (+ frontmatter)..."
            spellCheck="false"
          />
        </div>
      )}
    </div>
  );
}

function CreateSkillModal({ onClose, onCreated }) {
  const [slug, setSlug] = React.useState('');
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [scope, setScope] = React.useState('builtin');
  const [body, setBody] = React.useState(`## When to Use\n- Trigger condition 1\n- Trigger condition 2\n\n## Procedure\n1. First step\n2. Second step\n\n## Pitfalls\n- Common caveat\n\n## Verification\n- Concrete command to verify outcome\n`);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const cleanSlug = slug.trim().toLowerCase();
    if (!cleanSlug) {
      setError('Slug is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await window.SubstrateAPI.createSubstrateSkill({
        slug: cleanSlug,
        name: (name || cleanSlug).trim(),
        description: description.trim(),
        scope,
        body,
      });
      onCreated(res);
    } catch (err) {
      setError(String(err?.payload?.error || err?.message || err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="model-profile-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="model-profile-modal substrate-modal" role="dialog" aria-modal="true" aria-labelledby="create-skill-title">
        <div className="model-profile-modal-head">
          <div>
            <div id="create-skill-title" className="model-profile-modal-title">Create Skill</div>
            <div className="roles-save-state">Author a new skill in canonical substrate, user global, or project pool</div>
          </div>
          <button className="orch-btn ghost" type="button" onClick={onClose}>×</button>
        </div>

        <form onSubmit={submit} className="substrate-modal-form">
          {error && <div className="roles-inline-error">{error}</div>}

          <div className="substrate-form-grid">
            <label className="model-profile-field">
              <span>Target Pool</span>
              <select
                className="mono"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="builtin">Substrate (Canonical repo source)</option>
                <option value="user">User Global (~/.agents/skills/)</option>
              </select>
            </label>

            <label className="model-profile-field">
              <span>Slug (Folder identifier)</span>
              <input
                className="mono"
                placeholder="e.g. designing"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                required
                pattern="^[a-z0-9_-]+$"
                autoFocus
              />
            </label>
          </div>

          <label className="model-profile-field">
            <span>Display Name</span>
            <input
              placeholder="e.g. Designing"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label className="model-profile-field">
            <span>Description (When to use trigger description)</span>
            <input
              placeholder="One-line summary of when an agent should load this skill"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
            />
          </label>

          <label className="model-profile-field">
            <span>Skill Markdown Body</span>
            <textarea
              className="substrate-modal-body-input mono"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              spellCheck="false"
            />
          </label>

          <div className="substrate-modal-actions">
            <button type="button" className="orch-btn ghost" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" className="orch-btn primary" disabled={submitting || !slug.trim()}>
              {submitting ? 'Creating…' : 'Create Skill'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Global Instructions (AGENTS.md) Tab
// ---------------------------------------------------------------------------

function SubstrateInstructionsView({ onSync, onToast }) {
  const [data, setData] = React.useState(null);
  const [rawText, setRawText] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [viewMode, setViewMode] = React.useState('preview');
  const [saving, setSaving] = React.useState(false);

  const loadInstructions = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.SubstrateAPI.getSubstrateInstructions();
      setData(res);
      setRawText(res.raw || '');
    } catch (err) {
      onToast(`Failed to load instructions: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  React.useEffect(() => {
    loadInstructions();
  }, [loadInstructions]);

  const handleSave = async (andSync = false) => {
    setSaving(true);
    try {
      const res = await window.SubstrateAPI.updateSubstrateInstructions({ raw: rawText });
      setData(res);
      onToast('Global AGENTS.md instructions saved successfully.', 'success');
      if (andSync) {
        await onSync();
      }
    } catch (err) {
      onToast(`Failed to save instructions: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="substrate-empty-card"><div>Loading AGENTS.md…</div></div>;
  }

  const renderedHtml = window.SubstrateFmt?.renderMarkdown
    ? window.SubstrateFmt.renderMarkdown(rawText)
    : rawText;

  return (
    <div className="substrate-skill-editor-card">
      <div className="substrate-editor-head">
        <div className="substrate-editor-identity">
          <h2 className="substrate-editor-title mono">AGENTS.md</h2>
          <div className="substrate-editor-path mono">substrate/instructions/AGENTS.md · {data?.word_count || 0} words</div>
        </div>

        <div className="substrate-editor-actions">
          <div className="substrate-view-toggles" role="group" aria-label="View mode">
            <button
              type="button"
              className={`substrate-mode-btn ${viewMode === 'preview' ? 'active' : ''}`}
              onClick={() => setViewMode('preview')}
            >
              Preview
            </button>
            <button
              type="button"
              className={`substrate-mode-btn ${viewMode === 'edit' ? 'active' : ''}`}
              onClick={() => setViewMode('edit')}
            >
              Edit Markdown
            </button>
          </div>

          {viewMode === 'edit' && (
            <>
              <button
                type="button"
                className="orch-btn ghost"
                onClick={() => setRawText(data?.raw || '')}
                disabled={saving || rawText === data?.raw}
              >
                Discard
              </button>
              <button
                type="button"
                className="orch-btn"
                onClick={() => handleSave(false)}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="orch-btn primary"
                onClick={() => handleSave(true)}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save & Sync'}
              </button>
            </>
          )}
        </div>
      </div>

      {viewMode === 'preview' ? (
        <div className="substrate-preview-wrap">
          <div
            className="td-md substrate-rendered-doc"
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        </div>
      ) : (
        <div className="substrate-raw-edit-wrap">
          <textarea
            className="substrate-markdown-textarea mono"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            spellCheck="false"
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Multi-Pool Roles Registry Tab
// ---------------------------------------------------------------------------

function SubstrateRolesView({ onSync, onToast }) {
  const [roles, setRoles] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [activeRole, setActiveRole] = React.useState(null);
  const [roleBody, setRoleBody] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const loadRoles = React.useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.SubstrateAPI.listSubstrateRoles();
      setRoles(list);
      if (list.length > 0 && !activeRole) {
        setActiveRole(list[0].role);
        setRoleBody(list[0].body);
      }
    } catch (err) {
      onToast(`Failed to load roles: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [activeRole, onToast]);

  React.useEffect(() => {
    loadRoles();
  }, [loadRoles]);

  const selectRole = (r) => {
    setActiveRole(r.role);
    setRoleBody(r.body);
  };

  const handleSave = async (andSync = false) => {
    if (!activeRole) return;
    setSaving(true);
    try {
      const res = await window.SubstrateAPI.updateSubstrateRole(activeRole, { raw: roleBody });
      setRoles((prev) => prev.map((r) => r.role === activeRole ? { ...r, body: res.body, overridden: true } : r));
      onToast(`Role "${activeRole}" saved successfully.`, 'success');
      if (andSync) {
        await onSync();
      }
    } catch (err) {
      onToast(`Failed to save role: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="substrate-empty-card"><div>Loading roles…</div></div>;
  }

  const selectedRoleObj = roles.find((r) => r.role === activeRole);

  return (
    <div className="substrate-roles-container">
      <div className="substrate-roles-sidebar">
        <div className="substrate-roles-sidebar-head">
          <strong>Roles Registry</strong>
          <span className="mono tnum">({roles.length})</span>
        </div>
        <div className="substrate-roles-list">
          {roles.map((r) => (
            <button
              key={r.role}
              type="button"
              className={`substrate-role-item ${activeRole === r.role ? 'active' : ''}`}
              onClick={() => selectRole(r)}
            >
              <div className="substrate-role-item-main">
                <span className="substrate-role-item-name mono">{r.name}</span>
                <span className={`substrate-scope-badge ${r.builtin ? 'builtin' : 'custom'}`}>
                  {r.builtin ? 'Built-in' : 'Custom'}
                </span>
              </div>
              <div className="substrate-role-item-sub">
                {r.glyph && <span className="substrate-role-glyph" style={{ color: r.color }}>{r.glyph}</span>}
                <span className="substrate-role-item-meta">{r.overridden ? 'overridden' : 'default'}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="substrate-roles-main">
        {activeRole ? (
          <div className="substrate-skill-editor-card">
            <div className="substrate-editor-head">
              <div className="substrate-editor-identity">
                <div className="substrate-editor-title-row">
                  <h2 className="substrate-editor-title mono">{activeRole}</h2>
                  <span className={`substrate-scope-badge ${selectedRoleObj?.builtin ? 'builtin' : 'custom'}`}>
                    {selectedRoleObj?.builtin ? 'Built-in Role' : 'Custom User Role'}
                  </span>
                </div>
                <div className="substrate-editor-path mono">
                  {selectedRoleObj?.overlay_path || selectedRoleObj?.default_path || `~/.golem/roles/${activeRole}.md`}
                </div>
              </div>

              <div className="substrate-editor-actions">
                <button
                  type="button"
                  className="orch-btn"
                  onClick={() => handleSave(false)}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  className="orch-btn primary"
                  onClick={() => handleSave(true)}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : 'Save & Sync'}
                </button>
              </div>
            </div>

            <div className="substrate-raw-edit-wrap">
              <textarea
                className="substrate-markdown-textarea mono"
                value={roleBody}
                onChange={(e) => setRoleBody(e.target.value)}
                placeholder="Role directives markdown..."
                spellCheck="false"
              />
            </div>
          </div>
        ) : (
          <div className="substrate-empty-card">Select a role on the left.</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Harness Sync & Matrix Tab
// ---------------------------------------------------------------------------

function SubstrateSyncView({ onSync, syncing, syncResult }) {
  const [status, setStatus] = React.useState(null);
  const [config, setConfig] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [savingHarness, setSavingHarness] = React.useState(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const [cfg, st] = await Promise.all([
        window.SubstrateAPI.substrateConfig(),
        window.SubstrateAPI.substrateStatus(),
      ]);
      setConfig(cfg);
      setStatus(st);
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh, syncResult]);

  const harnesses = React.useMemo(() => {
    const h = config?.harnesses || status?.config?.harnesses || {};
    return Object.entries(h).map(([id, row]) => ({ id, ...row }));
  }, [config, status]);

  const cells = React.useMemo(() => status?.global || [], [status]);
  const artifactRows = React.useMemo(() => {
    const order = ['skills', 'agents', 'roles', 'commands', 'hooks', 'mcp', 'config-fragment', 'instructions'];
    const set = new Set(order);
    for (const c of cells) set.add(c.artifact);
    return [...set];
  }, [cells]);

  const cellFor = (artifact, harness) => cells.find((c) => c.artifact === artifact && c.harness === harness);

  const toggleHarness = async (id, enabled) => {
    setSavingHarness(id);
    try {
      const next = await window.SubstrateAPI.updateSubstrateConfig({ harnesses: { [id]: { enabled } } });
      setConfig(next);
      await refresh();
    } catch {} finally {
      setSavingHarness(null);
    }
  };

  return (
    <div className="settings-stack substrate-sync-stack">
      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <h2>Harness Target Switches</h2>
            <p>Enable or disable compilation targets for installed harness renders.</p>
          </div>
        </div>

        <div className="settings-harness-grid">
          {harnesses.map((h) => (
            <label key={h.id} className={`settings-harness-card ${h.enabled ? 'enabled' : 'disabled'}`}>
              <span>
                <span className="settings-harness-name mono">{h.id}</span>
                <span className="settings-harness-meta">{h.testedVersion ? `pinned ${h.testedVersion}` : 'no pinned version'}</span>
              </span>
              <span className="settings-switch">
                <input
                  type="checkbox"
                  checked={!!h.enabled}
                  disabled={savingHarness === h.id}
                  onChange={(e) => toggleHarness(h.id, e.target.checked)}
                />
                <span className="settings-switch-track"/>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <h2>Compilation Drift Matrix</h2>
            <p>Monitors global drift across substrate artifacts and harness renders.</p>
          </div>
        </div>

        <div className="settings-matrix-wrap">
          <table className="settings-matrix">
            <thead>
              <tr>
                <th>Artifact</th>
                {harnesses.map((h) => <th key={h.id}>{h.id}</th>)}
              </tr>
            </thead>
            <tbody>
              {artifactRows.map((artifact) => (
                <tr key={artifact}>
                  <td className="mono">{artifact}</td>
                  {harnesses.map((h) => {
                    const c = cellFor(artifact, h.id);
                    const st = c?.status || (h.enabled ? 'in_sync' : 'disabled');
                    return (
                      <td key={h.id}>
                        <span className={`settings-chip ${st}`}>
                          {st.replace('_', ' ')}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {syncResult && (
        <section className="settings-section">
          <div className="settings-section-head">
            <h2>Last Sync Report</h2>
          </div>
          <pre className="substrate-sync-raw mono">{JSON.stringify(syncResult, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}

window.SubstratePage = SubstratePage;
