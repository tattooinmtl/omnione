import { useEffect, useState } from 'react';
import {
  fetchProviders,
  fetchSettings,
  saveSettings,
  fmtTok,
} from '../hooks/useProviderTokenBudget.js';
import './SettingsModal.css';

const SAMPLE_KEY_HINT = 'sk-…';

export default function SettingsModal({ onClose }) {
  const [providers, setProviders] = useState([]);
  const [settings, setSettings] = useState({ provider: 'minimax', model: '', hasOwnKey: false, keyHint: null });
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [provs, mine] = await Promise.all([fetchProviders(), fetchSettings()]);
      setProviders(provs);
      setSettings((s) => ({ ...s, ...mine }));
    })();
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setStatus('Saving…');
    setError('');
    setSaving(true);
    try {
      const payload = { provider: settings.provider, model: settings.model || undefined };
      if (apiKey.trim()) payload.apiKey = apiKey.trim();
      const next = await saveSettings(payload);
      setSettings((s) => ({ ...s, ...next }));
      setApiKey('');
      setStatus('Saved.');
      // Refresh providers so hasOwnKey column flips
      setProviders(await fetchProviders());
    } catch (e) {
      setError(e.message || 'Save failed');
      setStatus('');
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    if (!settings.hasOwnKey) return;
    setStatus('Clearing key…');
    setError('');
    try {
      const next = await saveSettings({ provider: settings.provider, model: settings.model || undefined, apiKey: '' });
      setSettings((s) => ({ ...s, ...next }));
      setStatus('Key cleared.');
    } catch (e) {
      setError(e.message || 'Clear failed');
      setStatus('');
    }
  };

  const current = providers.find((p) => p.id === settings.provider);

  return (
    <div className="settings-modal" role="dialog" aria-modal="true">
      <div className="settings-modal__backdrop" onClick={onClose} />
      <div className="settings-modal__panel">
        <header className="settings-modal__head">
          <h3>AI SETTINGS</h3>
          <button type="button" className="settings-modal__close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="settings-modal__body">
          <p className="hint">
            Pick a provider and save your API key. The key never leaves this
            machine — the local server stores it in <code>.gwn-secrets.json</code>
            and only returns a 4-character hint to the UI. The built-in
            <strong> OmniOne Local</strong> stub demonstrates the full pipeline
            with no key.
          </p>

          <form onSubmit={save}>
            <label>
              <span>Provider</span>
              <select
                value={settings.provider}
                onChange={(e) => setSettings((s) => ({ ...s, provider: e.target.value, model: '' }))}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}{p.builtIn ? ' (built-in)' : ''}{p.free ? ' · free' : ''}
                    {p.hasOwnKey ? ' · key saved' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Model <em>(default: {current ? current.defaultModel : 'auto'})</em></span>
              <input
                type="text"
                placeholder={current ? current.defaultModel : 'model id'}
                value={settings.model || ''}
                onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
              />
            </label>

            <label>
              <span>
                Your API key{' '}
                {settings.hasOwnKey && settings.keyHint && <em>(saved: {settings.keyHint})</em>}
              </span>
              <div className="settings-modal__key-row">
                <input
                  type="password"
                  placeholder={settings.provider === 'gwn-local'
                    ? 'not needed — this provider requires no key'
                    : SAMPLE_KEY_HINT}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  disabled={settings.provider === 'gwn-local'}
                />
                {settings.hasOwnKey && settings.provider !== 'gwn-local' && (
                  <button
                    type="button"
                    className="settings-modal__clear"
                    onClick={clearKey}
                    title="Delete the saved key for this provider"
                  >Clear key</button>
                )}
              </div>
            </label>

            <div className="settings-modal__form-row">
              <button type="submit" className="settings-modal__save" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              {status && <span className="settings-modal__status">{status}</span>}
              {error && <span className="settings-modal__error">{error}</span>}
            </div>
          </form>

          <h4>Provider chart</h4>
          <div className="cap-table-wrap">
            <table className="cap-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Default model</th>
                  <th className="num">Output cap</th>
                  <th className="num">Context</th>
                  <th className="num">Tools</th>
                  <th>Key</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => (
                  <tr key={p.id} className={p.id === settings.provider ? 'is-active' : ''}>
                    <td>{p.label}{p.id === settings.provider ? ' · selected' : ''}</td>
                    <td className="muted">{p.defaultModel || 'auto'}</td>
                    <td className="num">{fmtTok(p.defaultMaxTokens)}</td>
                    <td className="num">{fmtTok(p.maxContextTokens)}</td>
                    <td className="num">{p.maxToolCalls == null ? '—' : Number(p.maxToolCalls).toLocaleString()}</td>
                    <td>{p.id === 'gwn-local' ? '—' : (p.hasOwnKey ? <span className="muted">saved</span> : <span className="muted">none</span>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
