import path from 'node:path';
import { defineConfig } from '@playwright/test';

const output = process.env.GOLEM_ATOMS_RESULTS_ROOT,
  base = process.env.GOLEM_ATOMS_BASE_URL;
// Import-safe metadata; atoms.fixture globalSetup refuses missing facilities before browser allocation.
export default defineConfig({
  testDir: '.',
  testMatch: 'atoms.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  updateSnapshots: 'none',
  timeout: 60000,
  outputDir: output ?? path.resolve('.test-results/atoms-unallocated'),
  globalSetup: './atoms.fixture.ts',
  snapshotPathTemplate: '{testDir}/__screenshots__/atoms/{arg}{ext}',
  use: {
    baseURL: base,
    viewport: { width: 640, height: 900 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'atoms-functional', grepInvert: /@visual/ },
    { name: 'atoms-visual', grep: /@visual/ },
  ],
});
