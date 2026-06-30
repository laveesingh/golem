import { chromium } from 'playwright-core';
import fs from 'node:fs';

const OUT = '/tmp/golem-ui-smoke';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(`${OUT}/data`, { recursive: true });

const log = (...a) => console.log('[smoke]', ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find((p) => p.url().includes('127.0.0.1:7420'));
  if (!page) {
    page = await ctx.newPage();
    await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' });
  }
  await page.bringToFront();
  await page.setViewportSize({ width: 1440, height: 900 });

  // TKT-0176: stale-cache trap. A long-running CDP Chrome can hold a
  // babel-transformed .jsx from before a JSX change (the dispatcher hit this:
  // a pre-TKT-0172 td-annotate.jsx made block-hover silently fail). Disable the
  // browser cache over CDP so every subsequent navigation fetches fresh JS,
  // then force a hard reload of the dashboard (ignoreCache).
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Page.enable');
    await cdp.send('Page.reload', { ignoreCache: true });
    log('cache disabled + hard reload via CDP');
  } catch (e) {
    log('CDP cache-disable failed (continuing):', e.message);
  }

  await page.waitForSelector('#root', { timeout: 15000 });
  await wait(2500);

  const issues = [];

  page.on('pageerror', (err) => {
    log('PAGE ERROR:', err.message);
    issues.push(`pageerror: ${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      log('CONSOLE ERROR:', msg.text());
      issues.push(`console.error: ${msg.text()}`);
    }
  });

  // Reset to a clean state: close any open drawer (Escape), navigate to root.
  await page.keyboard.press('Escape');
  await wait(200);
  await page.evaluate(() => {
    document.querySelectorAll('.drawer.open').forEach((d) => d.classList.remove('open'));
    document.querySelectorAll('.drawer-backdrop.open').forEach((b) => b.classList.remove('open'));
    window.dispatchEvent(new CustomEvent('close-ceo-drawer'));
  });
  await wait(300);
  await page.goto('http://127.0.0.1:7420/', { waitUntil: 'domcontentloaded' });
  await wait(1500);

  async function shot(name) {
    const p = `${OUT}/${name}.png`;
    await page.screenshot({ path: p });
    log('  shot:', name);
  }

  await shot('01-initial');

  // High-level: app state + global functions present
  const initial = await page.evaluate(() => ({
    title: document.title,
    hasStore: typeof window.Store,
    hasAPI: typeof window.SubstrateAPI,
    // TKT-0171/0176: marked is now shipped to the browser (esm.sh import map)
    // and used by window.SubstrateFmt.renderMarkdown. The smoke previously
    // flagged window.marked as wrong/absent — that check flips to expect-present.
    hasMarked: typeof window.marked === 'function',
    hasDOMPurify: typeof window.DOMPurify?.sanitize === 'function',
    hasRenderMarkdown: typeof window.SubstrateFmt?.renderMarkdown === 'function',
    drawer: !!document.querySelector('.drawer-ticket'),
    bodyScrollW: document.body.scrollWidth,
    bodyClientW: document.body.clientWidth,
    hasHScroll: document.body.scrollWidth > document.body.clientWidth,
  }));
  log('initial:', initial);
  issues.push(`title: ${initial.title}`);
  issues.push(`marked-loaded (UI): ${initial.hasMarked}`);
  // TKT-0176: marked presence is now required (flipped from "wrong" to "expected").
  if (!initial.hasMarked) issues.push('ERROR: window.marked missing (expected present — TKT-0171)');
  if (!initial.hasDOMPurify) issues.push('ERROR: window.DOMPurify.sanitize missing (expected present — TKT-0171)');
  if (!initial.hasRenderMarkdown) issues.push('ERROR: window.SubstrateFmt.renderMarkdown missing (expected present — TKT-0171)');

  // Click "Tracker" tab if present
  const trackerTab = await page.locator('text=Tracker').first();
  if (await trackerTab.count()) {
    await trackerTab.click();
    await wait(1000);
    await shot('02-tracker-tab');
  }

  // Click any ticket card. Use locator with broader match.
  let opened = false;
  const selectors = [
    '[class*="ticket"][class*="card"]',
    '[class*="ticket-row"]',
    '[class*="Tracker"] [role="button"]',
    '.tb-card',
    'button:has-text("TKT-")',
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel);
    if (await loc.count()) {
      log(`trying selector ${sel}, count=${await loc.count()}`);
      try { await loc.first().click({ timeout: 3000 }); opened = true; break; } catch (e) {}
    }
  }

  // If still not open, open a ticket via the Router (TKT-0146 made drawers URL
  // overlays; the old `open-ticket-drawer` custom event is no longer listened to).
  if (!opened) {
    log('opening ticket via window.Router.openTicket');
    const ticketId = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/tickets?project=golem-1eba80&includeArchived=true');
        const data = await res.json();
        return data?.[0]?.id || null;
      } catch { return null; }
    });
    log('first ticket id:', ticketId);
    if (ticketId) {
      await page.evaluate((id) => window.Router?.openTicket(id), ticketId);
      opened = true;
    }
  }

  await wait(2000);
  await shot('03-drawer');

  const drawer = await page.evaluate(() => {
    const d = document.querySelector('.drawer-ticket');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      left: Math.round(r.left),
      drawHScroll: d.scrollWidth > d.clientWidth,
      scrollW: d.scrollWidth, clientW: d.clientWidth,
    };
  });
  log('drawer:', drawer);
  issues.push(`drawer-width: ${drawer?.w}`);

  // Inspect body area
  const bodyArea = await page.evaluate(() => {
    const wrap = document.querySelector('.td-annotate-wrap');
    const body = document.querySelector('.td-md');
    const rail = document.getElementById('anno-rail');
    const fab = document.getElementById('anno-fab');
    const pill = document.getElementById('anno-pill');
    return {
      hasWrap: !!wrap, hasBody: !!body, hasRail: !!rail, hasFab: !!fab, hasPill: !!pill,
      wrapClass: wrap?.className, railClass: rail?.className, railOpen: rail?.classList.contains('open'),
      wrapOverflowX: wrap && getComputedStyle(wrap).overflowX,
      bodyFirst: body?.firstElementChild?.tagName,
      bodyHScroll: body ? body.scrollWidth > body.clientWidth : null,
      bodyScrollW: body?.scrollWidth, bodyClientW: body?.clientWidth,
      // Detect unrendered markdown literals
      bodyHasHashHeadings: body?.innerHTML.includes('## '),
      bodyTextHasHeading: /(^|\n)## /.test(body?.textContent || ''),
      bodyTextHasListDash: /(^|\n)- /.test(body?.textContent || ''),
    };
  });
  log('bodyArea:', bodyArea);
  issues.push(`body-h-scroll: ${bodyArea.bodyHScroll} (${bodyArea.bodyScrollW}/${bodyArea.bodyClientW})`);
  issues.push(`unrendered-markdown: ${bodyArea.bodyTextHasHeading || bodyArea.bodyTextHasListDash}`);
  issues.push(`rail-open-class-on-wrap: ${bodyArea.wrapClass?.includes('rail-open')}`);

  // Toggle the rail
  if (bodyArea.hasFab) {
    await page.click('#anno-fab');
    await wait(700);
    await shot('04-rail-toggled');
    const rail2 = await page.evaluate(() => ({
      wrapClass: document.querySelector('.td-annotate-wrap')?.className,
      railClass: document.getElementById('anno-rail')?.className,
      drawHScroll: (() => { const d = document.querySelector('.drawer-ticket'); return d ? d.scrollWidth > d.clientWidth : null; })(),
      drawW: (() => { const d = document.querySelector('.drawer-ticket'); return d ? d.getBoundingClientRect().width : null; })(),
      bodyHScroll: (() => { const b = document.querySelector('.td-md'); return b ? b.scrollWidth > b.clientWidth : null; })(),
    }));
    log('rail-toggled:', rail2);
    issues.push(`with-rail: drawer-h-scroll=${rail2.drawHScroll}, body-h-scroll=${rail2.bodyHScroll}`);

    // Try selecting text and triggering the pill
    await page.evaluate(() => {
      const root = document.querySelector('.td-md');
      if (!root) return false;
      const target = root.querySelector('p, li, h2, h3');
      if (!target) return false;
      // TKT-0176: firstChild may be an element (e.g. rendered heading), not a
      // text node. Walk to the first real text node before building the range,
      // otherwise setEnd throws IndexSizeError ("no child at offset N").
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, null);
      let tn = walker.nextNode();
      if (!tn || !tn.textContent.trim()) return false;
      const len = Math.min(25, tn.textContent.length);
      const range = document.createRange();
      range.setStart(tn, 0);
      range.setEnd(tn, len);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return true;
    });
    await wait(500);
    await shot('05-text-selected');
    const pillInfo = await page.evaluate(() => {
      const p = document.getElementById('anno-pill');
      return { exists: !!p, display: p?.style.display, rect: p ? JSON.stringify({ x: Math.round(p.getBoundingClientRect().left), y: Math.round(p.getBoundingClientRect().top), w: Math.round(p.getBoundingClientRect().width), h: Math.round(p.getBoundingClientRect().height) }) : null };
    });
    log('pill:', pillInfo);
    issues.push(`pill-display: ${pillInfo.display}`);

    // If pill is visible, click it
    if (pillInfo.display === 'flex') {
      await page.click('#anno-pill');
      await wait(600);
      await shot('06-composer');
      // Check that the composer exists
      const composerInfo = await page.evaluate(() => {
        const c = document.querySelector('.anno-composer');
        return c ? { tag: c.querySelector('textarea')?.tagName, hasSend: !!c.querySelector('.send') } : null;
      });
      log('composer:', composerInfo);

      // Try typing a comment
      await page.fill('.anno-composer textarea', 'E2E smoke comment via CDP');
      await page.click('.anno-composer .send');
      await wait(1500);
      await shot('07-after-comment');
      const afterComment = await page.evaluate(() => ({
        cardCount: document.querySelectorAll('.anno-card').length,
        pillStillThere: document.getElementById('anno-pill')?.style.display,
        bodyHScroll: (() => { const b = document.querySelector('.td-md'); return b ? b.scrollWidth > b.clientWidth : null; })(),
      }));
      log('after-comment:', afterComment);
      issues.push(`cards-after-comment: ${afterComment.cardCount}`);
      issues.push(`body-h-scroll-after-comment: ${afterComment.bodyHScroll}`);
    }
  }

  fs.writeFileSync(`${OUT}/issues.json`, JSON.stringify(issues, null, 2));
  log('DONE. Issues written to', `${OUT}/issues.json`);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
