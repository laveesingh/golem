// _chrome.mjs — shared helper for smoke / probe / debug scripts.
//
// Why this exists (TKT-0187): a non-headless Chrome on 9222 is visible on
// the user's screen; CDP actions (page.click, page.keyboard.press,
// page.bringToFront) cause the OS to activate that window and steal
// focus from the user's terminal / editor / other apps. Multi-session
// agents sharing a non-headless Chrome on 9222 was making the user's
// typing get routed into the wrong window.
//
// What this helper does:
//   1. Allocates a unique per-process remote-debugging port (no collision
//      with other agents or a user-launched Chrome on 9222).
//   2. Spawns a *headless* Chrome on that port if nothing is listening
//      yet (idempotent — if our port is already up, we connect instead).
//   3. Verifies the listening Chrome is actually headless. If a
//      non-headless Chrome is squatting our port, it picks the next port.
//   4. Cleans up the spawned Chrome on process exit so we don't leave
//      zombies behind.
//
// The exported `acquireChrome({ port })` returns { port, cdpUrl, browser,
// cleanup }. Callers (smoke scripts) just need to:
//   const { cdpUrl, browser, cleanup } = await acquireChrome();
//   ... do CDP stuff ...
//   await cleanup();
//
// `acquireChrome` is safe to call from a smoke script: if the script
// crashes the process, the SIGTERM/SIGINT handler below kills the
// spawned Chrome child.

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

const CHROME_BIN = process.env.CHROME_BIN
  || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : 'google-chrome');

// Distinct from 9222 (which other tools / user-launched Chrome often uses)
// and 9223 (used by screenshot-home.mjs). Adding process.pid to base gives
// every concurrent agent its own port; the modulo prevents clash with
// common infra ports.
const PORT_BASE = 19300;
function pickPort(seed) {
  // Seed by process.pid if not provided.
  const s = (seed || process.pid) & 0xffff;
  return PORT_BASE + (s % 1000);
}

function isPortListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let done = false;
    const finish = (result) => { if (!done) { done = true; sock.destroy(); resolve(result); } };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    setTimeout(() => finish(false), 200);
  });
}

async function getBrowserCmdline(cdpPort) {
  // The CDP /json/version endpoint doesn't expose the launch command. We
  // walk `/proc` on Linux/macOS to find a Chrome with `--remote-debugging-port=<port>`.
  // On macOS, `ps -A -o pid,command` works. Best-effort; returns null if
  // we can't determine headless state.
  try {
    if (process.platform === 'darwin') {
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'command=']).toString();
      for (const line of out.split('\n')) {
        if (line.includes(`--remote-debugging-port=${cdpPort}`)) {
          return line;
        }
      }
    } else {
      for (const proc of readdirSync('/proc')) {
        if (!/^\d+$/.test(proc)) continue;
        try {
          const cmd = readFileSync(`/proc/${proc}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
          if (cmd.includes(`--remote-debugging-port=${cdpPort}`)) return cmd;
        } catch {}
      }
    }
  } catch {}
  return null;
}

function isHeadlessCmdline(cmd) {
  if (!cmd) return null; // unknown
  return /(?:^|\s)(--headless(?:=new|\s|$))/.test(cmd);
}

function makeProfileDir(port) {
  const dir = path.join(os.tmpdir(), `golem-chrome-headless-${port}-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let cleanupRegistered = false;
const spawned = []; // { pid, port }

function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const kill = () => {
    for (const c of spawned) {
      try { process.kill(c.pid, 'SIGTERM'); } catch {}
    }
  };
  process.on('exit', kill);
  process.on('SIGINT', () => { kill(); process.exit(130); });
  process.on('SIGTERM', () => { kill(); process.exit(143); });
}

async function spawnHeadless(port) {
  const profileDir = makeProfileDir(port);
  const child = spawn(
    CHROME_BIN,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-gpu',
      '--no-sandbox',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  spawned.push({ pid: child.pid, port });
  registerCleanup();

  // Wait for CDP to come up.
  for (let i = 0; i < 30; i++) {
    if (await isPortListening(port)) return child.pid;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`headless Chrome did not start on port ${port} within 6s`);
}

/**
 * Acquire a headless Chrome for the calling smoke / probe script. Picks
 * a unique port per process, spawns a headless Chrome if needed, refuses
 * to connect to a non-headless Chrome, and returns a cleanup callback.
 *
 * @param {object} opts
 * @param {number} [opts.port] — preferred port; helper walks +1, +2, ...
 *   until it finds a free port whose listener (if any) is headless.
 * @returns {Promise<{ port:number, cdpUrl:string, browser:import('playwright-core').Browser, spawned:boolean, cleanup:()=>Promise<void> }>}
 */
export async function acquireChrome(opts = {}) {
  if (!existsSync(CHROME_BIN)) {
    throw new Error(`Chrome not found at ${CHROME_BIN}. Set CHROME_BIN env var.`);
  }
  let port = opts.port || pickPort();
  let browser = null;

  async function cleanup(spawnedHere) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    if (spawnedHere) {
      const entry = spawned.find((c) => c.port === port);
      if (entry) {
        try { process.kill(entry.pid, 'SIGTERM'); } catch {}
      }
    }
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    if (await isPortListening(port)) {
      const cmd = await getBrowserCmdline(port);
      const headless = isHeadlessCmdline(cmd);
      if (headless === false) {
        // Non-headless Chrome squatting — skip this port.
        console.warn(`[chrome] port ${port} is in use by a non-headless Chrome — skipping`);
        port += 1;
        continue;
      }
      // Either headless or unknown — try connecting.
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        return { port, cdpUrl: `http://127.0.0.1:${port}`, browser, spawned: false, cleanup: () => cleanup(false) };
      } catch (e) {
        // CDP didn't accept; try the next port.
        port += 1;
        continue;
      }
    }
    // Nothing listening — spawn our own.
    try {
      await spawnHeadless(port);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      return { port, cdpUrl: `http://127.0.0.1:${port}`, browser, spawned: true, cleanup: () => cleanup(true) };
    } catch (e) {
      // Spawn failed (port still in use? race with another agent?). Try next.
      port += 1;
      continue;
    }
  }
  throw new Error(`Could not acquire a headless Chrome within 10 port attempts (last tried ${port})`);
}
