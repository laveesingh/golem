// router.js — tiny path-based client-side router for the dashboard (TKT-0146).
//
// Replaces the old hash+replaceState model (which never pushed history, so Back
// exited the SPA). Plain JS (no JSX), loaded as a regular <script> before the
// babel component scripts. Exposed as window.Router.
//
// Routes (path-based):
//   /                 → dashboard
//   /dashboard        → dashboard (alias)
//   /tracker          → tracker
//   /projects         → projects
//   /agents           → agents
//   /logs             → logs
//   /project/<id>     → { kind:'project', id, tab?, q?, showArchived? }
//   /tickets/<id>     → { kind:'ticket', id }
//
// Drawers are URL overlays carried as query params on the current page's path:
//   ?ticket=<id>  ?compose=1 (&project=<pid>)  ?chat=<sid>  ?ns=<sid>
// Opening a drawer PUSHES a history entry (so Back closes it); closing either
// pops that entry (history.back) or, for deep-linked overlays with nothing to
// pop, replaceState-strips the param.
//
// History policy: page navigation + tab switches push; transient filter typing
// uses go(route, {replace:true}) (debounced by the caller) so the stack isn't
// spammed — preserves the original "don't spam history" intent.

(function () {
  const TOP_LEVEL = ['dashboard', 'tracker', 'projects', 'agents', 'logs'];

  const parseQuery = (search) => {
    const out = {};
    const s = (search || '').replace(/^\?/, '');
    if (!s) return out;
    for (const pair of s.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = eq === -1 ? pair : pair.slice(0, eq);
      const v = eq === -1 ? '' : pair.slice(eq + 1);
      out[decodeURIComponent(k)] = decodeURIComponent(v);
    }
    return out;
  };

  const stringifyQuery = (obj) => {
    const parts = [];
    for (const [k, v] of Object.entries(obj || {})) {
      if (v === null || v === undefined || v === '' || v === false) continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    return parts.length ? `?${parts.join('&')}` : '';
  };

  const normalizePath = (p) => (p || '/').replace(/\/+$/, '') || '/';

  // Map a {path, query} to a route descriptor. Unknown paths fall back to
  // dashboard so the SPA never white-screens on a bad deep link.
  const parseRoute = (path, query) => {
    const p = normalizePath(path);
    if (p === '/' || p === '/dashboard') return { kind: 'dashboard' };
    if (p === '/tracker') return { kind: 'tracker' };
    if (p === '/projects') return { kind: 'projects' };
    if (p === '/agents') return { kind: 'agents' };
    if (p === '/logs') return { kind: 'logs' };
    const pm = p.match(/^\/project\/(.+)$/);
    if (pm) {
      return {
        kind: 'project',
        id: decodeURIComponent(pm[1]),
        tab: query.tab || null,
        q: query.q || null,
        showArchived: !!query.showArchived,
      };
    }
    const tm = p.match(/^\/tickets\/(.+)$/);
    if (tm) return { kind: 'ticket', id: decodeURIComponent(tm[1]) };
    return { kind: 'dashboard' };
  };

  // Build an href (path + query) for a route descriptor. Used for <a href> so
  // links are real (middle-click / open-in-new-tab work).
  const buildHref = (route) => {
    if (!route || !route.kind) return '/';
    switch (route.kind) {
      case 'dashboard': return '/';
      case 'tracker': return '/tracker';
      case 'projects': return '/projects';
      case 'agents': return '/agents';
      case 'logs': return '/logs';
      case 'project': {
        const q = {};
        if (route.tab) q.tab = route.tab;
        if (route.q) q.q = route.q;
        if (route.showArchived) q.showArchived = '1';
        return `/project/${encodeURIComponent(route.id)}${stringifyQuery(q)}`;
      }
      case 'ticket': return `/tickets/${encodeURIComponent(route.id)}`;
      default: return '/';
    }
  };

  // Read the current location into a route descriptor + overlay map.
  const parseLocation = () => {
    const path = window.location.pathname;
    const query = parseQuery(window.location.search);
    const route = parseRoute(path, query);
    route.overlays = {
      ticket: query.ticket || null,
      compose: !!query.compose,
      composeProject: query.project || null,
      chat: query.chat || null,
      ns: query.ns || null,
      ideas: !!query.ideas, // TKT-0206: global ideas stack overlay
    };
    return route;
  };

  const dispatchChange = () =>
    window.dispatchEvent(new CustomEvent('route-change'));

  // Navigate to a route. push by default (so Back traverses); pass replace:true
  // for transient updates (filter typing, toggle) that shouldn't add history.
  const go = (route, opts = {}) => {
    const href = buildHref(route);
    if (opts.replace) window.history.replaceState({}, '', href);
    else window.history.pushState({}, '', href);
    dispatchChange();
  };

  // ── Overlay (drawer) helpers ──────────────────────────────────────────────
  // Open = push the current path + query with the overlay param added. The
  // pushed entry's history.state marks which overlay opened it, so closeOverlay
  // knows whether back() will pop it (vs. a deep link with nothing to pop).
  const openOverlay = (name, value, extra) => {
    const query = parseQuery(window.location.search);
    const next = { ...query, [name]: value == null ? '1' : value, ...(extra || {}) };
    const href = window.location.pathname + stringifyQuery(next);
    window.history.pushState({ overlay: name }, '', href);
    dispatchChange();
  };

  const closeOverlay = (name) => {
    const st = window.history.state;
    if (st && typeof st === 'object' && st.overlay === name) {
      // We pushed this entry — pop it. popstate fires → App re-parses → closes.
      window.history.back();
    } else {
      // Deep-linked overlay (no push entry to pop): strip via replaceState.
      const query = parseQuery(window.location.search);
      delete query[name];
      const href = window.location.pathname + stringifyQuery(query);
      window.history.replaceState(st || {}, '', href);
      dispatchChange();
    }
  };

  // Convenience: build a query with one overlay param added, preserving the
  // rest (used by openers that already know the current route).
  const openTicket = (id) => openOverlay('ticket', id);
  const openComposer = (projectId) =>
    openOverlay('compose', '1', projectId ? { project: projectId } : null);
  const openChat = (sessionId) => openOverlay('chat', sessionId);
  const openNativeSession = (sessionId) => openOverlay('ns', sessionId);
  // TKT-0206: open / close the global ideas-stack drawer.
  const openIdeas = () => openOverlay('ideas', '1');
  const closeIdeas = () => closeOverlay('ideas');

  // True if navigating from `from` to `to` is a same-page overlay/filter change
  // (no page swap) — lets callers decide replace vs push. Not required for P1.
  const samePage = (from, to) =>
    !!from && !!to && from.kind === to.kind && from.id === to.id;

  window.Router = {
    parseQuery, stringifyQuery, parseRoute, parseLocation, buildHref,
    go, openOverlay, closeOverlay,
    openTicket, openComposer, openChat, openNativeSession, openIdeas, closeIdeas,
    samePage, TOP_LEVEL,
  };
})();