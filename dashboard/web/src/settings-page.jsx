function SettingsPage() {
  const [status, setStatus] = React.useState(null);
  const [config, setConfig] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(null);
  const [syncing, setSyncing] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [syncResult, setSyncResult] = React.useState(null);

  const refresh = React.useCallback(async () => {
    setError(null);
    try {
      const [cfg, st] = await Promise.all([
        window.SubstrateAPI.substrateConfig(),
        window.SubstrateAPI.substrateStatus(),
      ]);
      setConfig(cfg);
      setStatus(st);
    } catch (e) {
      setError(e?.payload?.error || e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);

  const harnesses = React.useMemo(() => {
    const h = config?.harnesses || status?.config?.harnesses || {};
    return Object.entries(h).map(([id, row]) => ({ id, ...row }));
  }, [config, status]);

  const cells = React.useMemo(() => status?.global || [], [status]);
  const artifactRows = React.useMemo(() => {
    const order = ['skills', 'agents', 'commands', 'hooks', 'mcp', 'config-fragment'];
    const set = new Set(order);
    for (const c of cells) set.add(c.artifact);
    return [...set];
  }, [cells]);
  const enabledHarnesses = harnesses.filter((h) => h.enabled !== false);
  const latestSync = React.useMemo(() => {
    const stamps = cells.map((c) => c.lock?.synced_at).filter(Boolean).sort();
    return stamps.length ? stamps[stamps.length - 1] : null;
  }, [cells]);

  const cellFor = (artifact, harness) => cells.find((c) => c.artifact === artifact && c.harness === harness);

  async function toggleHarness(id, enabled) {
    setSaving(id);
    setError(null);
    try {
      const next = await window.SubstrateAPI.updateSubstrateConfig({ harnesses: { [id]: { enabled } } });
      setConfig(next);
      await refresh();
    } catch (e) {
      setError(e?.payload?.error || e.message || String(e));
    } finally {
      setSaving(null);
    }
  }

  async function syncNow(target) {
    setSyncing(true);
    setSyncResult(null);
    setError(null);
    try {
      const res = await window.SubstrateAPI.syncSubstrate(target ? { target } : {});
      setSyncResult(res);
      await refresh();
    } catch (e) {
      setError(e?.payload?.error || e.message || String(e));
      setSyncResult(e?.payload || null);
    } finally {
      setSyncing(false);
    }
  }

  if (loading) {
    return <div className="page settings-page"><div className="empty-card">loading settings…</div></div>;
  }

  return (
    <div className="page settings-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <div className="page-subtitle">Harness switches, substrate sync state, and render controls.</div>
        </div>
        <button className="settings-primary" onClick={() => syncNow(null)} disabled={syncing} data-testid="sync-now">
          {syncing ? 'Syncing…' : 'Sync Now'}
        </button>
      </div>

      {error && <div className="settings-alert error">{error}</div>}

      <div className="settings-stack">
        <DiagnosticCard />
        <section className="settings-section" data-testid="harnesses-section">
          <div className="settings-section-head">
            <div>
              <h2>Harnesses</h2>
              <p>Enable or disable harness renders. Unknown future harnesses are rendered from config automatically.</p>
            </div>
          </div>
          <div className="settings-harness-grid">
            {harnesses.map((h) => (
              <label key={h.id} className={`settings-harness-card ${h.enabled ? 'enabled' : 'disabled'}`}>
                <span>
                  <span className="settings-harness-name">{h.id}</span>
                  <span className="settings-harness-meta">{h.testedVersion ? `tested ${h.testedVersion}` : 'no pinned version'}</span>
                </span>
                <span className="settings-switch">
                  <input
                    type="checkbox"
                    checked={!!h.enabled}
                    disabled={saving === h.id}
                    onChange={(e) => toggleHarness(h.id, e.target.checked)}
                    data-testid={`harness-${h.id}`}
                  />
                  <span className="settings-switch-track"/>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className="settings-section" data-testid="sync-section">
          <div className="settings-section-head">
            <div>
              <h2>Substrate Sync</h2>
              <p>Matrix shows global render drift by artifact type and harness. Disabled harnesses intentionally skip sync.</p>
            </div>
            <div className="settings-generated mono">
              <div>checked {status?.generated_at || ''}</div>
              <div>last sync {latestSync || 'never'}</div>
            </div>
          </div>

          <div className="settings-warning-row">
            <strong>Capability notes</strong>
            {Object.entries(status?.warnings || {}).map(([h, list]) => (
              <div key={h}><span className="mono">{h}</span>: {(list || []).join(' ')}</div>
            ))}
          </div>

          <div className="settings-matrix-wrap">
            <table className="settings-matrix" data-testid="sync-matrix">
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
                    {harnesses.map((h) => <td key={h.id}>{renderCell(cellFor(artifact, h.id), h)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {syncResult && (
          <section className={`settings-section sync-result ${syncResult.status === 'error' ? 'error' : ''}`} data-testid="sync-result">
            <div className="settings-section-head"><h2>Sync Result</h2></div>
            <SyncResultSummary result={syncResult}/>
          </section>
        )}

        <section className="settings-section settings-future">
          <div className="settings-section-head">
            <div>
              <h2>Work-loop Settings</h2>
              <p>Reserved extension point for future dispatcher and verification policy controls.</p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function syncResultSummary(result) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  const failed = result?.status === 'error' || rows.some((r) => r.status === 'error' || r.error);
  const firstError = result?.error || rows.find((r) => r.error)?.error || null;
  const ok = rows.filter((r) => r.status === 'ok').length;
  const skipped = rows.filter((r) => r.status === 'skipped' || r.status === 'disabled').length;
  const elapsed = rows.map((r) => Number(r.elapsed_ms)).filter(Number.isFinite).reduce((sum, n) => sum + n, 0);
  if (failed) return { tone: 'error', title: `Sync failed${firstError ? `: ${firstError}` : ''}`, meta: `${rows.length} harness${rows.length === 1 ? '' : 'es'} checked` };
  if (result?.status === 'skipped' || (rows.length && ok === 0)) return { tone: 'neutral', title: 'Sync skipped', meta: `${skipped} harness${skipped === 1 ? '' : 'es'} skipped` };
  return { tone: 'success', title: `Sync complete${elapsed ? ` in ${elapsed}ms` : ''}`, meta: `${ok} harness${ok === 1 ? '' : 'es'} ok${skipped ? `, ${skipped} skipped` : ''}` };
}

function SyncResultSummary({ result }) {
  const summary = syncResultSummary(result);
  const rows = Array.isArray(result?.results) ? result.results : [];
  return (
    <div className={`sync-summary ${summary.tone}`}>
      <div className="sync-summary-line">
        <span className="sync-summary-pill">{summary.tone === 'error' ? 'failed' : summary.tone === 'success' ? 'success' : 'skipped'}</span>
        <span>{summary.title}</span>
        <span className="sync-summary-meta">{summary.meta}</span>
      </div>
      {rows.length > 0 && (
        <div className="sync-summary-results">
          {rows.map((r, i) => (
            <div key={`${r.harness || r.artifact || 'row'}-${i}`} className="sync-summary-row">
              <span className="mono">{r.harness || r.artifact || 'sync'}</span>
              <span>{r.status || 'ok'}</span>
              {r.elapsed_ms != null && <span className="sync-summary-meta">{r.elapsed_ms}ms</span>}
              {r.error && <span className="sync-summary-error">{r.error}</span>}
            </div>
          ))}
        </div>
      )}
      <details className="sync-summary-details">
        <summary>Raw details</summary>
        <pre>{JSON.stringify(result, null, 2)}</pre>
      </details>
    </div>
  );
}

function renderCell(cell, harness) {
  const status = cell?.status || (harness.enabled ? 'error' : 'disabled');
  const detail = cell?.error || cell?.out_dir || 'not produced by this harness';
  const title = [detail, cell?.details ? `${cell.details.drifted_count} drifted, ${cell.details.orphaned_count} orphaned` : null].filter(Boolean).join(' · ');
  return (
    <span className={`settings-chip ${status}`} title={title} data-status={status}>
      {cell?.label || status.replace('_', ' ')}
    </span>
  );
}

window.SettingsPage = SettingsPage;
