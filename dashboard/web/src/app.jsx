// Root App — routing + global shell.

function App() {
  const [ready, setReady] = React.useState(() => window.Store.getState().ready);
  // Route state is driven by window.Router (path-based). The router pushes
  // history on navigation (so Back traverses pages) and dispatches `route-change`
  // on every change; popstate fires on Back/Forward. Both keep this state in
  // sync with the URL. Replaces the old hash+replaceState model that never
  // pushed, so Back used to exit the SPA.
  const [route, setRoute] = React.useState(() => window.Router.parseLocation());

  React.useEffect(() => {
    if (ready) return undefined;
    return window.Store.subscribe((st) => {
      if (st.ready) setReady(true);
    });
  }, [ready]);

  React.useEffect(() => {
    const sync = () => setRoute(window.Router.parseLocation());
    window.addEventListener('popstate', sync);
    window.addEventListener('route-change', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('route-change', sync);
    };
  }, []);

  // TKT-0206: the ideas count is now tracked in the Sidebar component
  // (it renders the Ideas link with the count badge). The IdeasDrawer
  // also reads /api/ideas to populate its list; both refresh on the
  // shared 'ideas:changed' event.

  // setRoute navigates (push) — real links + in-app nav both go through this.
  // Callers that want replace semantics (filter typing) call window.Router.go
  // directly with {replace:true}.
  const navigate = (r) => window.Router.go(r);

  // GOL-275: per-view browser tab titles. The ticket lookup matches both
  // keys: deep links carry the display id (GOL-275) while the store indexes
  // tickets by their internal id (TKT-0537).
  React.useEffect(() => {
    let title = 'Golem';
    const state = window.Store.getState();
    if (route.kind === 'ticket') {
      let ticket = null;
      for (const t of state.trackerTickets.values()) {
        if (t.id === route.id || t.display_id === route.id) { ticket = t; break; }
      }
      title = ticket ? `${ticket.title} · Golem`
        : `Ticket ${route.id} · Golem`;
    } else if (route.kind === 'project') {
      const project = window.Store.getProjects().find((p) => p.id === route.id || p.project_id === route.id);
      title = project ? `${project.name} · Golem` : 'Project · Golem';
    } else {
      const names = {
        dashboard: 'Dashboard', tracker: 'Tracker', specs: 'Specs',
        projects: 'Projects', agents: 'Agents', logs: 'Logs', settings: 'Settings',
        substrate: 'Substrate',
      };
      title = `${names[route.kind] || 'Dashboard'} · Golem`;
    }
    document.title = title;
  }, [route]);

  // Reader view (/read/<id>): the ticket document alone — body + contents
  // rail, no sidebar/topbar/props chrome. The drawer handles its own loading;
  // TicketDrawer's td-reader class hides the in-page chrome via CSS.
  if (route.kind === 'ticket' && route.reader) {
    return (
      <div className="reader-shell">
        <TicketDrawer variant="page" reader open={true} ticketId={route.id}
          onClose={() => window.history.back()}/>
      </div>
    );
  }

  let page;
  if (!ready) {
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
  else if (route.kind === 'tracker') page = <TrackerBoard route={route} setRoute={navigate} view={route.view}/>;
  else if (route.kind === 'specs') page = <SpecsPage/>;
  else if (route.kind === 'projects') page = <ProjectsPage setRoute={navigate}/>;
  else if (route.kind === 'agents') page = <AgentsPage setRoute={navigate}/>;
  else if (route.kind === 'logs') page = <LogsPage/>;
  else if (route.kind === 'settings') page = <SettingsPage/>;
  else if (route.kind === 'substrate') page = <SubstratePage route={route} setRoute={navigate}/>;
  else if (route.kind === 'project') page = (
    <ProjectView projectId={route.id} tab={route.tab} showArchived={route.showArchived} q={route.q} setRoute={navigate}/>
  );
  // GOL-273: the standalone ticket page (/tickets/<id>) was scrubbed. The
  // only full-page ticket surface is the reader view (/read/<id>); legacy
  // /tickets/<id> deep links parse to the reader route in router.js.
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
       <CommunicationDrawer
         open={!!route.overlays.communication}
         onClose={() => window.Router.closeOverlay('communication')}/>
       <CreateTicketDrawer
        open={!!route.overlays.compose}
        preselectProject={route.overlays.composeProject || ''}
        preselectKind={route.overlays.composeKind || ''}
        preselectParent={route.overlays.composeParent || ''}
        onClose={() => window.Router.closeOverlay('compose')}/>
      <TicketDrawer
        open={!!route.overlays.ticket}
        ticketId={route.overlays.ticket}
        onClose={() => window.Router.closeOverlay('ticket')}/>
      {/* TKT-0206: global ideas stack — URL overlay (?ideas=1) with the
          same shell pattern as the other drawers. The anchor is in the
          sidebar (the user wanted it embedded, not floating). */}
      <IdeasDrawer
        open={!!route.overlays.ideas}
        onClose={() => window.Router.closeOverlay('ideas')}/>
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
