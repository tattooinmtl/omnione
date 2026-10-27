// Keys out of tool results.
//
// Whatever a tool returns goes to the AI provider, and a page or file the
// agent reads can tell it to repeat what it saw somewhere else. So before a
// result reaches the model, known key shapes and the exact secrets OmniOne
// holds (provider keys, the API token, the website account token, *_KEY
// environment variables) are replaced with a marker.

import fs from 'node:fs';
import path from 'node:path';
import { getSecrets } from './secrets.js';
import { ensureToken, PROJECT_ROOT } from './auth.js';

const KEY_SHAPES = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bnvapi-[A-Za-z0-9_-]{20,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxai-[A-Za-z0-9]{20,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const MARK = '[redacted secret]';
const MIN_SECRET = 12;

/* Every string under a key that names a secret (apiKey, token, password…). */
function leaves(v, out, secretKey = false) {
  if (typeof v === 'string') { if (secretKey && v.length >= MIN_SECRET) out.add(v); }
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) leaves(x, out, secretKey || /key|token|secret|passw/i.test(k));
  }
  return out;
}

/* The exact secret strings this install knows about. */
export function knownSecrets({ env = process.env } = {}) {
  const out = new Set();
  try {
    leaves(getSecrets(), out);
  } catch { /* no secrets file */ }
  try { out.add(ensureToken()); } catch { /* no token yet */ }
  try { leaves(JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, '.gwn-cloud.json'), 'utf8')), out); } catch { /* not connected */ }
  for (const [k, v] of Object.entries(env)) {
    if (/(KEY|TOKEN|SECRET|PASSWORD)$/i.test(k) && v && v.length >= MIN_SECRET) out.add(v);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/* The text with every secret replaced. */
export function redactForModel(text, { secrets = knownSecrets() } = {}) {
  let s = String(text ?? '');
  for (const v of secrets) if (s.includes(v)) s = s.split(v).join(MARK);
  for (const re of KEY_SHAPES) s = s.replace(re, MARK);
  return s;
}
