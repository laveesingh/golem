// DiagnosticCard — environment readiness checks (GOL-16)
// Reused in /settings (top) and onboarding step 1.
// Shows Pi, Claude Code, Codex, model API keys with green/amber/red and remediation hints.
// Data source: GET /api/diagnostics  → { checks: [{id,label,status,detail,hint}] , overall }

function DiagnosticCard({ compact = false }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  const fetchDiagnostics = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.SubstrateAPI.getJSON('/api/diagnostics');
      setData(res);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { fetchDiagnostics(); }, [fetchDiagnostics]);

  // Also refresh when user clicks remediation that might change env (e.g., after sync)
  if (loading && !data) {
    return (
      <div className="diagnostic-card loading">
        <div className="diagnostic-card-head">
          <span className="diagnostic-card-title">Environment Readiness</span>
          <span className="diagnostic-card-status mono">checking…</span>
        </div>
        <div className="diagnostic-card-body">
          <div className="empty">Running doctor checks…</div>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="diagnostic-card error">
        <div className="diagnostic-card-head">
          <span className="diagnostic-card-title">Environment Readiness</span>
          <span className="diagnostic-card-status mono error">error</span>
        </div>
        <div className="diagnostic-card-body">
          <div className="diagnostic-card-error">{error}</div>
          <button className="orch-btn small" onClick={fetchDiagnostics}>Retry</button>
        </div>
      </div>
    );
  }

  const checks = data?.checks || [];
  const overall = data?.overall || 'unknown';
  const overallColor = overall === 'green' ? 'var(--status-active)' : overall === 'amber' ? 'var(--status-review)' : overall === 'red' ? 'var(--status-blocked)' : 'var(--text-3)';

  return (
    <div className={`diagnostic-card ${compact ? 'compact' : ''}`}>
      <div className="diagnostic-card-head">
        <span className="diagnostic-card-title">Environment Readiness</span>
        <span className="diagnostic-card-overall" style={{ background: overallColor }}>
          {overall === 'green' ? '✓ Ready' : overall === 'amber' ? '⚠ Needs attention' : overall === 'red' ? '✕ Action required' : 'Unknown'}
        </span>
        <button className="orch-btn ghost small" onClick={fetchDiagnostics} title="Re-run diagnostics">↻ Recheck</button>
      </div>
      <div className="diagnostic-card-body">
        {checks.length === 0 ? (
          <div className="empty">No checks available.</div>
        ) : (
          <div className="diagnostic-check-list">
            {checks.map((check) => {
              const statusIcon = check.status === 'green' ? '✓' : check.status === 'amber' ? '⚠' : check.status === 'red' ? '✕' : '—';
              const statusClass = check.status === 'green' ? 'green' : check.status === 'amber' ? 'amber' : check.status === 'red' ? 'red' : 'unknown';
              return (
                <div key={check.id} className={`diagnostic-check ${statusClass}`}>
                  <span className={`diagnostic-check-icon ${statusClass}`}>{statusIcon}</span>
                  <div className="diagnostic-check-main">
                    <span className="diagnostic-check-label">{check.label}</span>
                    <span className="diagnostic-check-detail">{check.detail || ''}</span>
                    {check.hint && <span className="diagnostic-check-hint">{check.hint}</span>}
                  </div>
                  <span className={`diagnostic-check-status ${statusClass}`}>{check.status}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

window.DiagnosticCard = DiagnosticCard;
