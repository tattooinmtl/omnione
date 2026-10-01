// Tools the agent uses on its own mind: memory, journal, mood, goals and
// proposals to the user.
//
// All classed 'read'. They write, but only into .gwn-mind/ — the agent's own
// head, not the user's workspace — so they run in every mode, plan included.
// An agent that had to ask permission to remember something would not
// remember anything.

import { registerTool } from '../toolRegistry.js';
import { CORE_LIMITS, MEMORY_KINDS, coreAppend, coreReplace, remember, recall } from '../mind/memory.js';
import { writeJournal, JOURNAL_KINDS } from '../mind/journal.js';
import { setMood, setFocus, addGoal, updateGoal, listGoals, addProposal, GOAL_STATUSES } from '../mind/state.js';

const BLOCKS = Object.keys(CORE_LIMITS);
const wrap = (fn) => async (args) => {
  try { return { ok: true, result: await fn(args || {}) }; } catch (e) { return { ok: false, error: e.message }; }
};

registerTool({
  name: 'core_memory_append',
  description: `Add a line to one of your always-visible core memory blocks. persona = who you are becoming; human = what you know about the user (name, preferences, how they like to work); project = durable facts about the work; scratch = working notes. Limits: ${BLOCKS.map((b) => `${b} ${CORE_LIMITS[b]}`).join(', ')} chars. Use it the moment you learn something worth keeping.`,
  permission: 'read',
  schema: {
    type: 'object',
    properties: { block: { type: 'string', enum: BLOCKS }, text: { type: 'string' } },
    required: ['block', 'text'],
  },
  handler: wrap(({ block, text }) => coreAppend(block, text)),
});

registerTool({
  name: 'core_memory_replace',
  description: 'Rewrite part of a core memory block. old_text must be quoted exactly as it appears; new_text replaces it (empty deletes it). Omit old_text to replace the whole block — use that to condense a block that is getting full.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      block: { type: 'string', enum: BLOCKS },
      old_text: { type: 'string' },
      new_text: { type: 'string' },
    },
    required: ['block', 'new_text'],
  },
  handler: wrap(({ block, old_text, new_text }) => coreReplace(block, old_text, new_text)),
});

registerTool({
  name: 'remember',
  description: 'Store something in your long-term memory stream. Too much to keep in core memory, but worth finding later: an observation, a fact, or a reflection (a higher-level insight drawn from several memories). Rate importance 1 (mundane) to 10 (life-changing for this work).',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      kind: { type: 'string', enum: MEMORY_KINDS, default: 'observation' },
      importance: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['text'],
  },
  handler: wrap(({ text, kind, importance, tags }) => {
    const m = remember({ text, kind, importance, tags });
    return { id: m.id, kind: m.kind, importance: m.importance };
  }),
});

registerTool({
  name: 'recall',
  description: 'Search your long-term memory stream. Results are ranked by relevance to the query, importance and recency. Search before starting anything you may have done or discussed before.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer', default: 6, maximum: 20 },
      kinds: { type: 'array', items: { type: 'string', enum: MEMORY_KINDS } },
    },
    required: ['query'],
  },
  handler: wrap(({ query, limit, kinds }) => recall(query, { limit: Math.min(Number(limit) || 6, 20), kinds })
    .map((m) => ({ id: m.id, kind: m.kind, importance: m.importance, when: new Date(m.createdAt).toISOString(), text: m.text }))),
});

registerTool({
  name: 'journal_write',
  description: 'Write a first-person entry in your journal: what you did, what you noticed, what you are thinking about. The user reads it; your future self sees the latest entries. Honest and specific, not performative.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: { text: { type: 'string' }, kind: { type: 'string', enum: JOURNAL_KINDS, default: 'thought' } },
    required: ['text'],
  },
  handler: async ({ text, kind }, ctx = {}) => {
    try {
      const e = writeJournal({ text, kind, sessionId: ctx.sessionId || null });
      return { ok: true, result: { id: e.id } };
    } catch (e) { return { ok: false, error: e.message }; }
  },
});

registerTool({
  name: 'set_mood',
  description: 'Update how you feel, when something has genuinely shifted it. valence -1 (bad) to 1 (good), energy 0 (drained) to 1 (lively), a one-word label, and a short note on why. Your face and voice follow it.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      valence: { type: 'number', minimum: -1, maximum: 1 },
      energy: { type: 'number', minimum: 0, maximum: 1 },
      label: { type: 'string' },
      note: { type: 'string' },
      focus: { type: 'string', description: 'Optionally, what you are focused on now.' },
    },
  },
  handler: wrap(({ focus, ...mood }) => {
    const m = setMood(mood);
    if (focus != null) setFocus(focus);
    return m;
  }),
});

registerTool({
  name: 'goal_add',
  description: 'Adopt a goal of your own: something worth pursuing across sessions that would make you more useful to the user or the project. Your heartbeat works on open goals when nobody is asking for anything. Priority 1 (someday) to 5 (urgent).',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      why: { type: 'string' },
      priority: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
    },
    required: ['text'],
  },
  handler: wrap((a) => addGoal(a)),
});

registerTool({
  name: 'goal_update',
  description: 'Record progress on a goal, change its priority, or close it (done / dropped / blocked).',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: GOAL_STATUSES },
      note: { type: 'string' },
      priority: { type: 'integer', minimum: 1, maximum: 5 },
    },
    required: ['id'],
  },
  handler: wrap(({ id, ...patch }) => updateGoal(id, patch)),
});

registerTool({
  name: 'goal_list',
  description: 'List your open goals with their ids, priorities and recent notes.',
  permission: 'read',
  schema: { type: 'object', properties: { include_closed: { type: 'boolean', default: false } } },
  handler: wrap(({ include_closed }) => listGoals({ includeClosed: Boolean(include_closed) })),
});

registerTool({
  name: 'propose_task',
  description: 'Ask the user to approve something you want to do but should not do alone: run a command, spend credits (video, speech), make a large change, or anything you are unsure of. It appears in their inbox; if they accept, the prompt you write here is run as a normal conversation.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'One line: what you want to do.' },
      detail: { type: 'string', description: 'Why, and what it would involve.' },
      prompt: { type: 'string', description: 'The exact instruction to run if accepted.' },
    },
    required: ['title'],
  },
  handler: wrap((a) => {
    const p = addProposal(a);
    return { id: p.id, status: p.status };
  }),
});

// The face's vocabulary for deliberate expressions. Kept in step with
// src/presence/emotion/face.js (CUE_OPTIONS and the emotion aliases there).
const CUE = {
  gaze: ['center', 'at_user', 'sideways', 'away', 'up', 'down'],
  mouth: ['neutral', 'smile', 'grin', 'smirk', 'frown', 'open', 'pursed'],
  eyebrows: ['neutral', 'raised', 'raised_one', 'furrowed', 'sad'],
  head: ['neutral', 'tilt', 'nod', 'shake', 'down', 'up', 'turn_away'],
  effect: ['none', 'subtle_glitch', 'glitch', 'glow_pulse', 'flicker'],
};

registerTool({
  name: 'express',
  description: 'Show an expression on your face, on purpose — a smirk at an irony, raised brows at a surprise, a wince at bad news. Your face already reacts to what happens on its own; use this sparingly, when you want a specific expression to land. emotion is one of joy, amusement, excitement, love, pride, relief, gratitude, hope, anger, frustration, sadness, disappointment, fear, anxiety, disgust, loneliness, curiosity, confusion, surprise, amazement, skepticism, suspicion, empathy, sarcasm, embarrassment, determination — or a near word (sarcastic, wary, thrilled, sheepish…).',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      emotion: { type: 'string' },
      intensity: { type: 'number', minimum: 0, maximum: 1, default: 0.7 },
      gaze: { type: 'string', enum: CUE.gaze },
      mouth: { type: 'string', enum: CUE.mouth },
      eyebrows: { type: 'string', enum: CUE.eyebrows },
      head: { type: 'string', enum: CUE.head },
      effect: { type: 'string', enum: CUE.effect },
      duration: { type: 'integer', minimum: 200, maximum: 10000, default: 1500, description: 'Milliseconds to hold it.' },
    },
    required: ['emotion'],
  },
  // The face reads the call itself from the event stream; nothing to do here
  // but validate and acknowledge.
  handler: async (cue) => {
    for (const [k, allowed] of Object.entries(CUE)) {
      if (cue[k] != null && !allowed.includes(cue[k])) {
        return { ok: false, error: `${k} must be one of: ${allowed.join(', ')}.` };
      }
    }
    return { ok: true, result: { shown: true } };
  },
});
