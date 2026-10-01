// The connection to the user's account on omnione.globalwarningnetworks.com.
//
// Optional: nothing in OmniOne needs it to run. Connected, the app shows who
// is signed in, Omi-One can read and (with the user's approval) post on the
// forum, and usage totals sync to the website profile.
//
// Connecting works like signing in to a CLI from Claude or ChatGPT: the app
// asks the site for a short code, the user approves it in their browser —
// where they are already signed in — and the app receives a token. The app
// never sees the password. The token lives in .gwn-cloud.json (gitignored,
// owner-only), never in the browser: every cloud call goes through this
// server, and the React app only ever gets the profile.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
let statePath = path.join(PROJECT_ROOT, '.gwn-cloud.json');

export const DEFAULT_SITE = 'https://omnione.globalwarningnetworks.com';
const TIMEOUT_MS = 15_000;

let state = null;
let pending = null;   // an in-progress connect: { deviceCode, userCode, verifyUrl, expiresAt, interval }

export function _setCloudStateForTest(p) {
  statePath = p;
  state = null;
  pending = null;
}

export function siteUrl() {
  return (process.env.OMNI_CLOUD_URL || DEFAULT_SITE).replace(/\/+$/, '');
}

function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
}

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    state = {};
  }
  // A stable id for this installation, made once. It is how the website
  // tells this computer apart from the user's others.
  if (!state.deviceUid) {
    state.deviceUid = 'omni-' + crypto.randomBytes(12).toString('hex');
    save();
  }
  return state;
}

function save() {
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, statePath);
}

function deviceInfo() {
  const s = load();
  return {
    uid: s.deviceUid,
    name: os.hostname().slice(0, 100),
    os: `${os.type()} ${os.release()}`.slice(0, 100),
    app_version: appVersion(),
  };
}

export class CloudError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/* One call to the website's API. Throws CloudError with the site's own
 * error code and message, which are written for people. */
async function api(method, route, { body, token, signal } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let res;
  try {
    res = await fetch(`${siteUrl()}/api/${route}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'User-Agent': `OmniOne/${appVersion() || 'dev'}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
  } catch (e) {
    throw new CloudError('offline', `Can’t reach ${siteUrl().replace(/^https?:\/\//, '')}. Check your internet connection.`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !json || json.ok === false) {
    const code = json?.error || `http_${res.status}`;
    // The website says a token is no good any more: forget it, so the UI
    // shows "Connect account" instead of failing forever.
    if (res.status === 401 && token) signOutLocally();
    throw new CloudError(code, json?.message || `The website answered ${res.status}.`, res.status);
  }
  return json;
}

function token() {
  return load().token || null;
}

function requireToken() {
  const t = token();
  if (!t) throw new CloudError('not_connected', 'OmniOne isn’t connected to an account. Connect one from the account menu (bottom left).');
  return t;
}

function signOutLocally() {
  const s = load();
  delete s.token;
  delete s.user;
  delete s.device;
  s.disconnectedAt = new Date().toISOString();
  save();
}

/* What the React app may know: never the token. */
export function publicAccount() {
  const s = load();
  return {
    connected: Boolean(s.token),
    site: siteUrl(),
    user: s.token ? s.user || null : null,
    device: s.token ? s.device || null : null,
    connectedAt: s.token ? s.connectedAt || null : null,
    lastSync: s.lastSync || null,
    pending: pending && pending.expiresAt > Date.now()
      ? { userCode: pending.userCode, verifyUrl: pending.verifyUrl, expiresAt: pending.expiresAt }
      : null,
  };
}

function remember(result) {
  const s = load();
  s.token = result.token;
  s.user = result.user || null;
  s.device = result.device || null;
  s.connectedAt = new Date().toISOString();
  delete s.disconnectedAt;
  save();
}

// --- connecting -----------------------------------------------------------------

/* Step 1: get a code for the user to approve in their browser. */
export async function startConnect() {
  const r = await api('POST', 'auth/device/start', { body: { device: deviceInfo() } });
  pending = {
    deviceCode: r.device_code,
    userCode: r.user_code,
    verifyUrl: r.verify_url,
    interval: Math.max(2, Number(r.interval) || 5),
    expiresAt: Date.now() + (Number(r.expires_in) || 600) * 1000,
  };
  return publicAccount().pending;
}

/* Step 2, repeated by the UI: has the user approved it yet? */
export async function pollConnect() {
  if (!pending) return { status: 'none' };
  if (pending.expiresAt <= Date.now()) {
    pending = null;
    return { status: 'expired' };
  }
  const r = await api('POST', 'auth/device/poll', { body: { device_code: pending.deviceCode } });
  if (r.status === 'approved' && r.token) {
    remember(r);
    pending = null;
    return { status: 'approved', account: publicAccount() };
  }
  if (r.status === 'denied' || r.status === 'expired') pending = null;
  return { status: r.status || 'pending' };
}

export function cancelConnect() {
  pending = null;
}

/* Refresh the profile (name, avatar, tier) from the website. */
export async function refreshAccount() {
  const r = await api('GET', 'me', { token: requireToken() });
  const s = load();
  s.user = r.user;
  s.device = r.device || s.device;
  save();
  return publicAccount();
}

export async function disconnect() {
  const t = token();
  if (t) {
    try { await api('POST', 'auth/logout', { token: t }); } catch { /* signing out locally is what matters */ }
  }
  signOutLocally();
  return publicAccount();
}

// --- forum ------------------------------------------------------------------------

export async function forumList({ category = '', page = 1, signal } = {}) {
  const q = new URLSearchParams();
  if (category) q.set('c', category);
  if (page > 1) q.set('p', String(page));
  return api('GET', 'forum/list' + (q.toString() ? `?${q}` : ''), { token: requireToken(), signal });
}

export async function forumRead(id, { signal } = {}) {
  return api('GET', `forum/read?id=${encodeURIComponent(id)}`, { token: requireToken(), signal });
}

export async function forumPost({ category, title, body }, { signal } = {}) {
  return api('POST', 'forum/post', { token: requireToken(), body: { category, title, body }, signal });
}

export async function forumComment({ postId, comment }, { signal } = {}) {
  return api('POST', 'forum/comment', { token: requireToken(), body: { post_id: postId, comment }, signal });
}

// --- usage sync ----------------------------------------------------------------------

/* Send the per-day totals to the profile. Idempotent on the website's side:
 * a day's numbers replace that day's row, so sending twice is harmless. */
export async function syncUsage(entries) {
  if (!token() || !entries.length) return { skipped: true };
  const r = await api('POST', 'usage', { token: token(), body: { entries } });
  const s = load();
  s.lastSync = new Date().toISOString();
  save();
  return r;
}
