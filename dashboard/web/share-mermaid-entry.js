// Isolated public-reader diagram bundle (GOL-387 fix round 1). No dashboard
// imports — mermaid only. Loaded lazily by /s/assets/reader.js solely when
// the document contains div.mermaid nodes. Semantics mirror the dashboard's
// window.runMermaid (entry.jsx): default strict security, suppressErrors,
// skip already-rendered nodes. Without JS (or without this bundle) the
// diagram source text stays visible as fallback.
import mermaid from 'mermaid';

mermaid.initialize({ startOnLoad: false });

export async function renderShareMermaids(root = document) {
  const nodes = [...root.querySelectorAll('div.mermaid')]
    .filter((n) => !n.querySelector('svg') && !n.dataset.mermaidProcessed);
  if (!nodes.length) return 0;
  try {
    await mermaid.run({ nodes, suppressErrors: true });
  } catch {
    /* suppressErrors covers per-diagram failure; mark below */
  }
  let rendered = 0;
  for (const n of nodes) {
    n.dataset.mermaidProcessed = '1';
    if (n.querySelector('svg')) rendered += 1;
    else n.classList.add('mermaid-error');
  }
  return rendered;
}

await renderShareMermaids();
