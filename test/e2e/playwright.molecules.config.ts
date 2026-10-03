import path from 'node:path';
import { defineConfig } from '@playwright/test';

const output = process.env.GOLEM_MOLECULES_RESULTS_ROOT,
  base = process.env.GOLEM_MOLECULES_BASE_URL;
// Import-safe metadata; molecules.fixture globalSetup refuses missing facilities before browser allocation.
export default defineConfig({
  testDir: '.',
  testMatch: 'molecules.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  updateSnapshots: 'none',
  timeout: 60000,
  outputDir: output ?? path.resolve('.test-results/molecules-unallocated'),
  globalSetup: './molecules.fixture.ts',
  snapshotPathTemplate: '{testDir}/__screenshots__/molecules/{arg}{ext}',
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
    { name: 'molecules-functional', grepInvert: /@visual/ },
    { name: 'molecules-visual', grep: /@visual/ },
  ],
});
