import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { app as ghostforgeApp } from './ghostforge-server.js';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'ghostforge-api',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = req.url?.split('?')[0] ?? '';
          if (url.startsWith('/api') || url === '/health') {
            ghostforgeApp(req, res, next);
            return;
          }
          next();
        });
      },
    },
  ],
  server: {
    port: 8080,
    host: '127.0.0.1',
    hmr: { overlay: false },
    watch: {
      ignored: ['**/uploads/**', '**/node_modules/**', '**/*.json'],
    },
  },
});
