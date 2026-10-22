import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const shared = fileURLToPath(new URL('../shared', import.meta.url));

export default defineConfig({
  root,
  resolve: { alias: { '@shared': shared } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: {
    port: 5173,
    host: true,
    proxy: { '/socket.io': { target: 'http://localhost:3000', ws: true } },
  },
});
