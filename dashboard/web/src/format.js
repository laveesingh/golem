// Formatting helpers ported from data.js, but free-standing (no mock data).

(function () {
  function fmtRuntime(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
  }

  function fmtTimeAgo(t) {
    if (!t) return '';
    const d = (Date.now() - t) / 1000;
    if (d < 0) return 'now';
    if (d < 60) return `${Math.floor(d)}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }

  function fmtClock(t) {
    const d = new Date(t || Date.now());
    return d.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  // Project glyph fallback if the server didn't compute one.
  function glyphFor(name) {
    const letters = String(name || '').replace(/[^a-zA-Z0-9]/g, '');
    if (!letters) return '··';
    if (letters.length === 1) return letters[0].toUpperCase().repeat(2);
    return (letters[0] + letters[1]).toUpperCase();
  }

  // ---- Markdown + sanitize render pipeline (TKT-0171) -------------------
  // Escape the three characters that would otherwise be read as markup inside
  // a <div class="mermaid">…</div>. mermaid reads the element's textContent,
  // which de-escapes the entities back to the original diagram source.
  function escMd(s) {
    return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  // DOMPurify config: the default allow-list already keeps svg/figure/table and
  // data-*/aria-*; we list the diagram-bearing tags explicitly so the intent is
  // obvious and survives any future default change. FORCE_BODY keeps <style>
  // blocks (existing house-style bodies scope diagram CSS via <style>); without
  // it DOMPurify drops <style> as a body-level element when sanitizing a
  // fragment. <script> and on* handlers are stripped regardless (the XSS
  // surface this closes).
  const SANITIZE_CFG = {
    ADD_TAGS: ['svg', 'figure', 'figcaption', 'style'],
    ALLOW_DATA_ATTR: true,
    FORCE_BODY: true,
  };

  let mdConfigured = false;
  // Configure marked once (on the first renderMarkdown call) with the custom
  // renderer: ```mermaid fenced blocks → <div class="mermaid">…</div>, and
  // GitHub-style admonitions (> [!NOTE]/[!WARNING]/[!IMPORTANT]) →
  // <div class="admonition admonition-<type>">. Returning false from a renderer
  // method falls back to marked's default for that token.
  function ensureMdConfigured() {
    if (mdConfigured || !window.marked) return;
    window.marked.use({
      breaks: true, // single newlines → <br> (preserves legacy plain-text comment rendering)
      renderer: {
        code({ text, lang }) {
          if (lang && String(lang).toLowerCase() === 'mermaid') {
            return `<div class="mermaid">${escMd(text)}</div>\n`;
          }
          return false;
        },
        blockquote(token) {
          const m = /^\[!(NOTE|WARNING|IMPORTANT)\][ \t]*\n?([\s\S]*)$/i.exec(token.text || '');
          if (m) {
            const type = m[1].toLowerCase();
            return `<div class="admonition admonition-${type}">\n${window.marked.parse(m[2] || '')}</div>\n`;
          }
          return false;
        },
      },
    });
    mdConfigured = true;
  }

  // Legacy plain-text fallback, used only before the esm.sh marked module has
  // resolved on first paint. Mirrors the old htmlBody behaviour exactly:
  // HTML-first → unchanged; otherwise wrap blank-line blocks in <p>, newlines
  // → <br/>. Unsanitized, but only fires briefly before the module lands.
  function legacyHtmlBody(text) {
    if (!text) return '';
    if (/^\s*<[a-zA-Z][^>]*>/.test(text)) return text;
    return text
      .split(/\n\n+/)
      .map((p) => `<p>${p.trim().replace(/\n/g, '<br/>')}</p>`)
      .join('');
  }

  /**
   * Render a ticket/comment body as safe HTML.
   *
   * Existing bodies are the legacy HTML "house-style" report (they start with a
   * tag); marked mangles those — it treats indented lines inside <svg> as
   * indented code blocks and wraps the SVG's inner content in <p> — so for
   * HTML-first bodies we pass the text through unchanged and only sanitize.
   * New bodies are Markdown: parse with marked (mermaid fences + GitHub
   * admonitions via the custom renderer) then sanitize. Either way DOMPurify
   * strips <script> and on* handlers (closing the XSS surface), while keeping
   * svg/figure/table/style and data-* so existing diagrams + styling survive.
   */
  function renderMarkdown(text) {
    if (!text) return '';
    // HTML-first body (legacy house-style): sanitize only, skip marked.
    if (/^\s*<[a-zA-Z][^>]*>/.test(text)) {
      return window.DOMPurify ? window.DOMPurify.sanitize(text, SANITIZE_CFG) : text;
    }
    // Markdown body: parse + sanitize.
    if (window.marked && window.DOMPurify) {
      ensureMdConfigured();
      return window.DOMPurify.sanitize(window.marked.parse(text), SANITIZE_CFG);
    }
    // marked/DOMPurify not yet loaded (esm.sh module still resolving on first
    // paint) — fall back to the legacy renderer so the UI never blanks;
    // subsequent renders use the full pipeline once the module has landed.
    return legacyHtmlBody(text);
  }

  // Backwards-compat alias: the local bodyHtml() in td-annotate.jsx routes
  // comment/reply bodies through SubstrateFmt.htmlBody, so keeping the old
  // name auto-covers those call sites.
  const htmlBody = renderMarkdown;

  window.SubstrateFmt = { fmtRuntime, fmtTimeAgo, fmtClock, glyphFor, renderMarkdown, htmlBody };
})();
