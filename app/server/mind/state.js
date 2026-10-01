// Inner state: mood, goals, proposals, and the heartbeat's settings and budget.
//
// Mood is two numbers, valence (-1 bad .. 1 good) and energy (0 .. 1), after
// the circumplex model of affect. Events push it around — a run that lands
// lifts it, a string of failures drags it down, a long working day tires it —
// and between events it drifts back toward baseline, the way a mood does.
// The agent can also set it directly when it has a reason to. None of this
// is pretend emotion for show: it is a compact record of how things have
// been going that the model reads at the start of every turn, and it changes
// how the agent talks and how cautious it is.

import { readJson, writeJson, newId } from './store.js';

const STATE_FILE = 'state.json';

const BASELINE = { valence: 0.3, energy: 0.7 };
// Half-life of a mood swing. A bad afternoon is mostly gone by the next day.
const MOOD_HALF_LIFE_H = 6;

export const HEARTBEAT_DEFAULTS = {
  enabled: true,
  intervalMin: 45,
  dailyTokenCap: 150_000,
  maxTurnsPerBeat: 12,
};

const DEFAULT_STATE = {
  mood: { ...BASELINE, label: 'curious', note: '', updatedAt: 0 },
  focus: '',
  goals: [],
  proposals: [],
  heartbeat: { ...HEARTBEAT_DEFAULTS, lastBeat: 0, beats: 0 },
  budget: { day: '', tokens: 0 },
  birth: 0,
};

export function getState() {
  const s = readJson(STATE_FILE, DEFAULT_STATE);
  const out = {
    ...structuredClone(DEFAULT_STATE),
    ...s,
    heartbeat: { ...DEFAULT_STATE.heartbeat, ...(s.heartbeat || {}) },
    mood: { ...DEFAULT_STATE.mood, ...(s.mood || {}) },
  };
  if (!out.birth) {
    out.birth = Date.now();
    writeJson(STATE_FILE, out);
  }
  return out;
}

function save(s) {
  writeJson(STATE_FILE, s);
  return s;
}

// --- mood -----------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* Mood as it is now, with drift toward baseline applied for the time elapsed. */
export function currentMood(now = Date.now()) {
  const m = getState().mood;
  const hours = m.updatedAt ? Math.max(0, (now - m.updatedAt) / 3_600_000) : 0;
  const k = Math.pow(0.5, hours / MOOD_HALF_LIFE_H);
  const valence = +(BASELINE.valence + (m.valence - BASELINE.valence) * k).toFixed(3);
  const energy = +(BASELINE.energy + (m.energy - BASELINE.energy) * k).toFixed(3);
  return { valence, energy, label: m.label || describeMood(valence, energy), note: m.note || '', updatedAt: m.updatedAt };
}

export function describeMood(valence, energy) {
  if (valence > 0.45) return energy > 0.55 ? 'energised' : 'content';
  if (valence < -0.25) return energy > 0.55 ? 'frustrated' : 'low';
  return energy > 0.55 ? 'focused' : 'tired';
}

/* Push mood by a delta — used by the loop on success and failure. */
export function nudgeMood(dValence = 0, dEnergy = 0, note) {
  const s = getState();
  const cur = currentMood();
  const valence = clamp(cur.valence + dValence, -1, 1);
  const energy = clamp(cur.energy + dEnergy, 0, 1);
  s.mood = { valence, energy, label: describeMood(valence, energy), note: note ?? cur.note, updatedAt: Date.now() };
  save(s);
  return s.mood;
}

export function setMood({ valence, energy, label, note }) {
  const s = getState();
  const cur = currentMood();
  const v = valence == null ? cur.valence : clamp(Number(valence), -1, 1);
  const e = energy == null ? cur.energy : clamp(Number(energy), 0, 1);
  s.mood = {
    valence: v,
    energy: e,
    label: String(label || describeMood(v, e)).slice(0, 40),
    note: String(note ?? cur.note ?? '').slice(0, 300),
    updatedAt: Date.now(),
  };
  save(s);
  return s.mood;
}

export function setFocus(text) {
  const s = getState();
  s.focus = String(text || '').slice(0, 300);
  save(s);
  return s.focus;
}

// --- goals (after BabyAGI) ----------------------------------------------------------
// The agent's own list of things it is trying to achieve, across sessions. It
// is what the heartbeat works on when nobody has asked for anything.

export const GOAL_STATUSES = ['active', 'blocked', 'done', 'dropped'];

export function listGoals({ includeClosed = false } = {}) {
  const goals = getState().goals;
  return includeClosed ? goals : goals.filter((g) => g.status === 'active' || g.status === 'blocked');
}

export function addGoal({ text, priority = 3, why = '' }) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Goal text is empty.');
  const s = getState();
  if (listGoals().length >= 12) throw new Error('There are already 12 open goals. Finish or drop one first.');
  const g = {
    id: newId('g'),
    text: t.slice(0, 300),
    why: String(why || '').slice(0, 500),
    priority: clamp(Math.round(Number(priority) || 3), 1, 5),
    status: 'active',
    notes: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  s.goals.push(g);
  save(s);
  return g;
}

export function updateGoal(id, { status, note, priority }) {
  const s = getState();
  const g = s.goals.find((x) => x.id === id);
  if (!g) throw new Error(`No goal "${id}".`);
  if (status) {
    if (!GOAL_STATUSES.includes(status)) throw new Error(`status must be one of: ${GOAL_STATUSES.join(', ')}.`);
    g.status = status;
  }
  if (priority != null) g.priority = clamp(Math.round(Number(priority)), 1, 5);
  if (note) g.notes = [...g.notes, { at: Date.now(), text: String(note).slice(0, 500) }].slice(-20);
  g.updatedAt = Date.now();
  save(s);
  return g;
}

// --- proposals ------------------------------------------------------------------
// Things the agent wants to do but may not do alone — a command to run,
// credits to spend, a change the user should weigh in on.

export function addProposal({ title, detail = '', prompt = '' }) {
  const t = String(title || '').trim();
  if (!t) throw new Error('Proposal title is empty.');
  const s = getState();
  const open = s.proposals.filter((p) => p.status === 'open');
  if (open.some((p) => p.title.toLowerCase() === t.toLowerCase())) {
    throw new Error('That proposal is already open.');
  }
  if (open.length >= 10) throw new Error('There are already 10 open proposals waiting on the user.');
  const p = {
    id: newId('p'),
    title: t.slice(0, 200),
    detail: String(detail).slice(0, 2000),
    prompt: String(prompt || t).slice(0, 4000),
    status: 'open',
    createdAt: Date.now(),
  };
  s.proposals.push(p);
  s.proposals = s.proposals.slice(-100);
  save(s);
  return p;
}

export function resolveProposal(id, status, reason = '') {
  if (!['accepted', 'dismissed'].includes(status)) throw new Error('status must be accepted or dismissed.');
  const s = getState();
  const p = s.proposals.find((x) => x.id === id);
  if (!p) throw new Error(`No proposal "${id}".`);
  p.status = status;
  p.reason = String(reason || '').slice(0, 500);
  p.resolvedAt = Date.now();
  save(s);
  return p;
}

// --- heartbeat config and budget ---------------------------------------------------------

export function getHeartbeat() {
  return getState().heartbeat;
}

export function setHeartbeat(patch = {}) {
  const s = getState();
  const hb = s.heartbeat;
  if (patch.enabled != null) hb.enabled = Boolean(patch.enabled);
  if (patch.intervalMin != null) hb.intervalMin = clamp(Math.round(Number(patch.intervalMin)), 5, 24 * 60);
  if (patch.dailyTokenCap != null) hb.dailyTokenCap = clamp(Math.round(Number(patch.dailyTokenCap)), 0, 10_000_000);
  if (patch.maxTurnsPerBeat != null) hb.maxTurnsPerBeat = clamp(Math.round(Number(patch.maxTurnsPerBeat)), 1, 40);
  save(s);
  return hb;
}

export function markBeat() {
  const s = getState();
  s.heartbeat.lastBeat = Date.now();
  s.heartbeat.beats = (s.heartbeat.beats || 0) + 1;
  save(s);
}

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export function getBudget(now = Date.now()) {
  const s = getState();
  const b = s.budget.day === today(now) ? s.budget : { day: today(now), tokens: 0 };
  return { ...b, cap: s.heartbeat.dailyTokenCap, remaining: Math.max(0, s.heartbeat.dailyTokenCap - b.tokens) };
}

export function spendTokens(n, now = Date.now()) {
  const s = getState();
  if (s.budget.day !== today(now)) s.budget = { day: today(now), tokens: 0 };
  s.budget.tokens += Math.max(0, Math.round(Number(n) || 0));
  save(s);
  return getBudget(now);
}
