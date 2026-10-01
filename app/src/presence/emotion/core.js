// Layer 2 — the emotion engine proper.
//
// A persistent affective state: twenty-six emotion activations in four
// families, plus the three continuous dimensions of the PAD model (valence,
// arousal, dominance) and a confidence in the inferred state. Appraised events
// push activations up; time lets them fall, each emotion at its own rate —
// surprise is gone in a couple of seconds, loneliness lingers. Personality
// scales how strongly each kind of emotion is expressed.
//
// The emotions are states, not animations: the face layer builds the richer
// ones out of the simpler ones (excitement is joy with high arousal and wide
// eyes; sarcasm is amusement crossed with skepticism), so twenty-six named
// states still read as one continuous face.
//
// The clock is explicit (`now` in ms) rather than Date.now(), so the
// animation loop drives it and tests can fast-forward it.

export const FAMILIES = {
  positive: ['joy', 'amusement', 'excitement', 'love', 'pride', 'relief', 'gratitude', 'hope'],
  negative: ['anger', 'frustration', 'sadness', 'disappointment', 'fear', 'anxiety', 'disgust', 'loneliness'],
  cognitive: ['curiosity', 'confusion', 'surprise', 'amazement', 'skepticism', 'suspicion'],
  social: ['empathy', 'sarcasm', 'embarrassment', 'determination'],
};

export const EMOTIONS = [
  'joy', 'amusement', 'excitement', 'love', 'pride', 'relief', 'gratitude', 'hope',
  'anger', 'frustration', 'sadness', 'disappointment', 'fear', 'anxiety', 'disgust', 'loneliness',
  'curiosity', 'confusion', 'surprise', 'amazement', 'skepticism', 'suspicion',
  'empathy', 'sarcasm', 'embarrassment', 'determination',
];

export const FAMILY_OF = Object.fromEntries(
  Object.entries(FAMILIES).flatMap(([family, list]) => list.map((e) => [e, family])),
);

// Seconds for an activation to halve.
export const HALF_LIFE = {
  joy: 8, amusement: 5, excitement: 4, love: 20, pride: 10, relief: 6, gratitude: 12, hope: 15,
  anger: 12, frustration: 14, sadness: 20, disappointment: 16, fear: 10, anxiety: 18, disgust: 6, loneliness: 40,
  curiosity: 9, confusion: 6, surprise: 2, amazement: 4, skepticism: 10, suspicion: 14,
  empathy: 14, sarcasm: 4, embarrassment: 5, determination: 20,
};

// Contribution to valence (pleasantness) per unit of activation.
export const VALENCE_SIGN = {
  joy: 0.8, amusement: 0.75, excitement: 0.8, love: 0.85, pride: 0.65, relief: 0.6, gratitude: 0.7, hope: 0.5,
  anger: -0.7, frustration: -0.6, sadness: -0.8, disappointment: -0.55, fear: -0.65, anxiety: -0.55, disgust: -0.7, loneliness: -0.6,
  curiosity: 0.15, confusion: -0.2, surprise: 0, amazement: 0.45, skepticism: -0.1, suspicion: -0.3,
  empathy: 0.25, sarcasm: 0.1, embarrassment: -0.25, determination: 0.15,
};

export const HIGH_AROUSAL = new Set([
  'joy', 'amusement', 'excitement', 'anger', 'frustration', 'fear', 'anxiety',
  'surprise', 'amazement', 'embarrassment', 'determination',
]);

// Emotions that make it feel more in control (dominance up) or less.
const DOMINANCE_SIGN = {
  pride: 0.5, anger: 0.4, determination: 0.5, excitement: 0.2, joy: 0.2, sarcasm: 0.25, skepticism: 0.2, curiosity: 0.1, love: 0.05,
  fear: -0.5, anxiety: -0.4, sadness: -0.3, disappointment: -0.25, loneliness: -0.35, confusion: -0.3,
  embarrassment: -0.4, surprise: -0.1, amazement: -0.1, relief: 0.1, suspicion: 0.1,
};

export const DEFAULT_PERSONALITY = {
  expressiveness: 0.85,
  humor: 0.7,
  assertiveness: 0.6,
  sensitivity: 0.7,
  curiosity: 0.8,
};

const clamp = (n, min = 0, max = 1) => Math.max(min, Math.min(max, n));
const neutralEmotions = () => Object.fromEntries(EMOTIONS.map((e) => [e, 0]));

export class EmotionEngine {
  constructor({ personality = DEFAULT_PERSONALITY, now = 0 } = {}) {
    this.personality = { ...DEFAULT_PERSONALITY, ...personality };
    // Where the dimensions rest when nothing is happening. The agent's
    // long-term mood (from the server) moves this.
    this.baseline = { valence: 0, arousal: 0.15, dominance: 0.5 };
    this.state = {
      emotions: neutralEmotions(),
      valence: 0,
      arousal: 0.15,
      dominance: 0.5,
      confidence: 1,
      updatedAt: now,
    };
  }

  setBaseline({ valence, arousal, dominance } = {}) {
    if (typeof valence === 'number') this.baseline.valence = clamp(valence, -1, 1);
    if (typeof arousal === 'number') this.baseline.arousal = clamp(arousal);
    if (typeof dominance === 'number') this.baseline.dominance = clamp(dominance);
  }

  /* Time-based recovery toward baseline. */
  decay(now) {
    const dt = Math.max(0, (now - this.state.updatedAt) / 1000);
    if (!dt) return;
    const s = this.state;
    for (const e of EMOTIONS) {
      s.emotions[e] *= Math.pow(0.5, dt / HALF_LIFE[e]);
      if (s.emotions[e] < 0.001) s.emotions[e] = 0;
    }
    const toward = (v, b, half) => b + (v - b) * Math.pow(0.5, dt / half);
    s.arousal = toward(s.arousal, this.baseline.arousal, 5);
    s.valence = toward(s.valence, this.baseline.valence, 15);
    s.dominance = toward(s.dominance, this.baseline.dominance, 20);
    s.updatedAt = now;
  }

  /* How strongly this personality expresses a given emotion. */
  scaleFor(emotion) {
    const p = this.personality;
    const by = (trait) => p.expressiveness * (0.6 + p[trait] * 0.4);
    switch (emotion) {
      case 'joy': case 'amusement': case 'excitement': case 'sarcasm':
        return by('humor');
      case 'empathy': case 'sadness': case 'love': case 'gratitude': case 'loneliness':
      case 'disappointment': case 'embarrassment': case 'anxiety':
        return by('sensitivity');
      case 'curiosity': case 'surprise': case 'amazement': case 'hope':
        return by('curiosity');
      case 'anger': case 'pride': case 'determination': case 'skepticism': case 'suspicion':
        return by('assertiveness');
      default:
        return p.expressiveness;
    }
  }

  /**
   * Apply one interpreted event. Returns the impact actually applied, which
   * the visualiser uses to decide how bright the path it took should be.
   * @param {{emotion: string, intensity: number, confidence?: number, source?: string}} event
   */
  apply(event, now = this.state.updatedAt) {
    if (!EMOTIONS.includes(event.emotion)) return 0;
    this.decay(now);
    const confidence = clamp(event.confidence ?? 0.8);
    const intensity = clamp(event.intensity);
    const impact = clamp(intensity * confidence * this.scaleFor(event.emotion));

    // Activation accumulates toward 1 but never past it.
    const prev = this.state.emotions[event.emotion];
    this.state.emotions[event.emotion] = clamp(prev + impact * (1 - prev));

    const s = this.state;
    const sign = VALENCE_SIGN[event.emotion] ?? 0;
    // Your update (0.7 memory, 0.3 new), plus a direct push so one strong
    // event is visible on the face without waiting for several to accumulate.
    s.valence = clamp(s.valence * 0.7 + sign * impact * 0.55, -1, 1);

    const boost = HIGH_AROUSAL.has(event.emotion) ? impact * 0.45 : impact * 0.12;
    s.arousal = clamp(s.arousal * 0.65 + boost + 0.05);

    const dom = DOMINANCE_SIGN[event.emotion] ?? 0;
    s.dominance = clamp(s.dominance + dom * impact * 0.3);

    s.confidence = confidence;
    s.updatedAt = now;
    return impact;
  }

  getState(now) {
    if (now != null) this.decay(now);
    return structuredClone(this.state);
  }

  /* Emotions above the noise floor, strongest first. */
  active(threshold = 0.05) {
    return Object.entries(this.state.emotions)
      .filter(([, v]) => v >= threshold)
      .sort((a, b) => b[1] - a[1]);
  }

  getDominantEmotion() {
    const [top] = this.active(0);
    return !top || top[1] < 0.15 ? 'neutral' : top[0];
  }

  getExpression(now) {
    if (now != null) this.decay(now);
    const dominant = this.getDominantEmotion();
    return {
      emotion: dominant,
      intensity: dominant === 'neutral' ? 0 : clamp(this.state.emotions[dominant]),
      valence: this.state.valence,
      arousal: this.state.arousal,
      dominance: this.state.dominance,
      personality: this.personality,
    };
  }
}
