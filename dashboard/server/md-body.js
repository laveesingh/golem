// Markdown block engine (GOL-369 R1, D1–D4).
//
// Blocks are top-level `marked` tokens: joining every token's `raw` returns
// the source byte for byte, so untouched blocks never re-format. `space`
// tokens (blank lines) join the block before them; a leading `space` joins
// the first block. `<details>` groups into a container block (targeting view
// only — the join stays the flat token stream): the opening `<details>`
// token through its matching `</details>` token is one container, the inner
// tokens become its child blocks. There are no stored ids (non-goal); every
// operation targets by strict text anchor via `body-anchor.js`.
//
// Sections (D4): a heading through the next heading of the same or a higher
// level (smaller number), ending at the container boundary — a heading inside
// `<details>` bounds a section inside it only.

import { marked } from 'marked';
import { badRequest, resolveAnchor, resolveEditRange } from './body-anchor.js';

const HEADING_LEVELS = { heading: true };

/** True when an `html` token opens a `<details>` container (not self-closed). */
function isDetailsOpen(token) {
  return token?.type === 'html'
    && /^\s*<details[\s>]/i.test(token.raw ?? '')
    && !/<\/details\s*>/i.test(token.raw ?? '');
}

/** True when an `html` token carries a `</details>` close. */
function isDetailsClose(token) {
  return token?.type === 'html' && /<\/details\s*>/i.test(token.raw ?? '');
}

function blockKind(token) {
  if (token.type === 'text') return 'paragraph';
  return token.type;
}

function headingText(token) {
  if (token.type === 'heading') return String(token.text ?? '').trim();
  if (token.type === 'details-container') {
    const m = /<summary>([\s\S]*?)<\/summary>/i.exec(token.openRaw ?? '');
    if (m) return m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || null;
    return null;
  }
  return null;
}

function shortText(token, raw) {
  const base = typeof token.text === 'string' && token.text ? token.text : raw;
  return String(base).replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * Split a token slice into blocks with absolute offsets.
 * @param {Array} tokens marked lexer tokens
 * @param {number} base absolute offset of tokens[0].raw in the document
 */
function splitTokens(tokens, base) {
  const blocks = [];
  let offset = base;
  let pendingLeading = '';
  let pendingLeadingStart = base;
  const flushLeading = (block) => {
    if (pendingLeading) {
      block.raw = pendingLeading + block.raw;
      block.start = pendingLeadingStart;
      pendingLeading = '';
    }
  };
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.type === 'space') {
      if (blocks.length === 0) {
        if (!pendingLeading) pendingLeadingStart = offset;
        pendingLeading += token.raw;
      } else {
        const last = blocks[blocks.length - 1];
        last.raw += token.raw;
        last.end += token.raw.length;
      }
      offset += token.raw.length;
      i += 1;
      continue;
    }
    if (isDetailsOpen(token)) {
      // Consume through the matching close (nested <details> deepen).
      let depth = 1;
      let j = i + 1;
      while (j < tokens.length && depth > 0) {
        if (isDetailsOpen(tokens[j])) depth += 1;
        else if (isDetailsClose(tokens[j])) depth -= 1;
        j += 1;
      }
      const closeIndex = depth === 0 ? j - 1 : tokens.length;
      const inner = tokens.slice(i + 1, depth === 0 ? closeIndex : tokens.length);
      const openLen = token.raw.length;
      const children = splitTokens(inner, offset + openLen);
      let raw = '';
      const rawEnd = depth === 0 ? closeIndex + 1 : tokens.length;
      for (let k = i; k < rawEnd; k += 1) raw += tokens[k].raw;
      const block = {
        kind: 'details',
        raw,
        start: offset,
        end: offset + raw.length,
        level: null,
        heading: null,
        children,
        // Offset where the tiled children end: start of the closing token,
        // or the container end when unterminated. Section bounds stop here.
        innerEnd: offset + raw.length - (depth === 0 ? tokens[closeIndex].raw.length : 0),
      };
      block.heading = headingText({ type: 'details-container', openRaw: token.raw });
      block.short_text = shortText({ text: block.heading ?? '' }, raw);
      offset += raw.length;
      flushLeading(block);
      blocks.push(block);
      i = rawEnd;
      continue;
    }
    const block = {
      kind: blockKind(token),
      raw: token.raw,
      start: offset,
      end: offset + token.raw.length,
      level: token.type === 'heading' ? token.depth : null,
      heading: token.type === 'heading' ? String(token.text ?? '').trim() : null,
      children: null,
    };
    block.short_text = shortText(token, token.raw);
    offset += token.raw.length;
    flushLeading(block);
    blocks.push(block);
    i += 1;
  }
  return blocks;
}

/** Split Markdown source into top-level blocks (byte-exact join). */
export function splitMarkdownBlocks(src) {
  const text = String(src ?? '');
  return splitTokens(marked.lexer(text), 0);
}

/** Rebuild the source by joining block raws — byte for byte. */
export function joinBlocks(blocks) {
  return (blocks ?? []).map((b) => b.raw).join('');
}

/** Flat `{start, end, ref}` spans over the source, containers and children both. */
export function spansFromBlocks(blocks) {
  const spans = [];
  const walk = (list) => {
    for (const block of list ?? []) {
      spans.push({ start: block.start, end: block.end, ref: block });
      if (block.children) walk(block.children);
    }
  };
  walk(blocks);
  return spans;
}

/** Outline entries `{kind, heading, level, section, short_text}` (D5 — no ids). */
export function outlineFromMarkdown(src) {
  const blocks = splitMarkdownBlocks(src);
  const entries = [];
  const stack = [];
  const walk = (list) => {
    for (const block of list) {
      if (block.kind === 'heading') {
        while (stack.length && stack[stack.length - 1].level >= block.level) stack.pop();
        stack.push({ level: block.level, heading: block.heading });
      }
      entries.push({
        kind: block.kind,
        heading: block.heading,
        level: block.level,
        section: stack.map((s) => s.heading).join(' > '),
        short_text: block.short_text,
      });
      if (block.children) walk(block.children);
    }
  };
  walk(blocks);
  return entries;
}

/** Locate a block's sibling array + index (top-level or inside a container). */
function locateBlock(blocks, target) {
  const walk = (list, parent) => {
    for (let index = 0; index < list.length; index += 1) {
      if (list[index] === target) return { siblings: list, index, parent };
      if (list[index].children) {
        const hit = walk(list[index].children, list[index]);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(blocks, null);
}

/**
 * Section range for a heading block: indexes `[index, end)` in its sibling
 * array, ending at the next heading of the same or a higher level, or at the
 * sibling (container) boundary.
 */
function sectionRange(blocks, headingBlock) {
  if (!HEADING_LEVELS[headingBlock.kind] && headingBlock.kind !== 'heading') {
    throw badRequest(
      `operation targets a '${headingBlock.kind}' block; section operations need a heading`,
      'section_target_not_heading',
    );
  }
  const located = locateBlock(blocks, headingBlock);
  if (!located) throw badRequest('section target is not in the document', 'block_not_found');
  const { siblings, index } = located;
  let end = siblings.length;
  for (let k = index + 1; k < siblings.length; k += 1) {
    const candidate = siblings[k];
    if (candidate.kind === 'heading' && candidate.level <= headingBlock.level) { end = k; break; }
  }
  return { siblings, index, end, parent: located.parent };
}

/** Boundary offset where a section range ends (next heading start or container end). */
function rangeEndOffset(blocks, range, srcLength) {
  if (range.end < range.siblings.length) return range.siblings[range.end].start;
  if (range.parent) return range.parent.innerEnd;
  return srcLength;
}

/** Junction separator guaranteeing one blank line between non-empty parts. */
function blankBetween(before, after) {
  if (!before || !after) return '';
  if (before.endsWith('\n\n') || after.startsWith('\n\n')) return '';
  if (before.endsWith('\n') || after.startsWith('\n')) return '\n';
  return '\n\n';
}

function spliceWithContent(src, at, removeEnd, content) {
  const left = src.slice(0, at);
  const right = src.slice(removeEnd);
  return left + blankBetween(left, content) + content + blankBetween(content, right) + right;
}

function requireContent(op, name) {
  if (typeof op.content !== 'string' || op.content === '') {
    throw badRequest(`operation '${name}': content is required and must be non-empty`, 'invalid_operation', { op: name });
  }
  return op.content;
}

function checkTargetShape(op, name) {
  if (op.block_id != null && op.anchor != null) {
    throw badRequest(`operation '${name}': give block_id or anchor, never both`, 'invalid_target', { op: name });
  }
  if (op.block_id != null) {
    throw badRequest(
      `operation '${name}': Markdown blocks have no ids; target with anchor`,
      'invalid_target',
      { op: name },
    );
  }
  if (op.anchor == null) {
    throw badRequest(`operation '${name}': anchor is required`, 'invalid_target', { op: name });
  }
}

const STRUCTURAL_OPS = new Set([
  'replace', 'insert_before', 'insert_after',
  'move_before', 'move_after', 'remove',
  'edit', 'replace_section', 'append_to_section',
]);

function applyOneMarkdownOp(src, op) {
  const name = String(op?.op ?? '');
  if (!STRUCTURAL_OPS.has(name)) {
    throw badRequest(`unknown operation '${name}'`, 'invalid_operation', { op: name });
  }
  if (name === 'edit') {
    if (op.block_id != null || op.anchor != null) {
      throw badRequest("operation 'edit': targets the whole body; drop block_id/anchor", 'invalid_target', { op: name });
    }
    if (typeof op.new !== 'string') {
      throw badRequest("operation 'edit': new is required and must be a string", 'invalid_operation', { op: name });
    }
    const { start, end } = resolveEditRange(src, op);
    return src.slice(0, start) + op.new + src.slice(end);
  }
  if (name === 'move_before' || name === 'move_after') {
    checkTargetShape(op, name);
    if (op.to_anchor == null && op.anchor_block_id == null) {
      throw badRequest(`operation '${name}': to_anchor is required`, 'invalid_target', { op: name });
    }
    if (op.to_anchor != null && op.anchor_block_id != null) {
      throw badRequest(`operation '${name}': give to_anchor or anchor_block_id, never both`, 'invalid_target', { op: name });
    }
    if (op.anchor_block_id != null) {
      throw badRequest(`operation '${name}': Markdown blocks have no ids; target with to_anchor`, 'invalid_target', { op: name });
    }
    const blocks = splitMarkdownBlocks(src);
    const target = resolveAnchor(src, spansFromBlocks(blocks), op.anchor).ref;
    const destProbe = resolveAnchor(src, spansFromBlocks(blocks), op.to_anchor).ref;
    if (destProbe === target) {
      throw badRequest(`operation '${name}': cannot move a block relative to itself`, 'invalid_move', {});
    }
    if (locateBlock(target.children ?? [], destProbe) || (target.children && locateBlock(target.children, destProbe))) {
      throw badRequest(`operation '${name}': cannot move a block relative to its own descendant`, 'invalid_move', {});
    }
    // Excise the target, then resolve the destination in the remainder —
    // sequential semantics: the destination must still match uniquely there.
    const remainder = src.slice(0, target.start) + src.slice(target.end);
    const remainderBlocks = splitMarkdownBlocks(remainder);
    const dest = resolveAnchor(remainder, spansFromBlocks(remainderBlocks), op.to_anchor).ref;
    const at = name === 'move_before' ? dest.start : dest.end;
    return spliceWithContent(remainder, at, at, target.raw.replace(/\n+$/, ''));
  }
  checkTargetShape(op, name);
  const blocks = splitMarkdownBlocks(src);
  const target = resolveAnchor(src, spansFromBlocks(blocks), op.anchor).ref;
  if (name === 'remove') return src.slice(0, target.start) + src.slice(target.end);
  if (name === 'replace') {
    return spliceWithContent(src, target.start, target.end, requireContent(op, name));
  }
  if (name === 'insert_before') {
    return spliceWithContent(src, target.start, target.start, requireContent(op, name));
  }
  if (name === 'insert_after') {
    return spliceWithContent(src, target.end, target.end, requireContent(op, name));
  }
  if (name === 'replace_section' || name === 'append_to_section') {
    const content = requireContent(op, name);
    const range = sectionRange(blocks, target);
    if (name === 'replace_section') {
      return spliceWithContent(src, target.start, rangeEndOffset(blocks, range, src.length), content);
    }
    const at = rangeEndOffset(blocks, range, src.length);
    return spliceWithContent(src, at, at, content);
  }
  throw badRequest(`unknown operation '${name}'`, 'invalid_operation', { op: name });
}

/**
 * Apply an ordered operations batch to Markdown source. Each op resolves
 * against the result of the ops before it (D3). Pure: any failure throws and
 * the caller writes nothing. Returns `{body, outline}` — the caller names its
 * own before/after for the T2 Mermaid hook.
 */
export function applyMarkdownOperations(src, operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw badRequest('operations must be a non-empty array', 'invalid_operations');
  }
  let current = String(src ?? '');
  for (const op of operations) current = applyOneMarkdownOp(current, op);
  return { body: current, outline: outlineFromMarkdown(current) };
}

/** Section heading path for a block: `3. Scope > 3.2 Engineering requirements`. */
function sectionPathFor(blocks, target) {
  const stack = [];
  let path = '';
  const walk = (list) => {
    for (const block of list) {
      if (block.kind === 'heading') {
        while (stack.length && stack[stack.length - 1].level >= block.level) stack.pop();
        stack.push({ level: block.level, heading: block.heading });
      }
      if (block === target) {
        path = stack.map((s) => s.heading).join(' > ');
        return true;
      }
      if (block.children && walk(block.children)) return true;
    }
    return false;
  };
  walk(blocks);
  return path;
}

/**
 * Describe one Markdown block via anchor (D5 get-block): meta plus the
 * block's verbatim source, or — with `{section: true}` — the whole section
 * under a heading anchor.
 */
export function describeMarkdownBlock(src, anchor, { section = false } = {}) {
  const text = String(src ?? '');
  const blocks = splitMarkdownBlocks(text);
  const target = resolveAnchor(text, spansFromBlocks(blocks), anchor).ref;
  if (!section) {
    return {
      kind: target.kind,
      heading: target.heading,
      level: target.level,
      section: sectionPathFor(blocks, target),
      short_text: target.short_text,
      source: text.slice(target.start, target.end),
    };
  }
  const range = sectionRange(blocks, target);
  return {
    kind: target.kind,
    heading: target.heading,
    level: target.level,
    section: sectionPathFor(blocks, target),
    short_text: target.short_text,
    source: text.slice(target.start, rangeEndOffset(blocks, range, text.length)),
  };
}

/** One block's verbatim source via anchor (D5 get-block). */
export function getMarkdownBlock(src, anchor) {
  return describeMarkdownBlock(src, anchor);
}

/** A whole section's verbatim source under a heading anchor (D5 --section). */
export function getMarkdownSection(src, anchor) {
  return describeMarkdownBlock(src, anchor, { section: true });
}
