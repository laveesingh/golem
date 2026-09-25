// GOL-384 public reader: loopback-only document listener isolated from the
// admin Fastify server. Allowlist only:
//   GET /s/:token                 — shared spec/doc reader (title/body only)
//   GET /s/:token/assets/:name    — token-scoped referenced ticket images
//   GET /s/assets/reader.css      — fixed reader stylesheet
//   GET /s/assets/reader.js       — fixed tiny loader (fetches the diagram
//                                   bundle only when div.mermaid exists)
//   GET /s/assets/share-mermaid.mjs — fixed isolated diagram bundle (built
//                                   via dashboard/vite.share.config.js)
// Everything else (including /api/*, /ws, /read/:id and all mutations) 404s.
// No dashboard bundle, no comments/children/assignee/state, no token logging.

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { marked } from 'marked';
import { parseAndNormalizeDoc, serializeNodes } from './html-body.js';

export const SHARE_ASSET_NAME_PATTERN = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/;
const TICKET_ASSET_SRC_PATTERN = /\/api\/ticket-assets\/([a-f0-9]{64}\.(?:png|jpg|gif|webp))/;
// Hosts that must never be navigable from a public document: loopback and the
// dashboard's own canonical host. Everything else absolute-http(s)/mailto and
// same-page fragments may stay (external author links within CSP).
const PUBLIC_LINK_INTERNAL_HOSTS = new Set(['127.0.0.1', 'localhost', 'dashboard.golem.localhost']);

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Mirror dashboard/web/src/format.js: ```mermaid fences become
// <div class="mermaid"> (rendered client-side by the isolated bundle) and
// GitHub-style admonitions become styled divs. Module-level once, matching
// the client's ensureMdConfigured; per-call breaks flags elsewhere override.
let mdConfigured = false;
function ensureMdConfigured() {
  if (mdConfigured) return;
  marked.use({
    breaks: true,
    renderer: {
      code({ text, lang }) {
        if (lang && String(lang).toLowerCase() === 'mermaid') {
          return `<div class="mermaid">${escHtml(text)}</div>\n`;
        }
        return false;
      },
      blockquote(token) {
        const m = /^\[!(NOTE|WARNING|IMPORTANT)\][ \t]*\n?([\s\S]*)$/i.exec(token.text || '');
        if (m) {
          const type = m[1].toLowerCase();
          return `<div class="admonition admonition-${type}">\n${marked.parse(m[2] || '')}</div>\n`;
        }
        return false;
      },
    },
  });
  mdConfigured = true;
}

function attrValue(node, name) {
  return node.attrs?.find((a) => a.name === name)?.value ?? null;
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

function childElements(node) {
  return (node.childNodes ?? []).filter((n) => n?.nodeName !== undefined && n.tagName !== undefined);
}

// GOL-384 D3/R4: the public contract is title + body only. Internal Golem
// document/API links are made inert (href="#") so the public render neither
// navigates to nor advertises dashboard URLs; same-page fragments, mailto,
// and external http(s) links stay (with noreferrer on externals).
export function neutralizePublicLinks(doc) {
  const walk = (node) => {
    for (const el of childElements(node)) {
      if (el.tagName.toLowerCase() === 'a') {
        const href = attrValue(el, 'href') ?? '';
        let keep = false;
        let external = false;
        if (href.startsWith('#')) {
          keep = true;
        } else {
          try {
            const u = new URL(href, 'https://golem.invalid');
            if (u.protocol === 'mailto:') {
              keep = true;
            } else if ((u.protocol === 'http:' || u.protocol === 'https:')
              && u.hostname !== 'golem.invalid'
              && !PUBLIC_LINK_INTERNAL_HOSTS.has(u.hostname.toLowerCase())) {
              keep = true;
              external = true;
            }
          } catch { keep = false; }
        }
        if (!keep) {
          setAttr(el, 'href', '#');
          removeAttr(el, 'target');
        } else if (external) {
          setAttr(el, 'rel', 'noreferrer noopener');
        }
      }
      walk(el);
    }
  };
  walk(doc);
  return doc;
}

// Render body to sanitized HTML + collect referenced asset names. Rewrites
// only parsed <img src> matching the ticket-assets form to token-scoped URLs.
export function renderSharedBody(body, format, token) {
  const fmt = String(format || 'markdown').toLowerCase() === 'html' ? 'html' : 'markdown';
  let rawHtml = '';
  if (fmt === 'html') {
    rawHtml = String(body ?? '');
  } else {
    const src = String(body ?? '');
    if (!src.trim()) return { html: '', refs: [] };
    ensureMdConfigured();
    rawHtml = marked(src, { gfm: true, breaks: true, headerIds: false, mangle: false });
  }
  if (!rawHtml.trim()) return { html: '', refs: [] };
  let doc;
  try {
    ({ doc } = parseAndNormalizeDoc(rawHtml));
  } catch {
    return { html: '', refs: [] };
  }
  const refs = [];
  const walk = (node) => {
    for (const el of childElements(node)) {
      if (el.tagName.toLowerCase() === 'img') {
        const src = attrValue(el, 'src') ?? '';
        const m = TICKET_ASSET_SRC_PATTERN.exec(src);
        if (m && SHARE_ASSET_NAME_PATTERN.test(m[1])) {
          refs.push(m[1]);
          setAttr(el, 'src', `/s/${token}/assets/${m[1]}`);
        }
      }
      walk(el);
    }
  };
  walk(doc);
  neutralizePublicLinks(doc);
  return { html: serializeNodes(doc.childNodes), refs: [...new Set(refs)] };
}

export function referencedShareAssets(body, format) {
  const fmt = String(format || 'markdown').toLowerCase() === 'html' ? 'html' : 'markdown';
  let rawHtml = fmt === 'html' ? String(body ?? '') : '';
  if (fmt === 'markdown') {
    const src = String(body ?? '');
    if (!src.trim()) return [];
    ensureMdConfigured();
    rawHtml = marked(src, { gfm: true, breaks: true, headerIds: false, mangle: false });
  }
  if (!rawHtml.trim()) return [];
  let doc;
  try {
    ({ doc } = parseAndNormalizeDoc(rawHtml));
  } catch {
    return [];
  }
  const refs = [];
  const walk = (node) => {
    for (const el of childElements(node)) {
      if (el.tagName.toLowerCase() === 'img') {
        const src = attrValue(el, 'src') ?? '';
        const m = TICKET_ASSET_SRC_PATTERN.exec(src);
        if (m && SHARE_ASSET_NAME_PATTERN.test(m[1])) refs.push(m[1]);
      }
      walk(el);
    }
  };
  walk(doc);
  return [...new Set(refs)];
}

const READER_CSS = `:root{color-scheme:light dark}body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;background:#fff;color:#111}main.share-reader{max-width:760px;margin:0 auto;padding:32px 20px 64px}h1.share-title{font-size:28px;line-height:1.25;margin:0 0 16px}.share-body img{max-width:100%;height:auto}.share-body pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto}.share-body code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}.share-body table{border-collapse:collapse;width:100%}.share-body th,.share-body td{border:1px solid #ddd;padding:6px 10px}.mermaid{background:#f6f8fa;border:1px solid #e1e4e8;border-radius:6px;padding:12px;white-space:pre-wrap}.mermaid svg{max-width:100%;height:auto;display:block;margin:0 auto}.mermaid-error{border-color:#d1242f}.admonition{border-left:3px solid #0969da;background:#ddf4ff33;padding:8px 12px;margin:12px 0;border-radius:0 6px 6px 0}@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}.share-body pre{background:#161b22}.mermaid{background:#161b22;border-color:#30363d}.share-body th,.share-body td{border-color:#30363d}}`;

// Tiny loader: fetch the (large) diagram bundle only when the document
// actually contains diagrams. No-JS clients keep the source-text fallback.
const READER_JS = `(async () => {\n  try {\n    if (!document.querySelector('div.mermaid')) return;\n    const mod = await import('/s/assets/share-mermaid.mjs');\n    if (mod && typeof mod.renderShareMermaids === 'function') await mod.renderShareMermaids(document);\n  } catch { /* source-text fallback stays visible */ }\n})();\n`;

function publicHeaders(extra = {}) {
  return {
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    // GOL-388 fix 5: isolated module scripts from self only — still no
    // inline scripts, no dashboard origins, no form actions.
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'",
    ...extra,
  };
}

// GOL-384 D3: title + body only — no display id, no tracker metadata.
export function buildReaderHtml({ title, bodyHtml }) {
  const safeTitle = escHtml(title || 'Shared document');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${safeTitle}</title><link rel="stylesheet" href="/s/assets/reader.css"></head><body><main class="share-reader"><h1 class="share-title">${safeTitle}</h1><div class="share-body">${bodyHtml || ''}</div></main><script type="module" src="/s/assets/reader.js"></script></body></html>`;
}

// Create the isolated public server. tracker must expose getShareGrantByToken
// and getTicket; assetsDir is the content-addressed image dir;
// mermaidBundlePath (optional) is the built isolated diagram bundle file —
// absent in source checkouts without a dashboard build, and the reader then
// degrades to the diagram source-text fallback.
export function createSharePublicServer({ tracker, assetsDir, mermaidBundlePath = null }) {
  const server = http.createServer((req, res) => {
    try {
      const method = String(req.method || 'GET').toUpperCase();
      const url = String(req.url || '/').split('?')[0];
      if (method !== 'GET') {
        res.writeHead(404, publicHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      if (url === '/s/assets/reader.css') {
        res.writeHead(200, publicHeaders({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'private, max-age=3600' }));
        res.end(READER_CSS);
        return;
      }
      if (url === '/s/assets/reader.js') {
        res.writeHead(200, publicHeaders({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, max-age=3600' }));
        res.end(READER_JS);
        return;
      }
      if (url === '/s/assets/share-mermaid.mjs') {
        if (!mermaidBundlePath || !fs.existsSync(mermaidBundlePath)) {
          res.writeHead(404, publicHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        res.writeHead(200, publicHeaders({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, max-age=3600' }));
        fs.createReadStream(mermaidBundlePath).pipe(res);
        return;
      }
      const docMatch = /^\/s\/([A-Za-z0-9_-]{8,256})\/?$/.exec(url);
      if (docMatch) {
        const token = docMatch[1];
        const grant = tracker.getShareGrantByToken(token);
        if (!grant) {
          res.writeHead(404, publicHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const ticket = tracker.getTicket(grant.ticket_id);
        if (!ticket || (ticket.kind !== 'spec' && ticket.kind !== 'doc')) {
          res.writeHead(404, publicHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const { html } = renderSharedBody(ticket.body, ticket.body_format, token);
        const page = buildReaderHtml({ title: ticket.title, bodyHtml: html });
        res.writeHead(200, publicHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
        res.end(page);
        return;
      }
      const assetMatch = /^\/s\/([A-Za-z0-9_-]{8,256})\/assets\/([A-Za-z0-9._-]+)$/.exec(url);
      if (assetMatch) {
        const token = assetMatch[1];
        const name = assetMatch[2];
        if (!SHARE_ASSET_NAME_PATTERN.test(name)) {
          res.writeHead(404, publicHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const grant = tracker.getShareGrantByToken(token);
        if (!grant) {
          res.writeHead(404, publicHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const ticket = tracker.getTicket(grant.ticket_id);
        if (!ticket || (ticket.kind !== 'spec' && ticket.kind !== 'doc')) {
          res.writeHead(404, publicHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const refs = referencedShareAssets(ticket.body, ticket.body_format);
        if (!refs.includes(name)) {
          res.writeHead(404, publicHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const fullPath = path.join(assetsDir, name);
        if (!fullPath.startsWith(assetsDir + path.sep) && fullPath !== assetsDir) {
          res.writeHead(404, publicHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        if (!fs.existsSync(fullPath)) {
          res.writeHead(404, publicHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const ext = name.split('.').pop();
        const mime = ({ png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' })[ext] || 'application/octet-stream';
        res.writeHead(200, publicHeaders({ 'Content-Type': mime }));
        fs.createReadStream(fullPath).pipe(res);
        return;
      }
      // Explicit deny: dashboard surface never exists here.
      res.writeHead(404, publicHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'not_found' }));
    } catch {
      try {
        res.writeHead(500, publicHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'internal' }));
      } catch { /* already closed */ }
    }
  });
  // Bind loopback-only; callers choose the port (recorded or ephemeral).
  function listen(port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListen);
        reject(err);
      };
      const onListen = () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListen);
      server.listen(port, '127.0.0.1');
    });
  }
  function close() {
    return new Promise((resolve) => server.close(() => resolve()));
  }
  return { server, listen, close, address: () => server.address() };
}
