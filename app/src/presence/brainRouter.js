// The agent's actions, into the brain network, through the emotions the
// engine is feeling at that moment.
//
//   user_prompt / session → the conversation neuron fires (grown if new)
//   tool_call             → brain → felt emotion → tool → skill → conversation,
//                           and the tool (and skill) are held until it returns
//   tool_result           → released
//   done / error          → everything released
//
// Shared by the Presence view and the floating Neural network window. Each
// emotion → action pairing is recorded (POST /api/brain/feel) only by the
// window whose own run it was: events relayed from another window carry an
// `origin`, so two open windows never count the same action twice.

import { emotionColor } from './BrainNetwork.js';

export const SKILL_TOOL_NAMES = new Set(['load_skill', 'load_skill_file']);

/* The emotions it is feeling enough to count: the strongest two above a
 * floor, as the engine holds them right now. */
export function feltNow(engine, floor = 0.15) {
  const em = engine?.core?.state?.emotions || {};
  return Object.entries(em)
    .filter(([, v]) => v >= floor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => k);
}

export function createBrainRouter({ getBrain, getEngine, onCounts, recordHeartbeat = false } = {}) {
  const live = { conv: null, prompt: '', held: new Map() };

  const handle = (ev) => {
    const brain = getBrain();
    if (!brain || !ev) return;
    if (ev.type === 'user_prompt') {
      live.prompt = String(ev.text || '').slice(0, 80);
      if (live.conv) brain.fire(['brain', live.conv]);
    } else if (ev.type === 'session' && ev.sessionId) {
      live.conv = `conv:${ev.sessionId}`;
      if (!brain.has(live.conv)) {
        brain.addConversation(live.conv, live.prompt || 'New conversation');
        if (brain.counts) onCounts?.({ ...brain.counts });
      }
      brain.fire(['brain', live.conv]);
    } else if (ev.type === 'tool_call' && ev.name) {
      const toolId = `tool:${ev.name}`;
      brain.addAction(toolId, 'tool', ev.name.replace(/^mcp__[^_]+__/, ''));
      const skill = SKILL_TOOL_NAMES.has(ev.name) && typeof ev.input?.name === 'string' ? `skill:${ev.input.name}` : null;
      if (skill) brain.addAction(skill, 'skill', ev.input.name);
      const action = skill || toolId;
      const felt = feltNow(getEngine());
      const conv = ev.heartbeat ? null : live.conv;
      for (const e of felt.length ? felt : [null]) {
        brain.fire(['brain', e && `emotion:${e}`, toolId, skill, conv].filter(Boolean), e ? emotionColor(e) : undefined);
      }
      const held = [toolId, skill].filter(Boolean);
      held.forEach((id) => brain.hold(id, true));
      if (ev.id) live.held.set(ev.id, held);
      const ownRun = !ev.origin && (!ev.heartbeat || recordHeartbeat);
      if (ownRun) recordFeel(felt, action);
    } else if (ev.type === 'tool_result') {
      const held = live.held.get(ev.id);
      if (held) { held.forEach((id) => brain.hold(id, false)); live.held.delete(ev.id); }
    } else if (ev.type === 'done' || ev.type === 'error' || ev.type === 'heartbeat_end') {
      brain.releaseAll();
      live.held.clear();
    }
  };

  return { handle, live };
}

/* The pairing is the record: emotion → action, kept across sessions. */
export function recordFeel(felt, action) {
  for (const e of felt) {
    fetch('/api/brain/feel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emotion: e, action }) }).catch(() => {});
  }
}

/* For a window whose own run it is but which has no brain drawn (the
 * Presence widget): record the pairings anyway, so the network still learns. */
export function recordOwnFeel(ev, engine) {
  if (ev?.type !== 'tool_call' || !ev.name || ev.origin || ev.heartbeat) return;
  const skill = SKILL_TOOL_NAMES.has(ev.name) && typeof ev.input?.name === 'string' ? `skill:${ev.input.name}` : null;
  recordFeel(feltNow(engine), skill || `tool:${ev.name}`);
}
