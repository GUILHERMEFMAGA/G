import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // permite servir através de proxies/previews (ex.: *.e2b.app)
    allowedHosts: true,
    cors: true,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
});
