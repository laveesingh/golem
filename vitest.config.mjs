import { defineConfig } from 'vitest/config';

console.error(
  'component project: atoms and molecules admitted; browser acceptance is separate',
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
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'component',
          environment: 'jsdom',
          include: ['test/component/**/*.test.{mjs,tsx}'],
          setupFiles: ['test/support/component-setup.ts'],
          fileParallelism: false,
          maxWorkers: 1,
          passWithNoTests: false,
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
