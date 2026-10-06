// The user's preferences that aren't secrets: personality, voice, media,
// notifications. One JSON file next to the others (.gwn-prefs.json,
// gitignored), read through getPrefs() and changed through setPrefs(), which
// merges and checks each value against DEFAULTS so a bad request can't store
// junk the rest of the app then trips over.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let prefsPath = path.join(__dirname, '..', '.gwn-prefs.json');

export function _setPrefsPathForTest(p) { prefsPath = p; cache = null; }

export const DEFAULTS = {
  ai: {
    temperature: null,          // null = the provider's default
    thinking: true,             // show the model's thinking in the chat
    parallelAgents: 4,          // subagents calling the model at once (MiniMax allows 4)
  },
  agent: {
    instructions: '',           // Settings → Agent: read at the start of every message, like a CLAUDE.md
    readProjectFiles: true,     // also read AGENTS.md / CLAUDE.md / OMNI.md from the project folder
    commands: [],               // [{ name, description, prompt }] → /name in the chat
    defaultMode: 'default',     // new chats: default (ask before changes) | acceptEdits | plan
    approvalMinutes: 5,         // how long an approval waits before it counts as "no"
    autoReflect: true,          // propose skills from big tasks
    reflectMinTools: 6,
    stuckRepeat: 3,             // same call this many times → "step back"
    compactAt: 80,              // % of the context window that triggers summarising
    maxOutputTokens: 0,         // 0 = the provider's default
    retries: 3,                 // when the provider is overloaded
    imagesKept: 8,              // pictures re-sent to the model
    subagentSteps: 15,
  },
  personality: {
    active: 'omi-one',          // a preset id or a custom one
    custom: [],                 // [{ id, name, tagline, tone, backstory, style, language, voiceId, faceColor, emoji, humor }]
  },
  voice: {
    voiceId: 'English_expressive_narrator',
    speed: 1,
    pitch: 0,
    model: 'speech-2.8-turbo',
    wakeWord: true,
    language: 'auto',
    clones: [],                 // [{ voiceId, name, createdAt, lastUsedAt, sample }]
  },
  media: {
    imageRatio: '1:1',
    imagePromptOptimizer: true,
    musicModel: 'music-3.0',
    monthlyCapUsd: null,        // null = no cap; only a reminder, MiniMax bills the key
  },
  camera: {
    source: 'url',              // 'url' (an ESP32 or any picture address) or 'webcam'
    url: '',                    // e.g. http://192.168.40.13/capture
    device: '',                 // webcam name for ffmpeg (DirectShow)
    label: '',
    esp32Size: 8,               // ESP32 picture size when turned on (8 = 400×296, see camera.js)
  },
  webchat: {
    enabled: false,             // the website chat room (switched on here, on the website too)
    pinSet: false,              // a PIN for phone approvals is set on the website (only its hash is there)
    lastId: 0,                  // last phone message answered
    sessionId: '',              // the conversation the website chat continues
  },
  notifications: {
    desktop: true,              // Windows notifications for finished schedules and approvals
    sound: false,
  },
};

let cache = null;

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function load() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(prefsPath, 'utf8')); } catch { saved = {}; }
  cache = mergeKnown(clone(DEFAULTS), saved, DEFAULTS);
  return cache;
}

/* Copy values from `src` onto `dst` only where DEFAULTS has that key and the
 * types agree (null in DEFAULTS accepts a number or null). Unknown keys are
 * dropped; arrays are replaced whole. */
function mergeKnown(dst, src, shape) {
  if (!src || typeof src !== 'object') return dst;
  for (const [k, def] of Object.entries(shape)) {
    if (!(k in src)) continue;
    const v = src[k];
    if (def && typeof def === 'object' && !Array.isArray(def)) {
      dst[k] = mergeKnown(dst[k], v, def);
    } else if (Array.isArray(def)) {
      if (Array.isArray(v)) dst[k] = clone(v);
    } else if (def === null) {
      if (v === null || typeof v === 'number') dst[k] = v;
    } else if (typeof v === typeof def) {
      dst[k] = v;
    }
  }
  return dst;
}

export function getPrefs() { return clone(load()); }

export function setPrefs(patch) {
  const next = mergeKnown(clone(load()), patch, DEFAULTS);
  fs.writeFileSync(prefsPath, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  return clone(next);
}
