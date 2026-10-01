// The emotion runtime — the continuous loop that joins the layers:
//
//   event ──► appraisal ──► emotion engine ──► face mapping ──► face / voice
//             (what it       (12 emotions,      (blended          (renderer,
//              means)         PAD, decay)        channels)         TTS delivery)
//
// Every frame: the engine decays, the active emotions are blended into face
// channels, behaviour (thinking, working, asking, dreaming), gestures, cues
// and life (blinks, saccades, breathing) are layered on, and the result is
// smoothed into the parameters the face renderer draws.
//
// Every appraised event also produces a trace — which source it came from,
// how it appraised, which emotions it moved and by how much, which face
// channels those drive — so the neural view can animate the path it took.
//
// Pure JavaScript; no DOM, no Three.js.

import { EmotionEngine, EMOTIONS } from './emotion/core.js';
import { appraiseAgentEvent, appraiseText, APPRAISAL_DIMS } from './emotion/appraisal.js';
import { blendFace, channelsFor, cueToOverlay, EMOTION_COLORS } from './emotion/face.js';

export { EMOTIONS, APPRAISAL_DIMS, EMOTION_COLORS };

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

// Head and eye motions layered over the expression; f(t) for t in 0..1.
const ease = (x) => Math.sin(Math.PI * clamp(x));
export const GESTURES = {
  nod:        { dur: 0.9, f: (t) => ({ headNod: -0.35 * Math.sin(t * Math.PI * 2) * (1 - t) }) },
  microNod:   { dur: 0.45, f: (t) => ({ headNod: -0.12 * ease(t) }) },
  shake:      { dur: 1.1, f: (t) => ({ headTurn: 0.3 * Math.sin(t * Math.PI * 4) * (1 - t) }) },
  tilt:       { dur: 1.6, f: (t) => ({ headTilt: 0.3 * ease(t) }) },
  lookAway:   { dur: 1.4, f: (t) => ({ gazeX: 0.7 * ease(t), gazeY: -0.2 * ease(t), headTurn: 0.12 * ease(t) }) },
  glanceDown: { dur: 0.7, f: (t) => ({ gazeY: -0.5 * ease(t) }) },
  lookAtUser: { dur: 0.8, f: (t) => ({ headNod: 0.08 * ease(t), eyeOpen: 0.15 * ease(t) }) },
  flinch:     { dur: 0.5, f: (t) => ({ headNod: 0.15 * ease(t), eyeOpen: -0.4 * ease(t * 2) }) },
};

// Behaviour: what it is doing, as opposed to what it feels.
const BEHAVIOURS = {
  thinking: { gazeX: -0.4, gazeY: 0.45 },
  working: { gazeY: -0.35 },
  asking: { gazeX: 0, gazeY: 0.05, headNod: 0.05 },
  dreaming: { eyeOpen: -0.8, glow: -0.1 },
};

const EVENT_GESTURE = {
  user_prompt: 'lookAtUser', tool_call: 'glanceDown', stuck: 'shake', approval_request: 'lookAtUser',
  done: 'nod', error: 'lookAway',
};

// MiniMax TTS emotions.
const VOICE_EMOTION = {
  joy: 'happy', amusement: 'happy', excitement: 'happy', love: 'happy', pride: 'happy',
  relief: 'calm', gratitude: 'happy', hope: 'fluent',
  anger: 'angry', frustration: 'angry', sadness: 'sad', disappointment: 'sad',
  fear: 'fearful', anxiety: 'fearful', disgust: 'disgusted', loneliness: 'sad',
  curiosity: 'fluent', confusion: 'calm', surprise: 'surprised', amazement: 'surprised',
  skepticism: 'calm', suspicion: 'calm',
  empathy: 'calm', sarcasm: 'fluent', embarrassment: 'calm', determination: 'fluent',
  neutral: 'calm',
};

let traceSeq = 0;

export class EmotionRuntime {
  constructor({ mood, personality } = {}) {
    this.time = 0;
    this.core = new EmotionEngine({ personality, now: 0 });
    this.mood = mood || { valence: 0.3, energy: 0.7, label: 'curious' };
    this.setMood(this.mood);
    this.behaviour = null;
    this.gestures = [];
    this.overlays = [];
    this.effects = [];
    this.speaking = 0;
    this.fails = 0;
    this.hadFailures = false;   // any failure since the user last spoke
    this.lastEventWall = Date.now();
    this.lastEventAt = 0;
    this.blink = { next: 2.5, t: -1 };
    this.saccade = { next: 1.5, x: 0, y: 0 };
    this.current = null;
    this.lastCue = null;
    this.listeners = new Set();
  }

  get now() {
    return this.time * 1000;
  }

  /* Subscribe to traces (for the neural view). */
  onTrace(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit(trace) {
    for (const fn of this.listeners) {
      try { fn(trace); } catch { /* a broken view must not stop the face */ }
    }
  }

  setMood(mood) {
    if (!mood || typeof mood.valence !== 'number') return;
    this.mood = { ...this.mood, ...mood };
    // Long-term mood is where the fast emotions come to rest.
    this.core.setBaseline({ valence: this.mood.valence * 0.6, arousal: 0.08 + (this.mood.energy ?? 0.7) * 0.15 });
  }

  /* Run an appraisal result through the engine and report its path. */
  #applyAppraised(result, kind) {
    if (!result) return null;
    const moved = [];
    for (const e of result.events) {
      const impact = this.core.apply(e, this.now);
      if (impact > 0.01) moved.push({ emotion: e.emotion, impact, source: e.source });
    }
    const trace = {
      id: ++traceSeq,
      kind,
      source: result.source || moved[0]?.source || 'agent',
      appraisal: result.appraisal,
      emotions: moved,
      channels: Object.fromEntries(moved.map((m) => [m.emotion, channelsFor(m.emotion)])),
      at: this.time,
    };
    if (moved.length) this.#emit(trace);
    return trace;
  }

  /* Feed an agent event. */
  handleEvent(ev) {
    if (!ev?.type) return null;
    if (ev.mood) this.setMood(ev.mood);
    this.lastEventAt = this.time;

    // History the appraisal needs: failures in a row (and how many just
    // ended, for relief), whether this run struggled at all, and how long it
    // has been quiet (for loneliness on waking).
    const previousFailures = this.fails;
    const idleHours = (Date.now() - this.lastEventWall) / 3_600_000;
    this.lastEventWall = Date.now();
    if (ev.type === 'user_prompt') this.hadFailures = false;
    if (ev.type === 'tool_result') {
      this.fails = ev.ok ? 0 : this.fails + 1;
      if (!ev.ok) this.hadFailures = true;
    }
    const hadFailures = this.hadFailures;
    if (ev.type === 'done' || ev.type === 'user_prompt') this.fails = 0;

    // Behaviour.
    switch (ev.type) {
      case 'turn_start': case 'thinking': this.behaviour = 'thinking'; break;
      case 'delta': if (this.behaviour === 'thinking') this.behaviour = null; break;
      case 'tool_call': this.behaviour = 'working'; break;
      case 'approval_request': this.behaviour = 'asking'; break;
      case 'approval_resolved': case 'done': case 'error': case 'heartbeat_end': this.behaviour = null; break;
      case 'heartbeat_start': this.behaviour = 'dreaming'; break;
      default: break;
    }
    if (ev.type === 'tool_result' && !ev.ok) this.gesture('flinch');
    else if (ev.type === 'tool_result' && ev.ok) this.gesture('microNod');
    else if (EVENT_GESTURE[ev.type]) this.gesture(EVENT_GESTURE[ev.type]);

    // The agent deliberately showing an expression.
    if (ev.type === 'tool_call' && ev.name === 'express') return this.applyCue(ev.input || {});

    return this.#applyAppraised(
      appraiseAgentEvent(ev, { consecutiveFailures: this.fails, previousFailures, hadFailures, idleHours }),
      ev.type,
    );
  }

  /* An explicit expression cue (the `express` tool, or anything else). */
  applyCue(cue) {
    const c = cueToOverlay(cue);
    this.lastCue = { ...cue, at: this.time };
    this.overlays.push({ values: c.overlay, start: this.time, dur: c.duration / 1000 });
    c.gestures.forEach((g) => this.gesture(g));
    if (c.effect) this.effects.push({ name: c.effect, start: this.time, dur: c.duration / 1000 });
    return this.#applyAppraised({ source: 'agent', appraisal: { event: 'express', relevance: 1, unexpectedness: 0, goalImpact: 0, socialTone: 0.3, certainty: 1, interpretation: 'neutral' }, events: c.events }, 'express');
  }

  /* Colour the face for something it is about to say; returns the delivery. */
  express(text) {
    this.#applyAppraised(appraiseText(text, 'agent'), 'speech');
    const dom = this.core.getDominantEmotion();
    const { valence, arousal } = this.core.state;
    const energy = this.mood.energy ?? 0.7;
    return {
      emotion: dom,
      voice: {
        emotion: VOICE_EMOTION[dom] || 'calm',
        speed: +clamp(0.9 + arousal * 0.2 + energy * 0.08, 0.8, 1.25).toFixed(2),
        pitch: Math.round(clamp(valence * 2 + (dom === 'surprise' || dom === 'joy' ? 1 : 0), -2, 2)),
      },
    };
  }

  gesture(name, delay = 0) {
    if (GESTURES[name]) this.gestures.push({ name, start: this.time + delay });
  }

  setSpeaking(level) {
    this.speaking = clamp(level);
  }

  dominant() {
    const d = this.core.getDominantEmotion();
    return d === 'neutral' ? (this.mood.label || 'calm') : d;
  }

  /* For the HUD: the strongest emotions, PAD and the last cue. */
  snapshot() {
    const s = this.core.state;
    return {
      emotions: this.core.active(0.03).slice(0, 5).map(([emotion, v]) => ({ emotion, v })),
      valence: s.valence,
      arousal: s.arousal,
      dominance: s.dominance,
      confidence: s.confidence,
      dominant: this.core.getDominantEmotion(),
      behaviour: this.behaviour,
      // Only while the expression is on the face (plus a moment to read it),
      // so an old cue does not sit in the HUD forever.
      cue: this.lastCue && this.time - this.lastCue.at < Math.min(10, (Number(this.lastCue.duration) || 1500) / 1000) + 2
        ? this.lastCue
        : null,
    };
  }

  /* Advance by dt seconds and return the face renderer's parameters. */
  update(dt) {
    dt = Math.min(0.1, Math.max(0, dt));
    this.time += dt;
    this.core.decay(this.now);
    const s = this.core.state;
    const energy = this.mood.energy ?? 0.7;

    // Emotions → face channels.
    const f = blendFace(s.emotions);

    // Cue overlays hold their values, easing in and out.
    this.overlays = this.overlays.filter((o) => this.time - o.start < o.dur);
    for (const o of this.overlays) {
      const t = (this.time - o.start) / o.dur;
      const w = Math.min(1, t * 6, (1 - t) * 4);
      for (const [k, v] of Object.entries(o.values)) f[k] = f[k] + (v - f[k]) * w;
    }

    // Face channels → renderer parameters.
    const target = {
      smile: f.smile - f.frown + s.valence * 0.15,
      smirk: f.smirk,
      browRaise: f.browInnerUp,
      browFurrow: f.browDown,
      browAsym: f.browAsym,
      eyeOpen: 0.5 + energy * 0.3 + f.eyeWide * 0.35 - f.eyeSquint * 0.2,
      squint: f.eyeSquint,
      gazeX: f.gazeX,
      gazeY: f.gazeY,
      headTilt: f.headTilt,
      headTurn: f.headTurn,
      headNod: f.headNod,
      glow: 0.35 + f.glow * 0.4 + energy * 0.1,
      agitation: 0.08 + s.arousal * 0.8,
      hue: clamp(0.08 + Math.max(0, -s.valence) * 0.55 + (s.emotions.anger || 0) * 0.3 + (s.emotions.fear || 0) * 0.2),
      glitch: f.glitch,
      jawOpenExpr: f.jawOpen,
    };

    // Behaviour on top.
    if (this.behaviour) for (const [k, v] of Object.entries(BEHAVIOURS[this.behaviour])) target[k] += v;

    // Long quiet and low energy: it gets drowsy.
    if (this.time - this.lastEventAt > 45 && energy < 0.6 && !this.behaviour) target.eyeOpen -= 0.3;

    // Gestures.
    this.gestures = this.gestures.filter((g) => this.time - g.start < GESTURES[g.name].dur);
    for (const g of this.gestures) {
      const t = (this.time - g.start) / GESTURES[g.name].dur;
      if (t < 0) continue;
      for (const [k, v] of Object.entries(GESTURES[g.name].f(t))) target[k] = (target[k] || 0) + v;
    }

    // Effects from cues.
    this.effects = this.effects.filter((e) => this.time - e.start < e.dur);
    for (const e of this.effects) {
      if (e.name === 'glow_pulse') target.glow += 0.4 * Math.abs(Math.sin(this.time * 6));
      if (e.name === 'flicker') target.glow *= Math.random() < 0.15 ? 0.3 : 1;
    }

    // Life: saccades and breathing.
    // Anxiety and suspicion make the eyes restless: quicker, wider darts.
    const restless = Math.min(1, (s.emotions.anxiety || 0) + (s.emotions.suspicion || 0) * 0.6);
    if (this.time > this.saccade.next) {
      const spread = 1 + restless * 1.8;
      this.saccade = {
        next: this.time + (0.8 + Math.random() * 2.5) * (1 - restless * 0.7),
        x: (Math.random() - 0.5) * 0.25 * spread,
        y: (Math.random() - 0.5) * 0.15 * spread,
      };
    }
    target.gazeX += this.saccade.x;
    target.gazeY += this.saccade.y;
    target.headNod += Math.sin(this.time * 0.9) * 0.02;
    target.headTilt += Math.sin(this.time * 0.37) * 0.025;
    target.glow += this.speaking * 0.2;

    // Smooth: fast for eyes and gaze, slower for the rest.
    if (!this.current) this.current = { ...target };
    const out = {};
    for (const [k, v] of Object.entries(target)) {
      const rate = k.startsWith('gaze') ? 14 : k === 'eyeOpen' || k === 'glitch' ? 10 : 5;
      const cur = this.current[k] ?? v;
      out[k] = cur + (v - cur) * (1 - Math.exp(-rate * dt));
    }
    this.current = out;

    // Blinks, more often when tired.
    let blinkClose = 0;
    if (this.blink.t < 0 && this.time > this.blink.next) this.blink.t = 0;
    if (this.blink.t >= 0) {
      this.blink.t += dt;
      const bt = this.blink.t / 0.16;
      blinkClose = bt < 1 ? Math.sin(bt * Math.PI) : 0;
      if (bt >= 1) this.blink = { t: -1, next: this.time + (1.5 + Math.random() * 4) * (0.5 + energy * 0.7) };
    }

    const signed = new Set(['smile', 'smirk', 'gazeX', 'gazeY', 'headTilt', 'headTurn', 'headNod', 'browAsym']);
    const frame = {};
    for (const [k, v] of Object.entries(out)) frame[k] = signed.has(k) ? clamp(v, -1, 1) : clamp(v);
    frame.eyeOpen = clamp(frame.eyeOpen * (1 - blinkClose));
    frame.jawOpen = clamp(this.speaking + frame.jawOpenExpr * 0.5);
    delete frame.jawOpenExpr;
    frame.dominant = this.dominant();
    return frame;
  }
}

// The old name, for anything still importing it.
export { EmotionRuntime as EmotionEngine };
