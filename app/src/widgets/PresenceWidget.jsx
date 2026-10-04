import { useEffect, useRef, useState, useCallback } from 'react';
import { FaceScene } from '../presence/FaceScene.js';
import { EmotionRuntime } from '../presence/emotionEngine.js';
import { Voice, speakable, speechChunks } from '../presence/voice.js';
import { recordOwnFeel } from '../presence/brainRouter.js';
import { chatText } from '../components/PresenceChat.jsx';
import { Preview } from '../components/ApprovalModal.jsx';
import { parseCommand } from '../components/CommandPalette.jsx';
import { runPrompt, answerApproval } from './runPrompt.js';

/* The Presence widget: Omi-One's face in a small floating window, always
 * listening.
 *
 * Say "Omi-One …" (or "Hey Omi …"): Windows' offline recognizer, run by the
 * server only while this window listens, hears it; what follows the wake
 * word becomes a prompt in the current conversation, run from here, and the
 * answer is spoken through the face. Everything else said nearby is ignored
 * by the recognizer itself. Mute releases the microphone.
 *
 * Tool approvals show right here, the administrator one in red; Windows
 * still asks (UAC) after an administrator yes. */

const LS_MUTE = 'gwn.widget.muted';
const LS_VOICE = 'gwn.presence.voice';
const readLS = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };

function captionFor(ev) {
  switch (ev.type) {
    case 'user_prompt': return 'thinking…';
    case 'tool_call': return `${String(ev.name || '').replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ')}…`;
    case 'tool_result': return ev.ok ? null : `that failed: ${String(ev.error || '').slice(0, 80)}`;
    case 'approval_request': return ev.permission === 'admin' ? 'asking for administrator rights' : `may I run ${ev.tool}?`;
    case 'error': return `something went wrong: ${String(ev.message || '').slice(0, 100)}`;
    case 'heartbeat_start': return 'dreaming… (heartbeat)';
    default: return null;
  }
}

export default function PresenceWidget({ origin }) {
  const faceRef = useRef(null);
  const engine = useRef(null);
  const voice = useRef(null);
  const run = useRef(null);
  const lastSpoke = useRef(0);
  const [caption, setCaption] = useState('');
  const [said, setSaid] = useState('');
  const [muted, setMuted] = useState(() => readLS(LS_MUTE, '0') === '1');
  const [voiceOn, setVoiceOn] = useState(() => readLS(LS_VOICE, '1') !== '0');
  const [listen, setListen] = useState({ state: 'off' });
  const [level, setLevel] = useState(0);
  const [approval, setApproval] = useState(null);
  const [typed, setTyped] = useState('');
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;

  // Face, engine, voice, and one animation loop.
  useEffect(() => {
    engine.current = new EmotionRuntime();
    voice.current = new Voice();
    let face = null;
    try { face = new FaceScene(faceRef.current); } catch (e) { setCaption(`WebGL unavailable: ${e.message}`); }
    const ro = new ResizeObserver(() => face?.resize());
    if (faceRef.current) ro.observe(faceRef.current);
    let raf = 0;
    let last = performance.now();
    const loop = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const audio = voice.current.frame(now / 1000);
      const speaking = audio.mode === 'speaking';
      if (speaking) lastSpoke.current = Date.now();
      engine.current.setSpeaking(speaking ? Math.min(1, audio.level * 1.4) : 0);
      const f = engine.current.update(dt);
      face?.setParams(f);
      face?.setVoice(speaking ? Math.min(1, audio.level * 1.6) : 0);
      face?.render(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    fetch('/api/mind').then((r) => r.json()).then((j) => engine.current?.setMood(j.mood)).catch(() => {});
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      voice.current?.stop();
      face?.dispose();
    };
  }, []);

  // Every run, from any window; this window's own come through runPrompt.
  useEffect(() => {
    const onEvent = (e) => {
      const ev = e.detail || {};
      if (!engine.current) return;
      engine.current.handleEvent(ev);
      recordOwnFeel(ev, engine.current);
      const c = captionFor(ev);
      if (c) setCaption(c);
      if (ev.type === 'approval_request') setApproval({ ...ev, state: 'pending' });
      if (ev.type === 'approval_resolved') setApproval((a) => (a && a.id === ev.id ? null : a));
      if (ev.type === 'done' || ev.type === 'error' || ev.type === 'stopped') setApproval(null);
      if (ev.type === 'done') {
        setCaption('');
        const line = speakable(chatText(ev.text).replace(/📄 wrote /g, 'I wrote '), 2400);
        if (line) {
          setSaid(speakable(line, 240));
          const delivery = engine.current.express(line);
          // Speak only answers to this window's own questions: another
          // window speaking its own runs would talk over it.
          if (voiceOnRef.current && !ev.origin) {
            for (const chunk of speechChunks(line)) voice.current.speak(chunk, delivery.voice);
          }
        }
      }
    };
    window.addEventListener('gwn:agent-event', onEvent);
    return () => window.removeEventListener('gwn:agent-event', onEvent);
  }, []);

  const ask = useCallback(async (text) => {
    const t = String(text || '').trim();
    if (!t) return;
    if (parseCommand(t)) { setCaption('Slash commands work in the main window.'); return; }
    voice.current?.stop();
    setSaid('');
    setCaption(`“${t}”`);
    // A new question interrupts the one still running from here.
    if (run.current) { run.current.abort(); await run.current.done; }
    const r = runPrompt(t, { origin });
    run.current = r;
    r.done.finally(() => { if (run.current === r) run.current = null; });
  }, [origin]);

  // Always listening (unless muted): Windows' recognizer, wake word "Omi-One".
  useEffect(() => {
    if (muted) { setListen({ state: 'muted' }); setLevel(0); return undefined; }
    let es;
    try { es = new EventSource('/api/listen'); } catch { setListen({ state: 'error', error: { message: 'No live connection to OmniOne.' } }); return undefined; }
    es.onmessage = (m) => {
      let ev;
      try { ev = JSON.parse(m.data); } catch { return; }
      if (ev.type === 'state') setListen(ev);
      else if (ev.type === 'level') setLevel(ev.v / 100);
      else if (ev.type === 'error') setListen({ state: 'error', error: ev });
      else if (ev.type === 'speech') engine.current?.gesture('lookAtUser');
      else if (ev.type === 'heard') {
        // Its own voice coming back through the speakers is not a question.
        if (voice.current?.mode === 'speaking' || Date.now() - lastSpoke.current < 1200) return;
        if (!ev.text) { setCaption('Yes? Say "Omi-One" and then your question.'); return; }
        ask(ev.text);
      }
    };
    es.onerror = () => setListen((s) => (s.state === 'error' ? s : { state: 'reconnecting' }));
    return () => es.close();
  }, [muted, ask]);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    try { localStorage.setItem(LS_MUTE, next ? '1' : '0'); } catch { /* private mode */ }
  };
  const toggleVoice = () => {
    const next = !voiceOn;
    setVoiceOn(next);
    try { localStorage.setItem(LS_VOICE, next ? '1' : '0'); } catch { /* private mode */ }
    if (!next) voice.current?.stop();
  };

  const decide = async (decision) => {
    if (!approval) return;
    const a = approval;
    setApproval({ ...a, state: 'sending' });
    try {
      await answerApproval(a.id, decision);
      setApproval(null);
      if (decision !== 'deny' && a.permission === 'admin') setCaption('Confirm in the Windows prompt (UAC).');
    } catch (e) {
      setApproval({ ...a, state: 'failed', error: e.message });
    }
  };

  const stopRun = () => { run.current?.abort(); voice.current?.stop(); };
  const submitTyped = (e) => {
    e.preventDefault();
    const t = typed.trim();
    if (!t) return;
    setTyped('');
    ask(t);
  };

  const mic = muted ? 'muted'
    : listen.state === 'listening' ? 'listening'
      : listen.state === 'error' || listen.state === 'unsupported' ? 'error' : 'starting';
  const micText = {
    muted: 'Muted — the microphone is off',
    listening: 'Listening — say “Omi-One…”',
    starting: 'Starting the microphone…',
    error: listen.state === 'unsupported' ? 'Voice input needs Windows' : (listen.error?.message || 'Voice input stopped'),
  }[mic];
  const isAdmin = approval?.permission === 'admin';

  return (
    <div className="wpres">
      <canvas ref={faceRef} className="wpres__face" />

      <div className="wpres__caption" aria-live="polite">
        {caption && <div className="wpres__doing">{caption}</div>}
        {said && <div className="wpres__said">{said}</div>}
      </div>

      {approval && (
        <div className={`wpres__approval ${isAdmin ? 'is-admin' : ''}`} role="alertdialog" aria-label="Approval">
          <div className="wpres__approval-head">
            {isAdmin ? 'ADMINISTRATOR ACCESS REQUESTED' : `May I ${approval.permission === 'write' ? 'change a file with' : 'run'} ${approval.tool}?`}
          </div>
          <div className="wpres__approval-body"><Preview preview={approval.preview} /></div>
          {isAdmin && <p className="wpres__approval-warn">Full control of this PC. Allow only if you expect it; Windows asks next.</p>}
          {approval.state === 'failed' && <p className="wpres__approval-warn">{approval.error}</p>}
          <div className="wpres__approval-actions">
            <button type="button" className="is-deny" onClick={() => decide('deny')} autoFocus disabled={approval.state === 'sending'}>Deny</button>
            {!isAdmin && <button type="button" onClick={() => decide('session')} disabled={approval.state === 'sending'}>Allow for session</button>}
            <button type="button" className={isAdmin ? 'is-admin' : 'is-allow'} onClick={() => decide('once')} disabled={approval.state === 'sending'}>
              {isAdmin ? 'Allow as administrator, once' : 'Allow once'}
            </button>
          </div>
        </div>
      )}

      <div className="wpres__bottom">
        <div className={`wpres__mic is-${mic}`} title={micText}>
          <button type="button" className="wpres__mic-btn" onClick={toggleMute} aria-pressed={!muted} aria-label={muted ? 'Unmute the microphone' : 'Mute the microphone'}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="2.5" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5M8.5 21.5h7" />{muted && <path d="M3 3l18 18" />}</svg>
          </button>
          <div className="wpres__mic-text">{micText}</div>
          <div className="wpres__level"><i style={{ width: `${Math.round((mic === 'listening' ? level : 0) * 100)}%` }} /></div>
        </div>
        <form className="wpres__type" onSubmit={submitTyped}>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="…or type to Omi-One" aria-label="Type to Omi-One" />
          <button type="button" className={`wpres__small ${voiceOn ? 'is-on' : ''}`} onClick={toggleVoice} title={voiceOn ? 'Voice on' : 'Voice off'}>{voiceOn ? '🔊' : '🔇'}</button>
          <button type="button" className="wpres__small" onClick={stopRun} title="Stop">◼</button>
        </form>
      </div>
    </div>
  );
}
