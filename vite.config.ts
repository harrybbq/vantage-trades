import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // In development the API runs as a separate process (scripts/dev-server.ts).
    // Proxying keeps the browser on one origin, so the app talks to /api/control
    // in development exactly as it does on Netlify.
    proxy: {
      '/api': {
        target: process.env['API_URL'] ?? 'http://localhost:8788',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/control/, '/'),
      },
    },
  },
});
