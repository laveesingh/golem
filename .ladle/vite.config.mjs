import { defineConfig } from 'vite';
export default defineConfig({
  cacheDir: '.atoms-cache',
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { host: '127.0.0.1', strictPort: true, open: false },
  preview: { host: '127.0.0.1', strictPort: true, open: false },
});
