import { useEffect, useRef, useState, useCallback } from 'react';
import { FaceScene } from '../presence/FaceScene.js';
import { VoiceWave } from '../presence/VoiceWave.js';
import { NeuralCore } from '../presence/NeuralCore.js';
import { BrainNetwork, emotionColor } from '../presence/BrainNetwork.js';
import { createBrainRouter } from '../presence/brainRouter.js';
import { EmotionRuntime, EMOTION_COLORS } from '../presence/emotionEngine.js';
import { Voice, speakable, speechChunks } from '../presence/voice.js';
import PresenceChat, { chatText } from './PresenceChat.jsx';
import './PresenceView.css';

/* Presence — the agent, embodied.
 *
 * Face (face1.jpg), voice (TTS.jpg) and emotion core (emotionengine.jpg),
 * all driven by one EmotionEngine. The engine listens to every event of the
 * run in progress (re-broadcast by AiPanel as gwn:agent-event), to what the
 * agent does on its own time (the /api/mind/events stream), and to its mood;
 * one animation loop turns that into expression, gesture, voice and colour.
 *
 * Under it, side by side: the emotion engine and the brain network it feeds.
 * Every emotion the engine moves fires from the brain into that emotion's
 * neuron; every tool or skill the agent uses then runs on from the emotions
 * it was felt with, to the action, to the conversation it happened in, and
 * the pairing is recorded so the links build up over time.
 *
 * Around it: the mind — journal, goals, proposals, the heartbeat's controls
 * and budget — so you can see what it has been doing while you were away.
 */

const LS_VOICE = 'gwn.presence.voice';
const readVoicePref = () => {
  try { return localStorage.getItem(LS_VOICE) !== '0'; } catch { return true; }
};

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function captionFor(ev) {
  switch (ev.type) {
    case 'user_prompt': return 'listening…';
    case 'turn_start': return 'thinking…';
    case 'tool_call': return `${ev.name.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ')}…`;
    case 'tool_result': return ev.ok ? null : `that failed: ${String(ev.error || '').slice(0, 80)}`;
    case 'stuck': return 'going in circles — rethinking';
    case 'approval_request': return `may I run ${ev.tool}? (waiting for you)`;
    case 'error': return `something went wrong: ${String(ev.message || '').slice(0, 100)}`;
    case 'heartbeat_start': return 'dreaming… (heartbeat)';
    case 'heartbeat_end': return ev.error ? `woke with a problem: ${ev.error}` : 'awake';
    default: return null;
  }
}

export default function PresenceView({ onClose, toast }) {
  const faceRef = useRef(null);
  const waveRef = useRef(null);
  const coreRef = useRef(null);
  const labelsRef = useRef(null);
  const brainRef = useRef(null);
  const brainLabelsRef = useRef(null);
  const brainNet = useRef(null);
  const [brainPath, setBrainPath] = useState('');
  const [brainCounts, setBrainCounts] = useState(null);
  const [affect, setAffect] = useState(null);
  const [lastPath, setLastPath] = useState('');
  const engine = useRef(null);
  const voice = useRef(null);
  const arousal = useRef(0.2);
  const [mind, setMind] = useState(null);
  const [caption, setCaption] = useState('');
  const [said, setSaid] = useState('');
  const [dominant, setDominant] = useState('calm');
  const [voiceOn, setVoiceOn] = useState(readVoicePref);
  const [voiceMode, setVoiceMode] = useState('idle');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('status');
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  // Held in a ref so a new toast function never tears down the WebGL scenes.
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/mind');
      if (!r.ok) return;
      const j = await r.json();
      setMind(j);
      engine.current?.setMood(j.mood);
    } catch { /* server down; keep the last state */ }
  }, []);

  const loadBrain = useCallback(async () => {
    try {
      const r = await fetch('/api/brain');
      if (!r.ok) return;
      const g = await r.json();
      brainNet.current?.setGraph(g);
      if (brainNet.current?.counts) setBrainCounts({ ...brainNet.current.counts });
    } catch { /* server down; keep what is drawn */ }
  }, []);

  // Renderers, engine, voice and the single animation loop.
  useEffect(() => {
    engine.current = new EmotionRuntime();
    voice.current = new Voice();
    voice.current.onState = setVoiceMode;

    let face;
    let wave;
    let core;
    try {
      face = new FaceScene(faceRef.current);
      core = new NeuralCore(coreRef.current, labelsRef.current);
    } catch (e) {
      toastRef.current?.(`WebGL unavailable: ${e.message}`, 'error');
    }
    try {
      brainNet.current = new BrainNetwork(brainRef.current, brainLabelsRef.current, {
        onPath: (labels) => setBrainPath(labels.join(' → ')),
      });
    } catch { brainNet.current = null; }
    const brain = brainNet.current;
    wave = new VoiceWave(waveRef.current);

    // Every appraised event animates its path through the network, and the
    // HUD spells it out.
    const offTrace = engine.current.onTrace((t) => {
      core?.addTrace(t);
      // The same emotions, in the brain: each one fires from the centre.
      for (const m of t.emotions) brain?.fire(['brain', `emotion:${m.emotion}`], emotionColor(m.emotion));
      const dims = Object.entries(t.appraisal || {})
        .filter(([k, v]) => typeof v === 'number' && Math.abs(v) > 0.4 && k !== 'certainty')
        .map(([k]) => k);
      const emos = t.emotions.map((m) => m.emotion);
      const regions = [...new Set(Object.values(t.channels).flat())].slice(0, 4);
      setLastPath(`${t.source} → ${dims.join(', ') || 'appraisal'} → ${emos.join(', ')} → ${regions.join(', ') || 'face'}`);
    });

    const onResize = () => { face?.resize(); wave.resize(); core?.resize(); brain?.resize(); };
    const ro = new ResizeObserver(onResize);
    [faceRef, waveRef, coreRef, brainRef].forEach((r) => r.current && ro.observe(r.current));

    let raf = 0;
    let last = performance.now();
    let domTick = 0;
    const loop = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const audio = voice.current.frame(now / 1000);
      engine.current.setSpeaking(audio.mode === 'speaking' ? Math.min(1, audio.level * 1.4) : 0);
      const f = engine.current.update(dt);
      arousal.current = Math.max(0.12, arousal.current * Math.exp(-dt / 6));
      face?.setParams(f);
      // The agent's voice shows on its mouth; the strip below is yours alone.
      face?.setVoice(audio.mode === 'speaking' ? Math.min(1, audio.level * 1.6) : 0);
      face?.render(dt);
      if (audio.mode === 'listening') wave.setAudio(audio.samples, audio.level, 'listening');
      else wave.setAudio(null, 0, 'idle');
      wave.render(dt);
      const st = engine.current.core.state;
      core?.setState({
        valence: st.valence,
        energy: engine.current.mood.energy ?? 0.7,
        arousal: Math.min(1, Math.max(st.arousal, arousal.current * 0.6) + audio.level * 0.4),
        emotions: st.emotions,
      });
      core?.render(dt);
      brain?.setEmotions(st.emotions, Math.max(st.arousal, arousal.current * 0.6));
      brain?.render(dt);
      if ((domTick += dt) > 0.25) {
        domTick = 0;
        setDominant(f.dominant);
        setAffect(engine.current.snapshot());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      offTrace();
      voice.current?.stop();
      voice.current?.stopListening();
      face?.dispose();
      core?.dispose();
      brain?.dispose();
      brainNet.current = null;
    };
  }, []);

  useEffect(() => {
    loadBrain();
    const t = setInterval(loadBrain, 60000);
    return () => clearInterval(t);
  }, [loadBrain]);

  // React to the run in progress.
  useEffect(() => {
    const onEvent = (e) => {
      const ev = e.detail || {};
      if (!engine.current) return;
      engine.current.handleEvent(ev);
      routeToBrain(ev);
      // A new question interrupts whatever it was still saying.
      if (ev.type === 'user_prompt') voice.current?.stop();
      if (['user_prompt', 'tool_call', 'error', 'stuck', 'approval_request', 'done', 'heartbeat_start'].includes(ev.type)) {
        arousal.current = Math.min(1, arousal.current + 0.25);
      }
      const c = captionFor(ev);
      if (c) setCaption(c);
      if (ev.type === 'done') {
        setCaption('');
        // Every answer is spoken, in full, through the face. Code the agent
        // wrote is announced rather than read out.
        const line = speakable(chatText(ev.text).replace(/📄 wrote /g, 'I wrote '), 2400);
        if (line) {
          setSaid(speakable(line, 320));
          const delivery = engine.current.express(line);
          // A question asked in another window (ev.origin) is answered aloud
          // there; speaking it here too would talk over it.
          if (voiceOnRef.current && !ev.origin) {
            for (const chunk of speechChunks(line)) voice.current.speak(chunk, delivery.voice);
          }
        }
        refresh();
        loadBrain();
      }
      if (ev.type === 'mood' || (ev.type === 'tool_result' && ev.tool === 'set_mood')) refresh();
    };
    window.addEventListener('gwn:agent-event', onEvent);
    return () => window.removeEventListener('gwn:agent-event', onEvent);
  }, [refresh, loadBrain]);

  /* The agent's actions, into the brain (shared with the Neural window). */
  const brainRouter = useRef(null);
  if (!brainRouter.current) {
    brainRouter.current = createBrainRouter({
      getBrain: () => brainNet.current,
      getEngine: () => engine.current,
      onCounts: setBrainCounts,
      recordHeartbeat: true,
    });
  }
  const routeToBrain = (ev) => brainRouter.current.handle(ev);

  // What it does on its own time.
  useEffect(() => {
    let es;
    try {
      es = new EventSource('/api/mind/events');
      es.onmessage = (m) => {
        let ev;
        try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.mood) engine.current?.setMood(ev.mood);
        if (ev.type === 'hello' || ev.type === 'ping') return;
        window.dispatchEvent(new CustomEvent('gwn:agent-event', { detail: ev.type === 'tool_result' || ev.type === 'tool_call' ? { ...ev, heartbeat: true } : ev }));
        if (ev.type === 'heartbeat_end') refresh();
      };
    } catch { /* no SSE; polling still works */ }
    return () => es?.close();
  }, [refresh]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleVoice = () => {
    const next = !voiceOn;
    setVoiceOn(next);
    try { localStorage.setItem(LS_VOICE, next ? '1' : '0'); } catch { /* private mode */ }
    if (!next) voice.current?.stop();
    else voice.current?.speak('Voice on.', engine.current?.express('Voice on.').voice);
  };

  const talk = async () => {
    const v = voice.current;
    if (!v) return;
    if (voiceMode === 'listening') { v.stopListening(); return; }
    if (!v.canListen) { toast?.('Speech recognition needs Chrome or Edge.', 'error'); return; }
    try {
      engine.current.handleEvent({ type: 'user_prompt' });
      const text = await v.listen({ onInterim: (t) => setCaption(`“${t}”`) });
      if (!text) { setCaption(''); return; }
      setCaption(`“${text}”`);
      window.dispatchEvent(new CustomEvent('gwn:submit-prompt', { detail: { text } }));
    } catch (e) {
      toast?.(`Microphone: ${e.message}`, 'error');
    }
  };

  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };

  const wake = async () => {
    setBusy(true);
    setCaption('waking…');
    try {
      const r = await post('/api/mind/beat');
      if (r.skipped) { setCaption(''); toast?.(`Did not wake: ${r.skipped}`, 'info'); }
      await refresh();
    } catch (e) {
      toast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const setHeartbeat = async (patch) => {
    try {
      await post('/api/mind/heartbeat', patch);
      refresh();
    } catch (e) { toast?.(e.message, 'error'); }
  };

  const answerProposal = async (p, status) => {
    try {
      await post(`/api/mind/proposals/${encodeURIComponent(p.id)}`, { status });
      if (status === 'accepted') {
        window.dispatchEvent(new CustomEvent('gwn:submit-prompt', { detail: { text: p.prompt || p.title } }));
        toast?.('Proposal accepted — running it', 'info');
      }
      refresh();
    } catch (e) { toast?.(e.message, 'error'); }
  };

  const mood = mind?.mood;
  const hb = mind?.heartbeat;
  const openProposals = (mind?.proposals || []).filter((p) => p.status === 'open');
  const openGoals = (mind?.goals || []).filter((g) => g.status === 'active' || g.status === 'blocked');

  return (
    <div className="presence" role="dialog" aria-label="Presence">
      <header className="presence__bar">
        <span className="presence__title">PRESENCE</span>
        <span className="presence__sep">/</span>
        <span className="presence__name">OMI-ONE</span>
        <span className="presence__sep">/</span>
        <span className="presence__mood">{mood ? (dominant && dominant !== mood.label ? `${mood.label} · ${dominant}` : mood.label) : 'waking…'}</span>
        <span className="presence__spacer" />
        {hb && (
          <span className={`presence__hb ${hb.beating ? 'is-beating' : ''}`}>
            ♥ {!hb.enabled ? 'heartbeat off'
              : hb.beating ? 'thinking on its own'
                : hb.lastSkip && hb.nextAt <= Date.now() ? `resting — ${hb.lastSkip.reason}`
                  : `next beat ${Math.max(0, Math.round((hb.nextAt - Date.now()) / 60000))}m`}
          </span>
        )}
        <button type="button" className="presence__close" onClick={onClose} aria-label="Close">×</button>
      </header>

      <div className="presence__grid">
        {/* Chat — nothing else in this column. */}
        <section className="presence__col presence__col--left pcard pcard--chat" aria-label="Chat">
          <header className="pcard__head">Chat</header>
          <PresenceChat />
        </section>

        {/* The face and your voice. */}
        <main className="presence__stage">
          <canvas ref={faceRef} className="presence__face" />
          <div className="presence__caption" aria-live="polite">
            {caption && <div className="presence__doing">{caption}</div>}
            {said && <div className="presence__said">{said}</div>}
          </div>
          <div className="presence__voice">
            <canvas ref={waveRef} className="presence__wave" />
            <button
              type="button"
              className={`presence__mic is-${voiceMode}`}
              onClick={talk}
              title={voiceMode === 'listening' ? 'Stop listening' : 'Talk to it — your voice shows here'}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="2.5" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5M8.5 21.5h7" /></svg>
            </button>
            <button type="button" className={`presence__voice-toggle ${voiceOn ? 'is-on' : ''}`} onClick={toggleVoice}>
              {voiceOn ? 'VOICE ON' : 'VOICE OFF'}
            </button>
          </div>
        </main>

        {/* Status and the mind, one tab at a time. */}
        <aside className="presence__col presence__col--right">
          <div className="presence__tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'status'} className={tab === 'status' ? 'is-on' : ''} onClick={() => setTab('status')}>STATUS</button>
            <button type="button" role="tab" aria-selected={tab === 'mind'} className={tab === 'mind' ? 'is-on' : ''} onClick={() => setTab('mind')}>
              MIND{openProposals.length > 0 && <span className="presence__badge">{openProposals.length}</span>}
            </button>
          </div>

          {tab === 'status' && (<>
            <section className="pcard" aria-label="Mood">
              <header className="pcard__head">Mood</header>
              {mood ? (
                <div className="presence__meters">
                  <Meter label="valence" value={(mood.valence + 1) / 2} text={mood.valence.toFixed(2)} />
                  <Meter label="energy" value={mood.energy} text={mood.energy.toFixed(2)} />
                  <div className="presence__kv"><span>feeling</span><b>{mood.label}</b></div>
                  {mind.focus && <div className="presence__kv"><span>focus</span><b>{mind.focus}</b></div>}
                  {mood.note && <div className="presence__note">“{mood.note}”</div>}
                </div>
              ) : <p className="presence__empty">Waking…</p>}
            </section>

            {hb && (
              <section className="pcard" aria-label="Heartbeat">
                <header className="pcard__head">Heartbeat</header>
                <label className="presence__switch">
                  <input type="checkbox" checked={hb.enabled} onChange={(e) => setHeartbeat({ enabled: e.target.checked })} />
                  <span>Thinks on its own every</span>
                  <select value={hb.intervalMin} onChange={(e) => setHeartbeat({ intervalMin: Number(e.target.value) })}>
                    {[15, 30, 45, 60, 120, 240].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>)}
                  </select>
                </label>
                <label className="presence__switch">
                  <span>Daily cap</span>
                  <select value={hb.dailyTokenCap} onChange={(e) => setHeartbeat({ dailyTokenCap: Number(e.target.value) })}>
                    {[0, 50_000, 150_000, 300_000, 600_000, 1_000_000].map((n) => <option key={n} value={n}>{n ? `${n / 1000}k tokens` : 'none (paused)'}</option>)}
                  </select>
                </label>
                <div className="presence__kv"><span>used today</span><b>{hb.budget.tokens.toLocaleString()} / {hb.budget.cap.toLocaleString()}</b></div>
                <Meter label="" value={hb.budget.cap ? hb.budget.tokens / hb.budget.cap : 0} text="" warn />
                <div className="presence__kv"><span>heartbeats</span><b>{hb.beats || 0}{hb.lastBeat ? ` · last ${ago(hb.lastBeat)} ago` : ''}</b></div>
                <button type="button" className="presence__wake" disabled={busy || hb.beating} onClick={wake}>
                  {hb.beating || busy ? 'THINKING…' : 'WAKE NOW'}
                </button>
                <p className="presence__fine">On its own it may read and edit files (every edit is checkpointed). Commands and anything that costs credits come to your inbox.</p>
              </section>
            )}
          </>)}

          {tab === 'mind' && (<>
            <section className="pcard" aria-label="Inbox">
              <header className="pcard__head">Inbox {openProposals.length > 0 && <span className="presence__badge">{openProposals.length}</span>}</header>
              {openProposals.length === 0 && <p className="presence__empty">Nothing waiting on you.</p>}
              {openProposals.map((p) => (
                <div key={p.id} className="presence__card presence__card--proposal">
                  <div className="presence__card-title">{p.title}</div>
                  {p.detail && <div className="presence__card-body">{p.detail}</div>}
                  <div className="presence__actions">
                    <button type="button" onClick={() => answerProposal(p, 'accepted')}>Accept &amp; run</button>
                    <button type="button" className="is-ghost" onClick={() => answerProposal(p, 'dismissed')}>Dismiss</button>
                  </div>
                </div>
              ))}
            </section>
            <section className="pcard" aria-label="Goals">
              <header className="pcard__head">Its goals</header>
              {openGoals.length === 0 && <p className="presence__empty">No goals of its own yet.</p>}
              {openGoals.map((g) => (
                <div key={g.id} className="presence__goal">
                  <span className="presence__prio">P{g.priority}</span>
                  <span>{g.text}{g.status === 'blocked' ? ' (blocked)' : ''}</span>
                </div>
              ))}
            </section>
            <section className="pcard presence__journal" aria-label="Journal">
              <header className="pcard__head">Journal</header>
              {(mind?.journal || []).length === 0 && <p className="presence__empty">No entries yet.</p>}
              {(mind?.journal || []).map((j) => (
                <div key={j.id} className={`presence__entry is-${j.kind}`}>
                  <span className="presence__when">{ago(j.at)} · {j.kind}</span>
                  <p>{j.text}</p>
                </div>
              ))}
            </section>
          </>)}
        </aside>
      </div>

      {/* Everything emotional, together: the live readout and the network. */}
      <section className="presence__engine" aria-label="Emotion engine and neural network">
        <div className="presence__half presence__half--emotion">
        <div className="presence__readout">
          <header className="pcard__head">Emotions now</header>
          {affect && (<>
            <div className="presence__meters">
              {affect.emotions.length === 0 && <p className="presence__empty">Neutral.</p>}
              {affect.emotions.map(({ emotion, v }) => (
                <Meter key={emotion} label={emotion} value={v} text={v.toFixed(2)} color={`#${(EMOTION_COLORS[emotion] || 0xffffff).toString(16).padStart(6, '0')}`} />
              ))}
            </div>
            <div className="presence__pad" title="valence · arousal · dominance · confidence">
              <span>V <b>{affect.valence.toFixed(2)}</b></span>
              <span>A <b>{affect.arousal.toFixed(2)}</b></span>
              <span>D <b>{affect.dominance.toFixed(2)}</b></span>
              <span>conf <b>{affect.confidence.toFixed(2)}</b></span>
            </div>
            {affect.cue && (<>
              <header className="pcard__head pcard__head--sub">Last expression</header>
              <pre className="presence__cue">{JSON.stringify(Object.fromEntries(Object.entries(affect.cue).filter(([k]) => k !== 'at')), null, 1)}</pre>
            </>)}
          </>)}
        </div>
        <div className="presence__net">
          <canvas ref={coreRef} className="presence__core" />
          <div ref={labelsRef} className="ncore-labels" aria-hidden="true" />
          <div className="presence__core-label">EMOTION ENGINE</div>
          {lastPath && <div className="presence__core-path">{lastPath}</div>}
        </div>
        </div>
        <div className="presence__half presence__brain" aria-label="Neural network">
          <canvas ref={brainRef} className="presence__core presence__brain-canvas" title="Drag to rotate · wheel to zoom" />
          <div ref={brainLabelsRef} className="brain-labels" aria-hidden="true" />
          <div className="presence__core-label">NEURAL NETWORK</div>
          <div className="presence__brain-legend">
            <span className="is-conversation">conversations{brainCounts ? ` ${brainCounts.conversations}` : ''}</span>
            <span className="is-skill">skills{brainCounts ? ` ${brainCounts.skills}` : ''}</span>
            <span className="is-tool">tools{brainCounts ? ` ${brainCounts.tools}` : ''}</span>
            <span className="is-emotion">emotions</span>
          </div>
          <div className="presence__brain-hint">drag to rotate · wheel to zoom</div>
          {brainPath && <div className="presence__core-path">{brainPath}</div>}
        </div>
      </section>
    </div>
  );
}

export { feltNow } from '../presence/brainRouter.js';

function Meter({ label, value, text, warn, color }) {
  const v = Math.max(0, Math.min(1, value || 0));
  return (
    <div className="presence__meter">
      {label && <span>{label}</span>}
      <div className={`presence__meter-bar ${warn && v > 0.8 ? 'is-warn' : ''}`}>
        <i style={{ width: `${v * 100}%`, ...(color ? { background: color, boxShadow: `0 0 8px ${color}` } : {}) }} />
      </div>
      {text && <b>{text}</b>}
    </div>
  );
}

/* The top-bar button: a small orb that carries the mood even when the
 * Presence view is closed, and pulses when something happens. */
export function PresenceOrb({ onClick }) {
  const [mood, setMood] = useState(null);
  const [pulse, setPulse] = useState(0);
  const [beating, setBeating] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/mind');
        if (r.ok && alive) {
          const j = await r.json();
          setMood(j.mood);
          setBeating(Boolean(j.heartbeat?.beating));
        }
      } catch { /* offline */ }
    };
    load();
    const t = setInterval(load, 60000);
    const onEv = (e) => {
      const ev = e.detail || {};
      if (ev.mood) setMood(ev.mood);
      if (ev.type === 'heartbeat_start') setBeating(true);
      if (ev.type === 'heartbeat_end') setBeating(false);
      setPulse((n) => n + 1);
    };
    window.addEventListener('gwn:agent-event', onEv);
    return () => { alive = false; clearInterval(t); window.removeEventListener('gwn:agent-event', onEv); };
  }, []);

  const v = mood?.valence ?? 0.3;
  const hue = 180 + (1 - (v + 1) / 2) * 120; // cyan when well, magenta when not
  return (
    <button
      type="button"
      className={`shell__btn presence-orb ${beating ? 'is-beating' : ''}`}
      onClick={onClick}
      title={mood ? `Presence — Omi-One is feeling ${mood.label}` : 'Presence — Omi-One'}
    >
      <span key={pulse} className="presence-orb__dot" style={{ '--orb-hue': hue, '--orb-speed': `${2.6 - (mood?.energy ?? 0.7) * 1.6}s` }} />
      PRESENCE
    </button>
  );
}
