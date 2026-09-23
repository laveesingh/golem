// Server-side Mermaid check (GOL-369 R6/D7): every body write commits, then
// reports each CHANGED diagram that fails `mermaid.parse`.
//
// Diagrams: Markdown ```mermaid fences; HTML elements with class `mermaid`
// (text content). "Changed" compares diagram-source multisets before/after;
// create treats all diagrams as changed. Writes with no changed diagrams
// never touch the checker process (fast path).
//
// Sync by design: the tracker DB layer is synchronous (better-sqlite3), and
// async-ifying it would ripple across every tracker consumer. `mermaid.parse`
// is async, so parsing runs in a worker thread (mermaid-worker.mjs) holding
// the single mermaid import; this module drives it synchronously through
// shared memory (postMessage, blocking Atomics.wait, JSON results from a
// shared buffer). First diagram-containing write pays worker startup once
// (~250ms); steady-state cost is parse time only (3–70ms per diagram).
// Worker failure fails open (no errors reported, write already committed)
// with a one-time stderr warning. Results are cached per process by diagram
// source (bounded), so repeated outline reads are free.

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as parse5 from 'parse5';
import { resolveAnchor } from './body-anchor.js';
import { splitMarkdownBlocks, spansFromBlocks } from './md-body.js';
import { parseAndNormalizeDoc, htmlAnchorIndex } from './html-body.js';

const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mermaid-worker.mjs');

let worker = null;
let warned = false;
// One slot: [0] result byte length (-1 overflow/error), [1] done flag.
const flagBuffer = new SharedArrayBuffer(8);
const dataBuffer = new SharedArrayBuffer(262144);
const flag = new Int32Array(flagBuffer);
const WAIT_TIMEOUT_MS = 30000;
const cache = new Map(); // `${format}\0${source}` -> {line, message} | null
const CACHE_LIMIT = 500;

function warnOnce(message) {
  if (warned) return;
  warned = true;
  process.stderr.write(`[mermaid-check] ${message}\n`);
}

function ensureWorker() {
  if (worker) return;
  worker = new Worker(workerPath);
  worker.unref();
  worker.on('error', () => { worker = null; });
  worker.on('exit', () => { worker = null; });
}

/** Parse many sources through the worker: [{ok, error?}] in input order. */
function parseManySync(sources) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      ensureWorker();
      if (!worker) throw new Error('mermaid worker failed to start');
      Atomics.store(flag, 0, 0);
      Atomics.store(flag, 1, 0);
      worker.postMessage({ flagBuffer, dataBuffer, sources });
      const status = Atomics.wait(flag, 1, 0, WAIT_TIMEOUT_MS);
      if (status !== 'ok') throw new Error(`mermaid worker wait ${status}`);
      const length = Atomics.load(flag, 0);
      if (length < 0) throw new Error('mermaid worker reported overflow');
      return JSON.parse(Buffer.from(dataBuffer, 0, length).toString('utf8'));
    } catch {
      try { worker?.terminate(); } catch { /* ignore */ }
      worker = null;
    }
  }
  warnOnce('checker worker unavailable; skipping mermaid errors (writes still commit)');
  return sources.map(() => ({ ok: true }));
}

function parseLineNumber(message) {
  const m = /line (\d+)/i.exec(message);
  return m ? Number(m[1]) : 1;
}

function toError(message) {
  return {
    line: parseLineNumber(message),
    message: String(message).split('\n')[0].trim().slice(0, 300),
  };
}

/**
 * Check raw sources (cached): Map(source -> {line, message} | null when clean).
 * Exported for outline flagging; write paths prefer checkChangedDiagrams.
 */
export function checkSources(sources, format = 'markdown') {
  const misses = [];
  const seen = new Set();
  for (const source of sources) {
    const key = `${format}\0${source}`;
    if (!cache.has(key) && !seen.has(key)) {
      seen.add(key);
      misses.push(source);
    }
  }
  if (misses.length) {
    const results = parseManySync(misses);
    misses.forEach((source, i) => {
      const key = `${format}\0${source}`;
      cache.set(key, results[i]?.ok ? null : toError(results[i]?.error ?? 'mermaid parse failed'));
      if (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
    });
  }
  const out = new Map();
  for (const source of sources) out.set(source, cache.get(`${format}\0${source}`) ?? null);
  return out;
}

function firstLineOf(source) {
  return String(source).split('\n')[0] ?? '';
}

function isMermaidLang(lang) {
  return /^mermaid\b/i.test(String(lang ?? ''));
}

/** Markdown diagrams in outline order with their outline entry index. */
export function markdownDiagramEntries(body) {
  const blocks = splitMarkdownBlocks(body);
  const out = [];
  let entryIndex = -1;
  const walk = (list) => {
    for (const block of list) {
      entryIndex += 1;
      if (block.kind === 'code' && isMermaidLang(block.lang)) {
        out.push({ entryIndex, source: block.text ?? '', firstLine: firstLineOf(block.text ?? '') });
      }
      if (block.children) walk(block.children);
    }
  };
  walk(blocks);
  return out;
}

function htmlTextContent(node) {
  if (node.nodeName === '#text') return node.value ?? '';
  if (node.tagName === undefined) {
    let out = '';
    for (const kid of node.childNodes ?? []) out += htmlTextContent(kid);
    return out;
  }
  let out = '';
  for (const kid of node.childNodes ?? []) out += htmlTextContent(kid);
  return out;
}

/** HTML diagrams with their nearest persisted block id (document order). */
export function htmlDiagramEntries(body) {
  const fragment = parse5.parseFragment(String(body ?? ''));
  const out = [];
  const walk = (node, stack) => {
    const isElement = node.tagName !== undefined;
    let next = stack;
    if (isElement) {
      const id = node.attrs?.find((a) => a.name === 'data-block-id')?.value ?? null;
      next = id ? [...stack, id] : stack;
      const classes = node.attrs?.find((a) => a.name === 'class')?.value ?? '';
      if (classes.split(/\s+/).includes('mermaid')) {
        const source = htmlTextContent(node).trim();
        if (source) {
          out.push({
            blockId: next.length ? next[next.length - 1] : null,
            source,
            firstLine: firstLineOf(source).trim(),
          });
        }
      }
    }
    for (const kid of node.childNodes ?? []) walk(kid, next);
  };
  walk(fragment, []);
  return out;
}

/** All diagrams in a body (document order): [{source, firstLine}]. */
export function extractDiagrams(body, format = 'markdown') {
  if (format === 'html') return htmlDiagramEntries(body).map(({ source, firstLine }) => ({ source, firstLine }));
  return markdownDiagramEntries(body).map(({ source, firstLine }) => ({ source, firstLine }));
}

function countSources(diagrams) {
  const counts = new Map();
  for (const d of diagrams) counts.set(d.source, (counts.get(d.source) ?? 0) + 1);
  return counts;
}

function occurrencesIn(docText, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = docText.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + 1;
  }
}

/**
 * Build a `{text, prefix?, suffix?}` anchor for one broken diagram and prove
 * it resolves through body-anchor.js to that diagram's block (D7). Starts
 * with the diagram's first line, extends with following lines, then with
 * preceding context, verifying each candidate.
 */
export function buildDiagramAnchor(afterBody, format, diagram) {
  const isHtml = format === 'html';
  const collapse = (s) => (isHtml ? s.replace(/\s+/g, ' ').trim() : s);
  const joiner = isHtml ? ' ' : '\n';
  const rawLines = String(diagram.source).split('\n');
  const normLines = rawLines.map((l) => collapse(l)).filter((l) => l !== '');
  const docText = isHtml
    ? htmlAnchorIndex(parseAndNormalizeDoc(afterBody).doc).text
    : String(afterBody ?? '');
  const spans = isHtml
    ? htmlAnchorIndex(parseAndNormalizeDoc(afterBody).doc).spans
    : spansFromBlocks(splitMarkdownBlocks(afterBody));
  const tryAnchor = (anchor) => {
    try {
      resolveAnchor(docText, spans, anchor);
      return true;
    } catch {
      return false;
    }
  };
  const textCandidates = [];
  for (let k = 0; k < Math.min(3, normLines.length); k += 1) {
    textCandidates.push(normLines.slice(0, k + 1).join(joiner));
  }
  const prefixCandidates = isHtml ? [''] : ['', '```mermaid\n'];
  for (const text of textCandidates) {
    for (const prefix of prefixCandidates) {
      if (!text) continue;
      const anchor = prefix ? { text, prefix } : { text };
      if (occurrencesIn(docText, prefix + text) === 1 && tryAnchor(anchor)) return anchor;
    }
  }
  // Preceding-context prefixes from the document itself (markdown raw lines).
  if (!isHtml) {
    const firstAt = docText.indexOf(normLines[0]);
    if (firstAt >= 0) {
      const preceding = docText.slice(0, firstAt).split('\n').filter((l) => l !== '');
      let prefix = '';
      for (let k = 1; k <= Math.min(3, preceding.length); k += 1) {
        prefix = `${preceding[preceding.length - k]}\n${prefix}`;
        const anchor = { text: normLines[0], prefix };
        if (occurrencesIn(docText, prefix + normLines[0]) === 1 && tryAnchor(anchor)) return anchor;
      }
    }
  }
  // Last resort: the whole normalized source (unique unless byte-identical
  // duplicate diagrams exist, which no text anchor can disambiguate).
  const full = normLines.join(joiner);
  if (full && tryAnchor({ text: full })) return { text: full };
  return { text: normLines[0] ?? '' };
}

/**
 * Changed-diagram errors for a write: `[{first_line, line, message, anchor}]`.
 * beforeFormat defaults to format (format-change writes pass both). The write
 * always commits first — this only reports.
 */
export function checkChangedDiagrams(before, after, format, beforeFormat = format) {
  const beforeCounts = countSources(extractDiagrams(before, beforeFormat));
  const changed = [];
  for (const diagram of extractDiagrams(after, format)) {
    const remaining = beforeCounts.get(diagram.source) ?? 0;
    if (remaining > 0) beforeCounts.set(diagram.source, remaining - 1);
    else changed.push(diagram);
  }
  if (!changed.length) return [];
  const verdicts = checkSources(changed.map((d) => d.source), format);
  const errors = [];
  for (const diagram of changed) {
    const verdict = verdicts.get(diagram.source);
    if (verdict) {
      errors.push({
        first_line: diagram.firstLine,
        line: verdict.line,
        message: verdict.message,
        anchor: buildDiagramAnchor(after, format, diagram),
      });
    }
  }
  return errors;
}

/** Outline flags for Markdown: Map(outline entry index -> {line, message}). */
export function markdownOutlineErrors(body) {
  const entries = markdownDiagramEntries(body);
  if (!entries.length) return new Map();
  const verdicts = checkSources(entries.map((e) => e.source), 'markdown');
  const out = new Map();
  for (const entry of entries) {
    const verdict = verdicts.get(entry.source);
    if (verdict) out.set(entry.entryIndex, verdict);
  }
  return out;
}

/** Outline flags for HTML: Map(block id -> {line, message}). */
export function htmlOutlineErrors(body) {
  const entries = htmlDiagramEntries(body);
  if (!entries.length) return new Map();
  const verdicts = checkSources(entries.map((e) => e.source), 'html');
  const out = new Map();
  for (const entry of entries) {
    if (!entry.blockId) continue;
    const verdict = verdicts.get(entry.source);
    if (verdict) out.set(entry.blockId, verdict);
  }
  return out;
}
