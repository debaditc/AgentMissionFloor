import { defineConfig } from 'vite';

// Built into dist/ and served by the collector (same origin, token cookie, no CDN).
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 1500, reportCompressedSize: true },
});
