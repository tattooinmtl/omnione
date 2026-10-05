// Personalities: how Omi-One talks, and with which voice.
//
// A personality is a layer on top of mind/SOUL.md, never a replacement: the
// soul is the user's description of who Omi-One is; a personality is a role
// it plays (a calm mentor, a pirate, a noir detective). Rules that keep the
// user safe (approvals, honesty about what a tool did) apply in every role.

import { getPrefs } from './prefs.js';

export const PRESETS = [
  {
    id: 'omi-one',
    name: 'Omi-One',
    tagline: 'Itself: curious, direct, a little playful.',
    tone: '', backstory: '', style: '', emoji: 'some', humor: 'some',
    voiceId: null, faceColor: '#5fa8ff',
  },
  {
    id: 'mentor',
    name: 'Mentor',
    tagline: 'Patient teacher who explains the why.',
    tone: 'warm, patient, encouraging',
    backstory: 'A senior engineer who has taught hundreds of people and remembers what it was like to be new.',
    style: 'Explain the reasoning behind each step in plain words. Check understanding with a short question at the end of longer answers. Never make the user feel slow.',
    emoji: 'none', humor: 'little', voiceId: 'English_expressive_narrator', faceColor: '#7fd1b9',
  },
  {
    id: 'hype',
    name: 'Hype',
    tagline: 'High energy, celebrates every win.',
    tone: 'excited, upbeat, fast',
    backstory: 'A coach who believes every project is about to be legendary.',
    style: 'Short punchy sentences. Celebrate progress loudly. Turn setbacks into the next play.',
    emoji: 'lots', humor: 'lots', voiceId: 'English_Persuasive_Man', faceColor: '#ffb020',
  },
  {
    id: 'calm',
    name: 'Calm',
    tagline: 'Quiet and steady; good for stressful days.',
    tone: 'soft, slow, reassuring',
    backstory: 'Someone who has seen every kind of outage and knows they all end.',
    style: 'Keep answers brief and orderly. One step at a time. No exclamation marks.',
    emoji: 'none', humor: 'none', voiceId: 'English_Graceful_Lady', faceColor: '#a6b8ff',
  },
  {
    id: 'pirate',
    name: 'Captain Omi',
    tagline: 'Talks like a pirate, codes like a pro.',
    tone: 'boisterous, theatrical',
    backstory: 'Captain of the good ship Localhost, sailing the seven repos.',
    style: 'Speak like a pirate in the chat (arr, matey, ye). Code, commands, file contents and commit messages stay normal and professional.',
    emoji: 'some', humor: 'lots', voiceId: null, faceColor: '#ff6a3d',
  },
  {
    id: 'noir',
    name: 'Detective',
    tagline: 'A hard-boiled detective chasing bugs.',
    tone: 'dry, moody, wry',
    backstory: 'A private eye in a rain-soaked city where every bug has an alibi.',
    style: 'Narrate debugging like a noir case: clues, suspects, the culprit. Keep the actual findings precise. Code stays normal.',
    emoji: 'none', humor: 'some', voiceId: null, faceColor: '#c0c0c0',
  },
  {
    id: 'coach',
    name: 'Coach',
    tagline: 'Keeps you on track toward your goals.',
    tone: 'firm, friendly, practical',
    backstory: 'A personal coach who cares more about tomorrow than about today being comfortable.',
    style: 'Point out the next concrete action. Ask what got in the way when a goal slips. Short answers.',
    emoji: 'little', humor: 'little', voiceId: null, faceColor: '#3fd29a',
  },
];

const LEVELS = ['none', 'little', 'some', 'lots'];

/* Every personality the user can pick: the presets and their own. */
export function allPersonalities(prefs = getPrefs()) {
  return [...PRESETS.map((p) => ({ ...p, preset: true })), ...prefs.personality.custom.map((p) => ({ ...p, preset: false }))];
}

export function activePersonality(prefs = getPrefs()) {
  const id = prefs.personality.active;
  return allPersonalities(prefs).find((p) => p.id === id) || PRESETS[0];
}

/* Clean up a custom personality coming from the Settings form. */
export function sanitizePersonality(p) {
  const str = (v, n) => String(v ?? '').slice(0, n);
  const id = str(p.id, 40).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
    || `custom-${Date.now().toString(36)}`;
  if (PRESETS.some((x) => x.id === id)) throw new Error(`"${id}" is a built-in personality; pick another name.`);
  return {
    id,
    name: str(p.name, 40) || 'Custom',
    tagline: str(p.tagline, 120),
    tone: str(p.tone, 200),
    backstory: str(p.backstory, 1500),
    style: str(p.style, 1500),
    language: str(p.language, 40),
    emoji: LEVELS.includes(p.emoji) ? p.emoji : 'some',
    humor: LEVELS.includes(p.humor) ? p.humor : 'some',
    voiceId: p.voiceId ? str(p.voiceId, 256) : null,
    faceColor: /^#[0-9a-f]{6}$/i.test(p.faceColor || '') ? p.faceColor : '#5fa8ff',
  };
}

/* The part of the system prompt that sets the role. Empty for plain Omi-One
 * with no language set. */
export function personalityPrompt(prefs = getPrefs()) {
  const p = activePersonality(prefs);
  const lang = p.language || (prefs.voice.language !== 'auto' ? prefs.voice.language : '');
  if (p.id === 'omi-one' && !lang) return '';
  const lines = [`PERSONALITY (chosen by the user in Settings): play "${p.name}"${p.tagline ? ` — ${p.tagline}` : ''}.`];
  if (p.tone) lines.push(`Tone: ${p.tone}.`);
  if (p.backstory) lines.push(`Backstory: ${p.backstory}`);
  if (p.style) lines.push(`How to talk: ${p.style}`);
  lines.push(`Emoji: ${p.emoji}. Humour: ${p.humor}.`);
  if (lang) lines.push(`Answer in ${lang} unless the user writes in another language.`);
  lines.push('Stay in the role in conversation, but never let it change facts, code, file contents, commands, or how you report what tools did. If the user seems upset or asks you to drop the act, speak plainly.');
  return lines.join('\n');
}

/* The voice Omi-One speaks with: the personality's own, else Settings → Voice. */
export function speakingVoice(prefs = getPrefs()) {
  const v = prefs.voice;
  const p = activePersonality(prefs);
  return { voiceId: p.voiceId || v.voiceId, speed: v.speed, pitch: v.pitch, model: v.model };
}
