// Root App — routing + global shell.

function App() {
  useStore();
  // Route state is driven by window.Router (path-based). The router pushes
  // history on navigation (so Back traverses pages) and dispatches `route-change`
  // on every change; popstate fires on Back/Forward. Both keep this state in
  // sync with the URL. Replaces the old hash+replaceState model that never
  // pushed, so Back used to exit the SPA.
  const [route, setRoute] = React.useState(() => window.Router.parseLocation());
  const state = window.Store.getState();

  React.useEffect(() => {
    const sync = () => setRoute(window.Router.parseLocation());
    window.addEventListener('popstate', sync);
    window.addEventListener('route-change', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('route-change', sync);
    };
  }, []);

  // TKT-0206: refresh the idea count on the bottom-left anchor whenever
  // the ideas list changes (an idea is posted or popped, anywhere in the
  // app). Cheap (just one GET); keeps the badge in sync without a global
  // store or interval.
  const [ideasCount, setIdeasCount] = React.useState(0);
  const refreshIdeasCount = React.useCallback(() => {
    window.SubstrateAPI.listIdeas()
      .then((rows) => setIdeasCount(Array.isArray(rows) ? rows.length : 0))
      .catch(() => {});
  }, []);
  React.useEffect(() => {
    refreshIdeasCount();
    window.addEventListener('ideas:changed', refreshIdeasCount);
    return () => window.removeEventListener('ideas:changed', refreshIdeasCount);
  }, [refreshIdeasCount]);

  // setRoute navigates (push) — real links + in-app nav both go through this.
  // Callers that want replace semantics (filter typing) call window.Router.go
  // directly with {replace:true}.
  const navigate = (r) => window.Router.go(r);

  let page;
  if (!state.ready) {
    page = (
      <div className="page">
        <div className="empty-card">
          <div>connecting…</div>
          <div className="empty-card-hint">
            Loading snapshot from <span className="mono">/api/snapshot</span>.
          </div>
        </div>
      </div>
    );
  } else if (route.kind === 'dashboard') page = <Dashboard setRoute={navigate}/>;
  else if (route.kind === 'tracker') page = <TrackerBoard setRoute={navigate}/>;
  else if (route.kind === 'projects') page = <ProjectsPage setRoute={navigate}/>;
  else if (route.kind === 'agents') page = <AgentsPage setRoute={navigate}/>;
  else if (route.kind === 'logs') page = <LogsPage/>;
  else if (route.kind === 'project') page = (
    <ProjectView projectId={route.id} tab={route.tab} showArchived={route.showArchived} q={route.q} setRoute={navigate}/>
  );
  else if (route.kind === 'ticket') page = (
    // Standalone ticket page (TKT-0154): reuses TicketDrawer in page variant so
    // the full interactive detail (body, annotations, field controls, dispatch,
    // comments) lives at /tickets/<id> — deep-linkable, refresh-safe.
    <TicketDrawer variant="page" open={true} ticketId={route.id}
      onClose={() => window.history.back()}/>
  );
  else page = <Dashboard setRoute={navigate}/>;

  return (
    <div className="app">
      <Sidebar route={route} setRoute={navigate}/>
      <div className="main">
        <Topbar route={route} setRoute={navigate}/>
        {page}
      </div>
      {/* Drawers are URL overlays (TKT-0153): App owns their open state, derived
          from route.overlays (?ticket=, ?compose=1&project=, ?chat=, ?ns=).
          Openers call Router.open* (push a history entry); close calls
          Router.closeOverlay (history.back), so Back closes each drawer. */}
      <CeoChatDrawer
        open={!!route.overlays.chat}
        sessionId={route.overlays.chat}
        onClose={() => window.Router.closeOverlay('chat')}/>
      <NativeSessionDrawer
        open={!!route.overlays.ns}
        sessionId={route.overlays.ns}
        onClose={() => window.Router.closeOverlay('ns')}/>
      <CreateTicketDrawer
        open={!!route.overlays.compose}
        preselectProject={route.overlays.composeProject || ''}
        onClose={() => window.Router.closeOverlay('compose')}/>
      <TicketDrawer
        open={!!route.overlays.ticket}
        ticketId={route.overlays.ticket}
        onClose={() => window.Router.closeOverlay('ticket')}/>
      {/* TKT-0206: global ideas stack — URL overlay (?ideas=1) with the
          same shell pattern as the other drawers. */}
      <IdeasDrawer
        open={!!route.overlays.ideas}
        onClose={() => window.Router.closeOverlay('ideas')}/>
      {/* TKT-0206: bottom-left anchor that opens the ideas drawer. Always
          visible (lives outside the route-overlays array) so the user can
          drop a thought from any page, including while looking at a ticket
          or a project. */}
      <button
        className="ideas-anchor"
        onClick={() => window.Router.openIdeas()}
        title="Open the ideas stack"
        aria-label="Open the ideas stack"
      >
        <Icon.Lightbulb/>
        <span>Ideas</span>
        {ideasCount > 0 && <span className="ideas-anchor-count mono">{ideasCount}</span>}
      </button>
    </div>
  );
}

// TKT-0103: defer the mount until window.__reactReady is set by the ESM
// block in index.html. The ESM block also performs a mount via
// ReactDOMClient.createRoot, so this becomes a no-op if it ran first. The
// guard handles the case where babel-standalone processes this file before
// the ESM block has finished (race) — without the guard, line below would
// throw "Cannot read properties of undefined (reading 'createRoot')".
function mount() {
  if (!window.ReactDOM || !window.ReactDOMClient) {
    return setTimeout(mount, 30);
  }
  const root = window.ReactDOMClient.createRoot(document.getElementById('root'));
  root.render(window.React.createElement(App));
}
mount();
