// Usage statistics, kept on this machine.
//
// Everything the Stats page shows: tokens in and out per model, what the
// heartbeat spent on its own time, tool calls and failures, requests,
// sessions, approvals, errors, and how Omi-One's mood moved. Numbers only —
// never message content.
//
// One small JSON file of daily buckets (.gwn-stats.json), 120 days deep.
// Writes are batched: the loop records on every model turn and tool call,
// and rewriting a file each time would be wasted work.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let statsPath = path.join(path.resolve(__dirname, '..'), '.gwn-stats.json');

const KEEP_DAYS = 120;
const FLUSH_MS = 2000;
const MOOD_SAMPLES_PER_DAY = 96;

let data = null;
let flushTimer = null;

/* Tests point this at a temp file. */
export function _setStatsPathForTest(p) {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  statsPath = p;
  data = null;
}

function load() {
  if (data) return data;
  try {
    data = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    if (!data || typeof data !== 'object' || !data.days) data = { days: {} };
  } catch {
    data = { days: {} };
  }
  return data;
}

export function flushStats() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!data) return;
  try {
    const tmp = statsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, statsPath);
  } catch { /* stats must never break a run */ }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushStats(); }, FLUSH_MS);
  flushTimer.unref?.();
}

export function dayKey(t = Date.now()) {
  return new Date(t).toISOString().slice(0, 10);
}

function emptyDay() {
  return {
    tokens: { in: 0, out: 0, cacheRead: 0 },
    requests: 0,
    byModel: {},               // "provider/model" → { in, out, requests, heartbeat }
    heartbeat: { tokens: 0, beats: 0 },
    tools: {},                 // name → { calls, errors, ms }
    sessions: [],              // ids seen today (deduped, capped)
    errors: 0,
    approvals: { asked: 0, approved: 0, denied: 0 },
    mood: [],                  // [epochSeconds, valence, energy]
  };
}

function today(t) {
  const d = load();
  const k = dayKey(t);
  if (!d.days[k]) {
    d.days[k] = emptyDay();
    prune(d);
  }
  return d.days[k];
}

function prune(d) {
  const keys = Object.keys(d.days).sort();
  while (keys.length > KEEP_DAYS) delete d.days[keys.shift()];
}

const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);

/**
 * One model call's token usage.
 * @param {{provider: string, model: string, usage: object, kind?: 'chat'|'heartbeat'|'subagent'}} e
 */
export function recordUsage({ provider, model, usage, kind = 'chat' }, t) {
  if (!usage) return;
  const d = today(t);
  const inT = n(usage.inputTokens);
  const outT = n(usage.outputTokens);
  d.tokens.in += inT;
  d.tokens.out += outT;
  d.tokens.cacheRead += n(usage.cacheReadTokens);
  d.requests += 1;
  const key = `${provider || 'unknown'}/${model || 'unknown'}`;
  const m = d.byModel[key] || (d.byModel[key] = { in: 0, out: 0, requests: 0, heartbeat: 0 });
  m.in += inT;
  m.out += outT;
  m.requests += 1;
  if (kind === 'heartbeat') {
    d.heartbeat.tokens += inT + outT;
    m.heartbeat += inT + outT;
  }
  scheduleFlush();
}

export function recordHeartbeat(t) {
  today(t).heartbeat.beats += 1;
  scheduleFlush();
}

export function recordTool({ name, ok, ms }, t) {
  if (!name) return;
  const d = today(t);
  const tl = d.tools[name] || (d.tools[name] = { calls: 0, errors: 0, ms: 0 });
  tl.calls += 1;
  if (!ok) tl.errors += 1;
  tl.ms += n(ms);
  scheduleFlush();
}

export function recordSession(id, t) {
  if (!id) return;
  const d = today(t);
  if (!d.sessions.includes(id) && d.sessions.length < 500) d.sessions.push(id);
  scheduleFlush();
}

export function recordError(t) {
  today(t).errors += 1;
  scheduleFlush();
}

export function recordApproval(approved, t) {
  const a = today(t).approvals;
  a.asked += 1;
  if (approved) a.approved += 1; else a.denied += 1;
  scheduleFlush();
}

/* Mood is sampled at most every 15 minutes, which is plenty for a chart. */
export function recordMood(mood, t = Date.now()) {
  if (!mood || typeof mood.valence !== 'number') return;
  const d = today(t);
  const last = d.mood.at(-1);
  const sec = Math.floor(t / 1000);
  if (last && sec - last[0] < 900) return;
  d.mood.push([sec, +mood.valence.toFixed(3), +Number(mood.energy ?? 0).toFixed(3)]);
  if (d.mood.length > MOOD_SAMPLES_PER_DAY) d.mood.shift();
  scheduleFlush();
}

/**
 * Everything the Stats page needs for the last `days` days: one entry per
 * day (zero-filled, oldest first) plus totals and per-model / per-tool tables.
 */
export function getStats({ days = 30, now = Date.now() } = {}) {
  const d = load();
  days = Math.max(1, Math.min(KEEP_DAYS, Math.round(days)));
  const series = [];
  const totals = { in: 0, out: 0, cacheRead: 0, requests: 0, heartbeatTokens: 0, beats: 0, toolCalls: 0, toolErrors: 0, sessions: 0, errors: 0, asked: 0, approved: 0, denied: 0 };
  const models = {};
  const tools = {};
  const mood = [];

  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(now - i * 86_400_000);
    const day = d.days[k] || emptyDay();
    let toolCalls = 0;
    let toolErrors = 0;
    for (const [name, t] of Object.entries(day.tools)) {
      toolCalls += t.calls;
      toolErrors += t.errors;
      const agg = tools[name] || (tools[name] = { calls: 0, errors: 0, ms: 0 });
      agg.calls += t.calls;
      agg.errors += t.errors;
      agg.ms += t.ms;
    }
    for (const [key, m] of Object.entries(day.byModel)) {
      const agg = models[key] || (models[key] = { in: 0, out: 0, requests: 0, heartbeat: 0 });
      agg.in += m.in;
      agg.out += m.out;
      agg.requests += m.requests;
      agg.heartbeat += m.heartbeat;
    }
    // One mood point per day for the long view: the day's average.
    if (day.mood.length) {
      const v = day.mood.reduce((a, s) => a + s[1], 0) / day.mood.length;
      const e = day.mood.reduce((a, s) => a + s[2], 0) / day.mood.length;
      mood.push({ day: k, valence: +v.toFixed(3), energy: +e.toFixed(3) });
    } else {
      mood.push({ day: k, valence: null, energy: null });
    }
    series.push({
      day: k,
      in: day.tokens.in,
      out: day.tokens.out,
      cacheRead: day.tokens.cacheRead,
      requests: day.requests,
      heartbeatTokens: day.heartbeat.tokens,
      beats: day.heartbeat.beats,
      toolCalls,
      toolErrors,
      sessions: day.sessions.length,
      errors: day.errors,
      asked: day.approvals.asked,
      approved: day.approvals.approved,
      denied: day.approvals.denied,
    });
    totals.in += day.tokens.in;
    totals.out += day.tokens.out;
    totals.cacheRead += day.tokens.cacheRead;
    totals.requests += day.requests;
    totals.heartbeatTokens += day.heartbeat.tokens;
    totals.beats += day.heartbeat.beats;
    totals.toolCalls += toolCalls;
    totals.toolErrors += toolErrors;
    totals.sessions += day.sessions.length;
    totals.errors += day.errors;
    totals.asked += day.approvals.asked;
    totals.approved += day.approvals.approved;
    totals.denied += day.approvals.denied;
  }

  return {
    days,
    series,
    totals,
    mood,
    models: Object.entries(models)
      .map(([key, m]) => ({ key, provider: key.split('/')[0], model: key.slice(key.indexOf('/') + 1), ...m }))
      .sort((a, b) => (b.in + b.out) - (a.in + a.out)),
    tools: Object.entries(tools)
      .map(([name, t]) => ({ name, ...t, avgMs: t.calls ? Math.round(t.ms / t.calls) : 0 }))
      .sort((a, b) => b.calls - a.calls),
  };
}

/* Per-day, per-model rows in the shape the cloud API's usage endpoint takes. */
export function usageEntries({ days = 2, now = Date.now() } = {}) {
  const d = load();
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(now - i * 86_400_000);
    const day = d.days[k];
    if (!day) continue;
    for (const [key, m] of Object.entries(day.byModel)) {
      const provider = key.split('/')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40) || 'unknown';
      out.push({
        day: k,
        provider,
        model: key.slice(key.indexOf('/') + 1).slice(0, 80) || 'unknown',
        input_tokens: m.in,
        output_tokens: m.out,
        heartbeat_tokens: m.heartbeat,
        requests: m.requests,
      });
    }
  }
  return out;
}
