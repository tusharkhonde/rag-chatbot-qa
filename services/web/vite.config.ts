import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: '../dist/client', emptyOutDir: true },
  // `npm run dev:client` serves the SPA with hot reload and proxies /api to the BFF,
  // so the browser still sees one origin (cookies and CSRF behave as in production).
  server: { port: 5173, proxy: { '/api': 'http://localhost:8080' } },
});
