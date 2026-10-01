// Layer 3 — the face connection.
//
// Maps the emotion state onto face channels. Every active emotion
// contributes its preset in proportion to its activation, so a face can be
// mostly amused with a trace of confusion instead of snapping between named
// expressions. Channels combine by weighted blend, not sum, so five weak
// emotions never add up to one exaggerated face.
//
// Also here: expression cues — the explicit directive form an agent can send
// to show something on purpose:
//   { emotion: "sarcastic", intensity: 0.8, gaze: "sideways", mouth: "smirk",
//     eyebrows: "raised_one", head: "tilt", effect: "subtle_glitch", duration: 1200 }

import { EMOTIONS } from './core.js';

export const FACE_CHANNELS = [
  'browInnerUp', 'browDown', 'browAsym', 'eyeWide', 'eyeSquint', 'blink',
  'smile', 'frown', 'jawOpen', 'smirk', 'headTilt', 'headNod', 'headTurn',
  'gazeX', 'gazeY', 'glow', 'glitch',
];

export const NEUTRAL_FACE = Object.fromEntries(FACE_CHANNELS.map((c) => [c, 0]));
NEUTRAL_FACE.glow = 0.3;

// gazeY: + up, - down. headNod: + up, - down.
//
// The base expressions: the twelve the others are built from.
const BASE = {
  joy:         { smile: 0.9, eyeSquint: 0.35, browInnerUp: 0.2, glow: 0.7 },
  sadness:     { browInnerUp: 0.8, frown: 0.8, gazeY: -0.5, headNod: -0.2, glow: 0.15 },
  anger:       { browDown: 0.9, eyeSquint: 0.8, frown: 0.6, glow: 1, glitch: 0.15 },
  fear:        { eyeWide: 0.9, browInnerUp: 0.7, frown: 0.3, jawOpen: 0.2, headNod: 0.1, glitch: 0.1 },
  surprise:    { eyeWide: 1, browInnerUp: 0.9, jawOpen: 0.65, glow: 0.9 },
  disgust:     { browDown: 0.5, eyeSquint: 0.5, frown: 0.5, smirk: -0.4, headTurn: 0.15 },
  curiosity:   { browInnerUp: 0.65, headTilt: 0.35, gazeX: 0.15, eyeWide: 0.25 },
  amusement:   { smile: 0.7, smirk: 0.5, eyeSquint: 0.3, headTilt: 0.15 },
  empathy:     { browInnerUp: 0.4, eyeSquint: 0.15, smile: 0.15, headTilt: 0.2, glow: 0.4 },
  frustration: { browDown: 0.6, eyeSquint: 0.45, frown: 0.7, glow: 0.75, glitch: 0.08 },
  confusion:   { browInnerUp: 0.5, browAsym: 0.4, headTilt: 0.3, eyeWide: 0.25 },
  pride:       { smile: 0.5, headNod: 0.15, eyeSquint: 0.15, glow: 0.6 },
};

// The rest are states built from the base ones — a mix of their faces plus
// what is particular to them. Excitement is joy with wide eyes and a lifted
// head; sarcasm is amusement crossed with skepticism, finished with a smirk.
// Building them this way keeps twenty-six states reading as one face.
const COMPOSED = {
  excitement:     { from: { joy: 0.8, surprise: 0.25 }, add: { eyeWide: 0.55, headNod: 0.15, glow: 0.95 } },
  love:           { from: { joy: 0.5, empathy: 0.6 }, add: { eyeSquint: 0.3, headTilt: 0.25, glow: 0.8 } },
  relief:         { from: { joy: 0.35 }, add: { smile: 0.45, browInnerUp: 0.25, eyeSquint: 0.2, headNod: -0.12, glow: 0.45 } },
  gratitude:      { from: { empathy: 0.6, joy: 0.45 }, add: { eyeSquint: 0.3, headNod: -0.18, glow: 0.6 } },
  hope:           { from: { joy: 0.3, curiosity: 0.4 }, add: { gazeY: 0.35, browInnerUp: 0.4, glow: 0.55 } },
  disappointment: { from: { sadness: 0.6 }, add: { frown: 0.45, gazeY: -0.35, headNod: -0.15, glow: 0.2 } },
  anxiety:        { from: { fear: 0.5 }, add: { browInnerUp: 0.6, eyeWide: 0.4, frown: 0.25, glitch: 0.08 } },
  loneliness:     { from: { sadness: 0.5 }, add: { gazeX: -0.5, gazeY: -0.3, headTurn: -0.2, glow: 0.1 } },
  amazement:      { from: { surprise: 0.7, joy: 0.4 }, add: { eyeWide: 1, jawOpen: 0.45, glow: 1 } },
  skepticism:     { from: { confusion: 0.3 }, add: { browAsym: 0.75, eyeSquint: 0.45, smirk: 0.2, headTilt: -0.15 } },
  suspicion:      { from: { skepticism: 0.6 }, add: { gazeX: 0.6, eyeSquint: 0.6, headTurn: -0.15, browDown: 0.3 } },
  sarcasm:        { from: { amusement: 0.6, skepticism: 0.6 }, add: { smirk: 0.9, gazeX: 0.4 } },
  embarrassment:  { from: { joy: 0.2 }, add: { smile: 0.35, gazeX: -0.5, gazeY: -0.4, headNod: -0.15, browInnerUp: 0.3, glow: 0.55 } },
  determination:  { from: {}, add: { browDown: 0.45, eyeSquint: 0.35, frown: 0.1, headNod: -0.08, glow: 0.7 } },
};

function compose(name) {
  if (BASE[name]) return { ...BASE[name] };
  const def = COMPOSED[name];
  const mixed = {};
  for (const [src, w] of Object.entries(def.from)) {
    const face = compose(src);
    for (const [c, v] of Object.entries(face)) mixed[c] = (mixed[c] || 0) + v * w;
  }
  // Its own features win over the mix where they overlap.
  return { ...mixed, ...def.add };
}

export const PRESETS = Object.fromEntries(EMOTIONS.map((e) => [e, compose(e)]));

// A colour per emotion, for paths and nodes in the neural view: warm and
// bright for the positive family, reds and blues for the negative, cool
// cyans and violets for the cognitive, pinks and golds for the social.
export const EMOTION_COLORS = {
  joy: 0x38f8d4, amusement: 0x7cff9e, excitement: 0xfff05a, love: 0xff6fb5,
  pride: 0xffd166, relief: 0x9ff0c8, gratitude: 0xffb38a, hope: 0xa8ffef,
  anger: 0xff3b5c, frustration: 0xff7a45, sadness: 0x5b6cff, disappointment: 0x7d8bd6,
  fear: 0x9b5cff, anxiety: 0xc77dff, disgust: 0x9fcf4a, loneliness: 0x4a6fa5,
  curiosity: 0x4dc3ff, confusion: 0xb8a1ff, surprise: 0xe8fbff, amazement: 0x7ff6ff,
  skepticism: 0xd0b3ff, suspicion: 0x8f9bb3,
  empathy: 0xff9ad5, sarcasm: 0xe4ff7a, embarrassment: 0xff8fa3, determination: 0xffa630,
};

const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));

/* Your mapEmotionToFace: one emotion at one intensity. */
export function mapEmotionToFace(emotion, intensity) {
  const preset = PRESETS[emotion] ?? {};
  const out = { ...NEUTRAL_FACE };
  const k = clamp(intensity);
  for (const [c, v] of Object.entries(preset)) out[c] = NEUTRAL_FACE[c] + (v - NEUTRAL_FACE[c]) * k;
  return out;
}

/* Every active emotion, blended by activation. */
export function blendFace(emotions) {
  const out = { ...NEUTRAL_FACE };
  const total = EMOTIONS.reduce((a, e) => a + (emotions[e] || 0), 0);
  if (total < 0.01) return out;
  // Weight toward the strongest, but let the rest show through.
  const norm = Math.max(1, total);
  for (const e of EMOTIONS) {
    const w = (emotions[e] || 0) / norm;
    if (!w) continue;
    for (const [c, v] of Object.entries(PRESETS[e])) out[c] += (v - NEUTRAL_FACE[c]) * w;
  }
  for (const c of FACE_CHANNELS) {
    out[c] = ['smirk', 'headTilt', 'headNod', 'headTurn', 'gazeX', 'gazeY', 'browAsym'].includes(c)
      ? clamp(out[c], -1, 1)
      : clamp(out[c]);
  }
  return out;
}

/* Which face channels an emotion moves noticeably — the last hop of a path. */
export function channelsFor(emotion) {
  return Object.entries(PRESETS[emotion] || {})
    .filter(([c, v]) => Math.abs(v - NEUTRAL_FACE[c]) >= 0.25)
    .map(([c]) => c);
}

// --- expression cues ------------------------------------------------------------------

// Words the agent may use for an emotion, mapped to one of the twenty-six.
const ALIASES = {
  happy: 'joy', glad: 'joy', delighted: 'joy', content: 'joy', cheerful: 'joy',
  amused: 'amusement', playful: 'amusement', teasing: 'amusement',
  excited: 'excitement', thrilled: 'excitement', enthusiastic: 'excitement', eager: 'excitement',
  loving: 'love', affectionate: 'love', fond: 'love', adoring: 'love',
  proud: 'pride', confident: 'pride', satisfied: 'pride', smug: 'pride',
  relieved: 'relief', calm: 'relief', reassured: 'relief',
  grateful: 'gratitude', thankful: 'gratitude', appreciative: 'gratitude',
  hopeful: 'hope', optimistic: 'hope', expectant: 'hope',
  angry: 'anger', furious: 'anger', mad: 'anger',
  frustrated: 'frustration', annoyed: 'frustration', irritated: 'frustration',
  sad: 'sadness', sorry: 'sadness', unhappy: 'sadness',
  disappointed: 'disappointment', let_down: 'disappointment', deflated: 'disappointment',
  scared: 'fear', afraid: 'fear', alarmed: 'fear',
  anxious: 'anxiety', worried: 'anxiety', nervous: 'anxiety', restless: 'anxiety', uneasy: 'anxiety',
  disgusted: 'disgust', repulsed: 'disgust',
  lonely: 'loneliness', isolated: 'loneliness', withdrawn: 'loneliness',
  curious: 'curiosity', interested: 'curiosity', intrigued: 'curiosity', thinking: 'curiosity', thoughtful: 'curiosity',
  confused: 'confusion', puzzled: 'confusion', lost: 'confusion',
  surprised: 'surprise', shocked: 'surprise', startled: 'surprise',
  amazed: 'amazement', astonished: 'amazement', awed: 'amazement', wonder: 'amazement',
  skeptical: 'skepticism', doubtful: 'skepticism', unconvinced: 'skepticism',
  suspicious: 'suspicion', wary: 'suspicion', guarded: 'suspicion',
  empathetic: 'empathy', caring: 'empathy', sympathetic: 'empathy', warm: 'empathy', gentle: 'empathy',
  sarcastic: 'sarcasm', wry: 'sarcasm', ironic: 'sarcasm',
  embarrassed: 'embarrassment', sheepish: 'embarrassment', awkward: 'embarrassment',
  determined: 'determination', focused: 'determination', resolute: 'determination', firm: 'determination',
};

export const CUE_OPTIONS = {
  gaze: ['center', 'at_user', 'sideways', 'away', 'up', 'down'],
  mouth: ['neutral', 'smile', 'grin', 'smirk', 'frown', 'open', 'pursed'],
  eyebrows: ['neutral', 'raised', 'raised_one', 'furrowed', 'sad'],
  head: ['neutral', 'tilt', 'nod', 'shake', 'down', 'up', 'turn_away'],
  effect: ['none', 'subtle_glitch', 'glitch', 'glow_pulse', 'flicker'],
};

export function resolveEmotion(name) {
  const n = String(name || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (EMOTIONS.includes(n)) return n;
  return ALIASES[n] || null;
}

/**
 * Turn a cue into (a) emotion events for the engine and (b) a face overlay
 * that holds for the cue's duration on top of the blended face.
 */
export function cueToOverlay(cue = {}) {
  const intensity = clamp(Number(cue.intensity ?? 0.7));
  const emotion = resolveEmotion(cue.emotion);
  const o = {};
  switch (cue.gaze) {
    case 'sideways': o.gazeX = 0.7; break;
    case 'away': o.gazeX = -0.6; o.gazeY = -0.2; break;
    case 'up': o.gazeY = 0.6; break;
    case 'down': o.gazeY = -0.6; break;
    case 'at_user': case 'center': o.gazeX = 0; o.gazeY = 0; break;
    default: break;
  }
  switch (cue.mouth) {
    case 'smile': o.smile = 0.7; o.frown = 0; break;
    case 'grin': o.smile = 1; o.eyeSquint = 0.4; o.frown = 0; break;
    case 'smirk': o.smirk = 0.9; o.smile = 0.15; break;
    case 'frown': o.frown = 0.8; o.smile = 0; break;
    case 'open': o.jawOpen = 0.6; break;
    case 'pursed': o.smile = 0; o.frown = 0.2; o.jawOpen = 0; break;
    default: break;
  }
  switch (cue.eyebrows) {
    case 'raised': o.browInnerUp = 0.8; o.browDown = 0; break;
    case 'raised_one': o.browAsym = 0.9; break;
    case 'furrowed': o.browDown = 0.8; break;
    case 'sad': o.browInnerUp = 0.7; o.frown = Math.max(o.frown || 0, 0.3); break;
    default: break;
  }
  const gestures = [];
  switch (cue.head) {
    case 'tilt': o.headTilt = 0.45; break;
    case 'down': o.headNod = -0.35; break;
    case 'up': o.headNod = 0.3; break;
    case 'turn_away': o.headTurn = 0.4; break;
    case 'nod': gestures.push('nod'); break;
    case 'shake': gestures.push('shake'); break;
    default: break;
  }
  let effect = null;
  switch (cue.effect) {
    case 'subtle_glitch': o.glitch = 0.35; break;
    case 'glitch': o.glitch = 0.85; break;
    case 'glow_pulse': effect = 'glow_pulse'; break;
    case 'flicker': effect = 'flicker'; break;
    default: break;
  }
  // Scale the overlay by intensity.
  for (const k of Object.keys(o)) o[k] *= intensity;
  const duration = Math.max(200, Math.min(10_000, Number(cue.duration ?? 1500)));
  const events = emotion ? [{ emotion, intensity, confidence: 1, source: 'agent' }] : [];
  return { overlay: o, events, gestures, effect, duration, emotion };
}
