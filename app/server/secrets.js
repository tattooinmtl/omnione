// Local secrets store for API keys. Stored at <project>/.gwn-secrets.json —
// never committed (in .gitignore). The key is never sent back to the client;
// the API only ever sees a "hint" (last 4 chars).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SECRETS_PATH = path.join(PROJECT_ROOT, '.gwn-secrets.json');

const DEFAULT_SECRETS = { providers: {} };

let cache = null;

function readFromDisk() {
  try {
    if (!fs.existsSync(SECRETS_PATH)) return structuredClone(DEFAULT_SECRETS);
    const raw = fs.readFileSync(SECRETS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return structuredClone(DEFAULT_SECRETS);
    if (!parsed.providers) parsed.providers = {};
    return parsed;
  } catch {
    return structuredClone(DEFAULT_SECRETS);
  }
}

function writeToDisk(data) {
  const json = JSON.stringify(data, null, 2);
  // Write to a temp file then rename so a crash mid-write can't corrupt secrets.
  const tmp = SECRETS_PATH + '.tmp';
  fs.writeFileSync(tmp, json, { mode: 0o600 });
  fs.renameSync(tmp, SECRETS_PATH);
}

export function getSecrets() {
  if (!cache) cache = readFromDisk();
  return cache;
}

export function getProviderKey(providerId) {
  const s = getSecrets();
  return s.providers?.[providerId]?.apiKey || null;
}

export function getActiveSettings() {
  const s = getSecrets();
  return s.active || { provider: 'minimax', model: '' };
}

/* How many steps (model turns) one task may take before Omi-One stops,
 * sums up and offers to continue. Settings → AI. */
export const STEP_CHOICES = [25, 50, 100, 200, 300, 500];
export const DEFAULT_MAX_STEPS = 100;

export function getMaxSteps() {
  const n = Number(getSecrets().run?.maxSteps);
  return STEP_CHOICES.includes(n) ? n : DEFAULT_MAX_STEPS;
}

export function setMaxSteps(n) {
  const v = Number(n);
  if (!STEP_CHOICES.includes(v)) throw new Error(`Steps per task must be one of ${STEP_CHOICES.join(', ')}.`);
  const s = getSecrets();
  s.run = { ...(s.run || {}), maxSteps: v };
  writeToDisk(s);
  cache = s;
  return v;
}

export function setActiveSettings({ provider, model }) {
  const s = getSecrets();
  s.active = { provider, model: model || '' };
  // Also remember it against the provider, so switching provider and back
  // restores the model you last used with it rather than the global default.
  if (model) {
    if (!s.providers[provider]) s.providers[provider] = {};
    s.providers[provider].model = model;
  }
  writeToDisk(s);
  cache = s;
}

export function saveProviderKey(providerId, { apiKey, model } = {}) {
  const s = getSecrets();
  if (!s.providers[providerId]) s.providers[providerId] = {};
  if (apiKey != null) s.providers[providerId].apiKey = apiKey;
  if (model != null) s.providers[providerId].model = model;
  writeToDisk(s);
  cache = s;
  return publicProviderStatus(providerId);
}

export function clearProviderKey(providerId) {
  const s = getSecrets();
  if (s.providers[providerId]) {
    delete s.providers[providerId].apiKey;
    writeToDisk(s);
    cache = s;
  }
  return publicProviderStatus(providerId);
}

/* The one place that decides which model a provider actually runs.
 *
 * Precedence: the active selection, then the model last saved against that
 * provider (so switching away and back remembers your choice), then the
 * provider's default. Both /api/settings and /api/generate call this — they
 * used to resolve it differently, so the Settings modal could show one model
 * while generation used another. */
export function resolveModel(providerId, fallbackDefault = '') {
  const s = getSecrets();
  const active = s.active || {};
  if (active.provider === providerId && active.model) return active.model;
  const row = s.providers?.[providerId] || {};
  return row.model || fallbackDefault;
}

/* Return settings safe to send to the client (no key). */
export function publicSettings() {
  const s = getSecrets();
  const active = s.active || { provider: 'minimax', model: '' };
  const id = active.provider;
  const row = s.providers?.[id] || {};
  return {
    provider: id,
    model: resolveModel(id),
    hasOwnKey: Boolean(row.apiKey),
    keyHint: row.apiKey ? hintFromKey(row.apiKey) : null,
  };
}

export function publicProviderStatus(providerId) {
  const s = getSecrets();
  const row = s.providers?.[providerId] || {};
  return {
    hasOwnKey: Boolean(row.apiKey),
    keyHint: row.apiKey ? hintFromKey(row.apiKey) : null,
  };
}

function hintFromKey(k) {
  if (!k) return null;
  if (k.length <= 4) return 'set';
  return `…${k.slice(-4)}`;
}
