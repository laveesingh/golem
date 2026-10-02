import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, FullConfig } from '@playwright/test';
import { test as base, chromium, expect } from '@playwright/test';

// This module is import-safe for static tooling. Validation happens at real runner startup.
export default async function atomEnvironment(config?: FullConfig) {
  const temp = process.env.TMPDIR,
    output = process.env.GOLEM_ATOMS_RESULTS_ROOT,
    baseURL = process.env.GOLEM_ATOMS_BASE_URL;
  if (
    !temp ||
    !path.isAbsolute(temp) ||
    !output ||
    !path.isAbsolute(output) ||
    !baseURL
  )
    throw new Error(
      'Atom browser checks require owned TMPDIR/results and explicit private base URL',
    );
  const url = new URL(baseURL);
  if (
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    ['7420', '7421'].includes(url.port)
  )
    throw new Error(
      'Atom browser checks require private loopback nonlive port',
    );
  if (
    config &&
    config.updateSnapshots !== 'none' &&
    process.env.GOLEM_ATOMS_CAPTURE !== 'initial'
  )
    throw Error('Snapshot updates require explicit initial-candidate mode');
  const identityFile = process.env.GOLEM_ATOMS_IDENTITY_FILE;
  if (!identityFile || !path.isAbsolute(identityFile))
    throw Error('Observed browser/image identity facility required');
  const identityStat = fs.lstatSync(identityFile);
  if (
    !identityStat.isFile() ||
    identityStat.isSymbolicLink() ||
    identityStat.uid !== process.getuid?.() ||
    identityStat.mode & 0o022
  )
    throw Error('Identity must be owned regular private metadata');
  const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8')) as {
    imageDigest: string;
    imageObserved: boolean;
    executableObserved: boolean;
    executable: string;
    executableSha256: string;
    chromiumVersion: string;
    chromiumRevision: string;
    platform: string;
  };
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    identity.platform !== 'linux/amd64' ||
    identity.imageDigest !==
      'sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7' ||
    !identity.imageObserved ||
    !identity.executableObserved ||
    identity.chromiumRevision !== '1243' ||
    identity.chromiumVersion !== '153.0.8010.12'
  )
    throw Error('Actual pinned Linux/browser proof missing or mismatched');
  if (identity.executable !== chromium.executablePath())
    throw Error(
      'Observed browser executable path differs from actual facility',
    );
  const executableHash = createHash('sha256');
  for await (const chunk of fs.createReadStream(identity.executable))
    executableHash.update(chunk);
  if (executableHash.digest('hex') !== identity.executableSha256)
    throw Error(
      'Observed browser executable hash differs from actual facility',
    );
  if (!fs.existsSync(chromium.executablePath()))
    throw new Error(
      'Atom browser executable facility is missing; no implicit download',
    );
  const stat = fs.lstatSync(output),
    relative = path.relative(fs.realpathSync(temp), fs.realpathSync(output));
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o022 ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error(
      'Atom results must be an owned directory under the private TMPDIR',
    );
}
async function closedWithin(
  child: import('node:child_process').ChildProcess,
  milliseconds: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<boolean>((resolve) =>
        child.once('exit', () => resolve(true)),
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export const test = base.extend({
  browser: [
    async ({ browserName }, use) => {
      await atomEnvironment();
      if (browserName !== 'chromium')
        throw new Error('Atom browser fixture supports Chromium only');
      const temp = process.env.TMPDIR;
      if (!temp) throw Error('Missing validated private atom TMPDIR');
      const root = fs.mkdtempSync(path.join(temp, 'gol501-chrome-')),
        profile = path.join(root, 'profile');
      fs.mkdirSync(profile);
      const child = spawn(
        chromium.executablePath(),
        [
          '--headless=new',
          '--disable-gpu',
          '--no-sandbox',
          `--user-data-dir=${profile}`,
          '--remote-debugging-port=0',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '',
        browser: Browser | undefined,
        failure: unknown;
      const cleanup: unknown[] = [];
      try {
        const endpoint = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Owned Chrome CDP startup timeout')),
            15000,
          );
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`Owned Chrome exited before CDP: ${code}`));
          });
          child.stderr.on('data', (data) => {
            stderr = (stderr + String(data)).slice(-65536);
            const found = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
            if (found) {
              clearTimeout(timer);
              resolve(found[1]);
            }
          });
        });
        browser = await chromium.connectOverCDP(endpoint);
        if (
          process.env.GOLEM_ATOMS_BROWSER_VERSION &&
          browser.version() !== process.env.GOLEM_ATOMS_BROWSER_VERSION
        )
          throw new Error('Pinned atom Chromium version mismatch');
        await use(browser);
      } catch (error) {
        failure = error;
      } finally {
        try {
          if (browser) await browser.close();
        } catch (error) {
          cleanup.push(error);
        }
        let exited =
          child.pid === undefined ||
          child.exitCode !== null ||
          child.signalCode !== null;
        if (!exited) {
          child.kill('SIGTERM');
          exited = await closedWithin(child, 5000);
          if (!exited) {
            child.kill('SIGKILL');
            exited = await closedWithin(child, 5000);
          }
        }
        if (exited) {
          try {
            fs.rmSync(root, { recursive: true, force: true });
            if (fs.existsSync(root))
              cleanup.push(new Error('Owned Chrome profile cleanup failed'));
          } catch (error) {
            cleanup.push(error);
          }
        } else
          cleanup.push(
            new Error(
              `Uncertain Chrome exit; owned profile retained at ${root}`,
            ),
          );
      }
      if (failure || cleanup.length)
        throw new AggregateError(
          [...(failure ? [failure] : []), ...cleanup],
          'Owned atom browser failed or cleanup incomplete',
        );
    },
    { scope: 'worker' },
  ],
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-10-01T00:00:00Z'));
    await page.addInitScript(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {}
      Math.random = () => 0.125;
    });
    try {
      await use(page);
    } finally {
      await page.close();
    }
  },
});
export { expect };
