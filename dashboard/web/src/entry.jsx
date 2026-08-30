// Production entrypoint. The dashboard's existing global component contract is
// retained while Vite resolves, transforms, and locks every runtime dependency.
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as dnd from '@dnd-kit/core';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

window.React = React;
window.ReactDOM = ReactDOM;
window.ReactDOMClient = ReactDOMClient;
// Vite replaces this identifier from the root package.json at build/dev time.
// Publishing it once keeps display code decoupled from package-file paths.
window.__GOLEM_VERSION__ = __GOLEM_PACKAGE_VERSION__;
window.__reactReady = true;
window.__dndkit = dnd;
window.__dndkitReady = true;
window.marked = marked;
window.DOMPurify = DOMPurify;
window.__markdownReady = true;

let mermaid;
window.runMermaid = async (nodes) => {
  if (!nodes?.length) return;
  const unrendered = [...nodes].filter((n) => !n.querySelector('svg') && !n.dataset.mermaidProcessed);
  if (!unrendered.length) return;
  try {
    if (!mermaid) {
      mermaid = (await import('mermaid')).default;
      mermaid.initialize({ startOnLoad: false });
    }
    await mermaid.run({ nodes: unrendered, suppressErrors: true });
    unrendered.forEach((n) => { n.dataset.mermaidProcessed = '1'; });
  } catch (error) {
    console.error('mermaid lazy-load/render failed', error);
  }
};

// These files intentionally publish globals. Sequential imports preserve the
// former script ordering while moving transformation from browsers to Vite.
await import('./api.js');
await import('./store.js');
await import('./format.js');
await import('./model-providers.js');
await import('./router.js');
await import('./icons.jsx');
await import('./atoms.jsx');
await import('./shell.jsx');
await import('./dashboard.jsx');
await import('./project-view.jsx');
// GOL-13: tracker-board.jsx, specs-board.jsx, drawer-ceo.jsx pruned —
// standalone boards and floating CEO chat removed, ideas drawer now
// project-scoped.
await import('./ct-draft.js');
await import('./field-controls.jsx');
await import('./create-ticket-drawer.jsx');
await import('./td-annotate.jsx');
await import('./ticket-drawer.jsx');
await import('./other-pages.jsx');
await import('./communication-drawer.jsx');
await import('./settings-page.jsx');
await import('./substrate-view.jsx');
await import('./tweaks.jsx');
await import('./native-session-drawer.jsx');
await import('./ideas-drawer.jsx');
await import('./directive-modal.jsx');
await import('./peek-modal.jsx');
await import('./worker-spawn-modal.jsx');
await import('./diagnostic-card.jsx');
await import('./onboarding.jsx');
await import('./app.jsx');
