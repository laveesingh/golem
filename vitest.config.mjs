import { defineConfig } from 'vitest/config';

console.error(
  'component project PENDING W4: zero suites; no component coverage claimed',
);

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'artefact',
          environment: 'node',
          include: ['test/artefact/**/*.test.mjs'],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 120000,
          hookTimeout: 120000,
          setupFiles: ['test/support/vitest-isolation.mjs'],
        },
      },
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.mjs'],
          fileParallelism: false,
          setupFiles: ['test/support/unit-guard.mjs'],
        },
      },
      {
        test: {
          name: 'component',
          environment: 'jsdom',
          include: ['test/component/**/*.test.{mjs,tsx}'],
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: [
            'test/integration/**/*.test.mjs',
            'test/cli-verb-help.test.mjs',
            'test/model-providers.test.mjs',
          ],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 120000,
          hookTimeout: 120000,
          setupFiles: ['test/support/vitest-isolation.mjs'],
        },
      },
    ],
  },
});
