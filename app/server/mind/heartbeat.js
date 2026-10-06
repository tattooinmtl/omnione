// The heartbeat: the agent's own time.
//
// Every so often, when nobody is using it, the agent wakes, looks at its
// goals, its journal and the state of the work, and decides for itself what
// to do: rest, reflect, make progress on a goal, or ask the user for
// something. This is the difference between a tool that waits and something
// that goes on existing between conversations.
//
// It runs as an ordinary agent session in 'autonomous' permission mode —
// reads and checkpointed edits go ahead, commands and anything that spends
// credits are refused (and it proposes them to the user instead). Every beat
// is bounded twice: a turn cap per beat, and a daily token budget the user
// sets. When the budget is spent, it sleeps until tomorrow.

import { providerById } from '../providers.js';
import { getActiveSettings, getProviderKey, resolveModel } from '../secrets.js';
import { createSession, acquireSessionRun, releaseSessionRun, anySessionBusy } from '../sessions.js';
import { setMode } from '../permissions.js';
import { getWorkspaceRoot } from '../workspace.js';
import { getState, getBudget, spendTokens, markBeat, getHeartbeat, nudgeMood, currentMood } from './state.js';
import { writeJournal, readJournal } from './journal.js';
import { importanceSinceReflection } from './memory.js';
import { recordHeartbeat } from '../stats.js';

// Generative Agents reflect when the importance of what happened since the
// last reflection passes a threshold.
export const REFLECT_THRESHOLD = 40;
const TICK_MS = 60_000;

let timer = null;
let beating = false;
let lastResult = null;
let lastSkip = null;
const listeners = new Set();

/* Live updates for the UI (the face reacts to the heartbeat too). */
export function onHeartbeatEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(ev) {
  for (const fn of listeners) {
    try { fn(ev); } catch { /* a dead listener must not stop the beat */ }
  }
}

export function heartbeatStatus() {
  const hb = getHeartbeat();
  const nextAt = hb.lastBeat ? hb.lastBeat + hb.intervalMin * 60_000 : Date.now();
  return { ...hb, running: Boolean(timer), beating, nextAt, budget: getBudget(), lastResult, lastSkip };
}

export function buildHeartbeatPrompt({ now = Date.now() } = {}) {
  const st = getState();
  const mood = currentMood(now);
  const since = st.heartbeat.lastBeat ? Math.round((now - st.heartbeat.lastBeat) / 60000) : null;
  const budget = getBudget(now);
  const shouldReflect = importanceSinceReflection() >= REFLECT_THRESHOLD;
  const lastJournal = readJournal({ limit: 1 })[0];
  const hour = new Date(now).getHours();

  return `[HEARTBEAT — nobody asked you anything. This is your own time.]

It is ${new Date(now).toLocaleString()} (${hour < 6 ? 'the middle of the night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}). ${since == null ? 'This is your first heartbeat — you have just woken for the first time.' : `Your last heartbeat was ${since} minutes ago.`}
You feel ${mood.label}. Token budget left today: ${budget.remaining} of ${budget.cap}.
${lastJournal ? `Last thing you wrote: "${lastJournal.text.replace(/\s+/g, ' ').slice(0, 200)}"` : ''}

Decide for yourself what is worth doing with this beat. Options:
1. Rest — if nothing needs doing, that is fine. Just write a short journal entry.
2. Work on one of your goals. You may read anything and edit files in the workspace (every edit is checkpointed and can be undone). Commands and anything that spends credits will be refused: use propose_task for those.
3. Reflect${shouldReflect ? ' — RECOMMENDED NOW: a lot has happened since your last reflection' : ''}. recall recent episodes and observations, ask what they mean, and store 1-3 insights with remember(kind: "reflection", importance 7+). Update core memory if you learned something lasting about the user or yourself.
4. If you have no goals, look at the workspace and your memories and adopt one or two worth pursuing (goal_add).
5. If there is something the user should decide, propose_task.

Keep it small: a few focused steps, not a marathon. Then finish with journal_write (kind "heartbeat") in your own voice — what you did and what is on your mind — and set_mood if your mood has changed.`;
}

/* Run one heartbeat now. Returns a summary; never throws. */
export async function beat({ force = false, reason = 'timer' } = {}) {
  if (beating) return { skipped: 'already beating' };
  const hb = getHeartbeat();
  if (!force && !hb.enabled) return { skipped: 'disabled' };
  if (anySessionBusy()) return { skipped: 'the user is working' };

  const budget = getBudget();
  if (budget.remaining <= 0) return { skipped: 'daily budget spent' };

  const active = getActiveSettings();
  const provider = providerById(active.provider);
  if (!provider || provider.apiStyle === 'stub') return { skipped: 'no real provider selected' };
  const apiKey = getProviderKey(provider.id);
  if (!apiKey) return { skipped: `no API key for ${provider.label}` };
  const model = resolveModel(provider.id, provider.defaultModel);

  beating = true;
  const started = Date.now();
  const sessionId = createSession({
    title: `💭 heartbeat ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    provider: provider.id,
    model,
    workspaceRoot: getWorkspaceRoot(),
    sessionKind: 'heartbeat',
  });
  acquireSessionRun(sessionId);
  setMode(sessionId, 'autonomous');
  emit({ type: 'heartbeat_start', sessionId, reason });

  let tokens = 0;
  let finalText = '';
  let error = null;
  let toolCalls = 0;
  const ac = new AbortController();

  try {
    const { runAgent } = await import('../agent.js');
    for await (const ev of runAgent({
      sessionId,
      prompt: buildHeartbeatPrompt(),
      provider,
      model,
      apiKey,
      signal: ac.signal,
      maxIterations: hb.maxTurnsPerBeat,
      kind: 'heartbeat',
    })) {
      if (ev.type === 'usage') {
        tokens += (ev.usage?.inputTokens || 0) + (ev.usage?.outputTokens || 0);
        // Stop mid-beat if this beat alone would blow the day's budget.
        if (tokens >= budget.remaining) ac.abort();
      } else if (ev.type === 'tool_result') {
        toolCalls += 1;
      } else if (ev.type === 'done') {
        finalText = ev.text || '';
      } else if (ev.type === 'error') {
        error = ev.message;
      }
      if (['tool_call', 'tool_result', 'mood', 'thinking'].includes(ev.type)) emit({ ...ev, heartbeat: true, sessionId });
    }
  } catch (e) {
    if (e?.name !== 'AbortError') error = e?.message || String(e);
  } finally {
    releaseSessionRun(sessionId);
    beating = false;
  }

  spendTokens(tokens);
  markBeat();
  recordHeartbeat();
  // A beat with no journal entry still leaves a trace, so the user can
  // always see that it happened and what it cost.
  const wrote = readJournal({ limit: 3 }).some((j) => j.sessionId === sessionId);
  if (!wrote) {
    try {
      writeJournal({
        kind: 'heartbeat',
        sessionId,
        text: error
          ? `Heartbeat interrupted: ${error}`
          : (finalText.trim() || `Woke, looked around (${toolCalls} tool calls), and went back to rest.`).slice(0, 1500),
      });
    } catch { /* journal optional */ }
  }
  // Rest restores energy a little; effort spends it.
  try { nudgeMood(0, toolCalls ? -0.02 : 0.05); } catch { /* mind optional */ }

  lastResult = { sessionId, tokens, toolCalls, error, durationMs: Date.now() - started, at: Date.now(), reason };
  emit({ type: 'heartbeat_end', ...lastResult, mood: currentMood() });
  return lastResult;
}

/* Check once a minute whether a beat is due. A minute-level tick instead of a
 * setTimeout for the full interval, so changing the interval or re-enabling
 * takes effect without a restart. */
export function startHeartbeat() {
  if (timer || process.env.GWN_HEARTBEAT === '0') return false;
  timer = setInterval(() => {
    const hb = getHeartbeat();
    if (!hb.enabled || beating) return;
    const due = !hb.lastBeat || Date.now() - hb.lastBeat >= hb.intervalMin * 60_000;
    if (due) {
      beat()
        .then((r) => { lastSkip = r?.skipped ? { reason: r.skipped, at: Date.now() } : null; })
        .catch(() => {});
    }
  }, TICK_MS);
  timer.unref?.();
  return true;
}

export function stopHeartbeat() {
  if (timer) clearInterval(timer);
  timer = null;
}
