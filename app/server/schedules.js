// Scheduled tasks: "every weekday at 8, summarise the news on X".
//
// Each task runs as its own conversation in autonomous mode, the heartbeat's
// mode: reads, web searches and checkpointed edits run; commands and paid
// calls are refused and land in the inbox as proposals, because nobody is
// there to approve them. Results go to the run history, the chat windows
// (live channel) and a Windows notification.
//
// Tasks run only while OmniOne is running. A run missed by less than 12 hours
// (the PC was asleep at 8:00) runs when OmniOne is back; older ones are
// recorded as missed.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { providerById } from './providers.js';
import { getActiveSettings, getProviderKey, resolveModel } from './secrets.js';
import { createSession, acquireSessionRun, releaseSessionRun, anySessionBusy } from './sessions.js';
import { setMode } from './permissions.js';
import { getWorkspaceRoot } from './workspace.js';
import { notify } from './notify.js';
import { publishLive } from './live.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let storePath = path.join(__dirname, '..', '.gwn-schedules.json');
export function _setSchedulesPathForTest(p) { storePath = p; data = null; }

export const KINDS = ['once', 'daily', 'weekdays', 'weekly', 'monthly', 'interval'];
const TICK_MS = 30_000;
const CATCH_UP_MS = 12 * 3_600_000;
const BUSY_WAIT_MS = 10 * 60_000;   // let the user's own run finish first, up to this long
const MAX_RUNS_KEPT = 200;
export const DEFAULT_MAX_TURNS = 30;

let data = null;
let timer = null;
let running = null;   // id of the task running now

function load() {
  if (data) return data;
  try { data = JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch { data = null; }
  if (!data || !Array.isArray(data.tasks)) data = { tasks: [], runs: [] };
  if (!Array.isArray(data.runs)) data.runs = [];
  return data;
}
function save() {
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// --- when ---------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return [+m[1], +m[2]];
}

/* Check and normalise a schedule. Throws with a message a person can act on. */
export function normalizeSchedule(s = {}) {
  const kind = s.kind;
  if (!KINDS.includes(kind)) throw new Error(`Schedule kind must be one of: ${KINDS.join(', ')}.`);
  if (kind === 'once') {
    const at = new Date(s.at);
    if (Number.isNaN(at.getTime())) throw new Error('A one-time task needs a date and time ("at").');
    return { kind, at: at.toISOString() };
  }
  if (kind === 'interval') {
    const everyMin = Math.round(Number(s.everyMin));
    if (!(everyMin >= 15)) throw new Error('An interval must be 15 minutes or more.');
    return { kind, everyMin };
  }
  const t = parseTime(s.time);
  if (!t) throw new Error('Give a time of day as HH:MM, for example 08:00.');
  const out = { kind, time: `${pad(t[0])}:${pad(t[1])}` };
  if (kind === 'weekly') {
    const weekday = Number(s.weekday);
    if (!(weekday >= 0 && weekday <= 6)) throw new Error('A weekly task needs a weekday, 0 (Sunday) to 6 (Saturday).');
    out.weekday = weekday;
  }
  if (kind === 'monthly') {
    const day = Number(s.day);
    if (!(day >= 1 && day <= 31)) throw new Error('A monthly task needs a day of the month, 1 to 31.');
    out.day = day;
  }
  return out;
}

/* The next time a schedule fires strictly after `from` (ms), in local time.
 * null when a one-time task is in the past. A monthly day past the end of a
 * short month runs on that month's last day. */
export function nextRun(schedule, from = Date.now()) {
  const s = schedule;
  if (s.kind === 'once') {
    const t = new Date(s.at).getTime();
    return t > from ? t : null;
  }
  if (s.kind === 'interval') return from + s.everyMin * 60_000;
  const [h, m] = parseTime(s.time);
  const base = new Date(from);
  for (let i = 0; i <= 62; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, h, m, 0, 0);
    if (s.kind === 'monthly') {
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      if (d.getDate() !== Math.min(s.day, last)) continue;
    }
    if (d.getTime() <= from) continue;
    const wd = d.getDay();
    if (s.kind === 'weekdays' && (wd === 0 || wd === 6)) continue;
    if (s.kind === 'weekly' && wd !== s.weekday) continue;
    return d.getTime();
  }
  return null;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function describeSchedule(s) {
  switch (s.kind) {
    case 'once': return `once, ${new Date(s.at).toLocaleString()}`;
    case 'daily': return `every day at ${s.time}`;
    case 'weekdays': return `weekdays at ${s.time}`;
    case 'weekly': return `every ${DAYS[s.weekday]} at ${s.time}`;
    case 'monthly': return `on day ${s.day} of each month at ${s.time}`;
    case 'interval': return `every ${s.everyMin >= 60 && s.everyMin % 60 === 0 ? `${s.everyMin / 60} h` : `${s.everyMin} min`}`;
    default: return s.kind;
  }
}

// --- the list -------------------------------------------------------------------

function view(t) {
  return { ...t, when: describeSchedule(t.schedule), running: running === t.id };
}

export function listSchedules() {
  const d = load();
  return { tasks: d.tasks.map(view), runs: d.runs.slice(-50).reverse(), running };
}

export function getSchedule(id) {
  const t = load().tasks.find((x) => x.id === id);
  return t ? view(t) : null;
}

export function addSchedule({ title, prompt, schedule, maxTurns, enabled = true }, now = Date.now()) {
  const p = String(prompt || '').trim();
  if (!p) throw new Error('Say what Omi-One should do (prompt).');
  if (p.length > 4000) throw new Error('The prompt is over 4000 characters.');
  const sched = normalizeSchedule(schedule);
  const next = nextRun(sched, now);
  if (next == null) throw new Error('That time is already in the past.');
  const task = {
    id: crypto.randomBytes(6).toString('hex'),
    title: String(title || p).replace(/\s+/g, ' ').slice(0, 80),
    prompt: p,
    schedule: sched,
    maxTurns: Math.max(3, Math.min(100, Math.round(Number(maxTurns)) || DEFAULT_MAX_TURNS)),
    enabled: Boolean(enabled),
    createdAt: now,
    lastRunAt: null,
    nextRunAt: next,
  };
  const d = load();
  d.tasks.push(task);
  save();
  publishLive({ type: 'schedules_changed' }, 'schedules');
  return view(task);
}

export function updateSchedule(id, patch, now = Date.now()) {
  const d = load();
  const t = d.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`No scheduled task ${id}.`);
  if (patch.title != null) t.title = String(patch.title).slice(0, 80);
  if (patch.prompt != null) {
    const p = String(patch.prompt).trim();
    if (!p) throw new Error('The prompt can\'t be empty.');
    t.prompt = p.slice(0, 4000);
  }
  if (patch.maxTurns != null) t.maxTurns = Math.max(3, Math.min(100, Math.round(Number(patch.maxTurns)) || DEFAULT_MAX_TURNS));
  if (patch.schedule) t.schedule = normalizeSchedule(patch.schedule);
  if (patch.enabled != null) t.enabled = Boolean(patch.enabled);
  if (patch.schedule || patch.enabled) t.nextRunAt = nextRun(t.schedule, now);
  save();
  publishLive({ type: 'schedules_changed' }, 'schedules');
  return view(t);
}

export function removeSchedule(id) {
  const d = load();
  const before = d.tasks.length;
  d.tasks = d.tasks.filter((x) => x.id !== id);
  if (d.tasks.length === before) throw new Error(`No scheduled task ${id}.`);
  save();
  publishLive({ type: 'schedules_changed' }, 'schedules');
  return true;
}

// --- running ----------------------------------------------------------------------

function schedulePrompt(t, now) {
  return `[SCHEDULED TASK "${t.title}" — ${describeSchedule(t.schedule)}. The user set this up earlier; they are not here now.]
It is ${new Date(now).toLocaleString()}.

${t.prompt}

Nobody can approve anything during this run: commands and paid calls will be refused, so propose_task anything that needs them. Finish with a short, plain summary of what you found or did, written for the user to read later. That summary is what they will see in the notification and the run history.`;
}

/* Run one task now (also used by "Run now"). Never throws. */
export async function runSchedule(id, { reason = 'timer', runner } = {}) {
  const d = load();
  const t = d.tasks.find((x) => x.id === id);
  if (!t) return { error: `No scheduled task ${id}.` };
  if (running) return { skipped: `another task (${running}) is running` };

  const active = getActiveSettings();
  const provider = providerById(active.provider);
  const fail = (error) => {
    const run = { id: crypto.randomBytes(5).toString('hex'), taskId: t.id, title: t.title, startedAt: Date.now(), endedAt: Date.now(), ok: false, error, reason };
    d.runs.push(run);
    d.runs = d.runs.slice(-MAX_RUNS_KEPT);
    save();
    notify(`Scheduled task didn't run: ${t.title}`, error);
    publishLive({ type: 'schedule_run', run }, 'schedules');
    return run;
  };
  if (!provider || provider.apiStyle === 'stub') return fail('No AI provider with a key is selected (Settings → AI).');
  const apiKey = getProviderKey(provider.id);
  if (!apiKey) return fail(`No API key for ${provider.label}.`);
  const model = resolveModel(provider.id, provider.defaultModel);

  running = t.id;
  const started = Date.now();
  const sessionId = createSession({ title: `⏰ ${t.title}`, provider: provider.id, model, workspaceRoot: getWorkspaceRoot(), sessionKind: 'schedule' });
  acquireSessionRun(sessionId);
  setMode(sessionId, 'autonomous');
  publishLive({ type: 'schedule_start', taskId: t.id, title: t.title, sessionId }, 'schedules');

  let finalText = '';
  let error = null;
  let tokens = 0;
  let toolCalls = 0;
  try {
    const run = runner || (await import('./agent.js')).runAgent;
    for await (const ev of run({ sessionId, prompt: schedulePrompt(t, started), provider, model, apiKey, maxIterations: t.maxTurns, kind: 'heartbeat' })) {
      if (ev.type === 'usage') tokens += (ev.usage?.inputTokens || 0) + (ev.usage?.outputTokens || 0);
      else if (ev.type === 'tool_result') toolCalls += 1;
      else if (ev.type === 'done') finalText = ev.text || '';
      else if (ev.type === 'error') error = ev.message;
    }
  } catch (e) {
    error = e?.message || String(e);
  } finally {
    releaseSessionRun(sessionId);
    running = null;
  }

  const summary = (finalText.trim() || (error ? '' : 'Finished without a summary.')).slice(0, 4000);
  const record = {
    id: crypto.randomBytes(5).toString('hex'),
    taskId: t.id, title: t.title, sessionId, reason,
    startedAt: started, endedAt: Date.now(),
    ok: !error, error, summary, tokens, toolCalls,
  };
  const fresh = load();
  fresh.runs.push(record);
  fresh.runs = fresh.runs.slice(-MAX_RUNS_KEPT);
  const task = fresh.tasks.find((x) => x.id === t.id);
  if (task) task.lastRunAt = started;
  save();
  notify(error ? `Scheduled task failed: ${t.title}` : `Done: ${t.title}`, error || summary);
  publishLive({ type: 'schedule_run', run: record }, 'schedules');
  return record;
}

/* One pass of the clock: run whatever is due, one task at a time. */
export async function tick(now = Date.now(), opts = {}) {
  const d = load();
  const due = d.tasks
    .filter((t) => t.enabled && t.nextRunAt != null && t.nextRunAt <= now)
    .sort((a, b) => a.nextRunAt - b.nextRunAt);
  const results = [];
  for (const t of due) {
    if (running) break;
    const late = now - t.nextRunAt;
    if (late > CATCH_UP_MS) {
      d.runs.push({ id: crypto.randomBytes(5).toString('hex'), taskId: t.id, title: t.title, startedAt: t.nextRunAt, endedAt: t.nextRunAt, ok: false, missed: true, error: 'Missed: OmniOne was not running.' });
      advance(t, now);
      save();
      continue;
    }
    // The user is in the middle of something: give them a few minutes.
    if (anySessionBusy() && late < BUSY_WAIT_MS && !opts.ignoreBusy) continue;
    advance(t, now);
    save();
    results.push(await runSchedule(t.id, { reason: late > TICK_MS * 2 ? 'catch-up' : 'timer', runner: opts.runner }));
  }
  return results;
}

function advance(t, now) {
  t.nextRunAt = nextRun(t.schedule, now);
  if (t.nextRunAt == null) t.enabled = false; // a one-time task that has run
}

export function startSchedules() {
  if (timer || process.env.GWN_SCHEDULES === '0') return false;
  timer = setInterval(() => { tick().catch((e) => console.error('[omnione] schedules:', e.message)); }, TICK_MS);
  timer.unref?.();
  return true;
}

export function stopSchedules() {
  if (timer) clearInterval(timer);
  timer = null;
}
