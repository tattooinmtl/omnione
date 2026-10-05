import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { ensureToken, TOKEN_HEADER } from './server/auth.js';

// Vite config — dev server on :5174, served at the site root.
// The /api/* paths are proxied to the local Node server on :5180 so the
// React app can call /api/generate, /api/providers, /api/settings directly.
//
// The proxy attaches the auth token on the way through. Doing it here rather
// than in the browser means the token never reaches client-side JavaScript,
// and EventSource requests — which cannot set headers themselves — are
// authenticated like everything else.
const token = ensureToken();

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.OMNIONE_PORT) || 5174,
    strictPort: true,
    // This PC only. Anyone who can reach :5174 reaches the API through the
    // proxy below, token and all, so the LAN is opt-in: OMNIONE_LAN=1.
    host: process.env.OMNIONE_LAN === '1' ? true : 'localhost',
    proxy: {
      '/api': {
        // OMNIONE_API_PORT first: some launchers set PORT to Vite's own port.
        target: `http://127.0.0.1:${Number(process.env.OMNIONE_API_PORT || process.env.PORT) || 5180}`,
        changeOrigin: false,
        ws: false,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader(TOKEN_HEADER, token);
          });
        },
      },
    },
  },
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // Three.js and the editor make one big bundle; it's loaded from this PC,
    // not over the network, so the size warning is just noise.
    chunkSizeWarningLimit: 4000,
  },
});
