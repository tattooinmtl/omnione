import { useEffect, useState } from 'react';
import { api, Msg, Section, Switch, ago } from './shared.jsx';

/* Settings → Memory: SOUL.md, what Omi-One remembers, and its heartbeat. */
export default function MemoryTab() {
  const [mind, setMind] = useState(null);
  const [soul, setSoul] = useState('');
  const [msg, setMsg] = useState({ text: '', error: false });

  const load = () => api('/api/mind').then((m) => { setMind(m); setSoul(m.soul || ''); }).catch((e) => setMsg({ text: e.message, error: true }));
  useEffect(() => { load(); }, []);
  if (!mind) return <Msg msg={msg} />;

  const hb = mind.heartbeat;
  const setHb = async (patch, text) => {
    try {
      const next = await api('/api/mind/heartbeat', { method: 'POST', body: patch });
      setMind((m) => ({ ...m, heartbeat: next }));
      setMsg({ text, error: false });
    } catch (e) { setMsg({ text: e.message, error: true }); }
  };
  const saveSoul = async () => {
    try {
      await api('/api/mind/soul', { method: 'PUT', body: { soul } });
      setMsg({ text: 'SOUL.md saved. Omi-One reads it at the start of every message.', error: false });
    } catch (e) { setMsg({ text: e.message, error: true }); }
  };

  return (
    <>
      <Section title="Who Omi-One is (SOUL.md)" lead="Your description of Omi-One. It reads this every turn and can't change it. Personalities play roles on top of it.">
        <textarea id="memory-soul" className="settings-form__code" rows={8} value={soul} onChange={(e) => setSoul(e.target.value)} spellCheck={false} />
        <div className="settings-modal__form-row">
          <button type="button" className="settings-modal__save" onClick={saveSoul} disabled={soul === mind.soul}>Save</button>
          {soul !== mind.soul && <button type="button" className="settings-modal__ghost" onClick={() => setSoul(mind.soul)}>Undo changes</button>}
        </div>
      </Section>

      <Section title="What it remembers about you" lead="Omi-One keeps these notes itself. Ask it in the chat to change or forget something.">
        <dl className="settings-memory">
          <dt>About you</dt><dd>{mind.core.human || 'Nothing yet.'}</dd>
          <dt>About itself</dt><dd>{mind.core.persona || 'Nothing yet.'}</dd>
        </dl>
        {mind.memories?.length > 0 && (
          <details className="settings-modal__disclose">
            <summary>Latest {mind.memories.length} memories</summary>
            <ul className="settings-memory__list">
              {mind.memories.map((m) => <li key={m.id}><span>{ago(m.at || m.createdAt)}</span> {m.text}</li>)}
            </ul>
          </details>
        )}
      </Section>

      <Section title="Heartbeat" lead="When nobody is using it, Omi-One wakes up now and then to work on its own goals, reflect and tidy its notes. It can't run commands or spend credits on its own.">
        <Switch id="memory-hb" on={hb.enabled} onChange={(on) => setHb({ enabled: on }, on ? 'Heartbeat on.' : 'Heartbeat off: Omi-One only acts when you ask.')} label="Heartbeat" hint={`${hb.beats || 0} beats so far · last ${ago(hb.lastBeat)}`} />
        <div className="settings-form">
          <div className="settings-form__row">
            <label>
              <span>Every</span>
              <select id="memory-hb-interval" value={hb.intervalMin} onChange={(e) => setHb({ intervalMin: Number(e.target.value) }, 'Saved.')}>
                {[15, 30, 60, 120, 240, 480].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`}</option>)}
              </select>
            </label>
            <label>
              <span>Daily token budget</span>
              <select id="memory-hb-budget" value={hb.dailyTokenCap} onChange={(e) => setHb({ dailyTokenCap: Number(e.target.value) }, 'Saved.')}>
                {[50_000, 100_000, 200_000, 500_000, 1_000_000].map((n) => <option key={n} value={n}>{n.toLocaleString()} tokens</option>)}
                {![50_000, 100_000, 200_000, 500_000, 1_000_000].includes(hb.dailyTokenCap) && <option value={hb.dailyTokenCap}>{hb.dailyTokenCap.toLocaleString()} tokens</option>}
              </select>
            </label>
            <label>
              <span>Steps per beat</span>
              <select id="memory-hb-turns" value={hb.maxTurnsPerBeat} onChange={(e) => setHb({ maxTurnsPerBeat: Number(e.target.value) }, 'Saved.')}>
                {[...new Set([4, 8, 12, 20, hb.maxTurnsPerBeat])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          {hb.budget && <p className="settings-modal__note">Used today: {(hb.budget.cap - hb.budget.remaining).toLocaleString()} of {hb.budget.cap.toLocaleString()} tokens.</p>}
        </div>
        <Msg msg={msg} />
      </Section>
    </>
  );
}
