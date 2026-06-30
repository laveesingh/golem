// TdAnnotate — html-report-style annotation layer for tracker ticket bodies.
// Renders the ticket body as HTML and mounts a Google-Docs-style comment rail.

const TA_AUTHORS = {
  you:        { label: 'You',         color: '#f5a623' },
  claude_opus:{ label: 'Claude Opus', color: '#b394ff' },
  gemini35:   { label: 'Gemini 3.5',  color: '#5b8cff' },
  kimi_k27:   { label: 'Kimi K2.7',   color: '#ff6f9c' },
  minimax_m3: { label: 'MiniMax M3',  color: '#2dd4a7' },
};

const TA_TAGS = {
  confirmed: { label: 'Confirmed', icon: '✓', color: '#3ddc97' },
  partial:   { label: 'Partial',   icon: '◐', color: '#f5a623' },
  disputed:  { label: 'Disputed',  icon: '✗', color: '#fb6f92' },
  fix:       { label: 'Fix',       icon: '✎', color: '#43c6f0' },
  risk:      { label: 'Risk',      icon: '⚠', color: '#ff9e3d' },
  question:  { label: 'Question',  icon: '?', color: '#c08bff' },
  note:      { label: 'Note',      icon: '•', color: '#9aa4bb' },
};
const TA_TAG_ORDER = ['confirmed', 'partial', 'disputed', 'fix', 'risk', 'question', 'note'];

// TKT-0172: the left-gutter "+" affordance that appears on block hover. Fully
// inline-styled (the annotation CSS lives in extra.css but this element is new
// and the CSS file is owned by TKT-0173), mirroring #anno-pill which is portaled
// to the same positioned ancestor (containerSelector). transform: translateY(-50%)
// centers it on the block's vertical midline; `top` is set to that midline.
const BLOCK_PLUS_STYLE = {
  position: 'absolute', zIndex: 68, display: 'none',
  alignItems: 'center', height: 22, padding: '0 5px', gap: 3,
  cursor: 'pointer', userSelect: 'none',
  background: '#1b2336', border: '1px solid #243049', borderRadius: '7px',
  color: '#e6e9f0', boxShadow: '0 4px 14px rgba(0,0,0,.4)',
  fontFamily: '"JetBrains Mono", monospace',
  transform: 'translateY(-50%)',
};

const CTX = 42;

function authorMeta(a) { return TA_AUTHORS[a] || { label: a, color: '#9aa4bb' }; }
function tagMeta(t) { return TA_TAGS[t] || TA_TAGS.note; }

function bodyHtml(text) {
  if (window.SubstrateFmt?.htmlBody) return window.SubstrateFmt.htmlBody(text);
  if (!text) return '';
  if (/^\s*<[a-zA-Z][^>]*>/.test(text)) return text;
  return text.split(/\n\n+/).map((p) => `<p>${p.trim().replace(/\n/g, '<br/>')}</p>`).join('');
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
      if (p.closest && p.closest('#anno-rail,#anno-pill,#anno-fab')) return NodeFilter.FILTER_REJECT;
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
  const tm = tagMeta(ann.tag);
  for (let t = targets.length - 1; t >= 0; t--) {
    let node = targets[t].node;
    const { ls, le } = targets[t];
    if (le < node.nodeValue.length) node.splitText(le);
    if (ls > 0) node = node.splitText(ls);
    const mk = document.createElement('mark');
    mk.className = 'anno';
    mk.dataset.id = ann.id;
    mk.dataset.author = ann.author;
    mk.dataset.tag = ann.tag || 'note';
    mk.title = `${tm.label} · ${authorMeta(ann.author).label}`;
    if (ann.status === 'resolved') mk.classList.add('resolved');
    applyAuthorVars(mk, ann.author);
    if (t === targets.length - 1) {
      mk.classList.add('anno-tail');
      mk.style.setProperty('--_tic', '"' + tm.icon + '"');
      mk.style.setProperty('--_tcol', tm.color);
    }
    node.parentNode.insertBefore(mk, node);
    mk.appendChild(node);
  }
  return targets.length > 0;
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
// nearestSection (text-select) and locateAnnotation (resolve).
function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Walk the top-level block children of the rendered body and assign each a
// data-block-id = "<nearest-preceding-heading-slug>#<index-within-section>".
// A heading starts a new section (the heading itself is index 0 within it);
// content blocks after it count up from 1. Blocks before the first heading
// get an empty-slug section ("#0", "#1", …). Run on the live DOM post-inject
// (after marked + DOMPurify) so attribute-sanitization concerns are moot.
function assignBlockIds(root) {
  let slug = '';
  let idx = 0;
  for (const child of root.children) {
    const isHeading = /^H[1-6]$/.test(child.tagName);
    if (isHeading) { slug = slugify(child.textContent); idx = 0; }
    child.dataset.blockId = `${slug}#${idx}`;
    idx = isHeading ? 1 : idx + 1;
  }
}

// Find the nearest preceding heading element (h1-h6) by walking the previous
// top-level siblings of `block`. Markdown renders headings as top-level
// blocks (children of root), so the containing block is a child of root and
// its previousElementSibling chain walks back through the section's earlier
// blocks to the heading that opens it.
function nearestPrecedingHeading(block) {
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
// block_id is primary: recompute-matched block elements (query by
// data-block-id) and span all text nodes inside that block. If there is no
// block_id, or the block_id no longer matches, fall back to the quote-based
// locate() — which the 44 legacy anchored comments rely on unchanged.
function locateAnnotation(root, idx, ann) {
  if (ann.block_id) {
    const sel = '[data-block-id="' + String(ann.block_id).replace(/["\\]/g, '\\$&') + '"]';
    const block = root.querySelector(sel);
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

function nearestSection(range) {
  let node = range.commonAncestorContainer;
  if (node.nodeType === 3) node = node.parentNode;
  const block = node && node.closest ? node.closest('[data-block-id]') : null;
  if (!block) return { id: '', title: '' };
  const h = nearestPrecedingHeading(block);
  return h
    ? { id: slugify(h.textContent), title: h.textContent.trim().slice(0, 80) }
    : { id: '', title: '' };
}

// ---- React component ----------------------------------------------------
// `containerSelector` is the CSS selector of the positioned ancestor the
// annotation pill portals into. The ticket drawer passes `.drawer-ticket`
// (position:fixed); the standalone ticket page passes `.ticket-page`. Defaults
// to `.drawer-ticket` for backward compatibility.
function TdAnnotate({ body, comments, currentAuthor = 'you', onCreate, onUpdate, onReply, containerSelector = '.drawer-ticket' }) {
  const rootRef = React.useRef(null);
  const railRef = React.useRef(null);
  const [annotations, setAnnotations] = React.useState(comments || []);
  const [activeId, setActiveId] = React.useState(null);
  const [showResolved, setShowResolved] = React.useState(true);
  const [railOpen, setRailOpen] = React.useState(false);
  const [saveState, setSaveState] = React.useState('');
  const [pendingComposer, setPendingComposer] = React.useState(null);
  const pendingRangeRef = React.useRef(null);
  // TKT-0172: block-hover state. hoverBlockRef holds the currently-hovered
  // block's { blockId, blockText, sectionId, sectionTitle } so the portaled
  // "+" button's onClick can open a composer anchored to it. showPlusTimerRef
  // delays show-on-hover (so the "+" doesn't flash during fast cursor moves);
  // hidePlusTimerRef delays hide (so the cursor can travel from block to "+"
  // without it vanishing underneath). The "+" itself has its own
  // mouseenter/mouseleave that bridge both timers. blockCountsRef is a
  // Map<block_id, open-count> kept fresh via an effect so the hover effect
  // (which only re-binds on html change) always reads current counts.
  const hoverBlockRef = React.useRef(null);
  // TKT-0192: the block element currently carrying the .block-hover highlight.
  // Tracked separately from hoverBlockRef (which is the anchor metadata) so
  // we can swap/clear the decoration as the cursor moves between blocks.
  // The class is styled in extra.css (`.td-md [data-block-id].block-hover`)
  // with an accent-color outline at 50% opacity and 3px offset — the same
  // in both the drawer variant and the standalone /tickets/<id> page.
  const hoverBlockElRef = React.useRef(null);
  const showPlusTimerRef = React.useRef(null);
  const hidePlusTimerRef = React.useRef(null);
  const blockCountsRef = React.useRef(new Map());

  // TKT-0171: render the body (raw Markdown or legacy HTML) to safe HTML via
  // the shared SubstrateFmt pipeline (marked + DOMPurify). Rendering moved
  // inside TdAnnotate (it previously received pre-rendered HTML) so the
  // annotation engine operates on the live, sanitized DOM, and so mermaid
  // can be lazy-loaded against the injected nodes.
  const html = React.useMemo(
    () => (window.SubstrateFmt?.renderMarkdown ? window.SubstrateFmt.renderMarkdown(body) : (body || '')),
    [body],
  );

  React.useEffect(() => { setAnnotations(comments || []); }, [comments]);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // TKT-0172: assign block-ids to the live DOM BEFORE resolving so
    // block_id-anchored comments can match their block element. Marks from a
    // prior render are unwrapped after (they live inside blocks, not at the
    // top level, so they don't disturb the block-id walk).
    assignBlockIds(root);
    root.querySelectorAll('mark.anno').forEach((m) => { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); });
    root.normalize();
    const idx0 = textNodes(root);
    for (const ann of annotations) {
      if (ann.status === 'deleted') continue;
      const loc = locateAnnotation(root, idx0, ann);
      ann._orphan = !loc;
      if (loc) wrapOffsets(root, loc.start, loc.end, ann);
    }
  }, [annotations, html]);

  // TKT-0171: after the body is injected, lazy-load mermaid (only when one or
  // more .mermaid blocks are present) and render the diagrams in place. The
  // dynamic import lives in window.runMermaid (an index.html module script),
  // because babel-standalone rewrites dynamic import() inside text/babel
  // components and would break a native esm.sh load.
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root || !window.runMermaid) return;
    const nodes = root.querySelectorAll('.mermaid');
    if (!nodes.length) return;
    window.runMermaid(nodes);
  }, [html]);

  // TKT-0172: keep blockCountsRef (open comments per block_id) fresh so the
  // hover effect — which only re-binds listeners when the rendered body
  // changes — reads current counts when positioning the "+" affordance.
  React.useEffect(() => {
    const m = new Map();
    for (const a of annotations || []) {
      if (a.status === 'deleted') continue;
      if (a.block_id) m.set(a.block_id, (m.get(a.block_id) || 0) + 1);
    }
    blockCountsRef.current = m;
  }, [annotations]);

  // TKT-0172: block-hover UX. On entering a top-level block (data-block-id),
  // portal the "+" to the positioned ancestor, place it at the block's left
  // gutter / vertical midline, and stash the block's anchor for the "+"
  // click handler. Showing is delayed 1s so the "+" doesn't trail the cursor
  // during fast moves; hiding is delayed 1s so the cursor can travel from the
  // block to the "+" without it vanishing.
//
// Event ordering caveat: when the cursor crosses from a block onto the "+",
  // the browser may fire `+mouseenter` BEFORE the block's `mouseleave` (the
// "+" sits at the highest z-index, so it's the first thing under the cursor
// even though the block also contains that point in document flow). A naive
// timer-cancel design raced and lost. So we use **two flags** — the "user left
// the block" set by block.mouseleave and the "user is on the +" set by
// +.mouseenter — and only schedule the hide when BOTH are true. Blocks with
// no text (hr, empty) are skipped — a comment there can't wrap anything and
// would orphan. Hides on scroll/escape so it never goes stale.
React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const blocks = root.querySelectorAll('[data-block-id]');
    // Block-side hover flag — true while the cursor is inside some commentable block.
    let onBlock = false;
    // "+"-side hover is read at fire time via :hover (covers the case where
    // the "+"'s own mouseenter/mouseleave events raced with the block's
    // mouseleave when the cursor crossed the high-z "+" before the browser
    // fired the block's leave).
    function plusOn() { return !!document.getElementById('anno-block-plus')?.matches(':hover'); }

    // TKT-0192: paint the block-hover decoration on `block`, clearing it
    // from whichever block held it before. The class is removed by the
    // leave timer (same 1s grace window as the "+" itself), so the
    // highlight survives the cursor's trip from the block onto the "+".
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

    // TKT-0192: position the "+" so its right edge sits BLOCK_PLUS_GAP px to
    // the LEFT of the block, leaving a clear margin between the button and the
    // block's left boundary. Width is read via offsetWidth — 0 while
    // display:none, so we re-place inside the show timeout (after display:flex)
    // where the real width is available. Left is clamped to ≥2px so the button
    // never escapes the drawer's left edge.
    const BLOCK_PLUS_GAP = 8;
    function placePlus(block) {
      const plus = document.getElementById('anno-block-plus');
      if (!plus) return;
      const rect = block.getBoundingClientRect();
      const drawerEl = document.querySelector(containerSelector);
      const drawerRect = drawerEl ? drawerEl.getBoundingClientRect() : { left: 0, top: 0 };
      plus.style.top = `${rect.top - drawerRect.top + rect.height / 2}px`;
      const w = plus.offsetWidth || 26;
      plus.style.left = `${Math.max(2, rect.left - drawerRect.left - BLOCK_PLUS_GAP - w)}px`;
      plus.style.right = 'auto';
    }

    function enter(block) {
      const t = blockText(block);
      if (!t) return; // textless block (hr, empty) — not commentable
      onBlock = true;
      clearTimeout(hidePlusTimerRef.current);
      clearTimeout(showPlusTimerRef.current);
      const plus = document.getElementById('anno-block-plus');
      if (!plus) return;
      const cnt = blockCountsRef.current.get(block.dataset.blockId) || 0;
      const h = nearestPrecedingHeading(block);
      const hb = {
        blockId: block.dataset.blockId || '',
        blockText: t,
        sectionId: (block.dataset.blockId || '').split('#')[0],
        sectionTitle: h ? h.textContent.trim().slice(0, 80) : '',
      };
      hoverBlockRef.current = hb;
      setHoverBlock(block);
      // Position immediately so the "+" lands on the right block when it
      // eventually appears; only the visibility is delayed. Width is an
      // estimate here (display:none → offsetWidth 0); re-placed with the
      // real width inside the show timeout below.
      placePlus(block);
      showPlusTimerRef.current = setTimeout(() => {
        // Bail if the cursor moved off the block AND off the "+" within 1s.
        if (!onBlock && !plusOn()) {
          hoverBlockRef.current = null;
          return;
        }
        const p = document.getElementById('anno-block-plus');
        if (!p) return;
        p.style.display = 'flex';
        // Re-place now that offsetWidth is real, so the gap is exact.
        placePlus(block);
        const badge = p.querySelector('.anno-block-count');
        if (badge) { badge.textContent = cnt ? String(cnt) : ''; badge.style.display = cnt ? 'inline-flex' : 'none'; }
      }, 1000);
    }
    function leave() {
      onBlock = false;
      clearTimeout(showPlusTimerRef.current);
      // Always arm a hide; the hide's fire-time check (onBlock / plusOn)
      // cancels it if the cursor bounced back to the block or onto the "+".
      const plus = document.getElementById('anno-block-plus');
      hidePlusTimerRef.current = setTimeout(() => {
        // At fire time, both must be false for the cursor to actually have
        // left the affordance.
        if (onBlock || plusOn()) return;
        if (plus) plus.style.display = 'none';
        hoverBlockRef.current = null;
        clearHoverBlock();
      }, 1000);
    }
    const ons = [];
    blocks.forEach((b) => {
      const e = () => enter(b);
      const l = () => leave();
      b.addEventListener('mouseenter', e);
      b.addEventListener('mouseleave', l);
      ons.push({ b, e, l });
    });
    function onScroll() {
      // Cancel a pending show so the "+" never appears at a stale position
      // after the body scrolled under it; hide it and drop the highlight.
      clearTimeout(showPlusTimerRef.current);
      const p = document.getElementById('anno-block-plus');
      if (p && p.style.display === 'flex') p.style.display = 'none';
      clearHoverBlock();
      hoverBlockRef.current = null;
    }
    document.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ons.forEach(({ b, e, l }) => { b.removeEventListener('mouseenter', e); b.removeEventListener('mouseleave', l); });
      document.removeEventListener('scroll', onScroll);
      clearTimeout(showPlusTimerRef.current);
      clearTimeout(hidePlusTimerRef.current);
      // Detach the decoration from whatever block held it so a re-render
      // (new block elements) never leaves a stale .block-hover on a node
      // that's about to be replaced.
      clearHoverBlock();
    };
  }, [html, containerSelector]);

  const docOrder = React.useCallback(() => {
    const root = rootRef.current;
    const order = new Map(); let i = 0;
    if (root) root.querySelectorAll('mark.anno').forEach((m) => { if (!order.has(m.dataset.id)) order.set(m.dataset.id, i++); });
    return (annotations || []).filter((a) => a.status !== 'deleted').slice().sort((a, b) => (order.has(a.id) ? order.get(a.id) : 1e9) - (order.has(b.id) ? order.get(b.id) : 1e9));
  }, [annotations]);

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

  const updateComment = React.useCallback((id, patch) => {
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch, updated_at: nowISO() } : a)));
    flashSaved();
    if (onUpdate) onUpdate(id, patch);
  }, [onUpdate, flashSaved]);

  const addReply = React.useCallback((parentId, text, author) => {
    const reply = { author, text, ts: nowISO() };
    setAnnotations((prev) => prev.map((a) => a.id === parentId ? { ...a, replies: [...(a.replies || []), reply], updated_at: nowISO() } : a));
    flashSaved();
    if (onReply) onReply(parentId, reply);
  }, [onReply, flashSaved]);

  const deleteComment = React.useCallback((id) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    flashSaved();
    if (onUpdate) onUpdate(id, { status: 'deleted' });
  }, [onUpdate, flashSaved]);

  const focusAnnotation = React.useCallback((id, fromMark) => {
    setActiveId(id);
    setRailOpen(true);
    const root = rootRef.current;
    if (root) root.querySelectorAll('mark.anno').forEach((m) => m.classList.toggle('is-active', m.dataset.id === id));
    setTimeout(() => {
      const card = railRef.current?.querySelector(`.anno-card[data-id="${id}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (!fromMark) {
        const mk = root?.querySelector(`mark.anno[data-id="${id}"]`);
        if (mk) mk.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 50);
  }, []);

  const startNewComment = React.useCallback(() => {
    const range = pendingRangeRef.current;
    if (!range) return;
    const root = rootRef.current;
    const idx = textNodes(root);
    const offs = offsetsFromRange(idx, range);
    const pill = document.getElementById('anno-pill');
    if (pill) pill.style.display = 'none';
    window.getSelection().removeAllRanges();
    if (!offs) return;
    const quote = idx.text.slice(offs.start, offs.end);
    const prefix = idx.text.slice(Math.max(0, offs.start - CTX), offs.start);
    const suffix = idx.text.slice(offs.end, offs.end + CTX);
    const section = nearestSection(range);
    // TKT-0172: anchor the text-select comment to its containing block's
    // block_id (primary anchor); quote/prefix/suffix stay as the fallback for
    // locate() if the block_id ever fails to match.
    let blockId = '';
    let btext = quote;
    {
      let n = range.startContainer;
      if (n.nodeType === 3) n = n.parentNode;
      const blockEl = n && n.closest ? n.closest('[data-block-id]') : null;
      if (blockEl) {
        blockId = blockEl.dataset.blockId || '';
        btext = blockText(blockEl);
      }
    }
    setRailOpen(true);
    setPendingComposer({ quote, prefix, suffix, section, blockId, blockText: btext });
  }, []);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    function onSelect() {
      const sel = window.getSelection();
      const pill = document.getElementById('anno-pill');
      const wrap = root;
      if (!pill) return;
      if (!sel || sel.isCollapsed || !sel.rangeCount) { pill.style.display = 'none'; return; }
      const range = sel.getRangeAt(0);
      if (range.collapsed || !range.toString().trim()) { pill.style.display = 'none'; return; }
      if (!wrap.contains(range.commonAncestorContainer)) { pill.style.display = 'none'; return; }
      pendingRangeRef.current = range.cloneRange();
      // TKT-0108: the pill is portaled to .drawer-ticket. The drawer is
      // `position: fixed` and the pill is `position: absolute`, so the pill's
      // containing block is the *drawer*, not the viewport. getBoundingClientRect()
      // returns viewport-relative coords; we clamp the pill inside the drawer's
      // content area (so it never escapes the right edge) and then subtract the
      // drawer origin to express the result in drawer-relative space.
      const rangeRect = range.getBoundingClientRect();
      const drawerEl = document.querySelector(containerSelector);
      const drawerRect = drawerEl ? drawerEl.getBoundingClientRect() : wrap.getBoundingClientRect();
      const pillWidth = pill.offsetWidth || 90;
      let desiredX = rangeRect.left + rangeRect.width / 2;
      let desiredY = rangeRect.top;
      const minX = drawerRect.left + pillWidth / 2 + 4;
      const maxX = drawerRect.right - pillWidth / 2 - 4;
      const x = Math.max(minX, Math.min(maxX, desiredX));
      // #anno-pill is position:absolute inside .drawer-ticket (position:fixed),
      // so its containing block is the drawer, not the viewport. Subtract the
      // drawer origin so the viewport-space clamp value lands in drawer space.
      pill.style.left = `${x - drawerRect.left}px`;
      pill.style.top = `${desiredY - drawerRect.top}px`;
      pill.style.display = 'flex';
    }

    function onKey(e) {
      const t = e.target;
      const typing = t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable;
      if (e.key === 'Escape') {
        document.getElementById('anno-rail')?.classList.remove('open');
        const pill = document.getElementById('anno-pill'); if (pill) pill.style.display = 'none';
        const plus = document.getElementById('anno-block-plus'); if (plus) plus.style.display = 'none';
        return;
      }
      // Cmd+C / bare "c" removed: native copy must not be hijacked, and the
      // comment composer is opened by clicking the pill, not by typing c.
    }

    document.addEventListener('mouseup', onSelect);
    // TKT-0108: instead of hiding the pill on scroll, re-run the positioning
    // math against the still-cached pendingRangeRef. The pill is portaled to
    // the drawer (containing block = drawer, not viewport), so its coords must
    // track the selection's new viewport position minus the drawer origin
    // when the body scrolls underneath.
    document.addEventListener('scroll', () => {
      const p = document.getElementById('anno-pill');
      const r = pendingRangeRef.current;
      if (!p || p.style.display !== 'flex' || !r) return;
      const rangeRect = r.getBoundingClientRect();
      const drawerEl = document.querySelector(containerSelector);
      const drawerRect = drawerEl ? drawerEl.getBoundingClientRect() : null;
      if (!drawerRect) return;
      const pillWidth = p.offsetWidth || 90;
      let desiredX = rangeRect.left + rangeRect.width / 2;
      const minX = drawerRect.left + pillWidth / 2 + 4;
      const maxX = drawerRect.right - pillWidth / 2 - 4;
      p.style.left = `${Math.max(minX, Math.min(maxX, desiredX)) - drawerRect.left}px`;
      p.style.top = `${rangeRect.top - drawerRect.top}px`;
    }, { passive: true });
    document.addEventListener('mousedown', (e) => {
      const p = document.getElementById('anno-pill');
      if (p && p.style.display === 'flex' && !p.contains(e.target)) p.style.display = 'none';
      const gp = document.getElementById('anno-block-plus');
      if (gp && gp.style.display === 'flex' && !gp.contains(e.target)) gp.style.display = 'none';
    });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mouseup', onSelect);
      document.removeEventListener('keydown', onKey);
    };
  }, [startNewComment]);

  const openCount = annotations.filter((a) => a.status === 'open').length;
  const resolvedCount = annotations.filter((a) => a.status === 'resolved').length;
  const visible = docOrder().filter((a) => showResolved || a.status !== 'resolved');
  const [plainComposer, setPlainComposer] = React.useState(false);

  // TKT-0108: hoist rail + FAB out of the scrollable body via a portal to the
  // drawer root. Otherwise both scroll with the body, which the user
  // complained about ("comments drawer and FAB are not sticky"). The pill
  // also tracks text-selection, so it goes through the same portal — its
  // positioning math is rewritten below to use viewport coordinates and
  // `position: fixed` (the previous math was wrap-relative and broke on
  // body scroll; the existing code only hid the pill on scroll as a
  // workaround).
  const drawerHost = typeof document !== 'undefined'
    ? document.querySelector(containerSelector)
    : null;
  const railAndFab = drawerHost ? ReactDOM.createPortal(
    <>
      <div id="anno-pill" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); startNewComment(); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Comment
      </div>

      {/* TKT-0172: block-hover "+" affordance. Portaled to the same positioned
          ancestor as the pill; shown + positioned by the block-hover effect on
          mouseenter of a [data-block-id] block (with a 1s appear / 1s hide
          delay so the cursor can travel from block to "+"). Bridges: while on
          the "+", any pending block-hover hide is cancelled; leaving the "+"
          restarts it (only if the cursor is not also back on a block, see
          plusOn() check in the block-hover effect). Click opens an
          AnnoComposer anchored to that block (block_id primary, block_text as
          quote fallback). */}
      <div
        id="anno-block-plus"
        style={BLOCK_PLUS_STYLE}
        onMouseEnter={() => {
          // Cursor is on the "+". Cancel any pending hide from a block.
          clearTimeout(hidePlusTimerRef.current);
          clearTimeout(showPlusTimerRef.current);
        }}
        onMouseLeave={() => {
          // Cursor left the "+". Re-arm a hide; the hide's fire-time check
          // (plusOn() / onBlock) means a quick bounce back onto a block in
          // the 1s window cancels it naturally.
          hidePlusTimerRef.current = setTimeout(() => {
            const p = document.getElementById('anno-block-plus');
            const onPlus = !!p?.matches?.(':hover');
            if (onPlus) return;
            if (p) p.style.display = 'none';
            hoverBlockRef.current = null;
          }, 1000);
        }}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onClick={() => {
          const hb = hoverBlockRef.current;
          const plus = document.getElementById('anno-block-plus');
          if (plus) plus.style.display = 'none';
          if (!hb || !hb.blockId) return;
          setRailOpen(true);
          setPendingComposer({
            quote: hb.blockText,
            prefix: '',
            suffix: '',
            section: { id: hb.sectionId, title: hb.sectionTitle },
            blockId: hb.blockId,
            blockText: hb.blockText,
          });
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 13, height: 13 }}><path d="M12 5v14M5 12h14"/></svg>
        <span className="anno-block-count" style={{ display: 'none', fontSize: 10, fontWeight: 700, color: '#b394ff', marginLeft: 2 }}></span>
      </div>

      <div id="anno-rail" ref={railRef} className={railOpen ? 'open' : ''}>
        <div className="rail-head">
          <div>
            <div className="t">Comments</div>
            <div className="meta">{openCount} open · {resolvedCount} resolved</div>
          </div>
          <div className="rail-tools">
            <button className="rail-btn" onClick={() => { setRailOpen(true); setPlainComposer(true); }}>+ New</button>
            <button className={`rail-btn ${showResolved ? 'on' : ''}`} onClick={() => setShowResolved((v) => !v)}>
              {showResolved ? 'Hide resolved' : 'Show resolved'}
            </button>
            <button className="rail-btn" onClick={() => setRailOpen(false)}>Close</button>
          </div>
        </div>
        <div id="anno-list">
          {plainComposer && (
            <AnnoComposer
              currentAuthor={currentAuthor}
              onSend={(text, author, tag) => { createComment({ author, body: text, tag }); setPlainComposer(false); }}
              onCancel={() => setPlainComposer(false)}
            />
          )}
          {pendingComposer && (
            <AnnoComposer
              quote={pendingComposer.quote}
              currentAuthor={currentAuthor}
              onSend={(text, author, tag) => {
                createComment({
                  author, body: text,
                  block_id: pendingComposer.blockId || null,
                  quote: pendingComposer.quote,
                  prefix: pendingComposer.prefix || '',
                  suffix: pendingComposer.suffix || '',
                  section: (pendingComposer.section && pendingComposer.section.title) || '',
                  section_id: (pendingComposer.section && pendingComposer.section.id) || '',
                  tag,
                });
                setPendingComposer(null);
              }}
              onCancel={() => setPendingComposer(null)}
            />
          )}
          {visible.length === 0 ? (
            <div className="empty">No comments yet.<br/>Select any text, or click + New.</div>
          ) : visible.map((ann) => (
            <CommentCard
              key={ann.id}
              ann={ann}
              active={ann.id === activeId}
              currentAuthor={currentAuthor}
              onFocus={() => focusAnnotation(ann.id)}
              onResolve={() => updateComment(ann.id, { status: ann.status === 'resolved' ? 'open' : 'resolved' })}
              onDelete={() => deleteComment(ann.id)}
              onReply={(text, author) => addReply(ann.id, text, author)}
              onTagChange={(tag) => updateComment(ann.id, { tag })}
              onEditBody={(text) => updateComment(ann.id, { body: text })}
            />
          ))}
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
      <div ref={rootRef} className="td-md" dangerouslySetInnerHTML={{ __html: html || '' }}/>
      {railAndFab}
    </div>
  );
}

function CommentCard({ ann, active, currentAuthor, onFocus, onResolve, onDelete, onReply, onTagChange, onEditBody }) {
  const [replying, setReplying] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [showTagPicker, setShowTagPicker] = React.useState(false);
  const c = authorMeta(ann.author);
  const tm = tagMeta(ann.tag);
  const editRef = React.useRef(null);

  const startEdit = (e) => {
    e.stopPropagation();
    setDraft(htmlToEditableText(ann.body));
    setEditing(true);
    setReplying(false);
    setTimeout(() => editRef.current?.focus(), 0);
  };
  const saveEdit = () => {
    const t = draft.trim();
    if (!t) return;
    onEditBody(t);
    setEditing(false);
  };
  const cancelEdit = () => { setEditing(false); setDraft(''); };

  return (
    <div
      className={`anno-card ${active ? 'is-active' : ''} ${ann.status === 'resolved' ? 'resolved' : ''} ${ann._orphan ? 'orphan' : ''}`}
      data-id={ann.id}
      style={{ '--_ac': c.color, '--_ac-soft': hexA(c.color, 0.1), '--_ac-bd': hexA(c.color, 0.5) }}
      onClick={onFocus}
    >
      <div className="ch">
        <span className="anno-tag clickable" onClick={(e) => { e.stopPropagation(); setShowTagPicker((v) => !v); }} style={{ '--_tc': tm.color, '--_tc-soft': hexA(tm.color, 0.14), '--_tc-bd': hexA(tm.color, 0.5) }}>
          <span className="ti">{tm.icon}</span>{tm.label}
        </span>
        <span className="anno-chip" style={{ '--_ac': c.color, '--_ac-soft': hexA(c.color, 0.1), '--_ac-bd': hexA(c.color, 0.5) }}>{esc(c.label)}</span>
        <span className="when">{shortTime(ann.created_at)}</span>
      </div>
      {showTagPicker && <TagChipRow inline current={ann.tag} onPick={(tag) => { onTagChange(tag); setShowTagPicker(false); }}/>}
      {ann.quote && <div className="quote">{esc(ann.quote)}</div>}
      {editing ? (
        <div className="anno-composer anno-edit">
          <textarea ref={editRef} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Edit comment…"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); saveEdit(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); } }}/>
          <div className="row">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
              <button className="cancel" onClick={cancelEdit}>esc</button>
              <button className="send" onClick={saveEdit} disabled={!draft.trim()}>Save</button>
            </div>
          </div>
          <div className="hint">Enter to save · Shift+Enter newline · Esc cancel</div>
        </div>
      ) : (
        <div className="body" dangerouslySetInnerHTML={{ __html: bodyHtml(ann.body) }}/>
      )}
      {(ann.replies || []).map((rep, i) => (
        <div className="reply" key={i}>
          <div className="ch">
            <span className="anno-chip" style={{ '--_ac': authorMeta(rep.author).color, '--_ac-soft': hexA(authorMeta(rep.author).color, 0.1), '--_ac-bd': hexA(authorMeta(rep.author).color, 0.5) }}>{esc(authorMeta(rep.author).label)}</span>
            <span className="when">{shortTime(rep.ts)}</span>
          </div>
          <div className="body" dangerouslySetInnerHTML={{ __html: bodyHtml(rep.text) }}/>
        </div>
      ))}
      {replying && <AnnoComposer hideTag currentAuthor={currentAuthor} onSend={(text, author) => { onReply(text, author); setReplying(false); }} onCancel={() => setReplying(false)}/>}
      <div className="acts">
        <button onClick={(e) => { e.stopPropagation(); setReplying(true); }}>Reply</button>
        <button onClick={(e) => { e.stopPropagation(); startEdit(e); }}>Edit</button>
        <button onClick={(e) => { e.stopPropagation(); onResolve(); }}>{ann.status === 'resolved' ? 'Reopen' : 'Resolve'}</button>
        <button className="danger" onClick={(e) => { e.stopPropagation(); onDelete(); }}>Delete</button>
      </div>
    </div>
  );
}

function TagChipRow({ inline, current, onPick }) {
  const [sel, setSel] = React.useState(current || 'note');
  return (
    <div className={`anno-tagrow ${inline ? 'inline' : ''}`}>
      {TA_TAG_ORDER.map((t) => {
        const m = tagMeta(t);
        return (
          <button
            key={t}
            className={`anno-tagchip ${sel === t ? 'on' : ''}`}
            style={{ '--_tc': m.color, '--_tc-soft': hexA(m.color, 0.14), '--_tc-bd': hexA(m.color, 0.5) }}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSel(t); if (onPick) onPick(t); }}
          >
            <span className="ti">{m.icon}</span>{m.label}
          </button>
        );
      })}
    </div>
  );
}

function AnnoComposer({ quote, hideTag, currentAuthor, onSend, onCancel }) {
  const [text, setText] = React.useState('');
  const [author, setAuthor] = React.useState(currentAuthor);
  const [tag, setTag] = React.useState('note');
  const taRef = React.useRef(null);
  React.useEffect(() => { taRef.current?.focus(); }, []);

  const fire = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t, author, tag);
  };

  return (
    <div className="anno-composer">
      {quote && <div className="quote">{esc(quote)}</div>}
      <textarea ref={taRef} value={text} onChange={(e) => setText(e.target.value)} placeholder="Comment — Markdown (+ ```mermaid; > [!NOTE]/[!WARNING]/[!IMPORTANT])"
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); fire(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel && onCancel(); } }}/>
      <div className="row">
        {!hideTag && <TagChipRow current={tag} onPick={setTag}/>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
          <select value={author} onChange={(e) => setAuthor(e.target.value)}>
            {Object.entries(TA_AUTHORS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button className="cancel" onClick={onCancel}>esc</button>
          <button className="send" onClick={fire} disabled={!text.trim()}>Comment</button>
        </div>
      </div>
      <div className="hint">Enter to send · Shift+Enter newline · Esc cancel</div>
    </div>
  );
}

window.TdAnnotate = TdAnnotate;
