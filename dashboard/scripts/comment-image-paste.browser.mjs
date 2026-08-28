// Browser journey: image support in comments on specs/tickets (paste, upload, render)

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { strict as assert } from 'node:assert';
import { projectIdFor } from '../server/project-id.js';
import { acquireChrome } from './_chrome.mjs';

const repo = path.resolve(import.meta.dirname, '..', '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'golem-comment-img-'));
const home = path.join(scratch, 'home');
const projects = path.join(scratch, 'projects');
const projectPath = path.join(projects, 'fixture');
for (const dir of [home, projectPath]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(projectPath, 'CLAUDE.md'), '# Comment image fixture\n');
const projectId = projectIdFor(projectPath);
writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: [
  { id: projectId, name: 'Comment image fixture', path: projectPath, kind: 'auto' },
] }));

const socket = net.createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const server = spawn(process.execPath, ['dashboard/server/index.js'], {
  cwd: repo,
  env: {
    ...process.env,
    PORT: String(port),
    GOLEM_HOME: home,
    GOLEM_PROJECTS_ROOT: projects,
    GOLEM_IDEAS_ROOT: path.join(scratch, 'ideas'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const base = `http://127.0.0.1:${port}`;

async function api(pathname, options = {}) {
  const response = await fetch(`${base}/api${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${pathname}: ${response.status} ${JSON.stringify(body)}`);
  return body.ticket || body;
}

async function stopServer() {
  if (server.exitCode != null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

let chrome;
try {
  let healthy = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) { healthy = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(healthy, 'isolated dashboard reached its health endpoint');

  const ticket = await api('/tickets', {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId, kind: 'task', created_by: 'browser-fixture', title: 'Comment image ticket', body: 'Body with comments.' }),
  });

  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${base}/tickets/${encodeURIComponent(ticket.id)}`, { waitUntil: 'networkidle' });

  // Open the comment rail and start a new comment
  await page.locator('#anno-fab').click();
  await page.waitForSelector('#anno-rail.open');
  await page.locator('#anno-rail .rail-tools button:has-text("+ New")').click();
  await page.waitForSelector('.anno-composer textarea');

  // Dispatch a simulated image paste event into the composer textarea
  // 1x1 transparent PNG as base64
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await page.evaluate((b64) => {
    const byteCharacters = atob(b64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const file = new File([byteArray], 'screenshot.png', { type: 'image/png' });

    const dt = new DataTransfer();
    dt.items.add(file);

    const textarea = document.querySelector('.anno-composer textarea');
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    textarea.dispatchEvent(pasteEvent);
  }, pngBase64);

  // Wait for upload to complete and markdown to be inserted
  await page.waitForFunction(() => {
    const ta = document.querySelector('.anno-composer textarea');
    return ta && ta.value.includes('/api/ticket-assets/');
  });

  // Verify uploads strip is visible
  assert.equal(await page.locator('.anno-composer .ct-uploads .ct-upload').count(), 1);
  assert.ok(await page.locator('.anno-composer .ct-uploads img.ct-upload-thumb').isVisible());

  // Type some commentary alongside the image and submit
  await page.locator('.anno-composer textarea').fill('Here is the screenshot:\n\n' + await page.locator('.anno-composer textarea').inputValue());
  await page.locator('.anno-composer button.send:has-text("Comment")').click();

  // Wait for comment card to appear with rendered image
  await page.waitForSelector('.anno-card .body img');
  const imgSrc = await page.locator('.anno-card .body img').getAttribute('src');
  assert.ok(imgSrc.startsWith('/api/ticket-assets/'), `rendered img src must point to /api/ticket-assets/, got ${imgSrc}`);

  // Test reply-with-image paste. GOL-287: replies are written in the MAIN
  // composer — Reply attaches the reference pill there; send mechanism unchanged.
  await page.locator('.anno-card .acts button:has-text("Reply")').click();
  await page.waitForSelector('#anno-rail .anno-composer .anno-attachment-pill');
  const replyPill = await page.locator('#anno-rail .anno-composer .anno-attachment-pill').textContent();
  assert.ok(/Reply/.test(replyPill || ''), 'main composer carries the reply reference');

  await page.evaluate((b64) => {
    const byteCharacters = atob(b64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const file = new File([byteArray], 'reply-shot.png', { type: 'image/png' });

    const dt = new DataTransfer();
    dt.items.add(file);

    const textarea = document.querySelector('#anno-rail .anno-composer textarea');
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    textarea.dispatchEvent(pasteEvent);
  }, pngBase64);

  await page.waitForFunction(() => {
    const ta = document.querySelector('#anno-rail .anno-composer textarea');
    return ta && ta.value.includes('/api/ticket-assets/');
  });

  await page.locator('#anno-rail .anno-composer button.send:has-text("Comment")').click();

  // Wait for the nested reply to appear with rendered image (GOL-277 thread
  // markup: .thread-replies > .anno-card).
  await page.waitForSelector('.thread-replies .anno-card .body img');
  const replyImgSrc = await page.locator('.thread-replies .anno-card .body img').getAttribute('src');
  assert.ok(replyImgSrc.startsWith('/api/ticket-assets/'), `reply img src must point to /api/ticket-assets/, got ${replyImgSrc}`);

  const tableTicket = await api('/tickets', {
    method: 'POST',
    body: JSON.stringify({
      project_id: projectId,
      kind: 'spec',
      created_by: 'browser-fixture',
      title: 'Table columns ticket',
      body: '| Provider | Max Context | Context Support | Reasoning / Thinking Support | Default System Prompt Token Footprint | Cost / Rate Limits | Key Operational Caveats |\n|---|---|---|---|---|---|---|\n| Anthropic | 200k | Full 200k window | Configurable budget | ~800 tokens | Standard tier rates | None |\n| OpenAI | 128k | Full 128k window | Integrated reasoning | ~1,200 tokens | Tier-based limits | Strict rate limits on new keys |',
    }),
  });

  const tablePage = await chrome.browser.newPage({ viewport: { width: 900, height: 800 } });
  tablePage.on('pageerror', (error) => pageErrors.push(error.message));
  await tablePage.goto(`${base}/tickets/${encodeURIComponent(tableTicket.id)}`, { waitUntil: 'networkidle' });
  await tablePage.waitForSelector('.td-md table');

  const tableReport = await tablePage.evaluate(() => {
    const table = document.querySelector('.td-md table');
    const ths = [...table.querySelectorAll('th')];
    const secondColTd = table.querySelector('tbody tr td:nth-child(2)');
    const range = document.createRange();
    range.selectNodeContents(secondColTd);
    const rects = range.getClientRects();
    return {
      tableCanScroll: table.scrollWidth > table.clientWidth,
      maxContextWidth: ths[1]?.getBoundingClientRect().width,
      secondColTextLineCount: rects.length,
      secondColText: secondColTd?.innerText,
    };
  });

  assert.ok(tableReport.maxContextWidth >= 70, `Max Context column width must not be squished, got ${tableReport.maxContextWidth}px`);
  assert.equal(tableReport.secondColTextLineCount, 1, `200k text should be single-line without character-by-character wrap, got ${tableReport.secondColTextLineCount} lines`);
  assert.equal(tableReport.secondColText, '200k');
  await tablePage.close();

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`);
  console.log('comment image paste and table layout browser journey passed');
} finally {
  if (chrome) await chrome.cleanup();
  await stopServer();
  rmSync(scratch, { recursive: true, force: true });
}
