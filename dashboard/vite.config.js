import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

export default defineConfig({
  root: path.join(here, 'web'),
  cacheDir: process.env.GOLEM_VITE_CACHE_DIR,
  define: {
    __GOLEM_PACKAGE_VERSION__: JSON.stringify(packageJson.version),
  },
  build: {
    target: 'esnext',
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
  },
  server: {
    host: process.env.GOLEM_PROFILE ? '127.0.0.1' : undefined,
    port: Number(process.env.GOLEM_VITE_PORT ?? '5173'),
    strictPort: true,
    proxy: {
      '/api': process.env.GOLEM_DASHBOARD_URL ?? 'http://127.0.0.1:7421',
      '/ws': { target: (process.env.GOLEM_DASHBOARD_URL ?? 'http://127.0.0.1:7421').replace(/^http/, 'ws'), ws: true },
    },
  },
});
