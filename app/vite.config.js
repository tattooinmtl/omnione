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
    port: 5174,
    strictPort: true,
    // NOTE: `host: true` also exposes the UI on the LAN. The API itself stays
    // bound to loopback, but anyone who can reach :5174 reaches the API
    // through this proxy, token and all. Set host: 'localhost' if you want
    // this machine only.
    host: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5180',
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
  },
});
