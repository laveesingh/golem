// TdAnnotate — html-report-style annotation layer for tracker ticket bodies.
// Renders the ticket body as HTML and mounts a Google-Docs-style comment rail.

const TA_AUTHORS = {
  you:               { label: 'Lavee',       color: '#f5a623' },
  human:             { label: 'Lavee',       color: '#f5a623' },
  'human:dashboard': { label: 'Lavee',       color: '#f5a623' },
  claude_opus:       { label: 'Claude Opus', color: '#b394ff' },
  gemini35:          { label: 'Gemini 3.5',  color: '#5b8cff' },
  kimi_k27:          { label: 'Kimi K2.7',   color: '#ff6f9c' },
  minimax_m3:        { label: 'MiniMax M3',  color: '#2dd4a7' },
};

function authorMeta(a, labelHint) {
  if (TA_AUTHORS[a]) return TA_AUTHORS[a];
  if (a === 'human' || a === 'you' || a === 'human:dashboard') {
    return { label: 'Lavee', color: '#f5a623' };
  }
  if (labelHint) {
    return { label: labelHint, color: '#9aa4bb' };
  }
  const session = window.Store?.getNativeSessionById?.(a);
  if (session?.label || session?.name) {
    return { label: session.label || session.name, color: '#9aa4bb' };
  }
  if (typeof a === 'string' && a.length > 12 && /^[0-9a-fA-F-]+$/.test(a)) {
    return { label: `session ${a.slice(0, 8)}`, color: '#9aa4bb' };
  }
  return { label: a || 'Agent', color: '#9aa4bb' };
}

// Fullscreen Mermaid. After window.runMermaid renders SVGs into .mermaid
// blocks, attach an expand button to each. The overlay is vanilla DOM because
// Mermaid's generated SVG is not React-managed.
const MERMAID_FS_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 6V3.5A.5.5 0 0 1 3.5 3H6M13 6V3.5a.5.5 0 0 0-.5-.5H10M3 10v2.5a.5.5 0 0 0 .5.5H6M13 10v2.5a.5.5 0 0 1-.5.5H10"/></svg>';

const MERMAID_ZOOM_MIN = 10;
const MERMAID_ZOOM_MAX = 400;
const MERMAID_ZOOM_STEP = 1.25;
const MERMAID_VIEWPORT_PADDING = 72;
let mermaidFullscreenSequence = 0;

function pixelValue(value) {
  const text = String(value || '').trim();
  if (!text || text.includes('%')) return 0;
  const number = Number.parseFloat(text);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function clampMermaidZoom(value) {
  return Math.max(MERMAID_ZOOM_MIN, Math.min(MERMAID_ZOOM_MAX, Math.round(value)));
}

// Mermaid scopes its generated CSS to the root SVG id (for example,
// #mermaid-123 .node rect). A straight clone with the root id removed loses
// those styles, while retaining the id makes a duplicate-id document. Give the
// clone a private id namespace and rewrite its SVG-internal references so it
// remains visually identical without leaking ids into the page.
function cloneMermaidSvg(svg) {
  const clone = svg.cloneNode(true);
  const prefix = `mermaid-fs-${++mermaidFullscreenSequence}`;
  const ids = new Map();
  const rootId = clone.getAttribute('id');
  if (rootId) {
    const nextId = `${prefix}-root`;
    ids.set(rootId, nextId);
    clone.setAttribute('id', nextId);
  } else {
    clone.setAttribute('id', `${prefix}-root`);
  }
  clone.querySelectorAll('[id]').forEach((element) => {
    const previousId = element.getAttribute('id');
    if (!previousId) return;
    const nextId = `${prefix}-${previousId}`;
    ids.set(previousId, nextId);
    element.setAttribute('id', nextId);
  });
  const rewriteReferences = (value) => {
    let result = String(value || '');
    ids.forEach((nextId, previousId) => {
      result = result.split(`#${previousId}`).join(`#${nextId}`);
    });
    return result;
  };
  const rewriteElement = (element) => {
    ['href', 'xlink:href', 'fill', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end', 'style']
      .forEach((attribute) => {
        const value = element.getAttribute(attribute);
        if (value) element.setAttribute(attribute, rewriteReferences(value));
      });
  };
  rewriteElement(clone);
  clone.querySelectorAll('*').forEach(rewriteElement);
  clone.querySelectorAll('style').forEach((style) => {
    style.textContent = rewriteReferences(style.textContent);
  });
  return clone;
}

function attachMermaidFullscreen(root) {
  if (!root) return;
  root.querySelectorAll('.mermaid').forEach((block) => {
    if (block.dataset.fsAttached) return;
    if (!block.querySelector('svg')) return; // mermaid hasn't rendered this one yet
    block.dataset.fsAttached = '1';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mermaid-fs-btn';
    btn.title = 'View diagram fullscreen';
    btn.setAttribute('aria-label', 'View diagram fullscreen');
    btn.innerHTML = MERMAID_FS_ICON;
    btn.addEventListener('click', (e) => { e.stopPropagation(); openMermaidFullscreen(block); });
    block.appendChild(btn);
  });
}

function openMermaidFullscreen(block) {
  const svg = block.querySelector('svg');
  if (!svg || document.querySelector('.mermaid-fs-overlay')) return;

  const previouslyFocused = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'mermaid-fs-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Fullscreen diagram');
  overlay.innerHTML =
    '<button class="mermaid-fs-close" type="button" aria-label="Close fullscreen diagram">&#215;</button>' +
    '<div class="mermaid-fs-toolbar" role="toolbar" aria-label="Diagram controls">' +
      '<button class="mermaid-fs-zoom-out" type="button" aria-label="Zoom out" title="Zoom out">&#8722;</button>' +
      '<output class="mermaid-fs-zoom-level" aria-live="polite">100%</output>' +
      '<button class="mermaid-fs-zoom-in" type="button" aria-label="Zoom in" title="Zoom in">+</button>' +
      '<button class="mermaid-fs-fit" type="button" title="Fit diagram to the viewport">Fit</button>' +
      '<button class="mermaid-fs-reset" type="button" title="View diagram at 100%">100%</button>' +
    '</div>' +
    '<div class="mermaid-fs-stage" tabindex="0" aria-label="Diagram viewport. Scroll, drag, or use the zoom controls to explore the diagram.">' +
      '<div class="mermaid-fs-canvas"></div>' +
    '</div>';
  const stage = overlay.querySelector('.mermaid-fs-stage');
  const canvas = overlay.querySelector('.mermaid-fs-canvas');
  const level = overlay.querySelector('.mermaid-fs-zoom-level');
  const clone = cloneMermaidSvg(svg);
  clone.removeAttribute('width');
  clone.removeAttribute('height');
  clone.style.maxWidth = 'none';
  const viewBox = svg.viewBox && svg.viewBox.baseVal;
  const baseWidth = pixelValue(svg.style.maxWidth)
    || (viewBox && viewBox.width)
    || pixelValue(svg.getAttribute('width'))
    || svg.getBoundingClientRect().width
    || 1;
  const baseHeight = viewBox && viewBox.height && viewBox.width
    ? baseWidth * (viewBox.height / viewBox.width)
    : pixelValue(svg.getAttribute('height')) || svg.getBoundingClientRect().height || 1;
  clone.style.height = 'auto';
  canvas.appendChild(clone);
  document.body.appendChild(overlay);

  let zoom = 100;
  let layout = null;
  let pan = null;
  let closed = false;

  const viewportLayout = (nextZoom) => {
    const scale = nextZoom / 100;
    const width = Math.max(1, Math.round(baseWidth * scale));
    const height = Math.max(1, Math.round(baseHeight * scale));
    const canvasWidth = Math.max(stage.clientWidth, width + MERMAID_VIEWPORT_PADDING * 2);
    const canvasHeight = Math.max(stage.clientHeight, height + MERMAID_VIEWPORT_PADDING * 2);
    return {
      scale,
      width,
      height,
      canvasWidth,
      canvasHeight,
      diagramLeft: (canvasWidth - width) / 2,
      diagramTop: (canvasHeight - height) / 2,
    };
  };
  const renderViewport = (nextZoom) => {
    zoom = clampMermaidZoom(nextZoom);
    layout = viewportLayout(zoom);
    clone.style.width = `${layout.width}px`;
    canvas.style.width = `${layout.canvasWidth}px`;
    canvas.style.height = `${layout.canvasHeight}px`;
    level.textContent = `${zoom}%`;
  };
  const setZoom = (nextZoom, anchor) => {
    const before = layout || viewportLayout(zoom);
    const rect = stage.getBoundingClientRect();
    const localX = anchor ? anchor.clientX - rect.left : stage.clientWidth / 2;
    const localY = anchor ? anchor.clientY - rect.top : stage.clientHeight / 2;
    const diagramX = (stage.scrollLeft + localX - before.diagramLeft) / before.scale;
    const diagramY = (stage.scrollTop + localY - before.diagramTop) / before.scale;
    renderViewport(nextZoom);
    stage.scrollLeft = Math.max(0, diagramX * layout.scale + layout.diagramLeft - localX);
    stage.scrollTop = Math.max(0, diagramY * layout.scale + layout.diagramTop - localY);
  };
  const fitDiagram = () => {
    const usableWidth = Math.max(1, stage.clientWidth - MERMAID_VIEWPORT_PADDING * 2);
    const usableHeight = Math.max(1, stage.clientHeight - MERMAID_VIEWPORT_PADDING * 2);
    setZoom(Math.min(100, (Math.min(usableWidth / baseWidth, usableHeight / baseHeight)) * 100));
  };

  // Start with the whole diagram visible, then let readers zoom to native size
  // and pan or scroll through the enlarged canvas.
  renderViewport(100);
  fitDiagram();

  const close = () => {
    if (closed) return;
    closed = true;
    overlay.classList.remove('open');
    document.removeEventListener('keydown', onKey, true);
    window.setTimeout(() => {
      overlay.remove();
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
    }, 220);
  };
  // Esc closes ONLY the overlay — not the ticket drawer. The drawer registers
  // its own Esc handler on window (bubble) that would otherwise unmount the
  // whole ticket subtree (and the mermaid block with it). Listening on
  // document in the CAPTURE phase fires before any window-bubble handler, and
  // stopImmediatePropagation kills the event so the drawer's (and the
  // annotation-rail's) Esc listeners never see it. (Registering on window
  // instead would lose the ordering — the drawer's listener is added first.)
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      close();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setZoom(zoom * MERMAID_ZOOM_STEP);
    } else if (e.key === '-') {
      e.preventDefault();
      setZoom(zoom / MERMAID_ZOOM_STEP);
    } else if (e.key === '0') {
      e.preventDefault();
      fitDiagram();
    }
  };
  const stopPanning = (event) => {
    if (!pan || (event && event.pointerId !== pan.pointerId)) return;
    if (stage.hasPointerCapture(pan.pointerId)) stage.releasePointerCapture(pan.pointerId);
    pan = null;
    stage.classList.remove('is-panning');
  };
  stage.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setZoom(zoom * (event.deltaY < 0 ? MERMAID_ZOOM_STEP : 1 / MERMAID_ZOOM_STEP), event);
  }, { passive: false });
  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    pan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('is-panning');
  });
  stage.addEventListener('pointermove', (event) => {
    if (!pan || event.pointerId !== pan.pointerId) return;
    stage.scrollLeft = pan.left - (event.clientX - pan.x);
    stage.scrollTop = pan.top - (event.clientY - pan.y);
  });
  stage.addEventListener('pointerup', stopPanning);
  stage.addEventListener('pointercancel', stopPanning);
  stage.addEventListener('dragstart', (event) => event.preventDefault());
  overlay.querySelector('.mermaid-fs-zoom-out').addEventListener('click', () => setZoom(zoom / MERMAID_ZOOM_STEP));
  overlay.querySelector('.mermaid-fs-zoom-in').addEventListener('click', () => setZoom(zoom * MERMAID_ZOOM_STEP));
  overlay.querySelector('.mermaid-fs-fit').addEventListener('click', fitDiagram);
  overlay.querySelector('.mermaid-fs-reset').addEventListener('click', () => setZoom(100));
  overlay.querySelector('.mermaid-fs-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => overlay.classList.add('open'));
  overlay.querySelector('.mermaid-fs-close').focus();
}

// Test hooks for smoke-tkt-0234.mjs (fullscreen-mermaid Esc regression). The
// smoke injects a .mermaid block with a fake SVG and drives the real
// attach/open/Esc path without needing the mermaid network or a fixture ticket.
// Harmless DOM helpers, not user-facing.
if (typeof window !== 'undefined') {
  window.__tdAttachMermaidFullscreen = attachMermaidFullscreen;
  window.__tdOpenMermaidFullscreen = openMermaidFullscreen;
}

function bodyHtml(text) {
  if (window.SubstrateFmt?.htmlBody) return window.SubstrateFmt.htmlBody(text);
  if (!text) return '';
  if (/^\s*<[a-zA-Z][^>]*>/.test(text)) return text;
  return text.split(/\n\n+/).map((p) => `<p>${p.trim().replace(/\n/g, '<br/>')}</p>`).join('');
}

function countWords(text) {
  const value = String(text ?? '').trim();
  return value ? value.split(/\s+/).length : 0;
}

// Keep Markdown-rendered structure intact while clipping a comment at a word
// boundary. The full HTML is still used when the divider is expanded; this
// temporary DOM only supplies the collapsed preview.
function clampHtmlToWords(html, limit = 300) {
  if (!html || typeof document === 'undefined') return html || '';
  const root = document.createElement('div');
  root.innerHTML = html;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = limit;
  let boundary = null;
  let node;
  while ((node = walker.nextNode())) {
    const words = node.nodeValue.match(/\S+/g) || [];
    if (words.length <= remaining) {
      remaining -= words.length;
      continue;
    }
    const matcher = /\S+/g;
    let match;
    let end = 0;
    for (let index = 0; index < remaining && (match = matcher.exec(node.nodeValue)); index += 1) {
      end = match.index + match[0].length;
    }
    node.nodeValue = node.nodeValue.slice(0, end);
    boundary = node;
    break;
  }
  if (!boundary) return root.innerHTML;

  // Remove every sibling after the boundary, walking back through its
  // ancestors. This preserves the tags that wrap the visible 300 words.
  let current = boundary;
  while (current && current !== root) {
    while (current.nextSibling) current.nextSibling.remove();
    current = current.parentNode;
  }
  return root.innerHTML;
}

// TKT-0172: comment bodies are now stored verbatim as Markdown, so editing is
// trivial — the stored body is already editable text. No HTML→text inverse is
// needed; this is kept as a thin passthrough for the existing call site.
function htmlToEditableText(text) { return text == null ? '' : String(text); }

function hexA(hex, a) {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function uid() { return 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36); }
function nowISO() { return new Date().toISOString(); }
function shortTime(iso) { try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }

function applyAuthorVars(node, author) {
  const c = authorMeta(author).color;
  node.style.setProperty('--_ac', c);
  node.style.setProperty('--_ac-soft', hexA(c, 0.12));
  node.style.setProperty('--_ac-mid', hexA(c, 0.28));
  node.style.setProperty('--_ac-bd', hexA(c, 0.5));
}

// ---- text index + anchoring ---------------------------------------------
function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
      const p = n.parentNode;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.nodeName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      if (p.closest && p.closest('#anno-rail,#anno-fab')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let pos = 0, n;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    nodes.push({ node: n, start: pos, end: pos + len });
    pos += len;
  }
  return { nodes, text: nodes.map((x) => x.node.nodeValue).join('') };
}
function rangeFromOffsets(idx, start, end) {
  const r = document.createRange(); let placedStart = false;
  for (const seg of idx.nodes) {
    if (!placedStart && start >= seg.start && start <= seg.end) { r.setStart(seg.node, start - seg.start); placedStart = true; }
    if (end >= seg.start && end <= seg.end) { r.setEnd(seg.node, end - seg.start); break; }
  }
  return placedStart ? r : null;
}
function offsetsFromRange(idx, range) {
  let start = -1, end = -1;
  for (const seg of idx.nodes) {
    if (seg.node === range.startContainer) start = seg.start + range.startOffset;
    if (seg.node === range.endContainer) end = seg.start + range.endOffset;
  }
  if (start < 0 || end < 0 || end <= start) return null;
  return { start, end };
}
function commonPrefix(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }
function commonSuffix(a, b) { let i = 0; while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; }
function locate(text, ann) {
  const { quote, prefix, suffix } = ann;
  if (!quote) return null;
  const pre = prefix || '', suf = suffix || '';
  const sig = pre + quote + suf;
  let i = text.indexOf(sig);
  if (i >= 0) return { start: i + pre.length, end: i + pre.length + quote.length };
  const hits = []; let from = 0, k;
  while ((k = text.indexOf(quote, from)) >= 0) { hits.push(k); from = k + 1; if (hits.length > 200) break; }
  if (!hits.length) return null;
  if (hits.length === 1) return { start: hits[0], end: hits[0] + quote.length };
  let best = hits[0], bestScore = -1;
  for (const h of hits) {
    const hpre = text.slice(Math.max(0, h - pre.length), h);
    const hsuf = text.slice(h + quote.length, h + quote.length + suf.length);
    const score = commonSuffix(hpre, pre) + commonPrefix(hsuf, suf);
    if (score > bestScore) { bestScore = score; best = h; }
  }
  return { start: best, end: best + quote.length };
}
function wrapOffsets(root, start, end, ann) {
  const idx = textNodes(root);
  const targets = [];
  for (const seg of idx.nodes) {
    if (seg.end <= start || seg.start >= end) continue;
    targets.push({ node: seg.node, ls: Math.max(0, start - seg.start), le: Math.min(seg.node.nodeValue.length, end - seg.start) });
  }
  for (let t = targets.length - 1; t >= 0; t--) {
    let node = targets[t].node;
    const { ls, le } = targets[t];
    if (le < node.nodeValue.length) node.splitText(le);
    if (ls > 0) node = node.splitText(ls);
    const mk = document.createElement('mark');
    mk.className = 'anno';
    mk.dataset.id = ann.id;
    mk.dataset.author = ann.author;
    mk.title = authorMeta(ann.author, ann.author_label).label;
    if (ann.status === 'resolved') mk.classList.add('resolved');
    applyAuthorVars(mk, ann.author);
    if (t === targets.length - 1) mk.classList.add('anno-tail');
    node.parentNode.insertBefore(mk, node);
    mk.appendChild(node);
  }
  return targets.length > 0;
}
function findBlockById(root, blockId) {
  if (!root || !blockId) return null;
  const wanted = String(blockId);
  for (const block of root.querySelectorAll('[data-block-id]')) {
    if (block.dataset.blockId === wanted) return block;
  }
  return null;
}
function annotationAnchorKind(ann) {
  const explicit = String(ann?.anchor_kind || '').toLowerCase();
  if (explicit === 'block' || explicit === 'text') return explicit;
  if (!ann?.block_id) return 'text';
  // Comments written before anchor_kind was persisted can still be read. The
  // first block-hover implementation wrote an empty prefix/suffix; selected
  // text normally carried surrounding context. Keep that distinction while
  // old rows are upgraded lazily by the server.
  return ann.prefix || ann.suffix ? 'text' : 'block';
}
function isBlockAnnotation(ann) { return annotationAnchorKind(ann) === 'block'; }
function blockAnnotationIds(block) {
  return String(block?.dataset.annoBlockIds || '').split(/\s+/).filter(Boolean);
}
function setBlockAnnotationState(block, anns) {
  const ids = anns.map((ann) => ann.id).filter(Boolean);
  const allResolved = anns.length > 0 && anns.every((ann) => ann.status === 'resolved');
  block.classList.add('anno-block-comment');
  block.classList.toggle('anno-block-multi', ids.length > 1);
  block.classList.toggle('anno-block-resolved', allResolved);
  block.dataset.annoBlockIds = ids.join(' ');
  block.dataset.annoCommentCount = String(ids.length);
  block.dataset.annoOpenCount = String(anns.filter((ann) => ann.status !== 'resolved').length);
}
function clearBlockAnnotationState(root) {
  root.querySelectorAll('[data-anno-block-ids]').forEach((block) => {
    block.classList.remove('anno-block-comment', 'anno-block-multi', 'anno-block-resolved', 'is-active');
    block.removeAttribute('data-anno-block-ids');
    block.removeAttribute('data-anno-comment-count');
    block.removeAttribute('data-anno-open-count');
  });
}
function setActiveAnnotationState(root, id) {
  const wanted = id ? String(id) : '';
  root.querySelectorAll('mark.anno').forEach((mark) => {
    mark.classList.toggle('is-active', !!wanted && mark.dataset.id === wanted);
  });
  root.querySelectorAll('[data-anno-block-ids]').forEach((block) => {
    block.classList.toggle('is-active', !!wanted && blockAnnotationIds(block).includes(wanted));
  });
}
function findAnnotationAnchor(root, id) {
  const wanted = String(id || '');
  if (!wanted) return null;
  const mark = [...root.querySelectorAll('mark.anno')].find((candidate) => candidate.dataset.id === wanted);
  if (mark) return mark;
  return [...root.querySelectorAll('[data-anno-block-ids]')]
    .find((block) => blockAnnotationIds(block).includes(wanted)) || null;
}
function clearMarks(root, id) {
  root.querySelectorAll(`mark.anno[data-id="${id}"]`).forEach((mk) => {
    const parent = mk.parentNode;
    while (mk.firstChild) parent.insertBefore(mk.firstChild, mk);
    parent.removeChild(mk);
    parent.normalize();
  });
}
// TKT-0172: slugify a heading's text into a stable section id. Must match the
// slug assignBlockIds uses so block_id = "<slug>#<idx>" round-trips through
// locateAnnotation (resolve).
function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function tocText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function tocComparable(s) {
  return tocText(s).toLowerCase().replace(/^(spec|task|doc)\s*:\s*/, '').replace(/[^\da-z]+/g, '');
}
function sameDocumentHeading(headingText, documentTitle) {
  const heading = tocComparable(headingText);
  const title = tocComparable(documentTitle);
  return !!heading && !!title && heading === title;
}
function assignTocHeadingIds(root, documentTitle = '') {
  const headings = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  const used = new Set();
  const doc = root.ownerDocument || document;
  const items = headings.map((heading, index) => {
    const text = tocText(heading.textContent);
    const base = heading.id || slugify(text) || `section-${index + 1}`;
    let id = base;
    let suffix = 2;
    while (used.has(id) || (doc.getElementById(id) && doc.getElementById(id) !== heading)) id = `${base}-${suffix++}`;
    heading.id = id;
    used.add(id);
    return { id, level: Number(heading.tagName.slice(1)) || 6, text };
  });
  if (items.length > 1 && items[0].level === 1 && sameDocumentHeading(items[0].text, documentTitle)) items.shift();
  return items;
}
function tocTree(items) {
  const roots = [];
  const stack = [];
  for (const item of items) {
    const node = { ...item, children: [] };
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}
function scrollParentFor(root) {
  let el = root?.parentElement || null;
  let overflowParent = null;
  while (el && el !== document.body) {
    const style = getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(style.overflowY)) {
      overflowParent ||= el;
      if (el.scrollHeight > el.clientHeight + 1) return el;
    }
    el = el.parentElement;
  }
  return overflowParent || root?.ownerDocument?.scrollingElement || document.documentElement;
}
function readTocPrefs(storageKey) {
  if (!storageKey) return { hidden: false, collapsed: {} };
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '{}');
    return {
      hidden: value?.hidden === true,
      collapsed: value?.collapsed && typeof value.collapsed === 'object' ? value.collapsed : {},
    };
  } catch { return { hidden: false, collapsed: {} }; }
}
function writeTocPrefs(storageKey, prefs) {
  if (!storageKey) return;
  try { localStorage.setItem(storageKey, JSON.stringify(prefs)); } catch {}
}

function TdTocNode({ node, activeId, collapsed, onToggle, onNavigate }) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = !!collapsed[node.id];
  return (
    <li className={`td-toc-item level-${Math.min(node.level, 6)}`}>
      <div className="td-toc-row">
        {hasChildren ? (
          <button
            type="button"
            className="td-toc-toggle"
            aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${node.text}`}
            aria-expanded={!isCollapsed}
            onClick={() => onToggle(node.id)}
          >{isCollapsed ? '›' : '⌄'}</button>
        ) : <span className="td-toc-toggle-spacer" aria-hidden="true"/>}
        <a
          className={`td-toc-link${activeId === node.id ? ' active' : ''}`}
          href={`#${node.id}`}
          aria-current={activeId === node.id ? 'location' : undefined}
          onClick={(event) => onNavigate(event, node.id)}
        >{node.text}</a>
      </div>
      {hasChildren && !isCollapsed && (
        <ul className="td-toc-sublist">
          {node.children.map((child) => (
            <TdTocNode
              key={child.id}
              node={child}
              activeId={activeId}
              collapsed={collapsed}
              onToggle={onToggle}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// Must agree with --td-toc-column-w in extra.css (.td-main column reserve).
const TOC_RAIL_WIDTH = 250;

function TdToc({ headings, rootRef, documentKey, containerSelector }) {
  const storageKey = documentKey ? `golem.toc.${documentKey}` : 'golem.toc.anonymous';
  const initialPrefs = React.useMemo(() => readTocPrefs(storageKey), [storageKey]);
  const [hidden, setHidden] = React.useState(initialPrefs.hidden);
  const [collapsed, setCollapsed] = React.useState(initialPrefs.collapsed);
  const [activeId, setActiveId] = React.useState(headings[0]?.id || '');
  const [metrics, setMetrics] = React.useState(null);
  const tree = React.useMemo(() => tocTree(headings), [headings]);

  React.useEffect(() => {
    setActiveId((current) => headings.some((heading) => heading.id === current) ? current : (headings[0]?.id || ''));
  }, [headings]);

  React.useEffect(() => {
    const root = rootRef.current;
    const host = root?.closest(containerSelector) || document.querySelector(containerSelector);
    const scrollRoot = scrollParentFor(root);
    if (!root || !host || !scrollRoot) return undefined;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const hostRect = host.getBoundingClientRect();
        const scrollRect = scrollRoot.getBoundingClientRect();
        const main = root.closest('.td-main');
        const railRect = (main || host).getBoundingClientRect();
        const nextLeft = Math.max(0, Math.round(railRect.left - hostRect.left));
        const nextTop = Math.max(0, Math.round(scrollRect.top - hostRect.top));
        const nextMaxHeight = Math.max(160, Math.round(scrollRect.bottom - scrollRect.top));
        setMetrics((prev) => {
          if (prev && Math.abs(prev.left - nextLeft) <= 1 && Math.abs(prev.top - nextTop) <= 1 && Math.abs(prev.maxHeight - nextMaxHeight) <= 1) {
            return prev;
          }
          return { left: nextLeft, top: nextTop, maxHeight: nextMaxHeight };
        });
      });
    };
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(host);
    window.addEventListener('resize', update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [containerSelector, rootRef]);

  React.useEffect(() => {
    const main = rootRef.current?.closest('.td-main');
    if (!main) return undefined;
    main.classList.toggle('td-toc-rail-open', !hidden);
    return () => {
      main.classList.remove('td-toc-rail-open');
    };
  }, [hidden, rootRef]);

  React.useEffect(() => {
    const root = rootRef.current;
    const scrollRoot = scrollParentFor(root);
    if (!root || !scrollRoot) return undefined;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const scrollRect = scrollRoot.getBoundingClientRect();
        const line = scrollRect.top + Math.min(160, scrollRect.height * 0.2);
        let first = null;
        let best = null;
        for (const heading of headings) {
          const element = root.querySelector(`#${CSS.escape(heading.id)}`);
          if (!element) continue;
          const top = element.getBoundingClientRect().top;
          if (!first || top < first.top) first = { id: heading.id, top };
          if (top <= line + 1 && (!best || top > best.top)) best = { id: heading.id, top };
        }
        const nextId = (best || first)?.id || headings[0]?.id || '';
        setActiveId((prev) => (prev === nextId ? prev : nextId));
      });
    };
    update();
    scrollRoot.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scrollRoot.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [headings, rootRef]);

  const persist = (nextHidden, nextCollapsed) => writeTocPrefs(storageKey, { hidden: nextHidden, collapsed: nextCollapsed });
  const toggleHidden = () => {
    setHidden((current) => {
      const next = !current;
      persist(next, collapsed);
      return next;
    });
  };
  const toggleCollapsed = (id) => {
    setCollapsed((current) => {
      const next = { ...current, [id]: !current[id] };
      persist(hidden, next);
      return next;
    });
  };
  const navigate = (event, id) => {
    event.preventDefault();
    const root = rootRef.current;
    const heading = root?.querySelector(`#${CSS.escape(id)}`);
    if (heading) {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveId(id);
    }
  };
  if (!metrics) return null;
  const panelStyle = {
    left: `${metrics.left}px`,
    top: `${metrics.top}px`,
    width: `${TOC_RAIL_WIDTH}px`,
    maxHeight: `${metrics.maxHeight}px`,
  };
  const handleStyle = {
    left: `${metrics.left + (hidden ? 0 : TOC_RAIL_WIDTH)}px`,
    top: `${metrics.top + Math.max(48, Math.min(metrics.maxHeight / 2, 220))}px`,
  };
  return (
    <div className="td-toc-layer" aria-live="polite">
      {!hidden && (
        <nav className="td-toc-panel is-rail" style={panelStyle} aria-label="Contents">
          <div className="td-toc-head">
            <span>Contents</span>
          </div>
          <ul className="td-toc-list">
            {tree.map((node) => (
              <TdTocNode key={node.id} node={node} activeId={activeId} collapsed={collapsed} onToggle={toggleCollapsed} onNavigate={navigate}/>
            ))}
          </ul>
        </nav>
      )}
      <button
        type="button"
        className={`td-toc-handle${hidden ? ' is-collapsed' : ''}`}
        style={handleStyle}
        onClick={toggleHidden}
        aria-label={hidden ? 'Show contents' : 'Hide contents'}
        title={hidden ? 'Show contents' : 'Hide contents'}
      >{hidden ? '›' : '‹'}</button>
    </div>
  );
}

const NESTED_BLOCK_KINDS = Object.freeze({ UL: 'list', OL: 'list', LI: 'item', TABLE: 'table', TR: 'row' });
function nestedBlockKind(element) { return NESTED_BLOCK_KINDS[element?.tagName] || ''; }
function blockKind(element) { return nestedBlockKind(element) || String(element?.tagName || '').toLowerCase(); }

// Walk the rendered body and assign stable-enough semantic anchors. Existing
// top-level ids stay unchanged: "<nearest-heading-slug>#<index>". Structural
// descendants add a path, for example "section#1/list#0/item#2". The path is
// intentionally derived from the rendered tree, so a parent list/table owns
// the spaces that are not inside one of its child items/rows.
function assignBlockIds(root) {
  let slug = '';
  let idx = 0;
  root.querySelectorAll('[data-block-id]').forEach((block) => {
    block.removeAttribute('data-block-id');
    block.removeAttribute('data-block-parent-id');
    block.removeAttribute('data-block-kind');
  });

  const counters = new Map();
  function assignNested(node, parentId) {
    for (const child of node.children) {
      const kind = nestedBlockKind(child);
      let childParentId = parentId;
      if (kind) {
        const key = `${parentId}:${kind}`;
        const childIndex = counters.get(key) || 0;
        counters.set(key, childIndex + 1);
        child.dataset.blockId = `${parentId}/${kind}#${childIndex}`;
        child.dataset.blockParentId = parentId;
        child.dataset.blockKind = kind;
        childParentId = child.dataset.blockId;
      }
      assignNested(child, childParentId);
    }
  }

  for (const child of root.children) {
    const isHeading = /^H[1-6]$/.test(child.tagName);
    if (isHeading) { slug = slugify(child.textContent); idx = 0; }
    child.dataset.blockId = `${slug}#${idx}`;
    child.dataset.blockKind = blockKind(child);
    child.removeAttribute('data-block-parent-id');
    assignNested(child, child.dataset.blockId);
    idx = isHeading ? 1 : idx + 1;
  }
}

function topLevelBlock(root, block) {
  let el = block;
  while (el && el.parentElement && el.parentElement !== root) el = el.parentElement;
  return el && el.parentElement === root ? el : null;
}

function blockAtPoint(root, x, y) {
  const doc = root?.ownerDocument || document;
  const hits = doc.elementsFromPoint ? doc.elementsFromPoint(x, y) : [doc.elementFromPoint(x, y)];
  for (const hit of hits) {
    if (!hit || !root.contains(hit)) continue;
    const block = hit.closest ? hit.closest('[data-block-id]') : null;
    if (block && root.contains(block)) return block;
  }
  return null;
}

// Find the nearest preceding heading element (h1-h6) by walking the previous
// top-level siblings of `block`. Markdown renders headings as top-level
// blocks (children of root), so the containing block is a child of root and
// its previousElementSibling chain walks back through the section's earlier
// blocks to the heading that opens it.
function nearestPrecedingHeading(block, root = null) {
  if (root) block = topLevelBlock(root, block) || block;
  // GOL-287: a heading block opens its own section. Commenting on the heading
  // itself must anchor to THAT section — walking further back would attach the
  // previous sibling section (top level) or the parent heading (nested), which
  // is exactly the mis-attribution this function used to produce.
  if (/^H[1-6]$/.test(block?.tagName || '')) return block;
  let el = block;
  while (el) {
    const sib = el.previousElementSibling;
    if (sib) {
      if (/^H[1-6]$/.test(sib.tagName)) return sib;
      el = sib;
    } else {
      return null;
    }
  }
  return null;
}

// First ~120 chars of a block's rendered text — the quote fallback for
// block-hover comments so they can re-locate via locate() if block_id ever
// fails to match (e.g. the block was deleted/rewritten between sessions).
function blockText(block) {
  const t = (block && block.textContent || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 120);
}

// Resolve an annotation to a {start,end} text range within root's index.
// Whole-block anchors span their recomputed block. Text anchors always use the
// quote/context locator, even when block_id is present as relocation context.
function locateAnnotation(root, idx, ann) {
  if (isBlockAnnotation(ann) && ann.block_id) {
    const block = findBlockById(root, ann.block_id);
    if (block) {
      let start = Infinity, end = -Infinity;
      for (const seg of idx.nodes) {
        if (block.contains(seg.node)) {
          if (seg.start < start) start = seg.start;
          if (seg.end > end) end = seg.end;
        }
      }
      if (start < end) return { start, end };
    }
  }
  return locate(idx.text, ann);
}

// ---- React component ----------------------------------------------------
// `containerSelector` is the CSS selector of the positioned ancestor the
// annotation rail and FAB portal into. The ticket drawer passes
// `.drawer-ticket` (position:fixed); the standalone ticket page passes
// `.ticket-page`. Defaults to `.drawer-ticket` for backward compatibility.
function TdAnnotate({ body, comments, currentAuthor = 'you', onCreate, onCreateAndDispatch, onUpdate, onReply, onReplyAndDispatch, onDispatchComment, canDispatchComments = false, undispatchedCount = 0, dispatchTargetLabel = null, onBatchDispatch, commentDispatching = false, commentDispatchNote = null, containerSelector = '.drawer-ticket', documentKey = '', documentTitle = '', bodyFormat = 'markdown', onEditBlock = null }) {
  const rootRef = React.useRef(null);
  const railRef = React.useRef(null);
  const listRef = React.useRef(null);
  const nearBottomRef = React.useRef(true);
  const [annotations, setAnnotations] = React.useState(comments || []);
  const [tocHeadings, setTocHeadings] = React.useState([]);
  const [activeId, setActiveId] = React.useState(null);
  const [showResolved, setShowResolved] = React.useState(false);
  const [railOpen, setRailOpen] = React.useState(false);
  const [saveState, setSaveState] = React.useState('');
  const [pendingComposer, setPendingComposer] = React.useState(null);
  // Option/Alt+click-to-comment: track the modifier so the cursor can signal
  // "click adds a comment" only while it is held, and the click handler can
  // open a composer for the block under the cursor. (Ctrl+click is the system
  // right-click on macOS, so it is deliberately not used.)
  const [altComment, setAltComment] = React.useState(false);
  React.useEffect(() => {
    const down = (e) => { if (e.altKey) setAltComment(true); };
    const up = (e) => { if (!e.altKey) setAltComment(false); };
    const blur = () => setAltComment(false);
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('keydown', down);
      document.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // GOL-311 D1/D3: click-to-summon state. rootMouseDownRef captures where the
  // current press started so a click that moved more than
  // CLICK_DRAG_THRESHOLD_PX is a drag/select gesture, not a click.
  const CLICK_DRAG_THRESHOLD_PX = 6;
  const rootMouseDownRef = React.useRef(null);
  // GOL-311 D2: unique focus token per composer open. AnnoComposer refocuses
  // when focusToken changes; the old constant 'anchor' only ever fired once,
  // so repeat opens while the drawer was already open never re-focused.
  const composerFocusSeq = React.useRef(0);
  const [composerFocusToken, setComposerFocusToken] = React.useState(null);

  // GOL-311 single-step (D1/D3/D4): one click path for plain and option+click.
  // A click on the block under the cursor (hover has already preview-
  // highlighted it) opens the rail anchored to that block, focused and ready
  // to type — no comment button anywhere. Diagram bodies anchor too: .mermaid
  // is NOT suppressed (D4), and the fullscreen overlay is body-appended
  // outside this root so its pan/zoom clicks never reach onRootClick; the
  // only inline control is .mermaid-fs-btn, covered as a button. The suppress
  // set is load-bearing because every misclick is now a focus steal: drags
  // (mousedown→click distance), non-collapsed selections (selection always
  // wins), the image lightbox, native/interactive targets (links, buttons,
  // form fields, <summary> toggles, comment-anchor <mark class="anno">), and
  // rail/sidebar-internal clicks. <details> is deliberately NOT suppressed —
  // a details is one block whose body is not nested, so suppressing it would
  // kill decision-body comments (A9). onMarkClick's stopPropagation cannot
  // cancel this same-root React onClick, which is why mark.anno is in the set.
  const onRootMouseDown = (e) => {
    rootMouseDownRef.current = { x: e.clientX, y: e.clientY };
  };
  const onRootClick = (e) => {
    const target = e.target;
    if (target && target.tagName === 'IMG' && target.src) {
      e.stopPropagation();
      openImageLightbox(target.src, target.alt || 'Document image');
      return;
    }
    const down = rootMouseDownRef.current;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_DRAG_THRESHOLD_PX) return;
    const sel = window.getSelection ? window.getSelection() : null;
    if (sel && !sel.isCollapsed) return;
    if (target.closest('a, button, input, textarea, select, summary, mark.anno, .mermaid-fs-btn')) return;
    // Rail/sidebar-internal clicks never open or re-anchor (belt-and-braces:
    // the rail is portaled outside this root, so its clicks cannot reach the
    // React onClick anyway).
    if (target.closest('#anno-rail')) return;
    const block = target.closest('[data-block-id]');
    if (!block) return;
    const t = blockText(block);
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    const h = nearestPrecedingHeading(block, rootRef.current);
    setRailOpen(true);
    // First open and re-anchor both clear any pending reply — the attachment
    // prefers pendingReply, so the reply chip would otherwise survive.
    setPendingReply(null);
    setPendingComposer({
      quote: t,
      prefix: '',
      suffix: '',
      section: { id: (block.dataset.blockId || '').split('#')[0], title: h ? h.textContent.trim().slice(0, 80) : '' },
      blockId: block.dataset.blockId || '',
      blockText: t,
      anchorKind: 'block',
    });
    setComposerFocusToken(`anchor:${block.dataset.blockId || 'block'}:${++composerFocusSeq.current}`);
  };
  // TKT-0192 / GOL-311: hoverBlockElRef is the block element currently
  // carrying the .block-hover preview highlight. The class is styled in
  // extra.css (`.td-md [data-block-id].block-hover`) with an accent-color
  // outline at 50% opacity and 3px offset — the same in both the drawer
  // variant and the standalone /tickets/<id> page. Hover commits nothing:
  // the click layer (onRootClick) resolves the anchor from the click point.
  const hoverBlockElRef = React.useRef(null);

  // TKT-0171: render the body (raw Markdown or legacy HTML) to safe HTML via
  // the shared SubstrateFmt pipeline (marked + DOMPurify). Rendering moved
  // inside TdAnnotate (it previously received pre-rendered HTML) so the
  // annotation engine operates on the live, sanitized DOM, and so mermaid
  // can be lazy-loaded against the injected nodes.
  // GOL-326: render by the stored body_format — the body's first character
  // never decides. HTML spec bodies re-sanitize defensively (SubstrateFmt).
  const html = React.useMemo(
    () => (window.SubstrateFmt?.renderBody
      ? window.SubstrateFmt.renderBody(body, bodyFormat)
      : (window.SubstrateFmt?.renderMarkdown ? window.SubstrateFmt.renderMarkdown(body) : (body || ''))),
    [body, bodyFormat],
  );

  React.useEffect(() => {
    const next = comments || [];
    setAnnotations((prev) => {
      if (prev.length === next.length && prev.every((a, i) => a.id === next[i]?.id && a.status === next[i]?.status && a.updated_at === next[i]?.updated_at)) {
        return prev;
      }
      return next;
    });
  }, [comments]);

  // Track the reader's position before updates. New comments should only move
  // the rail when the reader was already near its bottom edge.
  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const updateNearBottom = () => {
      nearBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    };
    updateNearBottom();
    list.addEventListener('scroll', updateNearBottom, { passive: true });
    return () => list.removeEventListener('scroll', updateNearBottom);
  }, [comments, railOpen]);

  // Follow the bottom in layout + several animation frames. Comment bodies can
  // change height after the first React commit (Markdown, images, Mermaid), so
  // one passive effect is not enough to guarantee the live inbox stays pinned.
  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !nearBottomRef.current) return undefined;
    const flow = list.querySelector('.rail-flow') || list;
    let frame1 = 0;
    let frame2 = 0;
    let frame3 = 0;
    let resizeFrame = 0;
    const follow = () => {
      if (nearBottomRef.current) list.scrollTop = list.scrollHeight;
    };
    const onResize = () => {
      if (!nearBottomRef.current) return;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(follow);
    };
    follow();
    frame1 = requestAnimationFrame(() => {
      follow();
      frame2 = requestAnimationFrame(() => {
        follow();
        frame3 = requestAnimationFrame(follow);
      });
    });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
    observer?.observe(flow);
    return () => {
      cancelAnimationFrame(frame1);
      cancelAnimationFrame(frame2);
      cancelAnimationFrame(frame3);
      cancelAnimationFrame(resizeFrame);
      observer?.disconnect();
    };
  }, [annotations, comments, showResolved]);

  const lastHtmlRef = React.useRef(null);
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (lastHtmlRef.current !== html) {
      lastHtmlRef.current = html;
      root.innerHTML = html || '';
      // GOL-326 D3: HTML bodies carry server-persisted block ids — the browser
      // must not strip or regenerate them. Markdown keeps its positional ids.
      if (bodyFormat !== 'html') assignBlockIds(root);
      if (window.runMermaid) {
        const nodes = root.querySelectorAll('.mermaid');
        if (nodes.length) {
          window.runMermaid(nodes).then(() => {
            attachMermaidFullscreen(root);
          });
        }
      }
    }
  }, [html]);

  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      setTocHeadings((prev) => prev.length === 0 ? prev : []);
      return;
    }
    const nextList = assignTocHeadingIds(root, documentTitle);
    setTocHeadings((prev) => {
      if (prev.length === nextList.length && prev.every((h, i) => h.id === nextList[i]?.id && h.text === nextList[i]?.text && h.level === nextList[i]?.level)) {
        return prev;
      }
      return nextList;
    });
  }, [html, documentTitle]);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // TKT-0172: assign block-ids to the live DOM BEFORE resolving so
    // block_id-anchored comments can match their block element. Marks from a
    // prior render are unwrapped after (they live inside blocks, not at the
    // top level, so they don't disturb the block-id walk).
    if (bodyFormat !== 'html') assignBlockIds(root);
    root.querySelectorAll('mark.anno').forEach((m) => { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); });
    clearBlockAnnotationState(root);
    root.normalize();
    const idx0 = textNodes(root);
    const blockAnnotations = new Map();
    for (const ann of annotations) {
      if (ann.status === 'deleted') continue;
      const block = isBlockAnnotation(ann) ? findBlockById(root, ann.block_id) : null;
      if (block) {
        ann._orphan = false;
        const list = blockAnnotations.get(block) || [];
        list.push(ann);
        blockAnnotations.set(block, list);
        continue;
      }
      const loc = locateAnnotation(root, idx0, ann);
      ann._orphan = !loc;
      if (loc) wrapOffsets(root, loc.start, loc.end, ann);
    }
    for (const [block, anns] of blockAnnotations) setBlockAnnotationState(block, anns);
  }, [annotations, html]);

  React.useEffect(() => {
    const root = rootRef.current;
    if (root) setActiveAnnotationState(root, activeId);
  }, [activeId, annotations, html]);

  // TKT-0172 / GOL-311 single-step: block hover is a pure preview highlight.
  // On entering a commentable block (data-block-id) the .block-hover outline
  // moves immediately — no timers, no button, no anchor snapshot; hover
  // commits nothing. A click (onRootClick) is what opens the rail, and it
  // resolves the anchor from the click point, not from hover state. Blocks
  // with no text (hr, empty) are skipped — a comment there can't wrap anything
  // and would orphan. The highlight clears on scroll and on leaving the root
  // so it never names a block the cursor is not on.
React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    // TKT-0192: paint the block-hover decoration on `block`, clearing it
    // from whichever block held it before.
    function setHoverBlock(block) {
      const prev = hoverBlockElRef.current;
      if (prev && prev !== block) prev.classList.remove('block-hover');
      if (block) block.classList.add('block-hover');
      hoverBlockElRef.current = block || null;
    }
    function clearHoverBlock() {
      const prev = hoverBlockElRef.current;
      if (prev) prev.classList.remove('block-hover');
      hoverBlockElRef.current = null;
    }

    function enter(block) {
      const t = blockText(block);
      if (!t) return; // textless block (hr, empty) — not commentable
      setHoverBlock(block);
    }
    function leave() {
      clearHoverBlock();
    }
    function onMove(event) {
      if (event.target?.closest?.('#anno-rail')) return;
      const block = blockAtPoint(root, event.clientX, event.clientY);
      if (block && blockText(block)) enter(block);
      else leave();
    }
    root.addEventListener('mousemove', onMove);
    root.addEventListener('mouseleave', leave);
    function onScroll() {
      // The body scrolled under a stationary cursor: drop the preview so it
      // never highlights a block the cursor is not on.
      clearHoverBlock();
    }
    document.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('mousemove', onMove);
      root.removeEventListener('mouseleave', leave);
      document.removeEventListener('scroll', onScroll);
      // Detach the decoration from whatever block held it so a re-render
      // (new block elements) never leaves a stale .block-hover on a node
      // that's about to be replaced.
      clearHoverBlock();
    };
  }, [html, containerSelector]);

  const flashSaved = React.useCallback(() => {
    setSaveState('saving');
    setTimeout(() => setSaveState('saved'), 200);
    setTimeout(() => setSaveState((s) => (s === 'saved' ? '' : s)), 1600);
  }, []);

  const createComment = React.useCallback((input) => {
    const ann = { id: uid(), ...input, status: input.status || 'open', replies: input.replies || [], created_at: nowISO(), updated_at: nowISO() };
    setAnnotations((prev) => [ann, ...prev]);
    flashSaved();
    if (onCreate) onCreate(ann);
    return ann;
  }, [onCreate, flashSaved]);

  // GOL-101: the dispatch half used to be fired and forgotten — no await, no
  // catch — so a rejected dispatch became an unhandled rejection while the
  // optimistic annotation sat in the rail looking delivered. Now the promise is
  // returned, and if the *save* failed the optimistic card is withdrawn rather
  // than left flashing "saved" for a comment the server never took. A dispatch
  // that fails after a successful save keeps the card — that comment does exist
  // — and the drawer reports the delivery failure.
  const createCommentAndDispatch = React.useCallback((input) => {
    const ann = { id: uid(), ...input, status: input.status || 'open', replies: input.replies || [], created_at: nowISO(), updated_at: nowISO() };
    setAnnotations((prev) => [ann, ...prev]);
    flashSaved();
    if (!onCreateAndDispatch) return Promise.resolve(ann);
    return Promise.resolve(onCreateAndDispatch(ann)).then(
      () => ann,
      (err) => {
        if (err?.golemCommentSaved !== true) setAnnotations((prev) => prev.filter((a) => a.id !== ann.id));
        throw err;
      },
    );
  }, [onCreateAndDispatch, flashSaved]);

  const updateComment = React.useCallback((id, patch) => {
    setAnnotations((prev) => prev.map((annotation) => {
      if (annotation.id === id) return { ...annotation, ...patch, updated_at: nowISO() };
      if (!(annotation.replies || []).some((reply) => reply.id === id)) return annotation;
      return {
        ...annotation,
        replies: annotation.replies.map((reply) => reply.id === id
          ? { ...reply, ...patch, updated_at: nowISO() }
          : reply),
        updated_at: nowISO(),
      };
    }));
    flashSaved();
    if (onUpdate) onUpdate(id, patch);
  }, [onUpdate, flashSaved]);

  const makeReply = (parentId, text, author) => {
    const createdAt = nowISO();
    return {
      id: uid(), author, body: text, text,
      parent_id: parentId, status: 'open', dispatch_state: 'undispatched',
      created_at: createdAt, updated_at: createdAt, ts: createdAt,
    };
  };

  const appendReply = React.useCallback((parentId, reply) => {
    setAnnotations((prev) => prev.map((annotation) => {
      const ownsReply = annotation.id === parentId
        || (annotation.replies || []).some((candidate) => candidate.id === parentId);
      return ownsReply
        ? { ...annotation, replies: [...(annotation.replies || []), reply], updated_at: reply.updated_at }
        : annotation;
    }));
  }, []);

  const addReply = React.useCallback((parentId, text, author) => {
    const reply = makeReply(parentId, text, author);
    appendReply(parentId, reply);
    flashSaved();
    if (onReply) onReply(parentId, reply);
  }, [appendReply, onReply, flashSaved]);

  const addReplyAndDispatch = React.useCallback((parentId, text, author) => {
    const reply = makeReply(parentId, text, author);
    appendReply(parentId, reply);
    flashSaved();
    if (!onReplyAndDispatch) return Promise.resolve(reply);
    return Promise.resolve(onReplyAndDispatch(parentId, reply)).then(
      () => reply,
      (err) => {
        if (err?.golemCommentSaved !== true) {
          setAnnotations((prev) => prev.map((annotation) => ({
            ...annotation,
            replies: (annotation.replies || []).filter((candidate) => candidate.id !== reply.id),
          })));
        }
        throw err;
      },
    );
  }, [appendReply, flashSaved, onReplyAndDispatch]);

  const deleteComment = React.useCallback((id) => {
    setAnnotations((prev) => prev
      .filter((annotation) => annotation.id !== id)
      .map((annotation) => ({
        ...annotation,
        replies: (annotation.replies || []).filter((reply) => reply.id !== id),
      })));
    flashSaved();
    if (onUpdate) onUpdate(id, { status: 'deleted' });
  }, [onUpdate, flashSaved]);

  const focusAnnotation = React.useCallback((id, jumpToAnchor = false) => {
    setActiveId(id);
    setRailOpen(true);
    const root = rootRef.current;
    if (root) setActiveAnnotationState(root, id);
    setTimeout(() => {
      const card = railRef.current?.querySelector(`.anno-card[data-id="${id}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (jumpToAnchor) {
        const anchor = root && findAnnotationAnchor(root, id);
        if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 50);
  }, []);

  // Anchor marks have an explicit jump action. Clicking the mark itself keeps
  // the existing direct-to-anchor behavior, while clicking a card only focuses
  // the card and leaves document scroll untouched.
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onMarkClick = (event) => {
      const mark = event.target?.closest?.('mark.anno');
      if (!mark || !root.contains(mark) || !mark.dataset.id) return;
      event.stopPropagation();
      focusAnnotation(mark.dataset.id, true);
    };
    root.addEventListener('click', onMarkClick);
    return () => root.removeEventListener('click', onMarkClick);
  }, [focusAnnotation, html, annotations]);

  // GOL-311 D4: the selection create-path is gone — text selection never
  // opens anything, and there is no selection pill. The only comment path is
  // the block click (onRootClick). Existing text-anchored comments still
  // locate/wrap via locate/wrapOffsets and render as mark.anno.

  // GOL-287: Esc closes the comments drawer, absorbing the event so an open
  // ticket drawer underneath does not close with it. Capture phase fires
  // before the drawer's window-bubble Esc handler. Fullscreen mermaid and the
  // image lightbox register their own later capture handlers for Esc — let
  // them win when present. Fields that own Esc (edit composer, filter inputs,
  // open PopSelect menus) are skipped; the composer textarea closes the drawer
  // via its own handler (draft preserved) so it is intentionally not skipped.
  // closeRail also releases focus if it is stranded inside the rail (the rail
  // stays mounted when hidden, and a focused textarea there would keep
  // absorbing Esc and shadow the ticket drawer's own Esc handler).
  const closeRail = React.useCallback(() => {
    setRailOpen(false);
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && typeof active.closest === 'function' && active.closest('#anno-rail')) {
        const host = rootRef.current?.closest('.drawer-ticket, .ticket-page');
        try { host?.focus({ preventScroll: true }); } catch {}
        if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#anno-rail')) active.blur();
      }
    });
  }, [rootRef]);
  React.useEffect(() => {
    if (!railOpen) return undefined;
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.mermaid-fs-overlay, .anno-image-lightbox')) return;
      const t = e.target;
      if (t && t.closest && t.closest('.anno-edit textarea, .ps-menu, input, select')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeRail();
    };
    document.addEventListener('keydown', onEsc, true);
    return () => document.removeEventListener('keydown', onEsc, true);
  }, [railOpen, closeRail]);

  const openCount = annotations.filter((a) => a.status === 'open').length;
  const resolvedCount = annotations.filter((a) => a.status === 'resolved').length;
  const isDraftAnnotation = (annotation) => {
    const state = annotation.dispatch_state
      || ((annotation.author === 'human' || annotation.author === 'you') ? 'undispatched' : null);
    return state === 'undispatched';
  };
  const orderedComments = annotations
    .filter((annotation) => annotation.status !== 'deleted')
    .slice()
    .sort((a, b) => {
      const draftOrder = Number(isDraftAnnotation(a)) - Number(isDraftAnnotation(b));
      if (draftOrder) return draftOrder;
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
  const visible = orderedComments.filter((a) => showResolved || a.status !== 'resolved');
  const history = visible.filter((annotation) => !isDraftAnnotation(annotation));
  const drafts = visible.filter(isDraftAnnotation);

  const composerInput = React.useCallback((text, anchor) => {
    const input = { author: currentAuthor, body: text };
    if (!anchor) return input;
    return {
      ...input,
      block_id: anchor.blockId || null,
      anchor_kind: anchor.anchorKind || 'text',
      quote: anchor.quote || '',
      prefix: anchor.prefix || '',
      suffix: anchor.suffix || '',
      section: (anchor.section && anchor.section.title) || '',
      section_id: (anchor.section && anchor.section.id) || '',
    };
  }, [currentAuthor]);

  // GOL-287 feedback: replies are written in the main composer, not inside the
  // comment card. pendingReply carries only the reference — the send still goes
  // through the unchanged addReply / addReplyAndDispatch mechanism.
  const [pendingReply, setPendingReply] = React.useState(null);
  const startReply = React.useCallback((annotation) => {
    const meta = authorMeta(annotation.author, annotation.author_label);
    setPendingComposer(null);
    setRailOpen(true);
    setPendingReply({
      parentId: annotation.id,
      label: meta.label,
      excerpt: String(annotation.body ?? annotation.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 90),
    });
  }, []);
  const cancelReply = React.useCallback(() => setPendingReply(null), []);

  const sendComposer = React.useCallback((text) => {
    if (pendingReply) {
      addReply(pendingReply.parentId, text, currentAuthor);
      setPendingReply(null);
      return;
    }
    const anchor = pendingComposer;
    createComment(composerInput(text, anchor));
    setPendingComposer(null);
  }, [pendingReply, addReply, currentAuthor, composerInput, createComment, pendingComposer]);

  const sendComposerAndDispatch = React.useCallback((text) => {
    if (pendingReply) {
      const done = addReplyAndDispatch(pendingReply.parentId, text, currentAuthor);
      setPendingReply(null);
      return done;
    }
    const anchor = pendingComposer;
    const done = createCommentAndDispatch(composerInput(text, anchor));
    setPendingComposer(null);
    return done;
  }, [pendingReply, addReplyAndDispatch, currentAuthor, composerInput, createCommentAndDispatch, pendingComposer]);

  const renderComment = (annotation) => (
    <React.Fragment key={annotation.id}>
      <CommentCard
        ann={annotation}
        active={annotation.id === activeId}
        onFocus={() => focusAnnotation(annotation.id)}
        onJump={() => focusAnnotation(annotation.id, true)}
        onResolve={() => updateComment(annotation.id, { status: annotation.status === 'resolved' ? 'open' : 'resolved' })}
        onDelete={() => deleteComment(annotation.id)}
        onStartReply={startReply}
        onEditBody={(text) => updateComment(annotation.id, { body: text })}
        onDispatch={onDispatchComment}
        canDispatch={canDispatchComments}
      />
      {annotation.replies?.length > 0 && (
        <CommentThread
          parentId={annotation.id}
          replies={annotation.replies}
          showResolved={showResolved}
          activeId={activeId}
          onFocus={focusAnnotation}
          onResolve={updateComment}
          onDelete={deleteComment}
          onStartReply={startReply}
          onEditBody={updateComment}
          onDispatch={onDispatchComment}
          canDispatch={canDispatchComments}
        />
      )}
    </React.Fragment>
  );

  // TKT-0108: hoist rail + FAB out of the scrollable body via a portal to the
  // drawer root. Otherwise both scroll with the body, which the user
  // complained about ("comments drawer and FAB are not sticky").
  const drawerHost = typeof document !== 'undefined'
    ? document.querySelector(containerSelector)
    : null;
  const railAndFab = drawerHost ? ReactDOM.createPortal(
    <>
      {tocHeadings.length >= 2 && (
        <TdToc
          key={documentKey || 'anonymous'}
          headings={tocHeadings}
          rootRef={rootRef}
          documentKey={documentKey}
          containerSelector={containerSelector}
        />
      )}

      <div id="anno-rail" ref={railRef} className={railOpen ? 'open' : ''}>
        <div className="rail-head">
          <div className="rail-head-row">
            <div>
              <div className="t">Comments</div>
              <div className="meta">{openCount} open · {resolvedCount} resolved</div>
            </div>
            <div className="rail-tools">
              <button className="rail-btn" onClick={() => { setPendingComposer(null); setPendingReply(null); setRailOpen(true); }}>+ New</button>
              <label className="rail-check">
                <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
                Show resolved
              </label>
              {/* GOL-287: close the drawer from within — Esc does the same. */}
              <button type="button" className="rail-close" aria-label="Close comments drawer" title="Close (Esc)" onClick={closeRail}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </div>
        </div>
        <div id="anno-list" ref={listRef} className="rail-scroll">
          <div className="rail-flow">
            {visible.length === 0 ? (
              <div className="empty">No comments yet.<br/>Start a message below or attach a section.</div>
            ) : (
              <>
                {history.length > 0 && (
                  <div className="history" data-message-count={history.length}>
                    {history.map(renderComment)}
                  </div>
                )}
                {drafts.length > 0 && (
                  <div className="draft-queue" data-draft-count={drafts.length}>
                    <div className="draft-queue-head">
                      <div className="draft-queue-label">Draft queue · {drafts.length} not yet dispatched</div>
                    </div>
                    <div className="draft-queue-items">{drafts.map(renderComment)}</div>
                    {onBatchDispatch && (
                      <div className="draft-queue-foot">
                        <button
                          type="button"
                          className="rail-btn rail-dispatch-btn draft-queue-dispatch-btn"
                          onClick={onBatchDispatch}
                          disabled={commentDispatching}
                          title={dispatchTargetLabel ? `Dispatch all ${undispatchedCount} undispatched comment${undispatchedCount === 1 ? '' : 's'} to @${dispatchTargetLabel}` : `Dispatch all ${undispatchedCount} undispatched comment${undispatchedCount === 1 ? '' : 's'}`}
                        >
                          {commentDispatching ? 'Dispatching…' : (dispatchTargetLabel ? `↗ Dispatch all to @${dispatchTargetLabel}` : `↗ Dispatch all (${undispatchedCount})`)}
                        </button>
                        {commentDispatchNote && <span className="rail-dispatch-note draft-queue-note">{commentDispatchNote}</span>}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        <div className="anno-composer-dock">
          <AnnoComposer
            rail
            autoFocus={railOpen}
            // null on the plain composer so mounting never steals focus (an
            // Escape then reaches the drawer's close handler); a reply ref or
            // block anchor token focuses deliberately.
            focusToken={pendingReply ? `reply:${pendingReply.parentId}` : (pendingComposer ? composerFocusToken : null)}
            quote={pendingComposer?.anchorKind === 'block' ? null : pendingComposer?.quote}
            attachment={pendingReply ? {
              kind: 'reply',
              title: pendingReply.excerpt ? `${pendingReply.label} — ${pendingReply.excerpt}` : pendingReply.label,
              id: pendingReply.parentId,
            } : (pendingComposer ? {
              // GOL-287: the pill must name what will actually be anchored.
              // Block comments anchor the clicked block (block_id primary), so
              // the pill shows that block's text; the section stays context.
              kind: pendingComposer.anchorKind === 'block' ? 'block' : 'section',
              title: pendingComposer.anchorKind === 'block'
                ? (pendingComposer.blockText || pendingComposer.section?.title || '')
                : (pendingComposer.section?.title || ''),
              id: pendingComposer.anchorKind === 'block'
                ? (pendingComposer.blockId || pendingComposer.section?.id || '')
                : (pendingComposer.section?.id || pendingComposer.blockId || ''),
            } : null)}
            canDispatch={canDispatchComments && (pendingReply ? !!onReplyAndDispatch : !!onCreateAndDispatch)}
            dispatchLabel={pendingReply ? 'Reply + Dispatch' : 'Dispatch'}
            onSend={sendComposer}
            onSendAndDispatch={sendComposerAndDispatch}
            onCancel={() => { setPendingComposer(null); setPendingReply(null); }}
            onClearAttachment={() => { setPendingComposer(null); setPendingReply(null); }}
            onEscape={closeRail}
            canEditBlock={bodyFormat === 'html' && typeof onEditBlock === 'function'}
            onEditBlock={onEditBlock}
          />
        </div>
      </div>

      <div id="anno-fab" onClick={() => setRailOpen((v) => !v)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span className="n">{openCount}</span> <span className="lbl">{openCount === 1 ? 'comment' : 'comments'}</span>
      </div>

      <div id="anno-save" className={saveState ? `show ${saveState}` : ''}>
        {saveState === 'saving' ? 'saving…' : saveState === 'saved' ? 'saved ✓' : saveState === 'err' ? 'save failed' : ''}
      </div>
    </>,
    drawerHost,
  ) : null;

  return (
    <div className={`td-annotate-wrap ${railOpen ? 'rail-open' : ''}`}>
      <div ref={rootRef} className={`td-md${altComment ? ' anno-alt-comment' : ''}`} onMouseDown={onRootMouseDown} onClick={onRootClick} />
      {railAndFab}
    </div>
  );
}

function collectImages(dt) {
  if (!dt) return [];
  const out = [];
  if (dt.items) {
    for (const it of dt.items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && /^image\//.test(f.type)) out.push(f);
      }
    }
  }
  if (dt.files) {
    for (const f of dt.files) {
      if (f && /^image\//.test(f.type) && !out.includes(f)) out.push(f);
    }
  }
  return out;
}

function openImageLightbox(url, alt = 'Image preview') {
  if (!url || typeof document === 'undefined') return;
  document.querySelector('.anno-image-lightbox')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'anno-image-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', alt);
  const image = document.createElement('img');
  image.src = url;
  image.alt = alt;
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'anno-image-lightbox-close';
  closeButton.setAttribute('aria-label', 'Close image preview');
  closeButton.title = 'Close image preview';
  closeButton.textContent = '×';
  overlay.append(image, closeButton);
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    }
  };
  closeButton.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => {
    overlay.classList.add('open');
    closeButton.focus();
  });
}

function CommentThread({ parentId, replies = [], showResolved = false, activeId, onFocus, onResolve, onDelete, onStartReply, onEditBody, onDispatch, canDispatch = false }) {
  const [collapsed, setCollapsed] = React.useState(false);
  const visibleReplies = replies.filter((reply) => (
    reply.status !== 'deleted' && (showResolved || reply.status !== 'resolved')
  ));
  const count = visibleReplies.length;
  if (count === 0) return null;
  return (
    <div className="thread" data-thread-id={parentId} data-reply-count={count}>
      <div className="thread-head">
        <span className="thread-label">⎿ {count} replies ·</span>
        <button
          type="button"
          className="thread-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>
      {!collapsed && (
        <div className="thread-replies">
          {visibleReplies.map((reply) => {
            const annotation = reply.body == null
              ? { ...reply, body: reply.text || '', created_at: reply.created_at || reply.ts }
              : reply;
            return (
              <CommentCard
                key={annotation.id}
                ann={annotation}
                active={annotation.id === activeId}
                onFocus={() => onFocus(annotation.id)}
                onJump={() => onFocus(annotation.id, true)}
                onResolve={() => onResolve(annotation.id, { status: annotation.status === 'resolved' ? 'open' : 'resolved' })}
                onDelete={() => onDelete(annotation.id)}
                onStartReply={onStartReply}
                onEditBody={(text) => onEditBody(annotation.id, { body: text })}
                onDispatch={onDispatch}
                canDispatch={canDispatch}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function CommentCard({ ann, active, onFocus, onJump, onResolve, onDelete, onStartReply, onEditBody, onDispatch, canDispatch = false }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [editUploads, setEditUploads] = React.useState([]);
  const [expanded, setExpanded] = React.useState(false);
  const c = authorMeta(ann.author, ann.author_label);
  const editRef = React.useRef(null);
  const commentBody = ann.body ?? ann.text ?? '';
  const totalWords = countWords(commentBody);
  const longBody = totalWords > 300;
  const fullBodyHtml = bodyHtml(commentBody);
  const collapsedBodyHtml = longBody ? clampHtmlToWords(fullBodyHtml, 300) : fullBodyHtml;
  const dispatchState = ann.dispatch_state
    || ((ann.author === 'human' || ann.author === 'you') ? 'undispatched' : null);

  const uploadEditOne = React.useCallback(async (file) => {
    const id = `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    setEditUploads((u) => [...u, { id, name: file.name || 'image.png', status: 'uploading' }]);
    try {
      const res = await window.SubstrateAPI.uploadAsset(file);
      const md = `![](${res.url})`;
      setEditUploads((u) => u.map((x) => x.id === id ? { ...x, status: 'done', url: res.url, md } : x));
      return { id, md, url: res.url };
    } catch (err) {
      setEditUploads((u) => u.map((x) => x.id === id ? { ...x, status: 'error', error: String(err?.message || err) } : x));
      throw err;
    }
  }, []);

  const onEditPaste = React.useCallback(async (e) => {
    const files = collectImages(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    const before = editRef.current?.selectionStart ?? draft.length;
    const after = editRef.current?.selectionEnd ?? draft.length;
    for (const f of files) {
      try {
        const { md } = await uploadEditOne(f);
        const insert = `\n${md}\n`;
        setDraft((cur) => {
          const next = cur.slice(0, before) + insert + cur.slice(after);
          requestAnimationFrame(() => {
            if (editRef.current) {
              const pos = before + insert.length;
              editRef.current.setSelectionRange(pos, pos);
              editRef.current.focus();
            }
          });
          return next;
        });
        break;
      } catch (err) { /* error surfaced in uploads strip */ }
    }
  }, [draft, uploadEditOne]);

  const onEditDrop = React.useCallback(async (e) => {
    const files = collectImages(e.dataTransfer);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) {
      try {
        const { md } = await uploadEditOne(f);
        setDraft((cur) => cur + (cur.endsWith('\n') ? '' : '\n') + md + '\n');
      } catch (err) { /* surfaced in uploads strip */ }
    }
  }, [uploadEditOne]);

  const isEditUploading = editUploads.some((u) => u.status === 'uploading');
  const removeEditUpload = (id) => {
    const upload = editUploads.find((item) => item.id === id);
    setEditUploads((items) => items.filter((item) => item.id !== id));
    if (upload?.md) setDraft((value) => value.replace(upload.md, '').replace(/\n{3,}/g, '\n\n'));
  };

  const startEdit = (e) => {
    e.stopPropagation();
    setDraft(htmlToEditableText(commentBody));
    setEditUploads([]);
    setEditing(true);
    setExpanded(true); // TKT-0237: auto-expand on Edit (never collapse)
    setTimeout(() => editRef.current?.focus(), 0);
  };
  const saveEdit = () => {
    const t = draft.trim();
    if (!t || isEditUploading) return;
    onEditBody(t);
    setEditing(false);
  };
  const cancelEdit = () => { setEditing(false); setDraft(''); setEditUploads([]); };
  const dispatchComment = (e) => {
    e.stopPropagation();
    if (onDispatch) onDispatch(ann.id);
  };
  // Editing-phase dispatch: persist the edited body first, then dispatch the
  // comment so the target receives the latest text.
  const saveEditAndDispatch = async () => {
    const t = draft.trim();
    if (!t || isEditUploading) return;
    setEditing(false);
    await onEditBody(t);
    if (onDispatch) onDispatch(ann.id);
  };

  // Card clicks only focus the card. Expansion is owned by the in-flow divider
  // below the body, so clicking message text never causes a hidden scroll or
  // an unexpected collapse.
  const onCardClick = (e) => {
    if (e.target.closest('button, a, textarea, input, select, .acts, .anno-composer')) return;
    onFocus();
  };

  const isHuman = ann.author === 'human' || ann.author === 'you' || ann.author === 'human:dashboard';

  // GOL-287: agent comments wear the authoring session's model mark instead of
  // an initialism badge. The author field carries the session id; the live
  // session registry keeps offline sessions too, so history keeps its icons.
  // Unknown session / unresolvable provider falls back to the initials badge.
  const authorSession = !isHuman ? window.Store?.getNativeSessionById?.(ann.author) : null;
  const authorProvider = authorSession
    ? window.ModelProviders?.resolveProvider?.(authorSession.provider, authorSession.model)
    : null;
  const authorIconSrc = authorProvider?.iconIdleSrc || authorProvider?.iconSrc || null;

  const onBodyClick = (e) => {
    const target = e.target;
    if (target && target.tagName === 'IMG' && target.src) {
      e.stopPropagation();
      openImageLightbox(target.src, target.alt || 'Comment image');
    }
  };

  const initials = isHuman
    ? (c.label.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'L')
    : (c.label.split(/[\s:_-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'A');

  return (
    <div
      className={`anno-card ${isHuman ? 'anno-card-human' : 'anno-card-agent'} ${active ? 'is-active' : ''} ${ann.status === 'resolved' ? 'resolved' : ''} ${ann._orphan ? 'orphan' : ''}`}
      data-id={ann.id}
      onClick={onCardClick}
    >
      <div className="ch">
        <span className="anno-author">
          <span className={`anno-avatar ${isHuman ? 'anno-avatar-human' : 'anno-avatar-agent'}`} aria-label={`${c.label} avatar`}>{!isHuman && authorIconSrc ? <img src={authorIconSrc} alt=""/> : initials}</span>
          <span className="anno-author-name">{c.label}</span>
        </span>
        <span className="when">{shortTime(ann.created_at || ann.ts)}</span>
        {ann._orphan && <span className="anno-orphan-pill">· anchor lost</span>}
        {dispatchState && dispatchState !== 'n/a' && (
          <span className={`anno-dispatch-chip ${dispatchState}`}>{dispatchState}</span>
        )}
      </div>
      <div className="anno-card-content">
        {ann.quote && <div className="quote">{esc(ann.quote)}</div>}
        {editing ? (
          <div className="anno-composer anno-edit">
            {editUploads.length > 0 && (
              <div className="ct-uploads anno-image-previews">
                {editUploads.map((u) => (
                  <div key={u.id} className={`ct-upload ct-upload-${u.status}`}>
                    {u.status === 'uploading' && <span className="ct-upload-spinner" />}
                    {u.status === 'done' && u.url && (
                      <button type="button" className="ct-upload-preview" aria-label={`Preview ${u.name}`} onClick={(e) => { e.stopPropagation(); openImageLightbox(u.url, u.name); }}>
                        <img src={u.url} alt={u.name} className="ct-upload-thumb" />
                      </button>
                    )}
                    {u.status === 'error' && <span className="ct-upload-err">×</span>}
                    <span className="ct-upload-name">{u.name}</span>
                    {u.status === 'error' && <span className="ct-upload-err-msg">{u.error}</span>}
                    {u.status !== 'uploading' && (
                      <button type="button" className="ct-upload-remove" aria-label={`Remove ${u.name}`} onClick={(e) => { e.stopPropagation(); removeEditUpload(u.id); }}>×</button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={editRef}
              rows={5}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={onEditPaste}
              onDrop={onEditDrop}
              onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); }}
              placeholder="Edit comment… (paste/drop images)"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault(); e.stopPropagation(); saveEdit();
                } else if (e.key === 'Escape') {
                  e.preventDefault(); e.stopPropagation(); cancelEdit();
                }
              }}
            />
            <div className="row">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
                <button className="cancel" onClick={cancelEdit}>esc</button>
                {dispatchState === 'undispatched' && canDispatch && (
                  <button className="send secondary" onClick={saveEditAndDispatch} disabled={!draft.trim() || isEditUploading}>Dispatch</button>
                )}
                <button className="send" onClick={saveEdit} disabled={!draft.trim() || isEditUploading}>Save</button>
              </div>
            </div>
            <div className="hint">Enter to save · Shift+Enter newline · Esc cancel</div>
          </div>
        ) : (
          <>
            <div className="body" onClick={onBodyClick} dangerouslySetInnerHTML={{ __html: expanded ? fullBodyHtml : collapsedBodyHtml }}/>
            {longBody && (
              <button
                type="button"
                className="anno-body-divider"
                aria-expanded={expanded}
                onClick={(e) => { e.stopPropagation(); setExpanded((value) => !value); }}
              >
                <span>{expanded ? 'Show less ↑' : `Show ${totalWords - 300} more words ↓`}</span>
              </button>
            )}
          </>
        )}
      </div>
      {/* GOL-287 feedback: reply composition lives in the main composer. The
          card's Reply button only sets the reply reference there; the send
          still routes through the unchanged reply mechanism. */}
      <div className="acts">
        <button type="button" className="act-reply" onClick={(e) => { e.stopPropagation(); if (onStartReply) onStartReply(ann); }}>
          <span aria-hidden="true">💬</span> Reply
        </button>
        {ann.block_id && onJump && (
          <button type="button" className="act-jump" title="Jump to section" aria-label="Jump to section" onClick={(e) => { e.stopPropagation(); onJump(); }}>
            <span aria-hidden="true">⧉</span> Jump
          </button>
        )}
        <button type="button" className="act-edit" onClick={(e) => { e.stopPropagation(); startEdit(e); }}>
          <span aria-hidden="true">✎</span> Edit
        </button>
        {dispatchState === 'undispatched' && canDispatch && (
          <button type="button" className="act-dispatch" onClick={dispatchComment}>
            <span aria-hidden="true">↗</span> Dispatch
          </button>
        )}
        <button type="button" className="act-resolve" onClick={(e) => { e.stopPropagation(); onResolve(); }}>
          <span aria-hidden="true">{ann.status === 'resolved' ? '↩' : '✓'}</span> {ann.status === 'resolved' ? 'Reopen' : 'Resolve'}
        </button>
        <button type="button" className="act-delete" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
          <span aria-hidden="true">🗑</span> Delete
        </button>
      </div>
    </div>
  );
}

function AnnoComposer({ quote, attachment, onSend, onSendAndDispatch, canDispatch = false, dispatchLabel = 'Dispatch', onCancel, onClearAttachment, rail = false, autoFocus = true, focusToken = null, onEscape = null, canEditBlock = false, onEditBlock = null }) {
  const [text, setText] = React.useState('');
  const [uploads, setUploads] = React.useState([]);
  const taRef = React.useRef(null);
  const words = countWords(text);

  React.useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);

  // GOL-287: refocus when the composer's mode flips (e.g. Reply pressed on a
  // card) so typing lands in the main box immediately.
  React.useEffect(() => {
    if (focusToken != null) taRef.current?.focus();
  }, [focusToken]);

  React.useLayoutEffect(() => {
    const textarea = taRef.current;
    if (!textarea || !rail) return;
    textarea.style.height = 'auto';
    const minHeight = 72;
    const maxHeight = 150;
    if (!textarea.value) {
      textarea.style.height = `${minHeight}px`;
      textarea.style.overflowY = 'hidden';
      return;
    }
    const nextHeight = Math.min(maxHeight, Math.max(minHeight, textarea.scrollHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [rail, text]);

  const uploadOne = React.useCallback(async (file) => {
    const id = `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    setUploads((u) => [...u, { id, name: file.name || 'image.png', status: 'uploading' }]);
    try {
      const res = await window.SubstrateAPI.uploadAsset(file);
      const md = `![](${res.url})`;
      setUploads((u) => u.map((x) => x.id === id ? { ...x, status: 'done', url: res.url, md } : x));
      return { id, md, url: res.url };
    } catch (err) {
      setUploads((u) => u.map((x) => x.id === id ? { ...x, status: 'error', error: String(err?.message || err) } : x));
      throw err;
    }
  }, []);

  const onPaste = React.useCallback(async (e) => {
    const files = collectImages(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    const before = taRef.current?.selectionStart ?? text.length;
    const after = taRef.current?.selectionEnd ?? text.length;
    for (const f of files) {
      try {
        const { md } = await uploadOne(f);
        const insert = `\n${md}\n`;
        setText((cur) => {
          const next = cur.slice(0, before) + insert + cur.slice(after);
          requestAnimationFrame(() => {
            if (taRef.current) {
              const pos = before + insert.length;
              taRef.current.setSelectionRange(pos, pos);
              taRef.current.focus();
            }
          });
          return next;
        });
        break;
      } catch (err) { /* error surfaced in uploads strip */ }
    }
  }, [text, uploadOne]);

  const onDrop = React.useCallback(async (e) => {
    const files = collectImages(e.dataTransfer);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) {
      try {
        const { md } = await uploadOne(f);
        setText((cur) => cur + (cur.endsWith('\n') ? '' : '\n') + md + '\n');
      } catch (err) { /* surfaced in uploads strip */ }
    }
  }, [uploadOne]);

  const isUploading = uploads.some((u) => u.status === 'uploading');
  const removeUpload = (id) => {
    const upload = uploads.find((item) => item.id === id);
    setUploads((items) => items.filter((item) => item.id !== id));
    if (upload?.md) setText((value) => value.replace(upload.md, '').replace(/\n{3,}/g, '\n\n'));
  };

  const clearDraft = () => {
    setText('');
    setUploads([]);
  };

  const fire = () => {
    const t = text.trim();
    if (!t || isUploading) return;
    onSend(t);
    clearDraft();
  };
  // GOL-101: swallow nothing. A rejected dispatch is reported on the drawer's
  // comment-dispatch note; catching here only keeps it from surfacing as an
  // unhandled rejection.
  const fireDispatch = () => {
    const t = text.trim();
    if (!t || !onSendAndDispatch || isUploading) return;
    const result = onSendAndDispatch(t);
    clearDraft();
    if (result && typeof result.catch === 'function') {
      result.catch((err) => console.error('comment dispatch failed', err));
    }
  };
  const cancel = () => {
    clearDraft();
    if (onCancel) onCancel();
  };

  return (
    <div className={`anno-composer${rail ? ' anno-rail-composer' : ''}`}>
      {attachment && (
        <div className="anno-attachment-pill" title={attachment.title || attachment.id || 'Attached section'}>
          <span aria-hidden="true">{attachment.kind === 'reply' ? '↩ Reply' : attachment.kind === 'block' ? '⧉ Block' : '⧉ Section'}</span>
          {attachment.title && <span className="anno-attachment-title">· {attachment.title}</span>}
          {/* GOL-326: for an HTML block the attachment pill also exposes the
              block-scoped raw HTML editor (same patch endpoint as the CLI). */}
          {canEditBlock && onEditBlock && attachment.kind === 'block' && attachment.id && (
            <button type="button" className="anno-edit-block" title="Edit this block's raw HTML"
              onClick={(e) => { e.stopPropagation(); onEditBlock(attachment.id); }}>Edit block</button>
          )}
          {onClearAttachment && (
            <button type="button" aria-label={attachment.kind === 'reply' ? 'Remove reply reference' : attachment.kind === 'block' ? 'Remove block attachment' : 'Remove section attachment'} title={attachment.kind === 'reply' ? 'Remove reply reference' : attachment.kind === 'block' ? 'Remove block attachment' : 'Remove section attachment'} onClick={(e) => { e.stopPropagation(); onClearAttachment(); }}>×</button>
          )}
        </div>
      )}
      {quote && <div className="quote">{esc(quote)}</div>}
      {uploads.length > 0 && (
        <div className="ct-uploads anno-image-previews">
          {uploads.map((u) => (
            <div key={u.id} className={`ct-upload ct-upload-${u.status}`}>
              {u.status === 'uploading' && <span className="ct-upload-spinner" />}
              {u.status === 'done' && u.url && (
                <button type="button" className="ct-upload-preview" aria-label={`Preview ${u.name}`} onClick={(e) => { e.stopPropagation(); openImageLightbox(u.url, u.name); }}>
                  <img src={u.url} alt={u.name} className="ct-upload-thumb" />
                </button>
              )}
              {u.status === 'error' && <span className="ct-upload-err">×</span>}
              <span className="ct-upload-name">{u.name}</span>
              {u.status === 'error' && <span className="ct-upload-err-msg">{u.error}</span>}
              {u.status !== 'uploading' && (
                <button type="button" className="ct-upload-remove" aria-label={`Remove ${u.name}`} onClick={(e) => { e.stopPropagation(); removeUpload(u.id); }}>×</button>
              )}
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        rows={rail ? 3 : 5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); }}
        placeholder="Comment — Markdown (+ ```mermaid; > [!NOTE]/[!WARNING]/[!IMPORTANT]; paste/drop images)"
        aria-describedby={rail ? 'anno-composer-word-count' : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            // GOL-287: Cmd/Ctrl+Enter dispatches straight to the assignee.
            e.preventDefault(); e.stopPropagation(); fireDispatch();
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault(); e.stopPropagation(); fire();
          } else if (e.key === 'Escape') {
            // Esc closes the comments drawer (without wiping the draft) when
            // the host provides a close; legacy default cancels the draft.
            e.preventDefault(); e.stopPropagation();
            if (onEscape) onEscape(); else cancel();
          }
        }}
      />
      <div className="row">
        {rail && (
          <span id="anno-composer-word-count" className={`anno-word-count${words > 300 ? ' warn' : ''}`} aria-live="polite">
            {words} {words === 1 ? 'word' : 'words'}
          </span>
        )}
        <div className="anno-composer-actions">
          {canDispatch && <button className="send secondary" onClick={fireDispatch} disabled={!text.trim() || isUploading} title="Dispatch immediately (Cmd/Ctrl+Enter)">{dispatchLabel} (cmd+enter)</button>}
          <button className="send" onClick={fire} disabled={!text.trim() || isUploading} title="Save as a draft comment (Enter)">Comment (enter)</button>
        </div>
      </div>
      <div className="hint">Enter to comment · Shift+Enter newline · Cmd/Ctrl+Enter dispatch · Esc closes the drawer</div>
    </div>
  );
}

window.TdAnnotate = TdAnnotate;
