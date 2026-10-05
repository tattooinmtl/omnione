import { useEffect, useState } from 'react';
import {
  fetchProviders,
  fetchSettings,
  saveSettings,
  fmtTok,
} from '../hooks/useProviderTokenBudget.js';
import PersonalityTab from './settings/PersonalityTab.jsx';
import VoiceTab from './settings/VoiceTab.jsx';
import MediaTab from './settings/MediaTab.jsx';
import SchedulesTab from './settings/SchedulesTab.jsx';
import ConnectionsTab from './settings/ConnectionsTab.jsx';
import MemoryTab from './settings/MemoryTab.jsx';
import { usePrefs, Switch, Msg, Section } from './settings/shared.jsx';
import './SettingsModal.css';

/* Settings, one tab per subject, listed down the side:
 *   AI           provider, model, API key, thinking, creativity
 *   Personality  the role Omi-One plays, and custom ones
 *   Voice        how it sounds, the wake word, cloning a voice
 *   Media        defaults for pictures and music
 *   Schedules    tasks it runs on its own, and their results
 *   Connections  outside services and MCP servers
 *   Memory       SOUL.md, what it remembers, the heartbeat
 *   Access       its folder, and what it may read and change on the PC
 *   App          start with Windows, notifications, version
 * The tray icon opens this window straight to a tab (#settings / #settings-app).
 */

const TABS = [
  { id: 'ai', label: 'AI' },
  { id: 'personality', label: 'Personality' },
  { id: 'voice', label: 'Voice' },
  { id: 'media', label: 'Media' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'connections', label: 'Connections' },
  { id: 'memory', label: 'Memory' },
  { id: 'access', label: 'Access' },
  { id: 'app', label: 'App' },
];

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `status ${r.status}`);
  return j;
}

// --- AI -------------------------------------------------------------------------------

const SAMPLE_KEY_HINT = 'sk-…';

function AiTab() {
  const [providers, setProviders] = useState([]);
  const [settings, setSettings] = useState({ provider: 'minimax', model: '', hasOwnKey: false, keyHint: null });
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [chart, setChart] = useState(false);

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
      setProviders(await fetchProviders());
    } catch (err) {
      setError(err.message || 'Save failed');
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
    } catch (err) {
      setError(err.message || 'Clear failed');
      setStatus('');
    }
  };

  const current = providers.find((p) => p.id === settings.provider);

  return (
    <>
      <p className="hint">
        Pick a provider and save your API key. The key never leaves this
        machine: the local server stores it in <code>.gwn-secrets.json</code> and
        only shows a 4-character hint here. The built-in <strong>OmniOne Local</strong> stub
        works with no key.
      </p>

      <form onSubmit={save}>
        <label>
          <span>Provider</span>
          <select value={settings.provider} onChange={(e) => setSettings((s) => ({ ...s, provider: e.target.value, model: '' }))}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}{p.builtIn ? ' (built-in)' : ''}{p.free ? ' · free' : ''}{p.hasOwnKey ? ' · key saved' : ''}
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
          <span>Your API key {settings.hasOwnKey && settings.keyHint && <em>(saved: {settings.keyHint})</em>}</span>
          <div className="settings-modal__key-row">
            <input
              type="password"
              placeholder={settings.provider === 'gwn-local' ? 'not needed: this provider requires no key' : SAMPLE_KEY_HINT}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              disabled={settings.provider === 'gwn-local'}
            />
            {settings.hasOwnKey && settings.provider !== 'gwn-local' && (
              <button type="button" className="settings-modal__clear" onClick={clearKey} title="Delete the saved key for this provider">Clear key</button>
            )}
          </div>
        </label>

        <div className="settings-modal__form-row">
          <button type="submit" className="settings-modal__save" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          {status && <span className="settings-modal__status">{status}</span>}
          {error && <span className="settings-modal__error">{error}</span>}
        </div>
      </form>

      <StepsSetting />
      <BehaviourSetting />

      <button type="button" className="settings-modal__disclose" aria-expanded={chart} onClick={() => setChart((c) => !c)}>
        {chart ? '▾' : '▸'} Provider chart
      </button>
      {chart && (
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
                  <td>{p.id === 'gwn-local' ? '—' : <span className="muted">{p.hasOwnKey ? 'saved' : 'none'}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* How the model answers: creativity (temperature) and the visible thinking. */
const CREATIVITY = [
  ['', 'Provider default'],
  ['0.2', 'Precise (0.2)'],
  ['0.7', 'Balanced (0.7)'],
  ['1', 'Creative (1.0)'],
];
function BehaviourSetting() {
  const { prefs, save, msg } = usePrefs();
  if (!prefs) return null;
  const t = prefs.ai.temperature;
  return (
    <Section title="How it answers">
      <label>
        <span>Creativity</span>
        <select id="ai-temperature" value={t == null ? '' : String(t)} onChange={(e) => save({ ai: { temperature: e.target.value === '' ? null : Number(e.target.value) } })}>
          {CREATIVITY.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
        </select>
      </label>
      <label>
        <span>Helpers working at the same time</span>
        <select id="ai-parallel" value={prefs.ai.parallelAgents} onChange={(e) => save({ ai: { parallelAgents: Number(e.target.value) } }, `Up to ${e.target.value} helper${e.target.value === '1' ? '' : 's'} at once.`)}>
          {[1, 2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n}{n === 4 ? ' (default, MiniMax allows 4)' : n === 1 ? ' (one after another)' : ''}</option>)}
        </select>
      </label>
      <p className="settings-modal__note">
        For a big job Omi-One can send several helpers (subagents) off at once, each on its own part,
        and gather their answers. Each one is a request to your AI provider at the same moment: MiniMax
        accepts 4 at once per key, so more than 4 makes the extra ones wait their turn.
      </p>
      <Switch id="ai-thinking" on={prefs.ai.thinking} onChange={(on) => save({ ai: { thinking: on } })} label="Show thinking" hint="Shows the model's reasoning in the chat while it works." />
      <Msg msg={msg} />
    </Section>
  );
}

/* How long Omi-One may work on one task before it stops, sums up and offers to continue. */
function StepsSetting() {
  const [steps, setSteps] = useState(null);
  const [msg, setMsg] = useState({ text: '', error: false });
  useEffect(() => {
    fetch('/api/settings/steps').then((r) => r.json()).then(setSteps).catch(() => {});
  }, []);
  if (!steps) return null;
  const change = async (e) => {
    const maxSteps = Number(e.target.value);
    try {
      setSteps(await post('/api/settings/steps', { maxSteps }));
      setMsg({ text: `Omi-One can now take up to ${maxSteps} steps per task.`, error: false });
    } catch (err) {
      setMsg({ text: err.message, error: true });
    }
  };
  return (
    <section className="settings-modal__section">
      <h4>Steps per task</h4>
      <label>
        <span>How long Omi-One may work on one task</span>
        <select value={steps.maxSteps} onChange={change}>
          {steps.choices.map((n) => <option key={n} value={n}>{n} steps{n === 100 ? ' (default)' : ''}</option>)}
        </select>
      </label>
      <p className="settings-modal__note">
        A step is one reply from the AI, with the tools it uses. At the limit Omi-One stops,
        tells you what's done and what's left, and you can press Continue. A higher limit
        lets long jobs (boards, big projects) run through, and uses more tokens.
      </p>
      {msg.text && <p className={msg.error ? 'settings-modal__error' : 'settings-modal__status'}>{msg.text}</p>}
    </section>
  );
}

// --- Access ---------------------------------------------------------------------------

function WorkspaceSetting() {
  const [ws, setWs] = useState({ root: '', isDefault: true });
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState({ text: '', error: false });

  useEffect(() => {
    fetch('/api/workspace').then((r) => r.json()).then((j) => { setWs(j); setTyped(j.root || ''); }).catch(() => {});
  }, []);

  const act = async (label, url, body, done) => {
    setBusy(label);
    setMsg({ text: '', error: false });
    try {
      const j = await post(url, body);
      await done(j);
    } catch (e) {
      setMsg({ text: e.message || 'Something went wrong.', error: true });
    } finally {
      setBusy('');
    }
  };
  const use = (root) => act('save', '/api/workspace', { root }, (j) => { setWs(j); setTyped(j.root); setMsg({ text: 'Omi-One now works in this folder.', error: false }); });
  const browse = () => act('browse', '/api/workspace/browse', {}, async (j) => { if (j?.root) await use(j.root); });
  const reset = () => act('reset', '/api/workspace', { reset: true }, (j) => { setWs(j); setTyped(j.root); setMsg({ text: 'Back to the default folder.', error: false }); });
  const isDriveRoot = /^[A-Za-z]:[\\/]?$/.test(ws.root || '');

  return (
    <section className="settings-modal__section">
      <h4>Omi-One’s folder</h4>
      <p className="settings-modal__lead">
        Where Omi-One works directly: it creates and edits files here (following your permission mode) without preparing a fix.
      </p>
      <div className="settings-modal__ws-current">
        <code>{ws.root || '…'}</code>
        {ws.isDefault && <span className="settings-modal__ws-tag">default</span>}
      </div>
      {isDriveRoot && (
        <p className="settings-modal__warn">This is a whole drive: Omi-One could edit any of your files on it without asking, and searches will be slow.</p>
      )}
      <div className="settings-modal__form-row">
        <button type="button" className="settings-modal__save" onClick={browse} disabled={!!busy}>
          {busy === 'browse' ? 'Waiting for the dialog…' : 'Choose folder…'}
        </button>
        {!ws.isDefault && <button type="button" className="settings-modal__ghost" onClick={reset} disabled={!!busy}>Use default</button>}
      </div>
      <form className="settings-modal__ws-type" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) use(typed.trim()); }}>
        <label>
          <span>Or type a path</span>
          <div className="settings-modal__key-row">
            <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="C:\Users\you\Projects" spellCheck={false} />
            <button type="submit" className="settings-modal__ghost" disabled={!!busy || !typed.trim() || typed.trim() === ws.root}>Use</button>
          </div>
        </label>
      </form>
      {msg.text && <p className={msg.error ? 'settings-modal__error' : 'settings-modal__status'}>{msg.text}</p>}
    </section>
  );
}

function AccessTab({ onOpenDoctor }) {
  return (
    <>
      <WorkspaceSetting />

      <section className="settings-modal__section">
        <h4>The rest of the PC</h4>
        <ul className="settings-modal__rules">
          <li className="is-yes"><b>Reads everywhere</b>, so a doctor scan can follow a problem wherever it is: PATH, installed tools, projects, logs.</li>
          <li className="is-no"><b>Never reads secrets</b>: passwords, keys, tokens, <code>.env</code> files, browser logins, <code>.ssh</code>, FTP and other credential stores. What it reads goes to the AI provider, so these stay off-limits.</li>
          <li className="is-hold"><b>Changes outside its folder only through fixes you accept.</b> It prepares the fix; nothing happens until you press Apply in Doctor &amp; fixes. Files and settings are backed up so you can undo.</li>
          <li className="is-no"><b>Never touches Windows</b>: system folders, Program Files and other users’ files are refused, and OmniOne never runs as administrator, so Windows blocks them too.</li>
          <li className="is-hold"><b>Commands always ask first</b>, every time, and never run while Omi-One is acting on its own.</li>
        </ul>
        {onOpenDoctor && <button type="button" className="settings-modal__ghost" onClick={onOpenDoctor}>Open Doctor &amp; fixes</button>}
      </section>
    </>
  );
}

// --- App --------------------------------------------------------------------------------

function NotificationsSetting() {
  const { prefs, save, msg } = usePrefs();
  if (!prefs) return null;
  return (
    <Section title="Notifications">
      <Switch
        id="app-notify"
        on={prefs.notifications.desktop}
        onChange={(on) => save({ notifications: { desktop: on } })}
        label="Windows notifications"
        hint="When a scheduled task finishes or fails. They appear as coming from Windows PowerShell for now."
      />
      <Msg msg={msg} />
    </Section>
  );
}

function AppTab() {
  const [info, setInfo] = useState(null);
  const [auto, setAuto] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', error: false });

  useEffect(() => {
    fetch('/api/app').then((r) => r.json()).then(setInfo).catch(() => setInfo({}));
    fetch('/api/app/autostart').then((r) => r.json()).then(setAuto).catch(() => setAuto({ available: false }));
  }, []);

  const toggle = async () => {
    setBusy(true);
    setMsg({ text: '', error: false });
    try {
      const next = await post('/api/app/autostart', { enabled: !auto.enabled });
      setAuto(next);
      setMsg({ text: next.enabled ? 'OmniOne will start in the tray when you sign in to Windows.' : 'OmniOne won’t start with Windows.', error: false });
    } catch (e) {
      setMsg({ text: e.message, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="settings-modal__section">
        <h4>Startup</h4>
        <div className="settings-modal__switch-row">
          <div>
            <b>Start with Windows</b>
            <span>Opens OmniOne in the tray when you sign in, ready when you need it.</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(auto?.enabled)}
            className={`settings-modal__switch${auto?.enabled ? ' is-on' : ''}`}
            onClick={toggle}
            disabled={busy || !auto?.available}
            aria-label="Start with Windows"
          >
            <span />
          </button>
        </div>
        {auto && !auto.available && <p className="settings-modal__note">Available in the OmniOne app (not in a browser or in development mode).</p>}
        {msg.text && <p className={msg.error ? 'settings-modal__error' : 'settings-modal__status'}>{msg.text}</p>}
      </section>

      <NotificationsSetting />

      <section className="settings-modal__section">
        <h4>About</h4>
        <dl className="settings-modal__about">
          <dt>Version</dt><dd>{info?.version ? `v${info.version}` : '…'}</dd>
          <dt>Running as</dt><dd>{info ? (info.desktop ? 'the OmniOne app' : 'a web page (development)') : '…'}</dd>
          <dt>Updates</dt><dd>Checked each time OmniOne starts, or from the tray: Check for updates.</dd>
        </dl>
      </section>
    </>
  );
}

export default function SettingsModal({ onClose, initialTab = 'ai', onOpenDoctor }) {
  const [tab, setTab] = useState(TABS.some((t) => t.id === initialTab) ? initialTab : 'ai');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-modal__backdrop" onClick={onClose} />
      <div className="settings-modal__panel">
        <header className="settings-modal__head">
          <h3>SETTINGS</h3>
          <button type="button" className="settings-modal__close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="settings-modal__layout">
          <nav className="settings-modal__tabs" role="tablist" aria-orientation="vertical">
            {TABS.map((t) => (
              <button key={t.id} id={`settings-tab-${t.id}`} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'is-on' : ''} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="settings-modal__body" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
            {tab === 'ai' && <AiTab />}
            {tab === 'personality' && <PersonalityTab />}
            {tab === 'voice' && <VoiceTab />}
            {tab === 'media' && <MediaTab />}
            {tab === 'schedules' && <SchedulesTab />}
            {tab === 'connections' && <ConnectionsTab />}
            {tab === 'memory' && <MemoryTab />}
            {tab === 'access' && <AccessTab onOpenDoctor={onOpenDoctor} />}
            {tab === 'app' && <AppTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
