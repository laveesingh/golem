// router.js — tiny path-based client-side router for the dashboard (TKT-0146, pruned GOL-13).
//
// GOL-13 pruned obsolete top-level boards (/tracker, /specs, /logs) and the
// floating CEO chat overlay (?chat=<sid>). Navigation is now 3 core views:
//   Workspace / Projects → / (/dashboard alias), /projects, /project/<id>
//   Swarm Ops           → /agents
//   Settings            → /settings, /substrate (alias)
// Legacy deep links to /tracker, /specs, /logs fall back to dashboard so
// the SPA never white-screens and old bookmarks/link history stay valid.
//
// Routes (path-based):
//   /                 → dashboard
//   /dashboard        → dashboard (alias)
//   /projects         → projects
//   /agents           → agents
//   /settings         → settings
//   /substrate        → settings (alias, same view)
//   /project/<id>     → { kind:'project', id, tab?, q?, showArchived? }
//   /tickets/<id>     → { kind:'ticket', id }
//
// Drawers are URL overlays carried as query params on the current page's path:
//   ?ticket=<id>  ?compose=1 (&project=<pid> &kind=<k> &parent=<id>)  ?ns=<sid>  ?ideas=1  ?communication=1
// Opening a drawer PUSHES a history entry (so Back closes it); closing either
// pops that entry (history.back) or, for deep-linked overlays with nothing to
// pop, replaceState-strips the param.
//
// History policy: page navigation + tab switches push; transient filter typing
// uses go(route, {replace:true}) (debounced by the caller) so the stack isn't
// spammed — preserves the original "don't spam history" intent.

(function () {
  const TOP_LEVEL = ['dashboard', 'projects', 'agents', 'settings', 'substrate', 'onboarding'];

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
  // GOL-13: /tracker, /specs, /logs are obsolete — they land on dashboard.
  const parseRoute = (path, query) => {
    const p = normalizePath(path);
    if (p === '/' || p === '/dashboard') return { kind: 'dashboard' };
    if (p === '/projects') return { kind: 'projects' };
    if (p === '/agents') return { kind: 'agents' };
    if (p === '/settings') return { kind: 'settings' };
    if (p === '/substrate' || p.startsWith('/substrate/')) {
      const parts = p.split('/').filter(Boolean);
      return {
        kind: 'substrate',
        tab: parts[1] || query.tab || 'skills',
        slug: parts[2] || query.slug || null,
      };
    }
    if (p === '/onboarding') return { kind: 'onboarding' };
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
    // GOL-273: the standalone ticket view was scrubbed — /tickets/<id> is a
    // legacy deep link that now lands in the reader view.
    const tm = p.match(/^\/(?:tickets|read)\/(.+)$/);
    if (tm) return { kind: 'ticket', id: decodeURIComponent(tm[1]), reader: true };
    return { kind: 'dashboard' };
  };

  // Build an href (path + query) for a route descriptor. Used for <a href> so
  // links are real (middle-click / open-in-new-tab work).
  const buildHref = (route) => {
    if (!route || !route.kind) return '/';
    switch (route.kind) {
      case 'dashboard': return '/';
      case 'projects': return '/projects';
      case 'agents': return '/agents';
      case 'settings': return '/settings';
      case 'onboarding': return '/onboarding';
      case 'substrate': {
        const q = {};
        if (route.tab && route.tab !== 'skills') q.tab = route.tab;
        if (route.slug) q.slug = route.slug;
        return `/substrate${stringifyQuery(q)}`;
      }
      case 'project': {
        const q = {};
        if (route.tab) q.tab = route.tab;
        if (route.q) q.q = route.q;
        if (route.showArchived) q.showArchived = '1';
        return `/project/${encodeURIComponent(route.id)}${stringifyQuery(q)}`;
      }
      // GOL-273: every ticket link builds to the reader view — the standalone
      // page no longer exists.
      case 'ticket': return `/read/${encodeURIComponent(route.id)}`;
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
      // TKT-0284: compose presets — Kind PopSelect + parent_id (silent).
      // `?compose=1&kind=spec` opens the composer with Kind=spec;
      // `?compose=1&kind=task&parent=TKT-0284` opens it with a parent.
      composeKind: query.kind || null,
      composeParent: query.parent || null,
      ns: query.ns || null,
      ideas: !!query.ideas, // GOL-13: project-scoped ideas stack overlay (per-project)
      communication: !!query.communication,
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
  // TKT-0284: openComposer accepts presets as an object OR (back-compat) a
  // bare projectId string. The presets carry kind + parent_id so the Specs
  // page can open the composer with Kind=spec, and the drawer's "+ Work item"
  // can open it with Kind=task + Parent=<spec id>. `project` is kept
  // as the primary arg for back-compat with the existing tracker + project
  // openers (`Router.openComposer(projectId)`).
  const openComposer = (projectId, presets) => {
    const base = projectId ? { project: projectId } : null;
    if (!presets) return openOverlay('compose', '1', base);
    const extra = { ...(base || {}) };
    if (presets.kind) extra.kind = presets.kind;
    if (presets.parent) extra.parent = presets.parent;
    return openOverlay('compose', '1', extra);
  };
  const openNativeSession = (sessionId) => openOverlay('ns', sessionId);
  // GOL-13: project-scoped ideas drawer — overlay stays ?ideas=1; the
  // owning project is derived from the current route in App (passed as
  // prop to IdeasDrawer) so no extra query param is needed.
  const openIdeas = () => openOverlay('ideas', '1');
  const closeIdeas = () => closeOverlay('ideas');

  // True if navigating from `from` to `to` is a same-page overlay/filter change
  // (no page swap) — lets callers decide replace vs push. Not required for P1.
  const samePage = (from, to) =>
    !!from && !!to && from.kind === to.kind && from.id === to.id;

  window.Router = {
    parseQuery, stringifyQuery, parseRoute, parseLocation, buildHref,
    go, openOverlay, closeOverlay,
    openTicket, openComposer, openNativeSession, openIdeas, closeIdeas,
    samePage, TOP_LEVEL,
  };
})();
