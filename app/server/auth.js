// Loopback auth for the OmniOne API server.
//
// The server binds to 127.0.0.1 only, but that is not enough on its own: any
// page open in any browser on this machine can POST to http://localhost:5180.
// Once the agent grows filesystem and shell tools, that is remote code
// execution reachable from a malicious webpage (directly, or via DNS
// rebinding, which defeats the Origin check alone).
//
// Two gates, both cheap:
//   1. A shared secret in .gwn-token, generated on first boot (mode 0600).
//      The browser never sees it — the Vite dev proxy injects the header
//      server-side (see vite.config.js), so even EventSource requests, which
//      cannot set headers themselves, arrive authenticated.
//   2. A Host header check, so a rebound DNS name pointing at 127.0.0.1
//      is rejected even if the attacker somehow learns the token.
//
// When the server serves the built UI itself (OmniOne.exe, no Vite), there is
// no proxy to add the header, so the page gets an HttpOnly, SameSite=Strict
// cookie instead. The cookie is honoured only on requests the browser marks
// Sec-Fetch-Site: same-origin, i.e. from OmniOne's own page: another site,
// even one on a different localhost port, can't use it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const TOKEN_PATH = path.join(PROJECT_ROOT, '.gwn-token');

export const TOKEN_HEADER = 'x-gwn-token';

// Paths that answer without a token. Keep this list to things that leak
// nothing and change nothing — it exists so a human can curl the server to
// find out whether it is up.
const PUBLIC_PATHS = new Set(['/api/health']);

let cached = null;

/* Read the token, creating it if this is the first boot. Both the API server
 * and the Vite config call this; whichever starts first wins the race and the
 * other reads the file back. */
export function ensureToken() {
  if (cached) return cached;
  try {
    const existing = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (existing.length >= 32) {
      cached = existing;
      return cached;
    }
  } catch {
    // Not there yet, or unreadable — fall through and write a fresh one.
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  // writeFileSync only applies `mode` when it creates the file; if an empty
  // or short token was already there, chmod explicitly.
  try { fs.chmodSync(TOKEN_PATH, 0o600); } catch { /* not supported on all FS */ }
  cached = token;
  return cached;
}

/* Constant-time compare that tolerates length mismatch without throwing. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* Only localhost names may address this server. Blocks DNS rebinding, where
 * an attacker-controlled name resolves to 127.0.0.1 and the browser happily
 * sends the request with the attacker's origin. */
export function isLocalHostHeader(hostHeader) {
  if (!hostHeader) return false;
  // Strip the port. Bracketed IPv6 literals need care: [::1]:5180.
  const host = String(hostHeader).startsWith('[')
    ? String(hostHeader).slice(1, String(hostHeader).indexOf(']'))
    : String(hostHeader).split(':')[0];
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export const UI_COOKIE = 'omni_ui';

/* The cookie value: derived from the token, so it can't be replayed as the header. */
export function uiCookieValue() {
  return crypto.createHmac('sha256', ensureToken()).update('omnione-ui-cookie').digest('hex');
}

function cookieFrom(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

export function authMiddleware(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  if (!isLocalHostHeader(req.headers.host)) {
    return res.status(403).json({ error: 'Forbidden: this server only accepts loopback Host headers.' });
  }

  // The UI itself (HTML, scripts, images) is public; only the API is gated.
  if (!req.path.startsWith('/api/') && req.path !== '/api') return next();

  if (req.headers['sec-fetch-site'] === 'same-origin' && safeEqual(cookieFrom(req, UI_COOKIE), uiCookieValue())) {
    return next();
  }

  // Header first (what the Vite proxy injects). The query fallback exists so
  // `curl "http://localhost:5180/api/tools?token=$(cat .gwn-token)"` works
  // without a -H flag; it is equally strong, just less ergonomic to keep
  // out of shell history.
  const presented = req.headers[TOKEN_HEADER] || req.query?.token;
  if (!safeEqual(presented, ensureToken())) {
    return res.status(401).json({
      error: 'Unauthorized: missing or bad token.',
      hint: `Send the contents of .gwn-token as the ${TOKEN_HEADER} header.`,
    });
  }
  return next();
}
