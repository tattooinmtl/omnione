import { useEffect, useRef, useState } from 'react';
import { NeuralCore } from '../presence/NeuralCore.js';
import { EmotionRuntime, EMOTION_COLORS } from '../presence/emotionEngine.js';

/* The emotion engine in its own floating window: the live readout and the
 * network the events run through, fed by every run (any window) and by
 * Omi-One's heartbeat. */

const hex = (n) => `#${(n || 0xffffff).toString(16).padStart(6, '0')}`;

export default function EmotionWidget() {
  const coreRef = useRef(null);
  const labelsRef = useRef(null);
  const engine = useRef(null);
  const arousal = useRef(0.2);
  const [affect, setAffect] = useState(null);
  const [path, setPath] = useState('');

  useEffect(() => {
    engine.current = new EmotionRuntime();
    let core = null;
    try { core = new NeuralCore(coreRef.current, labelsRef.current); } catch { /* no WebGL */ }
    const offTrace = engine.current.onTrace((t) => {
      core?.addTrace(t);
      const dims = Object.entries(t.appraisal || {})
        .filter(([k, v]) => typeof v === 'number' && Math.abs(v) > 0.4 && k !== 'certainty')
        .map(([k]) => k);
      const regions = [...new Set(Object.values(t.channels).flat())].slice(0, 4);
      setPath(`${t.source} → ${dims.join(', ') || 'appraisal'} → ${t.emotions.map((m) => m.emotion).join(', ')} → ${regions.join(', ') || 'face'}`);
    });
    const ro = new ResizeObserver(() => core?.resize());
    if (coreRef.current) ro.observe(coreRef.current);
    const onEvent = (e) => {
      const ev = e.detail || {};
      engine.current.handleEvent(ev);
      if (['user_prompt', 'tool_call', 'error', 'approval_request', 'done', 'heartbeat_start'].includes(ev.type)) {
        arousal.current = Math.min(1, arousal.current + 0.25);
      }
      if (ev.type === 'done' && ev.text) engine.current.express(String(ev.text).slice(0, 1200));
    };
    window.addEventListener('gwn:agent-event', onEvent);
    fetch('/api/mind').then((r) => r.json()).then((j) => engine.current?.setMood(j.mood)).catch(() => {});

    let raf = 0;
    let last = performance.now();
    let tick = 0;
    const loop = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      engine.current.update(dt);
      arousal.current = Math.max(0.12, arousal.current * Math.exp(-dt / 6));
      const st = engine.current.core.state;
      core?.setState({
        valence: st.valence,
        energy: engine.current.mood.energy ?? 0.7,
        arousal: Math.min(1, Math.max(st.arousal, arousal.current * 0.6)),
        emotions: st.emotions,
      });
      core?.render(dt);
      if ((tick += dt) > 0.25) { tick = 0; setAffect(engine.current.snapshot()); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      offTrace();
      window.removeEventListener('gwn:agent-event', onEvent);
      core?.dispose();
    };
  }, []);

  return (
    <div className="wemo">
      <aside className="wemo__readout">
        <div className="wemo__head">Emotions now</div>
        {affect && (<>
          {affect.emotions.length === 0 && <p className="wemo__empty">Neutral.</p>}
          {affect.emotions.map(({ emotion, v }) => (
            <div key={emotion} className="wemo__meter">
              <span>{emotion}</span>
              <div className="wemo__bar"><i style={{ width: `${Math.round(v * 100)}%`, background: hex(EMOTION_COLORS[emotion]), boxShadow: `0 0 8px ${hex(EMOTION_COLORS[emotion])}` }} /></div>
              <b>{v.toFixed(2)}</b>
            </div>
          ))}
          <div className="wemo__pad">
            <span>V <b>{affect.valence.toFixed(2)}</b></span>
            <span>A <b>{affect.arousal.toFixed(2)}</b></span>
            <span>D <b>{affect.dominance.toFixed(2)}</b></span>
          </div>
        </>)}
      </aside>
      <div className="wemo__net">
        <canvas ref={coreRef} className="wemo__canvas" />
        <div ref={labelsRef} className="ncore-labels" aria-hidden="true" />
        {path && <div className="widget__path">{path}</div>}
      </div>
    </div>
  );
}
