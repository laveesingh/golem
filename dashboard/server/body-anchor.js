// Shared strict text-anchor resolver (GOL-369 D2).
//
// Both body formats resolve `{text, prefix?, suffix?}` against the WHOLE
// document — Markdown against the raw source, HTML against the collapsed text
// content with a per-character innermost-block map. The rule is strict: the
// joined `prefix + text + suffix` must occur exactly once, or the batch fails
// with `anchor_not_found` / `anchor_ambiguous` (never a best-score fallback
// like comment anchoring). The match then selects the INNERMOST span covering
// the `text` part, so an anchor on nested text is not ambiguous with its
// parents. Operations resolve one after another (D3 sequential).
//
// The owned error family lives here so both engines share one class identity:
// callers check `err instanceof TrackerInputError` and the REST layer maps by
// `err.name === 'TrackerInputError'`. `html-body.js` re-exports these names so
// existing import paths keep working.

export class TrackerInputError extends Error {
  constructor(message, code, status = 400, extra = null) {
    super(message);
    this.name = 'TrackerInputError';
    this.code = code;
    this.status = status;
    if (extra) this.extra = extra;
  }
}

export const badRequest = (message, code = 'invalid_input', extra = null) =>
  new TrackerInputError(message, code, 400, extra);
export const notFound = (message, code = 'not_found', extra = null) =>
  new TrackerInputError(message, code, 404, extra);
export const revisionConflict = (message, extra = null) =>
  new TrackerInputError(message, 'revision_conflict', 409, extra);

/** Split an anchor into its joined needle plus the offset of `text` inside it. */
export function anchorNeedle(anchor) {
  const text = String(anchor?.text ?? '');
  const prefix = anchor?.prefix == null ? '' : String(anchor.prefix);
  const suffix = anchor?.suffix == null ? '' : String(anchor.suffix);
  if (!text) throw badRequest('anchor.text is required and must be non-empty', 'invalid_anchor', { anchor });
  return { needle: prefix + text + suffix, prefixLength: prefix.length, textLength: text.length };
}

/** Every occurrence of the joined needle in the document, with ~80 chars of context each. */
export function findAnchorMatches(docText, anchor) {
  const { needle } = anchorNeedle(anchor);
  const src = String(docText ?? '');
  const matches = [];
  let from = 0;
  for (;;) {
    const index = src.indexOf(needle, from);
    if (index < 0) break;
    const contextStart = Math.max(0, index - 40);
    const contextEnd = Math.min(src.length, index + needle.length + 40);
    matches.push({
      index,
      context: src.slice(contextStart, contextEnd),
    });
    from = index + 1;
  }
  return matches;
}

/**
 * Resolve an anchor to the innermost span covering the `text` part.
 *
 * @param {string} docText whole-document search text (raw Markdown source, or
 *   collapsed HTML text content).
 * @param {Array<{start:number,end:number,ref:any}>} spans block spans over
 *   docText; nested spans (details children, HTML nested blocks) are expected.
 *   The innermost — smallest — span covering the text range wins.
 * @param {{text:string,prefix?:string,suffix?:string}} anchor
 * @returns the winning span object (caller reads `.ref`).
 * @throws TrackerInputError `anchor_not_found` (zero matches, or no covering
 *   span) or `anchor_ambiguous` (more than one match, with candidates).
 */
export function resolveAnchor(docText, spans, anchor) {
  const { needle, prefixLength, textLength } = anchorNeedle(anchor);
  const src = String(docText ?? '');
  const matches = findAnchorMatches(src, anchor);
  if (matches.length === 0) {
    throw badRequest(
      `anchor not found: '${needle.slice(0, 80)}' occurs 0 times in the document`,
      'anchor_not_found',
      { anchor: { text: anchor?.text, prefix: anchor?.prefix, suffix: anchor?.suffix }, candidates: [] },
    );
  }
  if (matches.length > 1) {
    throw badRequest(
      `anchor ambiguous: '${needle.slice(0, 80)}' occurs ${matches.length} times in the document; add prefix/suffix`,
      'anchor_ambiguous',
      {
        anchor: { text: anchor?.text, prefix: anchor?.prefix, suffix: anchor?.suffix },
        candidates: matches,
      },
    );
  }
  const textStart = matches[0].index + prefixLength;
  const textEnd = textStart + textLength;
  let best = null;
  for (const span of spans ?? []) {
    if (span.start <= textStart && span.end >= textEnd) {
      if (!best || (span.end - span.start) < (best.end - best.start)) best = span;
    }
  }
  if (!best) {
    throw badRequest(
      `anchor not found: no block covers '${String(anchor?.text ?? '').slice(0, 80)}'`,
      'anchor_not_found',
      { anchor: { text: anchor?.text, prefix: anchor?.prefix, suffix: anchor?.suffix }, candidates: [] },
    );
  }
  return best;
}

/**
 * Resolve an `edit {old, new, prefix?, suffix?}` against the whole body.
 * `prefix + old + suffix` must occur exactly once; only the `old` portion is
 * replaced. Returns `{start, end}` offsets of the `old` portion.
 */
export function resolveEditRange(docText, { old, prefix, suffix }) {
  const oldText = String(old ?? '');
  if (!oldText) throw badRequest("operation 'edit': old is required and must be non-empty", 'invalid_operation', { op: 'edit' });
  const anchor = { text: oldText, prefix, suffix };
  const { needle, prefixLength, textLength } = anchorNeedle(anchor);
  const src = String(docText ?? '');
  const matches = findAnchorMatches(src, anchor);
  if (matches.length === 0) {
    throw badRequest(
      `operation 'edit': old text occurs 0 times in the document`,
      'anchor_not_found',
      { op: 'edit', old: oldText.slice(0, 80), candidates: [] },
    );
  }
  if (matches.length > 1) {
    throw badRequest(
      `operation 'edit': old text occurs ${matches.length} times; add prefix/suffix`,
      'anchor_ambiguous',
      { op: 'edit', old: oldText.slice(0, 80), candidates: matches },
    );
  }
  void needle;
  const start = matches[0].index + prefixLength;
  return { start, end: start + textLength };
}
