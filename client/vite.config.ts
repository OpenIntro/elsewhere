import { defineConfig, defaultClientConditions } from 'vite';
import react from '@vitejs/plugin-react';

const serverPort = Number(process.env.VITE_SERVER_PORT ?? process.env.PORT ?? 2567);

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Use @elsewhere/shared TypeScript sources directly (no prebuild needed, HMR works).
    conditions: ['source', ...defaultClientConditions],
  },
  server: {
    port: 5173,
    proxy: {
      // REST goes through the dev proxy; Colyseus connects straight to the server port (see net/connection.ts).
      '/api': { target: `http://localhost:${serverPort}`, changeOrigin: true },
    },
  },
  define: {
    __SERVER_PORT__: JSON.stringify(serverPort),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
});
