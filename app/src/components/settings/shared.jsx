import { useCallback, useEffect, useState } from 'react';

export async function api(url, { method = 'GET', body } = {}) {
  const r = await fetch(url, {
    method,
    headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `status ${r.status}`);
  return j;
}

/* The preferences file (/api/prefs): the whole object, and save(patch). */
export function usePrefs() {
  const [prefs, setPrefs] = useState(null);
  const [msg, setMsg] = useState({ text: '', error: false });
  useEffect(() => { api('/api/prefs').then(setPrefs).catch((e) => setMsg({ text: e.message, error: true })); }, []);
  const save = useCallback(async (patch, okText = 'Saved.') => {
    try {
      const next = await api('/api/prefs', { method: 'POST', body: patch });
      setPrefs(next);
      window.dispatchEvent(new CustomEvent('gwn:prefs-changed'));
      setMsg({ text: okText, error: false });
      return next;
    } catch (e) {
      setMsg({ text: e.message, error: true });
      return null;
    }
  }, []);
  return { prefs, save, msg, setMsg };
}

export function Msg({ msg }) {
  if (!msg?.text) return null;
  return <p className={msg.error ? 'settings-modal__error' : 'settings-modal__status'} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>;
}

export function Switch({ id, on, onChange, label, hint, disabled }) {
  return (
    <div className="settings-modal__switch-row">
      <div>
        <b id={`${id}-label`}>{label}</b>
        {hint && <span>{hint}</span>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={Boolean(on)}
        aria-labelledby={`${id}-label`}
        className={`settings-modal__switch${on ? ' is-on' : ''}`}
        onClick={() => onChange(!on)}
        disabled={disabled}
      >
        <span />
      </button>
    </div>
  );
}

export function Section({ title, lead, children }) {
  return (
    <section className="settings-modal__section">
      <h4>{title}</h4>
      {lead && <p className="settings-modal__lead">{lead}</p>}
      {children}
    </section>
  );
}

export const ago = (t) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};
