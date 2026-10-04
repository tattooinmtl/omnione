import { useEffect, useRef, useState, useCallback } from 'react';
import { BrainNetwork, emotionColor } from '../presence/BrainNetwork.js';
import { EmotionRuntime } from '../presence/emotionEngine.js';
import { createBrainRouter } from '../presence/brainRouter.js';

/* The neural network in its own floating window: the 3D brain with every
 * conversation, tool and skill, lit live by every run (any window) through
 * the emotions felt at that moment. Drag to rotate, wheel to zoom. */

export default function NeuralWidget() {
  const canvasRef = useRef(null);
  const labelsRef = useRef(null);
  const brain = useRef(null);
  const engine = useRef(null);
  const [path, setPath] = useState('');
  const [counts, setCounts] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/brain');
      if (!r.ok) return;
      brain.current?.setGraph(await r.json());
      if (brain.current?.counts) setCounts({ ...brain.current.counts });
    } catch { /* keep what is drawn */ }
  }, []);

  useEffect(() => {
    engine.current = new EmotionRuntime();
    try {
      brain.current = new BrainNetwork(canvasRef.current, labelsRef.current, { onPath: (l) => setPath(l.join(' → ')) });
    } catch { brain.current = null; }
    const router = createBrainRouter({ getBrain: () => brain.current, getEngine: () => engine.current, onCounts: setCounts });
    const offTrace = engine.current.onTrace((t) => {
      for (const m of t.emotions) brain.current?.fire(['brain', `emotion:${m.emotion}`], emotionColor(m.emotion));
    });
    const onEvent = (e) => {
      const ev = e.detail || {};
      engine.current.handleEvent(ev);
      router.handle(ev);
      if (ev.type === 'done') load();
    };
    window.addEventListener('gwn:agent-event', onEvent);
    const ro = new ResizeObserver(() => brain.current?.resize());
    if (canvasRef.current) ro.observe(canvasRef.current);
    fetch('/api/mind').then((r) => r.json()).then((j) => engine.current?.setMood(j.mood)).catch(() => {});
    load();
    const t = setInterval(load, 60000);

    let raf = 0;
    let last = performance.now();
    const loop = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      engine.current.update(dt);
      const st = engine.current.core.state;
      brain.current?.setEmotions(st.emotions, st.arousal);
      brain.current?.render(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(t);
      ro.disconnect();
      offTrace();
      window.removeEventListener('gwn:agent-event', onEvent);
      brain.current?.dispose();
      brain.current = null;
    };
  }, [load]);

  return (
    <div className="wneural">
      <canvas ref={canvasRef} className="wneural__canvas" title="Drag to rotate · wheel to zoom" />
      <div ref={labelsRef} className="brain-labels" aria-hidden="true" />
      <div className="presence__brain-legend">
        <span className="is-conversation">conversations{counts ? ` ${counts.conversations}` : ''}</span>
        <span className="is-skill">skills{counts ? ` ${counts.skills}` : ''}</span>
        <span className="is-tool">tools{counts ? ` ${counts.tools}` : ''}</span>
        <span className="is-emotion">emotions</span>
      </div>
      {path && <div className="widget__path">{path}</div>}
    </div>
  );
}
