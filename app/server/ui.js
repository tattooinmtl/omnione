// Serving the built UI (dist/) from the API server, for OmniOne.exe.
//
// In development `npm run dev` runs Vite, which serves the UI and proxies
// /api here with the token. Users don't need any of that: the UI is built
// once (`npm run build`) and this serves it, one process instead of three.
// The page gets the UI cookie (see auth.js) so its API calls are accepted.

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { PROJECT_ROOT, UI_COOKIE, uiCookieValue } from './auth.js';

export const DIST_DIR = path.join(PROJECT_ROOT, 'dist');

function sendIndex(res, distDir) {
  const index = path.join(distDir, 'index.html');
  if (!fs.existsSync(index)) {
    return res.status(503).type('text/plain').send('OmniOne\'s app files are not built yet. Run: npm run build');
  }
  res.setHeader('Set-Cookie', `${UI_COOKIE}=${uiCookieValue()}; HttpOnly; SameSite=Strict; Path=/api`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.sendFile(index);
}

export function serveBuiltUi(app, { distDir = DIST_DIR } = {}) {
  app.get(['/', '/index.html'], (_req, res) => sendIndex(res, distDir));
  app.use(express.static(distDir, { index: false, fallthrough: true, maxAge: '1h' }));
  // The app's own routes (/app, /presence…) all load the same page.
  app.get(/^\/(?!api(\/|$)).*/, (_req, res) => sendIndex(res, distDir));
}
