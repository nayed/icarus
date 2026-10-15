import { defineConfig } from 'vite';

export default defineConfig({
  // relative asset paths: the build works at any URL (GitHub Pages serves it under /icarus/)
  base: './',
  server: { port: 5173, strictPort: false },
  preview: { port: 4173 },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    // keep @license headers (three.js's MIT notice) in the minified bundle
    rolldownOptions: { output: { comments: { legal: true, annotation: false, jsdoc: false } } },
  },
});
