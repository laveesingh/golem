// HTML spec-body pipeline (GOL-326 D2/D3): server-owned parsing, sanitization,
// stable block IDs and atomic block operations for HTML spec bodies.
//
// Standards-based only: parsing and serialization use parse5's spec-compliant
// HTML fragment parser — never regex (D2). The sanitizer enforces the locked
// safe boundary: semantic HTML + SVG + data-*/ARIA; scripts, event handlers,
// styles, forms, frames/embeds and executable URLs are stripped; the pipeline
// rejects a body whose meaningful content sanitizes away to nothing.
//
// Block identity (D3): the server owns IDs. Canonical bodies persist opaque
// `data-block-id="b-<opaque>"` values on every top-level element and on the
// nested commentable kinds (ul/ol/li/table/tr). Valid unique persisted IDs are
// preserved; duplicate, malformed or reserved IDs fail normalization instead of
// being silently retargeted. Parent/kind metadata is derived from structure at
// read time and never persisted.
import crypto from 'node:crypto';
import * as parse5 from 'parse5';
// GOL-369 D2: the owned error family lives in the shared anchor module so
// both engines throw one class identity; re-exported here so existing
// import paths keep working.
import { TrackerInputError, badRequest, notFound, revisionConflict, resolveAnchor, resolveEditRange } from './body-anchor.js';

export { TrackerInputError, badRequest, notFound, revisionConflict };

export const BODY_FORMATS = Object.freeze(['markdown', 'html']);

// Elements removed together with their content: anything executable, styleable
// from the document side, or able to fetch/embed content.
const DROP_WITH_CONTENT = new Set(['script', 'style', 'noscript', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'template', 'title', 'base', 'meta', 'link']);

// Disallowed-but-keep-children elements: forms and interactive controls are
// stripped as elements so authored content is not silently deleted.
const UNWRAP = new Set(['form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea',
  'datalist', 'output', 'progress', 'meter', 'audio', 'video', 'source', 'track', 'canvas',
  'dialog', 'slot', 'portal']);

// Safe semantic/structural tags, including the SVG vocabulary the existing
// dashboard sanitizer keeps (diagrams are first-class content).
const ALLOWED_TAGS = new Set([
  'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'address', 'hgroup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'span', 'br', 'hr',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'menu',
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'figure', 'figcaption', 'img', 'picture',
  'a', 'code', 'pre', 'kbd', 'samp', 'var', 'blockquote', 'q', 'cite',
  'strong', 'em', 'b', 'i', 'u', 's', 'small', 'mark', 'sub', 'sup', 'abbr', 'dfn', 'time', 'wbr',
  'details', 'summary', 'ruby', 'rt', 'rp', 'bdi', 'bdo',
  'svg', 'math',
  'path', 'g', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'defs', 'marker', 'use', 'symbol', 'clippath', 'mask', 'pattern', 'lineargradient',
  'radialgradient', 'stop', 'view',
]);

// Attributes allowed on any element, plus tag-specific extras. `data-*` and
// `aria-*` pass through (block identity needs them); `style` and `on*` never.
const GLOBAL_ATTRS = new Set(['class', 'title', 'id', 'dir', 'lang', 'role', 'tabindex']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'poster', 'cite']);
const TAG_ATTRS = new Map([
  ['a', new Set(['href', 'target', 'rel', 'hreflang', 'type'])],
  ['img', new Set(['src', 'alt', 'width', 'height', 'loading', 'decoding'])],
  ['td', new Set(['colspan', 'rowspan', 'headers'])],
  ['th', new Set(['colspan', 'rowspan', 'headers', 'scope', 'abbr'])],
  ['col', new Set(['span'])],
  ['colgroup', new Set(['span'])],
  ['ol', new Set(['start', 'reversed', 'type'])],
  ['li', new Set(['value'])],
  ['details', new Set(['open'])],
  ['time', new Set(['datetime'])],
  ['svg', new Set(['viewbox', 'preserveaspectratio', 'xmlns', 'xmlns:xlink', 'width', 'height', 'fill', 'stroke'])],
  ['use', new Set(['x', 'y'])],
  ['symbol', new Set(['viewbox', 'preserveaspectratio'])],
  ['marker', new Set(['viewbox', 'refx', 'refy', 'markerwidth', 'markerheight', 'orient'])],
  ['pattern', new Set(['viewbox', 'patternunits'])],
  ['mask', new Set(['maskunits', 'maskcontentunits'])],
  ['clippath', new Set(['clippathunits'])],
  ['lineargradient', new Set(['x1', 'y1', 'x2', 'y2', 'gradientunits', 'spreadmethod'])],
  ['radialgradient', new Set(['cx', 'cy', 'r', 'fx', 'fy', 'gradientunits', 'spreadmethod'])],
  ['stop', new Set(['offset', 'stop-color', 'stop-opacity'])],
]);

// URL schemes that cannot execute. Relative and fragment URLs are safe; data:
// images survive for inline figures only (img src); everything else data: — and
// every javascript: — is stripped with the executable ones.
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
function isSafeUrl(value, { attributeName, tagName }) {
  const raw = String(value ?? '').trim();
  if (raw === '' || raw.startsWith('#')) return true;
  // SVG <use> may only reference same-document fragments: external file or
  // cross-origin references would fetch content the document does not own.
  if (tagName === 'use') return false;
  if (raw.startsWith('/') && !raw.startsWith('//')) return true;
  if (raw.startsWith('./')) return true;
  // Protocol-relative URLs inherit the scheme at render time and can point at
  // any external origin — rejected alongside the executable ones.
  if (raw.startsWith('//')) return false;
  if (/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/i.test(raw)) {
    return attributeName === 'src' && tagName === 'img';
  }
  if (/^data:/i.test(raw) || /^javascript:/i.test(raw) || /^vbscript:/i.test(raw)) return false;
  try {
    return SAFE_URL_SCHEMES.has(new URL(raw, 'https://golem.invalid').protocol);
  } catch {
    return false;
  }
}

// Commentable block kinds. Top-level elements are blocks; inside them, the
// nested structural kinds the dashboard already treats as commentable today
// (td-annotate NESTED_BLOCK_KINDS) are blocks too.
const NESTED_BLOCK_KINDS = new Map([['ul', 'list'], ['ol', 'list'], ['li', 'item'], ['table', 'table'], ['tr', 'row']]);
// Structural containers whose descendants are walked for nested blocks.
const CONTAINER_TAGS = new Set(['section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'div', 'details', 'figure', 'blockquote']);

export const BLOCK_ID_PATTERN = /^b-[a-z0-9]{8,64}$/;

function isElement(node) {
  return node?.nodeName !== undefined && node.tagName !== undefined;
}
const SVG_NS = 'http://www.w3.org/2000/svg';
// Geometry/presentation attributes allowed on SVG-subtree elements.
const SVG_ATTRS = new Set(['d', 'r', 'cx', 'cy', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'dx', 'dy',
  'rx', 'ry', 'points', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke',
  'stroke-opacity', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'opacity', 'offset', 'stop-color', 'stop-opacity', 'font-family', 'font-size', 'font-weight',
  'text-anchor', 'marker-end', 'marker-start', 'marker-mid', 'gradientunits', 'patternunits',
  'maskunits', 'maskcontentunits', 'clippathunits', 'spreadmethod', 'dominant-baseline',
  'paint-order', 'vector-effect']);
function childElements(node) {
  return (node.childNodes ?? []).filter(isElement);
}
function attrValue(node, name) {
  return node.attrs?.find((a) => a.name === name)?.value ?? null;
}
function hasAttr(node, name) {
  return node.attrs?.some((a) => a.name === name) ?? false;
}
function setAttr(node, name, value) {
  const existing = node.attrs?.find((a) => a.name === name);
  if (existing) existing.value = value;
  else node.attrs.push({ name, value });
}
function removeAttr(node, name) {
  if (!node.attrs) return;
  node.attrs = node.attrs.filter((a) => a.name !== name);
}

/** Serialize element nodes (outer HTML each) or a fragment container. */
export function serializeNodes(nodes) {
  return parse5.serialize({ childNodes: nodes, nodeName: '#document-fragment' });
}

/** Sanitize one parsed node. Returns the kept node(s), or null when dropped. */
function sanitizeNode(node) {
  if (node.nodeName === '#text') return node.value != null && node.value !== '' ? node : null;
  if (node.nodeName === '#comment' || node.nodeName === '#documentType') return null;
  if (!isElement(node)) return null;
  const tag = node.tagName.toLowerCase();
  if (DROP_WITH_CONTENT.has(tag)) return null;
  const keptAttrs = [];
  const inSvg = node.namespaceURI === SVG_NS;
  for (const attr of node.attrs ?? []) {
    const name = (attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name).toLowerCase();
    if (name.startsWith('on') || name === 'style') continue;
    if (name.startsWith('data-') || name.startsWith('aria-')) { keptAttrs.push(attr); continue; }
    if (URL_ATTRS.has(name)) {
      if (isSafeUrl(attr.value, { attributeName: name, tagName: tag })) keptAttrs.push(attr);
      continue;
    }
    if (GLOBAL_ATTRS.has(name) || TAG_ATTRS.get(tag)?.has(name)
      || (inSvg && SVG_ATTRS.has(name)) || (inSvg && TAG_ATTRS.get('svg')?.has(name))) keptAttrs.push(attr);
  }
  node.attrs = keptAttrs;
  const children = [];
  for (const child of node.childNodes ?? []) {
    const kept = sanitizeNode(child);
    if (!kept) continue;
    // Unwrapped elements splice their sanitized children into this node.
    if (Array.isArray(kept)) children.push(...kept);
    else children.push(kept);
  }
  if (UNWRAP.has(tag) || !ALLOWED_TAGS.has(tag)) {
    // Unwrap: the element is dropped, its sanitized children splice upward.
    return children;
  }
  node.childNodes = children;
  return node;
}

function flattenKept(nodes, out = []) {
  for (const node of nodes) {
    if (Array.isArray(node)) flattenKept(node, out);
    else out.push(node);
  }
  return out;
}

/** Sanitize a parsed fragment; returns the surviving top-level nodes. */
function sanitizeFragment(fragment) {
  const kept = flattenKept((fragment.childNodes ?? []).map(sanitizeNode).filter(Boolean));
  return kept.filter((node) => (node.nodeName === '#text' ? String(node.value ?? '').trim() !== '' : true));
}

/** Exposed for the DB patch pipeline: live doc + canonical serialization. */
export function parseAndNormalizeDoc(rawHtml) {
  const { doc, html, ids } = parseAndNormalizeDocInternal(rawHtml);
  return { doc, html, ids, blocks: outlineFromDoc(doc, ids) };
}

function parseAndNormalizeDocInternal(rawHtml) {
  const fragment = parse5.parseFragment(String(rawHtml ?? ''));
  const kept = sanitizeFragment(fragment);
  // Wrap stray top-level text into a <p> block so every document part is
  // addressable; whitespace-only text is dropped.
  const wrapped = [];
  for (const node of kept) {
    if (node.nodeName === '#text') {
      const p = parse5.parseFragment('<p></p>').childNodes[0];
      p.childNodes = [{ nodeName: '#text', value: node.value }];
      wrapped.push(p);
      continue;
    }
    wrapped.push(node);
  }
  if (!wrapped.length) {
    throw badRequest('html body has no meaningful content after sanitization', 'empty_html_body');
  }
  const doc = { childNodes: wrapped, nodeName: '#document-fragment' };
  const ids = assignBlockIds(doc);
  return { doc, html: serializeNodes(doc.childNodes), ids };
}

/** Public normalization: canonical html + outline metadata. */
export function normalizeHtmlBody(rawHtml) {
  const { doc, html, ids } = parseAndNormalizeDoc(rawHtml);
  return { html, blocks: outlineFromDoc(doc, ids), ids };
}

/** Assign or validate data-block-id on the parsed document (D3 rules 1–4). */
function assignBlockIds(fragment) {
  const ids = new Set();
  const ensure = (node, { allowAssign }) => {
    const existing = attrValue(node, 'data-block-id');
    if (existing != null) {
      if (!BLOCK_ID_PATTERN.test(existing)) {
        throw badRequest(`malformed data-block-id '${existing}'`, 'malformed_block_id', { block_id: existing });
      }
      if (ids.has(existing)) {
        throw badRequest(`duplicate data-block-id '${existing}'`, 'duplicate_block_id', { block_id: existing });
      }
      ids.add(existing);
      return;
    }
    if (!allowAssign) return;
    let id;
    do { id = `b-${crypto.randomBytes(6).toString('hex')}`; } while (ids.has(id));
    ids.add(id);
    setAttr(node, 'data-block-id', id);
    removeAttr(node, 'data-block-parent-id');
    removeAttr(node, 'data-block-kind');
  };
  const walk = (node, depth) => {
    for (const el of childElements(node)) {
      const tag = el.tagName.toLowerCase();
      const marked = hasAttr(el, 'data-block-id');
      // Rule 3: explicitly marked descendant IDs are preserved (and validated).
      // Rule 2: top-level elements and nested structural kinds get IDs.
      ensure(el, { allowAssign: marked || depth === 0 || NESTED_BLOCK_KINDS.has(tag) });
      walk(el, depth + 1);
    }
  };
  walk(fragment, 0);
  return ids;
}

function textContentOf(node) {
  if (node.nodeName === '#text') return node.value ?? '';
  let out = '';
  for (const child of node.childNodes ?? []) out += textContentOf(child);
  return out;
}

/** Readable text for search/outline: no tags, no script/style content (A11). */
export function searchTextFromHtml(html) {
  const fragment = parse5.parseFragment(String(html ?? ''));
  const drop = (node) => isElement(node) && DROP_WITH_CONTENT.has(node.tagName.toLowerCase());
  const blocky = new Set(['p', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'section',
    'article', 'table', 'pre', 'blockquote', 'div', 'details']);
  const walk = (node) => {
    if (node.nodeName === '#text') return node.value ?? '';
    if (!isElement(node)) return '';
    let out = '';
    for (const child of node.childNodes ?? []) {
      if (drop(child)) continue;
      out += walk(child);
      if (blocky.has(child.tagName?.toLowerCase())) out += '\n';
    }
    return out;
  };
  let out = '';
  for (const node of fragment.childNodes ?? []) {
    if (drop(node)) continue;
    out += walk(node);
    if (blocky.has(node.tagName?.toLowerCase())) out += '\n';
  }
  return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Outline metadata for an already-normalized document: every element carrying
 * data-block-id in document order, with nearest block ancestor and kind.
 */
export function outlineFromDoc(fragment, ids = null) {
  const allIds = ids ?? new Set();
  const blocks = [];
  const walk = (node, parentId) => {
    for (const child of childElements(node)) {
      const id = attrValue(child, 'data-block-id');
      if (id) {
        allIds.add(id);
        const tag = child.tagName.toLowerCase();
        const outer = serializeNodes([child]);
        const text = textContentOf(child).replace(/\s+/g, ' ').trim();
        blocks.push({
          id,
          parent_id: parentId,
          kind: NESTED_BLOCK_KINDS.get(tag) ?? tag,
          tag,
          heading: /^h[1-6]$/.test(tag) ? text : null,
          short_text: text.slice(0, 160),
          hash: sha256(outer),
        });
        walk(child, id);
      } else {
        walk(child, parentId);
      }
    }
  };
  walk(fragment, null);
  return blocks;
}

/** Canonical outer HTML of one block by ID (null when absent). */
export function blockHtmlFromDoc(doc, blockId) {
  const hit = findBlockNode(doc, blockId);
  return hit ? serializeNodes([hit]) : null;
}

/** Deepest element node carrying data-block-id === blockId (null when absent). */
export function findBlockNode(node, blockId) {
  for (const child of childElements(node)) {
    if (attrValue(child, 'data-block-id') === blockId) return child;
    const hit = findBlockNode(child, blockId);
    if (hit) return hit;
  }
  return null;
}

/**
 * Whole-document anchor search text (GOL-369 D2): the text content with
 * whitespace collapsed, plus per-character innermost-block ownership so an
 * anchor resolves to the innermost block covering its text.
 * Returns `{text, spans}` where spans are `{start, end, ref: blockId}`.
 */
export function htmlAnchorIndex(doc) {
  const raw = [];
  const walk = (node, stack) => {
    if (node.nodeName === '#text') {
      const innermost = stack.length ? stack[stack.length - 1] : null;
      for (const ch of String(node.value ?? '')) raw.push({ ch, block: innermost });
      return;
    }
    if (!isElement(node)) {
      // Fragment roots (and any other non-element containers) splice through.
      for (const child of node.childNodes ?? []) walk(child, stack);
      return;
    }
    const id = attrValue(node, 'data-block-id');
    const next = id ? [...stack, id] : stack;
    for (const child of node.childNodes ?? []) walk(child, next);
  };
  walk(doc, []);
  let text = '';
  const owner = [];
  let pending = false;
  let pendingBlock = null;
  for (const { ch, block } of raw) {
    if (/\s/.test(ch)) {
      pending = true;
      pendingBlock = pendingBlock ?? block;
      continue;
    }
    if (pending && text.length) {
      text += ' ';
      owner.push(pendingBlock ?? block);
    }
    pending = false;
    pendingBlock = null;
    text += ch;
    owner.push(block);
  }
  const ranges = new Map();
  owner.forEach((block, idx) => {
    if (!block) return;
    const r = ranges.get(block) ?? { start: idx, end: idx + 1 };
    r.start = Math.min(r.start, idx);
    r.end = Math.max(r.end, idx + 1);
    ranges.set(block, r);
  });
  return { text, spans: [...ranges].map(([block, r]) => ({ ...r, ref: block })) };
}

/** Strict anchor → block id against a normalized live document (D2). */
export function resolveHtmlAnchor(doc, anchor) {
  const { text, spans } = htmlAnchorIndex(doc);
  return resolveAnchor(text, spans, anchor).ref;
}

/**
 * Section HTML for a heading block: the heading through the next sibling
 * heading of the same or a higher level, inside the same parent (D4).
 * Returns `{level, html}` with the joined canonical outer HTML.
 */
export function htmlSectionHtml(doc, blockId) {
  const node = findBlockNode(doc, blockId);
  if (!node) return null;
  const tag = node.tagName.toLowerCase();
  const hm = /^h([1-6])$/.exec(tag);
  if (!hm) {
    throw badRequest(`section operations need a heading block, not '${tag}'`, 'section_target_not_heading', { block_id: blockId });
  }
  const level = Number(hm[1]);
  const container = findBlockContainer(doc, node);
  const siblings = childElements(container);
  const startIdx = siblings.indexOf(node);
  let endIdx = siblings.length;
  for (let k = startIdx + 1; k < siblings.length; k += 1) {
    const kh = /^h([1-6])$/.exec(siblings[k].tagName.toLowerCase());
    if (kh && Number(kh[1]) <= level) { endIdx = k; break; }
  }
  return { level, html: serializeNodes(siblings.slice(startIdx, endIdx)) };
}

function findBlockContainer(node, target) {
  for (const child of childElements(node)) {
    if (child === target) return node;
    if (childElements(child).length) {
      const hit = findBlockContainer(child, target);
      if (hit) return hit;
    }
  }
  return node;
}

/**
 * Parse + sanitize an operation payload fragment: exactly one root element
 * (stray top-level text is invalid for an operation), no full normalization —
 * ID assignment happens against the live document in applyBlockOperations.
 * Returns the root element node.
 */
function parseOperationBlock(html, op) {
  const fragment = parse5.parseFragment(String(html ?? ''));
  const kept = flattenKept((fragment.childNodes ?? []).map(sanitizeNode).filter(Boolean));
  const elements = kept.filter(isElement);
  if (elements.length !== 1 || kept.some((n) => n.nodeName === '#text')) {
    throw badRequest(`operation '${op}': html must contain exactly one root element`, 'invalid_block_html', { op });
  }
  return elements[0];
}

/**
 * Apply an ordered operations batch to a normalized live document. Every
 * operation is validated against the document state at its position in the
 * batch; nothing is persisted by this module — any failure throws and the
 * caller writes nothing (atomic batch, A6).
 *
 * Returns { html, inserted, removed, ids, blocks }:
 *   inserted — the assigned IDs of inserted roots, in operation order.
 *   removed  — every persisted ID that no longer exists (remove + descendants
 *              of removed/replaced subtrees), used for detached comments.
 */
export function applyBlockOperations(doc, operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw badRequest('operations must be a non-empty array', 'invalid_operations');
  }
  // GOL-369 D4: one grammar for both formats. `content` is an alias of
  // `html`; targeting is `block_id` OR `anchor`, never both; moves take
  // `anchor_block_id` OR `to_anchor`. `edit` runs on the serialized
  // canonical body; section ops span same-parent sibling headings.
  const OPS = new Set(['replace', 'insert_before', 'insert_after', 'move_before', 'move_after', 'remove',
    'edit', 'replace_section', 'append_to_section']);
  const blockId = (node) => attrValue(node, 'data-block-id');
  // One flat index of id → { node, container, parentBlockId } rebuilt per
  // operation so removed IDs simply stop resolving mid-batch.
  const index = () => {
    const map = new Map();
    const walk = (container, parentBlockId) => {
      for (const child of childElements(container)) {
        const id = blockId(child);
        if (id) {
          map.set(id, { node: child, container, parentBlockId });
          walk(child, id);
        } else {
          walk(child, parentBlockId);
        }
      }
    };
    walk(doc, null);
    return map;
  };
  const collectIds = (node, acc = []) => {
    const id = blockId(node);
    if (id) acc.push(id);
    for (const child of childElements(node)) collectIds(child, acc);
    return acc;
  };
  const descendsFrom = (candidate, ancestor) =>
    childElements(ancestor).some((child) => child === candidate || descendsFrom(candidate, child));
  const insertRootIds = [];
  for (const op of operations) {
    const name = String(op?.op ?? '');
    if (!OPS.has(name)) throw badRequest(`unknown operation '${name}'`, 'invalid_operation', { op: name });
    const map = index();
    const hasId = op.block_id != null;
    const hasAnchor = op.anchor != null;
    if (hasId && hasAnchor) {
      throw badRequest(`operation '${name}': give block_id or anchor, never both`, 'invalid_target', { op: name });
    }
    // Whole-body edit on the serialized canonical body. `old` must occur
    // exactly once (prefix/suffix allowed); touching `data-block-*` fails so
    // identity can never be forged or dropped by an edit. Renormalized after,
    // so persisted ids survive.
    if (name === 'edit') {
      if (hasId || hasAnchor) {
        throw badRequest(`operation 'edit': targets the whole body; drop block_id/anchor`, 'invalid_target', { op: name });
      }
      const oldText = String(op.old ?? '');
      if (!oldText) throw badRequest(`operation 'edit': old is required and must be non-empty`, 'invalid_operation', { op: name });
      if (typeof op.new !== 'string') {
        throw badRequest(`operation 'edit': new is required and must be a string`, 'invalid_operation', { op: name });
      }
      if (/data-block-/i.test(oldText) || /data-block-/i.test(op.new)) {
        throw badRequest(`operation 'edit': must not touch data-block-* attributes`, 'protected_attribute', { op: name });
      }
      const canonical = serializeNodes(doc.childNodes);
      const { start, end } = resolveEditRange(canonical, op);
      const fresh = parseAndNormalizeDocInternal(canonical.slice(0, start) + op.new + canonical.slice(end));
      doc.childNodes = fresh.doc.childNodes;
      continue;
    }
    const resolveTargetId = () => {
      if (hasAnchor) return resolveHtmlAnchor(doc, op.anchor);
      if (!hasId) throw badRequest(`operation '${name}': block_id or anchor is required`, 'invalid_operation', { op: name });
      return String(op.block_id);
    };
    const requireTarget = (id, field = 'block_id') => {
      if (!id) throw badRequest(`operation '${name}': ${field} is required`, 'invalid_operation', { op: name });
      const entry = map.get(String(id));
      if (!entry) throw notFound(`operation '${name}': block '${id}' not found`, 'block_not_found', { block_id: id, op: name });
      return entry;
    };
    // `content` is the cross-format payload name; `html` stays accepted.
    const payloadHtml = () => {
      const payload = op.html ?? op.content;
      if (typeof payload !== 'string' || !payload) {
        throw badRequest(`operation '${name}': html/content is required and must be non-empty`, 'invalid_operation', { op: name });
      }
      return payload;
    };
    const replaceChild = (entry, replacement) => {
      const siblings = entry.container.childNodes;
      siblings.splice(siblings.indexOf(entry.node), 1, replacement);
    };
    if (name === 'remove') {
      const entry = requireTarget(resolveTargetId());
      entry.container.childNodes.splice(entry.container.childNodes.indexOf(entry.node), 1);
      continue;
    }
    if (name === 'replace') {
      const targetId = resolveTargetId();
      const entry = requireTarget(targetId);
      const root = parseOperationBlock(payloadHtml(), name);
      // The replacement root retains the target ID (write contract); duplicate
      // or malformed descendant IDs fail the batch in the final validation.
      setAttr(root, 'data-block-id', targetId);
      removeAttr(root, 'data-block-parent-id');
      removeAttr(root, 'data-block-kind');
      replaceChild(entry, root);
      continue;
    }
    if (name === 'insert_before' || name === 'insert_after') {
      const entry = requireTarget(resolveTargetId());
      const root = parseOperationBlock(payloadHtml(), name);
      removeAttr(root, 'data-block-parent-id');
      removeAttr(root, 'data-block-kind');
      const siblings = entry.container.childNodes;
      const at = siblings.indexOf(entry.node) + (name === 'insert_after' ? 1 : 0);
      siblings.splice(at, 0, root);
      insertRootIds.push(root);
      continue;
    }
    if (name === 'move_before' || name === 'move_after') {
      const targetId = resolveTargetId();
      const entry = requireTarget(targetId);
      const destHasId = op.anchor_block_id != null;
      const destHasAnchor = op.to_anchor != null;
      if (destHasId && destHasAnchor) {
        throw badRequest(`operation '${name}': give anchor_block_id or to_anchor, never both`, 'invalid_target', { op: name });
      }
      const destId = destHasAnchor ? resolveHtmlAnchor(doc, op.to_anchor) : op.anchor_block_id;
      const anchor = requireTarget(destId, 'anchor_block_id');
      if (entry.node === anchor.node) {
        throw badRequest(`operation '${name}': cannot move a block relative to itself`, 'invalid_move',
          { block_id: targetId });
      }
      if (descendsFrom(anchor.node, entry.node)) {
        throw badRequest(`operation '${name}': cannot move '${targetId}' relative to its own descendant '${anchor.node === entry.node ? targetId : destId}'`,
          'invalid_move', { block_id: targetId, anchor_block_id: destId });
      }
      entry.container.childNodes.splice(entry.container.childNodes.indexOf(entry.node), 1);
      anchor.container.childNodes.splice(
        anchor.container.childNodes.indexOf(anchor.node) + (name === 'move_after' ? 1 : 0), 0, entry.node);
      continue;
    }
    // Section ops: heading through the next sibling heading of the same or a
    // higher level, inside the same parent element.
    if (name === 'replace_section' || name === 'append_to_section') {
      const targetId = resolveTargetId();
      const entry = requireTarget(targetId);
      const section = htmlSectionHtml(doc, targetId);
      const root = parseOperationBlock(payloadHtml(), name);
      removeAttr(root, 'data-block-parent-id');
      removeAttr(root, 'data-block-kind');
      const kids = entry.container.childNodes;
      const siblings = childElements(entry.container);
      const startIdx = siblings.indexOf(entry.node);
      let endIdx = siblings.length;
      for (let k = startIdx + 1; k < siblings.length; k += 1) {
        const kh = /^h([1-6])$/.exec(siblings[k].tagName.toLowerCase());
        if (kh && Number(kh[1]) <= section.level) { endIdx = k; break; }
      }
      if (name === 'append_to_section') {
        const before = endIdx < siblings.length ? siblings[endIdx] : null;
        kids.splice(before ? kids.indexOf(before) : kids.length, 0, root);
      } else {
        const at = kids.indexOf(siblings[startIdx]);
        for (let k = endIdx - 1; k >= startIdx; k -= 1) kids.splice(kids.indexOf(siblings[k]), 1);
        kids.splice(at, 0, root);
      }
      insertRootIds.push(root);
      continue;
    }
    throw badRequest(`unknown operation '${name}'`, 'invalid_operation', { op: name });
  }
  // Final validation pass: assigns IDs to new content (inserts, replacement
  // descendants), preserves valid caller-supplied IDs, and fails the whole
  // batch on duplicate/malformed IDs anywhere. The caller computes `removed`
  // from the pre-batch ID set minus this post-batch set so removed-subtree
  // descendants detach explicitly.
  const ids = assignBlockIds(doc);
  return {
    html: serializeNodes(doc.childNodes),
    inserted: insertRootIds.map((root) => blockId(root)).filter(Boolean),
    ids,
    blocks: outlineFromDoc(doc, ids),
  };
}