import { useCallback, useEffect, useState } from 'react';

/* useProviderTokenBudget — fetches the live provider chart from the local
 * API server (/api/providers) and the active settings (/api/settings).
 * The catalog and settings both live in <project>/.gwn-secrets.json on the
 * server; the client never sees API keys.
 */

export const FALLBACK_OUTPUT_CAP = 16384;

export function estimateTokens(s) {
  return Math.ceil(String(s || '').length / 4);
}

export function fmtTok(n, { zero = '0' } = {}) {
  if (n == null || n === '') return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return zero;
  if (v >= 1000000 && v % 1000000 === 0) return `${v / 1000000}M`;
  if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
  if (v >= 10000) return `${Math.round(v / 1000)}k`;
  return v.toLocaleString();
}

const FALLBACK_PROVIDERS = [
  { id: 'minimax', label: 'MiniMax', defaultModel: 'MiniMax-M3.1-Flash-Preview', defaultMaxTokens: 131072, maxContextTokens: 1000000, maxToolCalls: 200, free: false, builtIn: false },
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o', defaultMaxTokens: 16384, maxContextTokens: 128000, maxToolCalls: null, free: false },
  { id: 'anthropic', label: 'Anthropic', defaultModel: 'claude-sonnet-4-5', defaultMaxTokens: 64000, maxContextTokens: 200000, maxToolCalls: null, free: false },
  { id: 'gwn-local', label: 'OmniOne Local (no key)', defaultModel: 'gwn-stub', defaultMaxTokens: 8192, maxContextTokens: 32000, maxToolCalls: 0, free: true, builtIn: true },
];

let providerCache = null;
let settingsCache = null;
const subs = new Set();

function notify() {
  for (const fn of subs) {
    try { fn(); } catch { /* ignore */ }
  }
}

export async function fetchProviders() {
  if (providerCache) return providerCache;
  try {
    const r = await fetch('/api/providers');
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = await r.json();
    if (Array.isArray(j.providers) && j.providers.length) {
      providerCache = j.providers;
      return providerCache;
    }
  } catch { /* fall through */ }
  providerCache = FALLBACK_PROVIDERS;
  return providerCache;
}

export async function fetchSettings() {
  try {
    const r = await fetch('/api/settings');
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = await r.json();
    settingsCache = j;
    return settingsCache;
  } catch {
    return settingsCache || { provider: 'minimax', model: '', hasOwnKey: false, keyHint: null };
  }
}

export async function saveSettings(payload) {
  const r = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j.error || `status ${r.status}`);
    throw err;
  }
  settingsCache = j;
  // Key may have changed — provider row's hasOwnKey flips; refresh catalog too
  await fetchProviders();
  notify();
  return j;
}

export function useProviderTokenBudget() {
  const [state, setState] = useState({
    providerId: null,
    label: '',
    outputCap: FALLBACK_OUTPUT_CAP,
    contextTokens: null,
    maxToolCalls: null,
    hasOwnKey: false,
    ready: false,
  });

  const load = useCallback(async () => {
    const [providers, mine] = await Promise.all([fetchProviders(), fetchSettings()]);
    const id = (mine && mine.provider) || (providers[0] && providers[0].id) || 'minimax';
    const row = providers.find((p) => p.id === id) || providers[0];
    const out = row && Number(row.defaultMaxTokens) > 0
      ? Number(row.defaultMaxTokens)
      : (row && row.defaultMaxTokens === 0 ? 0 : FALLBACK_OUTPUT_CAP);
    const ctx = row && Number(row.maxContextTokens) > 0 ? Number(row.maxContextTokens) : null;
    const tools = row && Number(row.maxToolCalls) > 0 ? Number(row.maxToolCalls) : null;
    setState({
      providerId: id,
      label: row ? row.label : id,
      outputCap: out,
      contextTokens: ctx,
      maxToolCalls: tools,
      hasOwnKey: !!(mine && mine.hasOwnKey) || !!(row && row.hasOwnKey),
      ready: true,
    });
  }, []);

  useEffect(() => {
    load();
    const onChanged = () => load();
    subs.add(onChanged);
    window.addEventListener('gwn:ai-changed', onChanged);
    return () => {
      subs.delete(onChanged);
      window.removeEventListener('gwn:ai-changed', onChanged);
    };
  }, [load]);

  return state;
}

