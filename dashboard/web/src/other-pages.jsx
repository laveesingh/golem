// Agents / Projects / Logs pages. All read live store.

function UnackedDispatchBadge({ warning, compact = false }) {
  if (!warning) return null;
  const ticketId = warning.ticket_id;
  const deliveryId = warning.envelope_id || warning.delivery_event_id;
  const label = warning.display_id || ticketId || 'ticket';
  const deliveredMs = warning.delivered_at ? Date.parse(warning.delivered_at) : NaN;
  const age = Number.isFinite(deliveredMs) ? window.SubstrateFmt?.fmtTimeAgo?.(deliveredMs) : null;
  const session = warning.session_label || warning.session_id || 'target session';
  const severity = warning.severity || 'awaiting';
  const statusText = {
    awaiting: 'awaiting acknowledgement',
    pinged: 'acknowledgement reminder sent',
    failed: 'assigned but not delivered',
    escalated: 'missing acknowledgement escalated',
  }[severity] || 'dispatch appears unacknowledged';
  const title = [
    `${statusText} for dispatch to ${session}`,
    warning.delivered_at ? `delivered ${warning.delivered_at}` : null,
    warning.window_minutes != null ? `${warning.window_minutes}m window` : null,
    warning.title || null,
  ].filter(Boolean).join(' · ');
  const open = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (ticketId) window.Router.openTicket(ticketId);
  };
  const dismiss = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!ticketId || deliveryId == null) return;
    window.SubstrateAPI.dismissUnackedDispatch(ticketId, deliveryId).catch((err) => console.error('dismiss unacked failed', err));
  };
  return (
    <span className={`unacked-dispatch-badge severity-${severity}`}>
      <button className="unacked-dispatch-open" title={title} aria-label={`Open ${label}: ${statusText}`} onClick={open} disabled={!ticketId}>
        {severity === 'escalated' ? '⛔' : severity === 'failed' ? '✕' : '⚠'} {compact ? `${label} · ${statusText}` : `${label} · ${statusText}${age ? ` · ${age}` : ''}`}
      </button>
      <button className="unacked-dispatch-dismiss" title="dismiss warning" aria-label={`Dismiss ${label} warning`} onClick={dismiss} disabled={!ticketId || deliveryId == null}>×</button>
    </span>
  );
}

window.UnackedDispatchBadge = UnackedDispatchBadge;

function compactPath(p) {
  if (!p) return '—';
  const parts = String(p).split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  return `.../${parts.slice(-2).join('/')}`;
}

function CommunicationHealthIndicator({ health, onOpen }) {
  const summary = health?.health || { level: 'green', red: 0, amber: 0, needs_attention: 0, queued: 0 };
  const level = summary.level || 'green';
  const needsAttention = Math.max(0, Number(summary.needs_attention) || 0);
  const deliveryFailures = Math.max(0, (Number(summary.red) || 0) - needsAttention);
  const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  const label = level === 'red'
    ? needsAttention > 0
      ? [`${needsAttention} needs attention`, deliveryFailures > 0 ? plural(deliveryFailures, 'delivery failure') : null].filter(Boolean).join(' · ')
      : plural(Math.max(1, Number(summary.red) || 0), 'delivery failure')
    : level === 'amber'
      ? `${summary.amber} awaiting acknowledgement`
      : 'communication healthy';
  const detail = level === 'green' && summary.queued
    ? `${summary.queued} queued without degrading delivery health`
    : label;
  return (
    <button
      type="button"
      className={`communication-health-indicator severity-${level}`}
      data-testid="communication-health-indicator"
      title={`Communication health: ${detail}. Open envelope timeline.`}
      onClick={onOpen}
    >
      <span className="communication-health-dot"/>
      <span className="communication-health-label">{label}</span>
    </button>
  );
}

function AgentsPage({ setRoute }) {
  useStore();
  const all = window.Store.getNativeSessions();
  const rolesRev = window.Store.getRolesRev ? window.Store.getRolesRev() : 0;
  const [profilesRev, setProfilesRev] = React.useState(0);
  const bumpProfiles = React.useCallback(() => setProfilesRev((value) => value + 1), []);
  // The server broadcasts a payload-free fact-change signal. Fetching once per
  // signal keeps this compact summary live without a dashboard polling loop.
  const communicationHealthRev = window.Store.getState().communicationHealthRev || 0;
  const [communicationHealth, setCommunicationHealth] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    window.SubstrateAPI.communicationHealth()
      .then((result) => { if (!cancelled) setCommunicationHealth(result); })
      .catch(() => { if (!cancelled) setCommunicationHealth(null); });
    return () => { cancelled = true; };
  }, [communicationHealthRev]);

  // v4: the server already pid-checks native sessions and marks them .alive.
  // Drop anything not alive so dead registry rows / stale CLI entries never
  // render on the Agents page.
  const alive = all.filter((s) => s.alive);

  // TKT-0286: all pending dispatch-queue rows (enriched with ticket_title +
  // session_label by listDispatchQueue). Refetch on the dispatch-queue-updated
  // WS signal (rev) — no polling. Grouped by session for the card chip; rows
  // whose target session is no longer alive surface as offline orphans.
  const dispatchQueueRev = window.Store.getState().dispatchQueueRev || 0;
  const [queue, setQueue] = React.useState([]);
  React.useEffect(() => {
    let cancelled = false;
    window.SubstrateAPI.getJSON('/api/dispatch-queue')
      .then((rows) => { if (!cancelled) setQueue(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setQueue([]); });
    return () => { cancelled = true; };
  }, [dispatchQueueRev]);
  const queueBySession = React.useMemo(() => {
    const m = new Map();
    for (const r of queue) {
      const arr = m.get(r.session_id) ?? [];
      arr.push(r);
      m.set(r.session_id, arr);
    }
    return m;
  }, [queue]);
  const aliveIds = new Set(alive.map((s) => s.session_id));
  const orphans = queue.filter((r) => !aliveIds.has(r.session_id));

  // Disambiguate duplicate session names by appending project name + short sid.
  const nameCounts = {};
  for (const s of alive) {
    const key = s.name || '';
    nameCounts[key] = (nameCounts[key] || 0) + 1;
  }
  const formatName = (s) => {
    const base = s.name || s.session_id?.slice(0, 8) || `pid ${s.pid}`;
    if ((nameCounts[s.name || ''] || 0) <= 1) return base;
    const project = window.Store.getProjectByContractId(s.project_id);
    const suffix = project?.name || s.project_id || s.session_id?.slice(0, 8) || String(s.pid);
    return `${base} · ${suffix}`;
  };

  const isWorking = (s) => s.status === 'busy' || s.status === 'waiting';
  const byRecency = (a, b) => (b.updated_at ?? b.started_at ?? 0) - (a.updated_at ?? a.started_at ?? 0);
  const working = alive.filter(isWorking).sort(byRecency);
  const idle = alive.filter((s) => !isWorking(s)).sort(byRecency);

  return (
    <div className="page">
      <div className="page-header agents-page-header">
        <div>
          <h1 className="page-title">Agents</h1>
          <div className="page-subtitle">{alive.length} native Golem session{alive.length === 1 ? '' : 's'} online.</div>
        </div>
        <CommunicationHealthIndicator
          health={communicationHealth}
          onOpen={() => window.openCommunicationDrawer?.()}
        />
      </div>

      <ModelProfilesPanel rev={profilesRev + rolesRev} onChanged={bumpProfiles}/>
      <RolesPanel rev={rolesRev} profilesRev={profilesRev}/>

      {alive.length === 0 && orphans.length === 0 ? (
        <EmptyCard
          label="no native sessions online"
          hint={<>Start a supported Golem harness session to bring agents online.</>}
        />
      ) : (
        <>
          {working.length > 0 && (
            <div className="agents-section">
              <div className="agents-section-head">
                <Icon.Gear size={16} className="gear gear-working"/>
                <span className="agents-section-title">Working</span>
                <span className="agents-section-count">{working.length}</span>
              </div>
              <div className="native-sessions">
                {working.map((s) => (
                  <AgentCard key={s.session_id || s.pid} session={s} name={formatName(s)} queueCount={queueBySession.get(s.session_id)?.length || 0} setRoute={setRoute}/>
                ))}
              </div>
            </div>
          )}

          {idle.length > 0 && (
            <div className="agents-section">
              <div className="agents-section-head">
                <Icon.Gear size={16} className="gear gear-idle"/>
                <span className="agents-section-title">Idle</span>
                <span className="agents-section-count">{idle.length}</span>
              </div>
              <div className="native-sessions">
                {idle.map((s) => (
                  <AgentCard key={s.session_id || s.pid} session={s} name={formatName(s)} queueCount={queueBySession.get(s.session_id)?.length || 0} setRoute={setRoute}/>
                ))}
              </div>
            </div>
          )}

          {orphans.length > 0 && (
            <OfflineOrphansSection rows={orphans}/>
          )}
        </>
      )}
    </div>
  );
}

const ROLE_THINKING_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function roleErrorMessage(error, fallback) {
  return error?.payload?.error || error?.payload?.message || error?.message || fallback;
}

function newRoleDraft() {
  return {
    name: '',
    color: '#8a909c',
    glyph: '',
    body: '',
    default_profile: '',
  };
}

function sortRoleCards(items) {
  return items.slice().sort((a, b) => Number(Boolean(b.builtin)) - Number(Boolean(a.builtin)) || a.name.localeCompare(b.name));
}

function profileProvider(provider, model) {
  return window.ModelProviders?.resolveProvider?.(provider, model)
    || window.ModelProviders?.fallback
    || { id: 'fallback', label: 'Unknown' };
}

function ProfileMark({ provider, model, harness = false }) {
  const entry = harness
    ? window.ModelProviders?.harnessForId?.(provider || 'pi')
    : profileProvider(provider, model);
  const src = entry?.iconIdleSrc || entry?.iconSrc || null;
  return (
    <span className={`model-profile-mark ${harness ? 'harness-mark' : `provider-mark provider-${entry?.id || 'fallback'}`}`} title={entry?.label || provider || 'Unknown'} aria-hidden="true">
      {src ? <img src={src} alt=""/> : <span className="model-profile-mark-fallback">{harness ? 'π' : '·'}</span>}
    </span>
  );
}

// Native select elements cannot render provider/model icons consistently. This
// compact listbox keeps the same keyboard/click surface while letting profile
// choices show their resolved family mark.
function ProfileChoice({ value, options, onChange, id, placeholder = 'Select a profile', disabled = false, ariaLabel }) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef(null);
  React.useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const current = options.find((option) => option.value === value) || null;
  const choose = (next) => {
    onChange(next);
    setOpen(false);
  };
  return (
    <div className={`model-profile-choice ${open ? 'is-open' : ''}`} ref={rootRef}>
      <button
        id={id}
        type="button"
        className="model-profile-choice-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((state) => !state)}
      >
        {current?.provider && <ProfileMark provider={current.provider} model={current.model}/>}
        <span className={!current ? 'is-placeholder' : ''}>{current?.label || placeholder}</span>
        <span className="model-profile-choice-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="model-profile-choice-menu" role="listbox" aria-labelledby={id}>
          {options.length === 0 ? (
            <div className="model-profile-choice-empty">No choices available</div>
          ) : options.map((option) => (
            <button
              key={option.value || '__empty'}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`model-profile-choice-option ${option.value === value ? 'is-selected' : ''}`}
              onClick={() => choose(option.value)}
            >
              {option.provider && <ProfileMark provider={option.provider} model={option.model}/>}
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function roleProfileOptions(profiles, value) {
  const options = [{ value: '', label: 'No default — use role exec' }];
  const rows = Array.isArray(profiles) ? profiles : [];
  for (const profile of rows) {
    options.push({
      value: profile.name,
      label: profile.name,
      provider: profile.provider,
      model: profile.model,
    });
  }
  if (value && !options.some((option) => option.value === value)) {
    options.push({ value, label: `${value} (missing)` });
  }
  return options;
}

function RoleProfileField({ value, onChange, profiles, idPrefix, disabled = false }) {
  return (
    <div className="role-profile-field" role="group" aria-label="Default model profile">
      <div className="role-profile-heading">Default model profile</div>
      <ProfileChoice
        id={`${idPrefix}-default-profile`}
        value={value || ''}
        options={roleProfileOptions(profiles, value)}
        onChange={onChange}
        disabled={disabled}
        ariaLabel="Default model profile"
        placeholder="No default — use role exec"
      />
      <div className="role-profile-hint">Profiles resolve into the retained role exec at launch.</div>
    </div>
  );
}

function catalogProviders(catalog, current) {
  const values = Array.isArray(catalog?.providers) ? catalog.providers.slice() : [];
  if (current && !values.includes(current)) values.unshift(current);
  return values;
}

function catalogModels(catalog, provider, current) {
  const values = Array.isArray(catalog?.modelsByProvider?.[provider])
    ? catalog.modelsByProvider[provider].slice()
    : [];
  if (current && !values.includes(current)) values.unshift(current);
  return values;
}

function ModelProfileEditor({ profile, catalog, onCancel, onSave, saving, error }) {
  const [draft, setDraft] = React.useState(() => ({
    name: profile?.name || '',
    provider: profile?.provider || '',
    model: profile?.model || '',
    thinking: profile?.thinking || 'medium',
  }));
  React.useEffect(() => {
    setDraft({
      name: profile?.name || '',
      provider: profile?.provider || '',
      model: profile?.model || '',
      thinking: profile?.thinking || 'medium',
    });
  }, [profile?.name, profile?.provider, profile?.model, profile?.thinking]);

  const providers = catalogProviders(catalog, draft.provider);
  const models = catalogModels(catalog, draft.provider, draft.model);
  const providerOptions = providers.map((provider) => ({
    value: provider,
    label: provider,
    provider,
    model: catalogModels(catalog, provider, '')[0] || draft.model,
  }));
  const modelOptions = models.map((model) => ({
    value: model,
    label: model,
    provider: draft.provider,
    model,
  }));
  const catalogReady = Array.isArray(catalog?.providers) && catalog.providers.length > 0;
  const setProvider = (provider) => {
    const nextModels = catalogModels(catalog, provider, '');
    const nextModel = nextModels.includes(draft.model) ? draft.model : (nextModels[0] || draft.model);
    setDraft({ ...draft, provider, model: nextModel });
  };
  const submit = (event) => {
    event.preventDefault();
    onSave({ ...draft, name: draft.name.trim(), provider: draft.provider.trim(), model: draft.model.trim() });
  };
  return (
    <div className="model-profile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="model-profile-modal" role="dialog" aria-modal="true" aria-labelledby="model-profile-editor-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="model-profile-modal-head">
          <div>
            <div id="model-profile-editor-title" className="model-profile-modal-title">{profile ? 'Edit Model Profile' : 'Add Model Profile'}</div>
            <div className="roles-save-state">Named Pi execution config shared by roles.</div>
          </div>
          <button className="orch-btn ghost" type="button" onClick={onCancel} aria-label="Close model profile editor">×</button>
        </div>
        <form className="model-profile-form" onSubmit={submit}>
          <div className="model-profile-form-grid">
            <label className="model-profile-field">
              <span>Name</span>
              <input data-testid="model-profile-name" className="mono" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required maxLength={80} autoFocus/>
            </label>
            <label className="model-profile-field">
              <span>Harness</span>
              <input className="mono" value="pi" disabled aria-label="Harness"/>
            </label>
            <div className="model-profile-field">
              <span>Provider</span>
              {catalogReady ? (
                <ProfileChoice
                  id="model-profile-provider"
                  value={draft.provider}
                  options={providerOptions}
                  onChange={setProvider}
                  ariaLabel="Profile provider"
                  placeholder="Select provider"
                />
              ) : (
                <input data-testid="model-profile-provider-input" className="mono" value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value })} placeholder="provider (catalog unavailable)" required/>
              )}
            </div>
            <div className="model-profile-field model-profile-field-wide">
              <span>Model</span>
              {catalogReady ? (
                <ProfileChoice
                  id="model-profile-model"
                  value={draft.model}
                  options={modelOptions}
                  onChange={(model) => setDraft({ ...draft, model })}
                  disabled={!draft.provider}
                  ariaLabel="Profile model"
                  placeholder={draft.provider ? 'Select model' : 'Select provider first'}
                />
              ) : (
                <input data-testid="model-profile-model-input" className="mono" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="model (catalog unavailable)" required/>
              )}
            </div>
            <label className="model-profile-field">
              <span>Thinking</span>
              <select data-testid="model-profile-thinking" className="mono" value={draft.thinking} onChange={(event) => setDraft({ ...draft, thinking: event.target.value })}>
                {ROLE_THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            </label>
          </div>
          <div className="model-profile-catalog-note">
            {catalog?.error
              ? `Catalog unavailable — saved values remain editable. ${catalog.error}`
              : 'Provider and model choices come from Pi’s offline catalog.'}
          </div>
          {error && <div className="roles-inline-error" role="alert">{error}</div>}
          <div className="model-profile-modal-actions">
            <button className="orch-btn ghost" type="button" onClick={onCancel}>Cancel</button>
            <button className="orch-btn" data-testid="model-profile-save" type="submit" disabled={saving || !draft.name.trim() || !draft.provider.trim() || !draft.model.trim()}>{saving ? 'Saving…' : 'Save profile'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ModelProfilesPanel({ rev, onChanged }) {
  const [store, setStore] = React.useState({ profiles: [], role_defaults: {}, seeded_from_roles: false });
  const [catalog, setCatalog] = React.useState({ providers: [], modelsByProvider: {}, source: 'loading', stale: false, error: null });
  const [loading, setLoading] = React.useState(true);
  const [catalogLoading, setCatalogLoading] = React.useState(true);
  const [listError, setListError] = React.useState(null);
  const [editor, setEditor] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(null);
  const [editorError, setEditorError] = React.useState(null);
  const [panelError, setPanelError] = React.useState(null);

  const loadProfiles = React.useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const next = await window.SubstrateAPI.modelProfiles();
      setStore(next && typeof next === 'object' ? next : { profiles: [], role_defaults: {}, seeded_from_roles: false });
    } catch (error) {
      setListError(roleErrorMessage(error, 'model profiles could not be loaded'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCatalog = React.useCallback(async (refresh = false) => {
    setCatalogLoading(true);
    try {
      const next = await (refresh ? window.SubstrateAPI.refreshModelCatalog() : window.SubstrateAPI.modelCatalog());
      setCatalog(next && typeof next === 'object' ? next : { providers: [], modelsByProvider: {}, source: 'unavailable', stale: true, error: 'empty catalog response' });
    } catch (error) {
      setCatalog({ providers: [], modelsByProvider: {}, source: 'unavailable', stale: true, error: roleErrorMessage(error, 'catalog request failed') });
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadProfiles();
    loadCatalog();
  }, [loadProfiles, loadCatalog, rev]);

  const openNew = () => {
    setEditorError(null);
    setPanelError(null);
    setEditor({ name: '', provider: '', model: '', thinking: 'medium' });
  };
  const openExisting = (profile) => {
    setEditorError(null);
    setPanelError(null);
    setEditor({ ...profile });
  };
  const save = async (draft) => {
    setSaving(true);
    setEditorError(null);
    try {
      if (editor?.name) await window.SubstrateAPI.saveModelProfile(editor.name, draft);
      else await window.SubstrateAPI.createModelProfile(draft);
      setEditor(null);
      await loadProfiles();
      onChanged?.();
    } catch (error) {
      setEditorError(roleErrorMessage(error, 'model profile could not be saved'));
    } finally {
      setSaving(false);
    }
  };
  const remove = async (profile) => {
    setPanelError(null);
    if (!window.confirm(`Delete model profile “${profile.name}”?`)) return;
    setDeleting(profile.name);
    try {
      await window.SubstrateAPI.deleteModelProfile(profile.name);
      await loadProfiles();
      onChanged?.();
    } catch (error) {
      setPanelError(roleErrorMessage(error, 'model profile could not be deleted'));
    } finally {
      setDeleting(null);
    }
  };

  const defaults = store.role_defaults && typeof store.role_defaults === 'object' ? store.role_defaults : {};
  return (
    <div className="agents-section model-profiles-panel" data-testid="model-profiles-panel">
      <div className="agents-section-head model-profiles-head">
        <Icon.Agents size={16}/>
        <span className="agents-section-title">Model Profiles</span>
        <span className="agents-section-count">{Array.isArray(store.profiles) ? store.profiles.length : 0}</span>
        {loading && <span className="roles-save-state">loading…</span>}
        {listError && <span className="roles-save-state error">{listError}</span>}
        <span className="model-profiles-head-spacer"/>
        <span className={`model-catalog-status ${catalog.stale ? 'is-stale' : ''}`} title={catalog.error || `catalog source: ${catalog.source}`}>
          {catalogLoading ? 'catalog loading…' : catalog.stale ? 'catalog unavailable' : `${catalog.providers?.length || 0} providers`}
        </span>
        <button className="orch-btn ghost small" type="button" data-testid="model-catalog-refresh" onClick={() => loadCatalog(true)} disabled={catalogLoading}>{catalogLoading ? 'Refreshing…' : 'Refresh catalog'}</button>
        <button className="orch-btn small" type="button" data-testid="model-profile-add" onClick={openNew}>+ Add profile</button>
      </div>
      {panelError && <div className="roles-inline-error" role="alert">{panelError}</div>}
      {!loading && !listError && (!store.profiles || store.profiles.length === 0) && (
        <div className="model-profiles-empty">
          <strong>No model profiles yet.</strong>
          <span>Add a named Pi configuration, then assign it to a role below.</span>
          <button className="orch-btn small" type="button" onClick={openNew}>Create first profile</button>
        </div>
      )}
      <div className="model-profiles-grid">
        {(store.profiles || []).map((profile) => {
          const assigned = Object.entries(defaults).filter(([, name]) => name === profile.name).map(([role]) => role);
          return (
            <article className="model-profile-card" data-testid={`model-profile-card-${profile.name}`} key={profile.name}>
              <div className="model-profile-card-head">
                <div className="model-profile-card-name" title={profile.name}>{profile.name}</div>
                <span className="model-profile-harness-chip"><ProfileMark provider="pi" harness/> pi</span>
              </div>
              <div className="model-profile-card-model">
                <ProfileMark provider={profile.provider} model={profile.model}/>
                <span className="model-profile-card-model-text">
                  <strong>{profile.model}</strong>
                  <span className="mono">{profile.provider}</span>
                </span>
              </div>
              <div className="model-profile-card-meta">
                <span className="model-profile-thinking-chip">thinking · {profile.thinking}</span>
                <span title={assigned.length ? `Default for ${assigned.join(', ')}` : 'Not assigned to a role'}>{assigned.length ? `default · ${assigned.join(', ')}` : 'unassigned'}</span>
              </div>
              <div className="model-profile-card-actions">
                <button className="orch-btn ghost small" type="button" onClick={() => openExisting(profile)}>Edit</button>
                <button className="orch-btn danger ghost small" type="button" disabled={deleting === profile.name} onClick={() => remove(profile)}>{deleting === profile.name ? 'Deleting…' : 'Delete'}</button>
              </div>
            </article>
          );
        })}
      </div>
      {editor && <ModelProfileEditor profile={editor.name ? editor : null} catalog={catalog} onCancel={() => setEditor(null)} onSave={save} saving={saving} error={editorError}/>}    </div>
  );
}

function RolesPanel({ rev, profilesRev = 0 }) {
  const [roles, setRoles] = React.useState([]);
  const [profiles, setProfiles] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [listError, setListError] = React.useState(null);
  const [createError, setCreateError] = React.useState(null);
  const [creating, setCreating] = React.useState(false);
  const [draft, setDraft] = React.useState(() => newRoleDraft());

  const upsertRole = React.useCallback((role) => {
    if (!role?.name) return;
    setRoles((prev) => sortRoleCards([...prev.filter((item) => item.name !== role.name), role]));
  }, []);
  const removeRole = React.useCallback((name) => {
    setRoles((prev) => prev.filter((role) => role.name !== name));
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setListError(null);
    Promise.all([window.SubstrateAPI.listRoles(), window.SubstrateAPI.modelProfiles()])
      .then(([list, profileStore]) => {
        if (cancelled) return;
        setRoles(Array.isArray(list) ? sortRoleCards(list) : []);
        setProfiles(Array.isArray(profileStore?.profiles) ? profileStore.profiles : []);
      })
      .catch((err) => { if (!cancelled) setListError(roleErrorMessage(err, 'roles could not be loaded')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [rev, profilesRev]);

  const create = async (event) => {
    event.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      const role = await window.SubstrateAPI.createRole({ ...draft });
      upsertRole(role);
      setDraft(newRoleDraft());
    } catch (error) {
      setCreateError(roleErrorMessage(error, 'role could not be created'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="agents-section roles-panel">
      <div className="agents-section-head">
        <Icon.Agents size={16}/>
        <span className="agents-section-title">Roles</span>
        <span className="agents-section-count">{roles.length}</span>
        {loading && <span className="roles-save-state">loading…</span>}
        {listError && <span className="roles-save-state error">{listError}</span>}
      </div>
      <div className="roles-grid">
        {roles.map((role) => <RoleEditor key={role.name} role={role} profiles={profiles} onSaved={upsertRole} onDeleted={removeRole}/>)}
      </div>
      {!loading && !listError && roles.length === 0 && <div className="roles-empty">No roles are registered.</div>}
      <form className="role-editor-card role-create-card" onSubmit={create}>
        <div className="role-editor-head">
          <div>
            <div className="role-editor-name">Create role</div>
            <div className="roles-save-state">writes to ~/.golem/roles/index.json</div>
          </div>
          <button className="orch-btn" type="submit" disabled={creating || !draft.name.trim()}>{creating ? 'Creating…' : 'Create'}</button>
        </div>
        <div className="role-meta-row role-identity-row">
          <input className="mono" placeholder="name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}/>
          <input className="mono" placeholder="glyph" value={draft.glyph} maxLength={4} onChange={(e) => setDraft({ ...draft, glyph: e.target.value })}/>
          <input className="mono" type="color" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })}/>
        </div>
        <RoleProfileField value={draft.default_profile} onChange={(default_profile) => setDraft({ ...draft, default_profile })} profiles={profiles} idPrefix="create-role"/>
        {createError && <div className="roles-inline-error" role="alert">{createError}</div>}
        <textarea className="role-editor-body mono" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} placeholder="Optional role card body" spellCheck="false"/>
      </form>
    </div>
  );
}

function RoleEditor({ role, profiles, onSaved, onDeleted }) {
  const [body, setBody] = React.useState(role.body || '');
  const [meta, setMeta] = React.useState({ color: role.color || '#8a909c', glyph: role.glyph || '' });
  const [defaultProfile, setDefaultProfile] = React.useState(role.default_profile || '');
  const [state, setState] = React.useState('saved');
  const [profileState, setProfileState] = React.useState('saved');
  const [profileError, setProfileError] = React.useState(null);
  const [deleteError, setDeleteError] = React.useState(null);
  const [pushResult, setPushResult] = React.useState(null);

  React.useEffect(() => {
    setBody(role.body || '');
    setMeta({ color: role.color || '#8a909c', glyph: role.glyph || '' });
    setDefaultProfile(role.default_profile || '');
    setState('saved');
    setProfileState('saved');
    setProfileError(null);
    setDeleteError(null);
    setPushResult(null);
  }, [role.name, role.body, role.color, role.glyph, role.default_profile]);

  React.useEffect(() => {
    if (body === (role.body || '') && meta.color === (role.color || '#8a909c') && meta.glyph === (role.glyph || '')) return;
    setState('saving');
    const timer = setTimeout(() => {
      window.SubstrateAPI.saveRole(role.name, { body, color: meta.color, glyph: meta.glyph })
        .then((saved) => {
          setState('saved');
          if (saved?.name) onSaved?.(saved);
        })
        .catch((error) => setState(roleErrorMessage(error, 'save failed')));
    }, 650);
    return () => clearTimeout(timer);
  }, [body, meta.color, meta.glyph, role.name, role.body, role.color, role.glyph, onSaved]);

  const saveDefaultProfile = async (event) => {
    event.preventDefault();
    setProfileState('saving');
    setProfileError(null);
    try {
      const saved = await window.SubstrateAPI.saveRoleDefaultProfile(role.name, defaultProfile);
      setProfileState('saved');
      setState('saved');
      if (saved?.name) onSaved?.(saved);
    } catch (error) {
      setProfileState('error');
      setProfileError(roleErrorMessage(error, 'default profile save failed'));
    }
  };

  const push = () => {
    setPushResult({ state: 'pushing' });
    window.SubstrateAPI.pushRole(role.name)
      .then((result) => setPushResult({ state: 'done', result }))
      .catch((error) => setPushResult({ state: 'error', error: roleErrorMessage(error, 'role update failed') }));
  };

  const remove = async () => {
    setDeleteError(null);
    setState('deleting');
    try {
      await window.SubstrateAPI.deleteRole(role.name);
      onDeleted?.(role.name);
    } catch (error) {
      setState('delete failed');
      setDeleteError(roleErrorMessage(error, 'delete failed'));
    }
  };

  const status = state === 'saved'
    ? (role.overridden ? `saved override${role.updated_at ? ` · ${window.SubstrateFmt?.fmtTimeAgo?.(role.updated_at) || role.updated_at}` : ''}` : 'using default')
    : state;
  const pushed = pushResult?.result;
  const okCount = pushed?.results?.filter((r) => r.ok).length ?? 0;
  return (
    <div className="role-editor-card">
      <div className="role-editor-head">
        <div>
          <div className="role-editor-name">{role.name}{role.builtin ? ' · builtin' : ''}</div>
          <div className={`roles-save-state ${String(state).includes('failed') || String(state).includes('error') ? 'error' : ''}`}>{status}</div>
        </div>
        <div className="role-editor-actions">
          <button className="orch-btn" type="button" onClick={push} disabled={state === 'saving' || profileState === 'saving' || pushResult?.state === 'pushing'}>Update running agents</button>
          {!role.builtin && <button className="orch-btn danger" type="button" onClick={remove} disabled={state === 'deleting'}>{state === 'deleting' ? 'Deleting…' : 'Delete'}</button>}
        </div>
      </div>
      <div className="role-meta-row role-identity-row">
        <input className="mono" value={meta.glyph} maxLength={4} onChange={(e) => setMeta({ ...meta, glyph: e.target.value })} aria-label={`${role.name} glyph`} disabled={role.builtin} title={role.builtin ? 'Builtin identity is fixed' : undefined}/>
        <input className="mono" type="color" value={meta.color} onChange={(e) => setMeta({ ...meta, color: e.target.value })} aria-label={`${role.name} color`} disabled={role.builtin} title={role.builtin ? 'Builtin identity is fixed' : undefined}/>
      </div>
      <form className="role-profile-form" onSubmit={saveDefaultProfile}>
        <RoleProfileField value={defaultProfile} onChange={setDefaultProfile} profiles={profiles} idPrefix={`role-${role.name}`} disabled={false}/>
        <div className="role-exec-actions">
          <span className={`roles-save-state ${profileState === 'error' ? 'error' : ''}`}>
            {profileState === 'saving' ? 'saving default…' : profileState === 'error' ? 'default save failed' : defaultProfile ? 'using selected profile' : 'using retained role exec'}
          </span>
          <button className="orch-btn" type="submit" disabled={profileState === 'saving'}>{profileState === 'saving' ? 'Saving…' : 'Save default'}</button>
        </div>
        {profileError && <div className="roles-inline-error" role="alert">{profileError}</div>}
      </form>
      {deleteError && <div className="roles-inline-error" role="alert">{deleteError}</div>}
      <textarea
        className="role-editor-body mono"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        spellCheck="false"
        aria-label={`${role.name} role card`}
      />
      {pushResult?.state === 'pushing' && <div className="roles-push-result">pushing…</div>}
      {pushResult?.state === 'error' && <div className="roles-push-result error">{pushResult.error}</div>}
      {pushed && (
        <div className="roles-push-result">
          pushed to {okCount}/{pushed.count} live {role.name} session{pushed.count === 1 ? '' : 's'}
          {pushed.results?.length > 0 && (
            <div className="roles-push-list">
              {pushed.results.map((r) => <span key={r.session_id} className={`native-session-meta-chip mono ${r.ok ? '' : 'error'}`} title={r.error || r.target || ''}>{r.ok ? 'ok' : 'fail'} · {r.name || r.session_id.slice(0, 8)}</span>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LegacyNativeCardUnused({ session, name, queueCount = 0 }) {
  const [roleToast, setRoleToast] = React.useState(null);
  const working = session.status === 'busy' || session.status === 'waiting';
  const registered = session.registered || !!window.Store.getProjectByContractId(session.project_id);
  const pendingCount = Number(session.pending_count || queueCount || 0);
  const channelUnavailable = session.channel_present === false
    || (session.channel_present === true && ['unreachable', 'unverified', 'unhealthy'].includes(session.endpoint_health))
    || (session.channel_present == null && session.reachable === false);
  const currentTicket = session.current_in_progress_ticket;
  const unackedWarnings = session.active_unacked_dispatches || [];
  const pathLabel = compactPath(session.cwd);
  const openPeek = () => {
    if (session.session_id) window.openNativeSessionDrawer(session.session_id);
  };
  const flashRoleError = (err) => {
    const msg = err?.payload?.error || err?.message || 'Role assignment failed';
    console.error('set role failed', err);
    setRoleToast({ msg: `Role assignment failed: ${msg}`, id: Math.random() });
    setTimeout(() => setRoleToast(null), 3000);
  };
  const assignRole = async (role) => {
    try {
      const result = await window.SubstrateAPI.setSessionRole(session.session_id, role);
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
    <div
      className={`native-session-card ${working ? 'busy' : 'idle'} cc-clickable`}
      onClick={openPeek}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPeek(); } }}
      title="open session details"
    >
      <div className="native-session-top">
        <Icon.Gear size={16} className={`gear gear-${working ? 'working' : 'idle'}`}/>
        <span className="native-session-name">{name}</span>
        {session.role && <span className="native-session-role-chip">{session.role}</span>}
        {pendingCount > 0 && (
          <span className="native-session-queue-chip" title={`${pendingCount} dispatch${pendingCount === 1 ? '' : 'es'} queued — delivers when this session is idle`}>⏳ {pendingCount} queued</span>
        )}
        {unackedWarnings.map((w) => <UnackedDispatchBadge key={w.delivery_event_id || w.warning_event_id} warning={w}/>)}
        <span className={`native-session-status status-${working ? 'busy' : 'idle'}`}>
          {session.status || 'idle'}
          {session.waiting_for ? ` · ${session.waiting_for}` : ''}
        </span>
        {!registered && (
          <span className="native-session-badge" title="this project is not registered with the dashboard">
            unregistered
          </span>
        )}
      </div>
      <div className="native-session-path mono" title={session.cwd || ''}>
        {pathLabel}
      </div>
      {currentTicket && (
        <a
          className="native-session-current mono"
          href={window.Router.buildHref({ kind: 'ticket', id: currentTicket.id })}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.Router.openTicket(currentTicket.id); }}
          title={currentTicket.title}
        >
          current: {currentTicket.display_id || currentTicket.id} · {currentTicket.title}
        </a>
      )}
      {channelUnavailable && session.alive && (
        <div className="native-session-nochannel" title="live session with no golem channel registered — dispatches can queue, but briefs/interrupts cannot be delivered now">
          <span className="cc-nochannel-dot"/>
          no channel — dispatches queue until reachable
        </div>
      )}
      <div className="native-session-meta">
        <span className="native-session-meta-chip mono" title="process id"><span>pid</span>{session.pid ?? '?'}</span>
        {session.session_id && <span className="native-session-meta-chip mono" title={session.session_id}><span>sid</span>{session.session_id.slice(0, 8)}</span>}
        {session.project_id && <span className="native-session-meta-chip mono" title="derived project_id"><span>project</span>{session.project_id}</span>}
        {session.updated_at && (
          <span className="native-session-meta-chip mono" title="last updated">
            <span>seen</span>
            {window.SubstrateFmt?.fmtClock?.(session.updated_at) || ''}
          </span>
        )}
      </div>
      <div className="native-session-role" onClick={(e) => e.stopPropagation()}>
        <label>
          Role{' '}
          <RoleSelect
            value={session.role || ''}
            onChange={assignRole}
            disabled={!session.session_id}
          />
        </label>
        {roleToast && <div className="orch-toast err cc-toast" key={roleToast.id}>{roleToast.msg}</div>}
      </div>
    </div>
  );
}

function ProjectCard({ p, setRoute }) {
  const live = window.Store.getProjectAliveSessions(p).length;
  return (
    <div
      key={p.id}
      className={`project-card ${p.stale ? 'project-card-stale' : ''}`}
      onClick={() => setRoute({ kind: 'project', id: p.id, tab: 'agents' })}
    >
      <div className="project-card-top">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <ProjectGlyph project={p}/>
          <div>
            <div className="project-card-name">{p.name}</div>
            <div className="project-card-id mono">{p.id}</div>
          </div>
        </div>
        {live > 0
          ? <span className="pill active"><span className="dot"/>Active</span>
          : <span className="pill idle"><span className="dot"/>Idle</span>}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5,
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    overflow: 'hidden' }}>
        {p.description || <span style={{ color: 'var(--text-4)' }}>no description</span>}
      </div>
      <div className="project-card-stats">
        <div className="project-stat">
          <div className="project-stat-value tnum">{live}</div>
          <div className="project-stat-label">live sessions</div>
        </div>
        <div className="project-stat" style={{ marginLeft: 'auto' }}>
          <div className="project-stat-value tnum" style={{ color: p.color }}>
            {Number.isFinite(Number(p.progress)) ? `${Math.round(Number(p.progress) * 100)}%` : '—'}
          </div>
          <div className="project-stat-label">{Number.isFinite(Number(p.total_tickets)) ? p.total_tickets : 0} tickets</div>
        </div>
      </div>
      <div className="project-card-progress">
        <div className="project-card-progress-fill"
          style={{ width: `${(p.progress || 0) * 100}%`, background: p.color }}/>
      </div>
      {p.plan && p.plan.total > 0 && (
        <PlanProgress plan={p.plan} color={p.color}/>
      )}
    </div>
  );
}

function ProjectsPage({ setRoute }) {
  useStore();
  const [includeStale, setIncludeStale] = React.useState(false);
  const projects = window.Store.getState().projects;
  const active = projects.filter((p) => !p.stale);
  const stale = projects.filter((p) => p.stale);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Projects</h1>
          <div className="page-subtitle">{active.length} active · {stale.length} stale</div>
        </div>
        <label className="tracker-toggle stale-toggle">
          <input
            type="checkbox"
            checked={includeStale}
            onChange={(e) => setIncludeStale(e.target.checked)}
          />
          Include stale
        </label>
      </div>
      {projects.length === 0 ? (
        <EmptyCard
          label="no projects discovered"
          hint={<>Bootstrap a project under <span className="mono">~/Documents/software/experiments/golem/golem-projects/</span> — the harness will scaffold and register it in-session.</>}
        />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {active.map(p => <ProjectCard key={p.id} p={p} setRoute={setRoute}/>)}
          </div>
          {includeStale && stale.length > 0 && (
            <div className="stale-section">
              <div className="stale-section-head">
                <Icon.Archive size={16}/>
                <span className="stale-section-title">Stale</span>
                <span className="stale-section-count">{stale.length}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
                {stale.map(p => <ProjectCard key={p.id} p={p} setRoute={setRoute}/>)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// GOL-13: ReviewInbox / LogsPage / MilestonesFeed pruned — standalone
// /logs board removed. Review now happens in the Spec comment rail inside
// the project workspace. Legacy helpers below kept only for the Offline
// orphans section (Agents page).

// TKT-0286: pending dispatches whose target session is no longer alive. Named
// via the persisted session_labels join (the live-session list can't resolve
// them). Rendered below Working/Idle on the Agents page; Cancel relies on the
// dispatch-queue-updated WS signal for refresh (no manual refetch, no polling).
function OfflineOrphansSection({ rows }) {
  const [errors, setErrors] = React.useState({});
  const cancel = (qid) => {
    window.SubstrateAPI.delJSON(`/api/dispatch-queue/${encodeURIComponent(qid)}`)
      .catch((err) => setErrors((e) => ({ ...e, [qid]: String(err?.message || err) })));
  };
  const sessionLabel = (r) => r.session_label || `session ${String(r.session_id || '').slice(0, 8)}`;
  const ago = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? (window.SubstrateFmt?.fmtTimeAgo?.(t) || '') : ''; };
  return (
    <div className="agents-section agents-section-orphans">
      <div className="agents-section-head">
        <Icon.Archive size={16}/>
        <span className="agents-section-title">Queued for offline sessions</span>
        <span className="agents-section-count">{rows.length}</span>
      </div>
      <div className="native-sessions">
        {rows.map((r) => (
          <div key={r.id} className="orphan-row">
            <div className="orphan-row-top">
              <span className="orphan-session-label" title={r.session_id}>{sessionLabel(r)}</span>
              <a className="orphan-ticket-link"
                href={window.Router.buildHref({ kind: 'ticket', id: r.ticket_id })}
                onClick={(e) => { e.preventDefault(); window.Router.openTicket(r.ticket_id); }}
                title={r.ticket_title || r.ticket_id}
              >
                <span className="mono">{r.ticket_id}</span>
                {r.ticket_title ? <span className="orphan-ticket-title">{r.ticket_title}</span> : null}
              </a>
              <span className="orphan-ago" title={r.created_at}>{ago(r.created_at)}</span>
              <button className="orch-btn small ghost orphan-cancel" onClick={() => cancel(r.id)} title="Cancel this queued dispatch">Cancel</button>
            </div>
            <div className="orphan-row-hint">expires after 60m offline</div>
            {errors[r.id] && <div className="orphan-row-err">{errors[r.id]}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

window.AgentsPage = AgentsPage;
window.ProjectsPage = ProjectsPage;
