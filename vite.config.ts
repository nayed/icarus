import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: false },
  preview: { port: 4173 },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
});
