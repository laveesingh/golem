// GOL-387 fix round 1: standalone build for the isolated public-reader
// diagram bundle. Single self-contained ESM file (all mermaid chunks
// inlined) at a STABLE filename the public listener serves as a fixed
// allowlisted asset. Separate from vite.config.js on purpose: the main
// build wipes outDir, this one never does (emptyOutDir:false) and never
// touches the SPA output.
import { defineConfig } from 'vite';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    target: 'esnext',
    outDir: path.join(here, 'dist'),
    emptyOutDir: false,
    sourcemap: false,
    minify: true,
    lib: {
      entry: path.join(here, 'web', 'share-mermaid-entry.js'),
      formats: ['es'],
      fileName: () => 'share-mermaid.mjs',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
